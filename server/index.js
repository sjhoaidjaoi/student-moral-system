
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { pool, testConnection } = require('./db');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();

app.use(cors({
  origin: 'http://localhost:5173'
}));

app.use(express.json({ limit: '2mb' }));

// Excel 上传配置：文件保存在内存中，不写入磁盘
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    if (!/\.(xlsx|xls)$/i.test(file.originalname)) {
      return callback(new Error('只允许上传 .xlsx 或 .xls 文件'));
    }

    callback(null, true);
  }
});

// 获取当前学期
async function getActiveSemester() {
  const [rows] = await pool.query(
    `SELECT id, semester_name, start_date, end_date
     FROM semesters
     WHERE status = 'active'
     ORDER BY id DESC
     LIMIT 1`
  );

  return rows[0] || null;
}

/* ==================== 登录鉴权 ==================== */

const AUTH_SECRET = process.env.JWT_SECRET || 'student-moral-system-secret-key';
const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

// 密码使用 scrypt 加盐哈希，存储格式：salt:hash
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${hashPassword(password, salt)}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');

  if (!salt || !hash) return false;

  const computed = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');

  return (
    computed.length === expected.length &&
    crypto.timingSafeEqual(computed, expected)
  );
}

// 轻量 HS256 JWT（不依赖第三方库）
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;

  const [header, body, signature] = token.split('.');

  if (!header || !body || !signature) return null;

  const expected = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  const given = Buffer.from(signature);
  const target = Buffer.from(expected);

  if (given.length !== target.length || !crypto.timingSafeEqual(given, target)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));

    if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// 启动时确保账号表存在，并播种默认管理员 admin / admin123
async function ensureUsersTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS users (
       id INT AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(50) NOT NULL UNIQUE,
       password_hash VARCHAR(255) NOT NULL,
       real_name VARCHAR(50) NOT NULL DEFAULT '',
       role ENUM('admin','teacher') NOT NULL DEFAULT 'teacher',
       status ENUM('active','disabled') NOT NULL DEFAULT 'active',
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  const [rows] = await pool.query('SELECT id FROM users LIMIT 1');

  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO users (username, password_hash, real_name, role)
       VALUES ('admin', ?, '系统管理员', 'admin')`,
      [makePasswordRecord('admin123')]
    );

    console.log('已创建默认管理员账号：admin / admin123（请尽快修改密码）');
  }
}

// 按请求解析学期：传了 semester_id 就用指定学期，否则用当前 active 学期
async function resolveSemester(req) {
  const sid = Number(req.query?.semester_id);

  if (Number.isInteger(sid) && sid > 0) {
    const [rows] = await pool.query(
      'SELECT id, semester_name, start_date, end_date, status FROM semesters WHERE id = ?',
      [sid]
    );

    return rows[0] || null;
  }

  return getActiveSemester();
}

// 启动时确保审计日志表存在
async function ensureAuditTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS audit_logs (
       id BIGINT AUTO_INCREMENT PRIMARY KEY,
       user_id INT DEFAULT NULL,
       username VARCHAR(50) NOT NULL DEFAULT '',
       action VARCHAR(64) NOT NULL,
       target_type VARCHAR(32) DEFAULT '',
       target_id VARCHAR(64) DEFAULT '',
       detail TEXT,
       ip VARCHAR(64) DEFAULT '',
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_audit_action (action),
       INDEX idx_audit_user (user_id),
       INDEX idx_audit_time (created_at)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

// 记录操作审计日志（异步，不阻塞响应）
function logAudit(req, action, detail = '', targetType = '', targetId = '') {
  const auth = req.auth || {};
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

  pool.query(
    `INSERT INTO audit_logs (user_id, username, action, target_type, target_id, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      auth.uid || null,
      auth.username || auth.realName || '',
      action,
      targetType,
      String(targetId ?? ''),
      String(detail ?? '').slice(0, 1000),
      ip.slice(0, 64),
    ]
  ).catch(err => console.error('审计日志写入失败：', err.message));
}

// 启动时确保加分规则表存在，并播种默认规则
async function ensureBonusRulesTable() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bonus_rules (
       id INT AUTO_INCREMENT PRIMARY KEY,
       rule_name VARCHAR(100) NOT NULL,
       points DECIMAL(5, 2) NOT NULL,
       description VARCHAR(255) NOT NULL DEFAULT '',
       is_active TINYINT(1) NOT NULL DEFAULT 1,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );

  const [rows] = await pool.query('SELECT COUNT(*) AS n FROM bonus_rules');

  if (rows[0].n === 0) {
    const defaults = [
      ['见义勇为', 5, '检举违规行为、主动帮助他人'],
      ['好人好事', 3, '助人为乐、拾金不昧等'],
      ['竞赛获奖', 10, '校级以上学科/文体竞赛获奖'],
      ['志愿服务', 2, '参加校级以上志愿服务活动'],
      ['宿舍卫生优秀', 2, '宿舍卫生检查被评为优秀'],
      ['其他', 0, '自定义加分项']
    ];

    for (const [name, points, desc] of defaults) {
      await pool.query(
        'INSERT INTO bonus_rules (rule_name, points, description) VALUES (?, ?, ?)',
        [name, points, desc]
      );
    }

    console.log('已初始化 6 条默认加分规则');
  }
}

// 登录（公开接口）
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: '请输入用户名和密码'
      });
    }

    const [rows] = await pool.query(
      `SELECT id, username, password_hash, real_name, role, status
       FROM users
       WHERE username = ?`,
      [username.trim()]
    );

    const user = rows[0];

    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: '该账号已被停用，请联系管理员'
      });
    }

    const token = signToken({
      uid: user.id,
      username: user.username,
      realName: user.real_name,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    });

    // 登录审计
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    pool.query(
      `INSERT INTO audit_logs (user_id, username, action, target_type, target_id, detail, ip)
       VALUES (?, ?, 'login', '', '', ?, ?)`,
      [user.id, user.username, `登录成功`, ip.slice(0, 64)]
    ).catch(() => {});

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
});

// 除健康检查与登录外，其余 /api 接口一律需要登录
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/auth/login' || req.path.startsWith('/public/')) {
    return next();
  }

  const auth = req.headers.authorization || '';
  const payload = auth.startsWith('Bearer ')
    ? verifyToken(auth.slice(7))
    : null;

  if (!payload) {
    return res.status(401).json({
      success: false,
      message: '登录已失效，请重新登录'
    });
  }

  req.auth = payload;
  next();
});

// 管理员权限守卫
function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: '该操作需要管理员权限'
    });
  }

  next();
}

// 当前登录用户信息
app.get('/api/auth/me', (req, res) => {
  res.json({ success: true, user: req.auth });
});

/* ==================== 学生自助查询（公开，免登录） ==================== */

app.get('/api/public/score', async (req, res, next) => {
  try {
    const studentNo = String(req.query.studentNo ?? '').trim();

    if (!studentNo || studentNo.length > 30) {
      return res.status(400).json({
        success: false,
        message: '请输入有效的学号'
      });
    }

    const semester = await getActiveSemester();

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '当前没有有效的学期'
      });
    }

    // 查学生基本信息 + 当前学期得分汇总
    const [students] = await pool.query(
      `SELECT
         s.student_no,
         s.student_name,
         c.grade_name,
         c.class_name,
         s.initial_score
           - COALESCE(v.total_deduction, 0)
           + COALESCE(a.total_adjustment, 0) AS current_score,
         s.initial_score,
         COALESCE(v.total_deduction, 0) AS total_deduction,
         COALESCE(a.total_adjustment, 0) AS total_adjustment,
         COALESCE(v.record_count, 0) AS violation_count
       FROM students s
       JOIN classes c ON c.id = s.class_id
       LEFT JOIN (
         SELECT student_id, semester_id,
                SUM(points) AS total_deduction,
                COUNT(*) AS record_count
         FROM violation_records
         WHERE status = 'valid'
         GROUP BY student_id, semester_id
       ) v ON v.student_id = s.id
          AND v.semester_id = ?
       LEFT JOIN (
         SELECT student_id, semester_id,
                SUM(points_change) AS total_adjustment
         FROM score_adjustments
         WHERE status = 'valid'
         GROUP BY student_id, semester_id
       ) a ON a.student_id = s.id
          AND a.semester_id = ?
       WHERE s.student_no = ?
       LIMIT 1`,
      [semester.id, semester.id, studentNo]
    );

    if (!students.length) {
      return res.status(404).json({
        success: false,
        message: `未找到学号「${studentNo}」`
      });
    }

    const student = students[0];

    // 查当前学期的扣分明细（不含描述等敏感字段）
    const [violations] = await pool.query(
      `SELECT violation_name, points, violation_date, status
       FROM violation_records
       WHERE student_id = (SELECT id FROM students WHERE student_no = ? LIMIT 1)
         AND semester_id = ?
       ORDER BY violation_date DESC, id DESC`,
      [studentNo, semester.id]
    );

    // 查当前学期的加分/调整明细
    const [adjustments] = await pool.query(
      `SELECT points_change, reason, status, created_at
       FROM score_adjustments
       WHERE student_id = (SELECT id FROM students WHERE student_no = ? LIMIT 1)
         AND semester_id = ?
       ORDER BY created_at DESC`,
      [studentNo, semester.id]
    );

    res.json({
      success: true,
      semester: {
        id: semester.id,
        semester_name: semester.semester_name
      },
      data: {
        student_no: student.student_no,
        student_name: student.student_name,
        grade_name: student.grade_name,
        class_name: student.class_name,
        initial_score: student.initial_score,
        current_score: student.current_score,
        total_deduction: student.total_deduction,
        total_adjustment: student.total_adjustment,
        violation_count: student.violation_count,
        violations,
        adjustments
      }
    });
  } catch (error) {
    next(error);
  }
});

// 当前用户自助修改密码
app.put('/api/auth/password', async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};

    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ success: false, message: '参数不完整' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: '新密码至少 6 位'
      });
    }

    const [rows] = await pool.query(
      'SELECT password_hash FROM users WHERE id = ?',
      [req.auth.uid]
    );

    const user = rows[0];

    if (!user || !verifyPassword(oldPassword, user.password_hash)) {
      return res.status(400).json({
        success: false,
        message: '原密码不正确'
      });
    }

    await pool.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [makePasswordRecord(newPassword), req.auth.uid]
    );

    logAudit(req, 'change_password', '自助修改密码', 'user', req.auth.uid);

    res.json({ success: true, message: '密码修改成功' });
  } catch (error) {
    next(error);
  }
});

/* ==================== 账号管理（仅管理员） ==================== */

app.get('/api/users', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, real_name, role, status, created_at
       FROM users
       ORDER BY id`
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', requireAdmin, async (req, res, next) => {
  try {
    const { username, password, realName, role } = req.body || {};
    const name = String(username ?? '').trim();

    if (!name || name.length > 50) {
      return res.status(400).json({
        success: false,
        message: '请填写用户名（最多50个字符）'
      });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: '密码至少 6 位'
      });
    }

    if (!['admin', 'teacher'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: '角色只能是 admin 或 teacher'
      });
    }

    const [dup] = await pool.query('SELECT id FROM users WHERE username = ?', [
      name
    ]);

    if (dup.length) {
      return res.status(400).json({
        success: false,
        message: `用户名「${name}」已存在`
      });
    }

    const [result] = await pool.query(
      `INSERT INTO users (username, password_hash, real_name, role)
       VALUES (?, ?, ?, ?)`,
      [name, makePasswordRecord(password), String(realName ?? '').trim().slice(0, 50), role]
    );

    logAudit(req, 'create_user', `创建账号：${name}（${role}）`, 'user', result.insertId);

    res.status(201).json({
      success: true,
      message: '账号创建成功',
      data: { id: result.insertId }
    });
  } catch (error) {
    next(error);
  }
});

app.put('/api/users/:id/password', requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { password } = req.body || {};

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: '无效的账号' });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: '密码至少 6 位'
      });
    }

    const [result] = await pool.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [makePasswordRecord(password), userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: '账号不存在' });
    }

    logAudit(req, 'reset_user_password', `重置账号密码：${userId}`, 'user', userId);

    res.json({ success: true, message: '密码已重置' });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);

    if (userId === req.auth.uid) {
      return res.status(400).json({
        success: false,
        message: '不能删除当前登录的账号'
      });
    }

    const [result] = await pool.query('DELETE FROM users WHERE id = ?', [
      userId
    ]);

    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: '账号不存在' });
    }

    logAudit(req, 'delete_user', `删除账号：${userId}`, 'user', userId);

    res.json({ success: true, message: '账号已删除' });
  } catch (error) {
    next(error);
  }
});

// 停用 / 启用账号
app.patch('/api/users/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const { status } = req.body || {};

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ success: false, message: '无效的账号' });
    }

    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: '状态只能是 active 或 disabled'
      });
    }

    if (userId === req.auth.uid && status === 'disabled') {
      return res.status(400).json({
        success: false,
        message: '不能停用当前登录的账号'
      });
    }

    const [result] = await pool.query(
      'UPDATE users SET status = ? WHERE id = ?',
      [status, userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: '账号不存在' });
    }

    logAudit(
      req,
      'toggle_user_status',
      `${status === 'disabled' ? '停用' : '启用'}账号：${userId}`,
      'user',
      userId
    );

    res.json({
      success: true,
      message: status === 'disabled' ? '账号已停用' : '账号已启用'
    });
  } catch (error) {
    next(error);
  }
});

/* ==================== 操作审计日志（仅管理员） ==================== */

// 操作类型 -> 中文标签
const ACTION_LABELS = {
  login: '登录',
  change_password: '修改密码',
  reset_user_password: '重置密码',
  create_user: '创建账号',
  delete_user: '删除账号',
  toggle_user_status: '停用/启用账号',
  create_semester: '新建学期',
  switch_semester: '切换学期',
  delete_semester: '删除学期',
  create_student: '添加学生',
  update_student: '编辑学生',
  delete_student: '删除学生',
  import_students: '导入学生',
  import_violations: '导入扣分',
  add_violation: '扣分',
  dorm_batch_violation: '宿舍批量扣分',
  revoke_violation: '撤销扣分',
  add_bonus: '加分',
  add_penalty: '手动减分',
  revoke_adjustment: '撤销调整',
  reset_scores: '重置分数',
  clear_records: '清空记录',
  create_bonus_rule: '创建加分规则',
  update_bonus_rule: '修改加分规则',
  delete_bonus_rule: '删除加分规则',
  export_database: '导出全库'
};

// 分页查询审计日志
app.get('/api/audit-logs', requireAdmin, async (req, res, next) => {
  try {
    const { action = '', username = '' } = req.query;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 200);

    const where = [];
    const params = [];

    if (typeof action === 'string' && action.trim()) {
      where.push('action = ?');
      params.push(action.trim());
    }

    if (typeof username === 'string' && username.trim()) {
      where.push('username LIKE ?');
      params.push(`%${username.trim()}%`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM audit_logs ${whereClause}`,
      params
    );

    const offset = (page - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT id, user_id, username, action, target_type, target_id, detail, ip, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({
      success: true,
      data: rows.map(r => ({ ...r, action_label: ACTION_LABELS[r.action] || r.action })),
      total,
      page,
      pageSize
    });
  } catch (error) {
    next(error);
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '学生品行分管理系统后端运行正常'
  });
});

// 查询班级
app.get('/api/classes', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, grade_name, class_name
       FROM classes
       ORDER BY grade_name, class_name`
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// 查询学期
app.get('/api/semesters', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, semester_name, start_date, end_date, status
       FROM semesters
       ORDER BY start_date DESC`
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// 新建学期（仅管理员）。activate=true 则同时设为当前 active 学期
app.post('/api/semesters', requireAdmin, async (req, res, next) => {
  try {
    const { semesterName, startDate, endDate, activate } = req.body || {};

    if (
      typeof semesterName !== 'string' ||
      !semesterName.trim() ||
      !startDate ||
      !endDate
    ) {
      return res.status(400).json({
        success: false,
        message: '请填写学期名称、开始日期和结束日期'
      });
    }

    if (String(startDate) >= String(endDate)) {
      return res.status(400).json({
        success: false,
        message: '开始日期必须早于结束日期'
      });
    }

    const [result] = await pool.query(
      `INSERT INTO semesters (semester_name, start_date, end_date, status)
       VALUES (?, ?, ?, ?)`,
      [
        semesterName.trim().slice(0, 50),
        String(startDate).slice(0, 10),
        String(endDate).slice(0, 10),
        activate ? 'active' : 'archived'
      ]
    );

    if (activate) {
      // 把其它学期置为 archived
      await pool.query(
        'UPDATE semesters SET status = "archived" WHERE id <> ?',
        [result.insertId]
      );
    }

    logAudit(req, 'create_semester', `新建学期：${semesterName}${activate ? '（设为当前）' : ''}`, 'semester', result.insertId);

    res.status(201).json({
      success: true,
      message: activate ? '学期已创建并设为当前学期' : '学期已创建',
      data: { id: result.insertId }
    });
  } catch (error) {
    next(error);
  }
});

// 切换当前学期（仅管理员）：把指定学期设为 active，其它置为 inactive
app.patch('/api/semesters/:id/activate', requireAdmin, async (req, res, next) => {
  let connection;

  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的学期' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [exists] = await connection.execute(
      'SELECT semester_name FROM semesters WHERE id = ?',
      [id]
    );

    if (!exists.length) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: '学期不存在' });
    }

    await connection.execute('UPDATE semesters SET status = "archived"');
    await connection.execute('UPDATE semesters SET status = "active" WHERE id = ?', [id]);

    await connection.commit();

    logAudit(req, 'switch_semester', `切换到学期：${exists[0].semester_name}`, 'semester', id);

    res.json({ success: true, message: `已切换到学期「${exists[0].semester_name}」` });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    next(error);
  } finally {
    if (connection) connection.release();
  }
});

// 删除学期（仅管理员）：只能删除非当前学期，且该学期下没有扣分/调整记录
app.delete('/api/semesters/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '无效的学期' });
    }

    const [sem] = await pool.query(
      'SELECT semester_name, status FROM semesters WHERE id = ?',
      [id]
    );

    if (!sem.length) {
      return res.status(404).json({ success: false, message: '学期不存在' });
    }

    if (sem[0].status === 'active') {
      return res.status(400).json({
        success: false,
        message: '当前使用中的学期不能删除，请先切换到其它学期'
      });
    }

    const [[vc]] = await pool.query(
      'SELECT COUNT(*) AS n FROM violation_records WHERE semester_id = ?',
      [id]
    );
    const [[ac]] = await pool.query(
      'SELECT COUNT(*) AS n FROM score_adjustments WHERE semester_id = ?',
      [id]
    );

    if (vc.n > 0 || ac.n > 0) {
      return res.status(400).json({
        success: false,
        message: `该学期下还有 ${vc.n} 条扣分记录、${ac.n} 条调整记录，不能删除`
      });
    }

    await pool.query('DELETE FROM semesters WHERE id = ?', [id]);
    logAudit(req, 'delete_semester', `删除学期：${sem[0].semester_name}`, 'semester', id);

    res.json({ success: true, message: `学期「${sem[0].semester_name}」已删除` });
  } catch (error) {
    next(error);
  }
});

// 查询扣分规则
app.get('/api/rules', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, rule_name, points, description
       FROM deduction_rules
       WHERE is_active = TRUE
       ORDER BY id`
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

/* ==================== 加分规则管理 ==================== */

// 查询加分规则
app.get('/api/bonus-rules', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, rule_name, points, description, is_active, created_at
       FROM bonus_rules
       ORDER BY is_active DESC, id`
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// 新增加分规则（管理员）
app.post('/api/bonus-rules', requireAdmin, async (req, res, next) => {
  try {
    const { ruleName, points, description = '' } = req.body || {};
    const name = String(ruleName ?? '').trim();

    if (!name || name.length > 100) {
      return res.status(400).json({
        success: false,
        message: '请填写规则名称（最多100个字符）'
      });
    }

    const pts = Number(points);

    if (
      !Number.isFinite(pts) ||
      pts < 0 ||
      pts > 100 ||
      !/^\d+(\.\d{1,2})?$/.test(String(points))
    ) {
      return res.status(400).json({
        success: false,
        message: '加分分值必须是 0-100 的数字，最多两位小数'
      });
    }

    const [dup] = await pool.query(
      'SELECT id FROM bonus_rules WHERE rule_name = ?',
      [name]
    );

    if (dup.length) {
      return res.status(400).json({
        success: false,
        message: `规则「${name}」已存在`
      });
    }

    const [result] = await pool.query(
      `INSERT INTO bonus_rules (rule_name, points, description)
       VALUES (?, ?, ?)`,
      [name, pts, String(description).trim().slice(0, 255)]
    );

    logAudit(req, 'create_bonus_rule', `创建加分规则：${name}（+${pts}）`, 'bonus_rule', result.insertId);

    res.status(201).json({
      success: true,
      message: '加分规则创建成功',
      data: { id: result.insertId }
    });
  } catch (error) {
    next(error);
  }
});

// 修改加分规则（管理员）
app.patch('/api/bonus-rules/:id', requireAdmin, async (req, res, next) => {
  try {
    const ruleId = Number(req.params.id);
    const { ruleName, points, description, isActive } = req.body || {};

    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ success: false, message: '无效的规则' });
    }

    const fields = [];
    const values = [];

    if (ruleName !== undefined) {
      const name = String(ruleName).trim();

      if (!name || name.length > 100) {
        return res.status(400).json({
          success: false,
          message: '规则名称最多100个字符'
        });
      }

      fields.push('rule_name = ?');
      values.push(name);
    }

    if (points !== undefined) {
      const pts = Number(points);

      if (
        !Number.isFinite(pts) ||
        pts < 0 ||
        pts > 100 ||
        !/^\d+(\.\d{1,2})?$/.test(String(points))
      ) {
        return res.status(400).json({
          success: false,
          message: '加分分值必须是 0-100 的数字'
        });
      }

      fields.push('points = ?');
      values.push(pts);
    }

    if (description !== undefined) {
      fields.push('description = ?');
      values.push(String(description).trim().slice(0, 255));
    }

    if (isActive !== undefined) {
      fields.push('is_active = ?');
      values.push(isActive ? 1 : 0);
    }

    if (!fields.length) {
      return res.status(400).json({ success: false, message: '没有需要更新的字段' });
    }

    values.push(ruleId);

    const [result] = await pool.query(
      `UPDATE bonus_rules SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: '规则不存在' });
    }

    logAudit(req, 'update_bonus_rule', `修改加分规则：${ruleId}`, 'bonus_rule', ruleId);

    res.json({ success: true, message: '规则已更新' });
  } catch (error) {
    next(error);
  }
});

// 删除加分规则（管理员）
app.delete('/api/bonus-rules/:id', requireAdmin, async (req, res, next) => {
  try {
    const ruleId = Number(req.params.id);

    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return res.status(400).json({ success: false, message: '无效的规则' });
    }

    const [result] = await pool.query('DELETE FROM bonus_rules WHERE id = ?', [
      ruleId
    ]);

    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: '规则不存在' });
    }

    logAudit(req, 'delete_bonus_rule', `删除加分规则：${ruleId}`, 'bonus_rule', ruleId);

    res.json({ success: true, message: '规则已删除' });
  } catch (error) {
    next(error);
  }
});

// 查询学生名单

app.get('/api/students', async (req, res, next) => {
  try {
    const { keyword = '', grade = '', class: className = '' } = req.query;
    const page = Number(req.query.page);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 500);

    const where = [];
    const params = [];

    if (typeof keyword === 'string' && keyword.trim()) {
      where.push('(s.student_no LIKE ? OR s.student_name LIKE ?)');
      const kw = `%${keyword.trim()}%`;
      params.push(kw, kw);
    }

    if (typeof grade === 'string' && grade.trim()) {
      where.push('c.grade_name = ?');
      params.push(grade.trim());
    }

    if (typeof className === 'string' && className.trim()) {
      where.push('c.class_name = ?');
      params.push(className.trim());
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const baseFrom = `FROM students s JOIN classes c ON c.id = s.class_id ${whereClause}`;

    if (Number.isInteger(page) && page > 0) {
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total ${baseFrom}`,
        params
      );

      const offset = (page - 1) * pageSize;
      const [rows] = await pool.query(
        `SELECT s.id, s.student_no, s.student_name, s.class_id,
                c.grade_name, c.class_name, s.dorm_building, s.dorm_room, s.initial_score
         ${baseFrom}
         ORDER BY c.grade_name, c.class_name, s.student_no
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );

      return res.json({ success: true, data: rows, total, page, pageSize });
    }

    const [rows] = await pool.query(
      `SELECT s.id, s.student_no, s.student_name, s.class_id,
              c.grade_name, c.class_name, s.dorm_building, s.dorm_room, s.initial_score
       ${baseFrom}
       ORDER BY c.grade_name, c.class_name, s.student_no`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});



// 年级规范化：提取年份 -> 「2025级」，兼容 2025、2025级、25级 等
function normalizeGradeName(value) {
  const text = String(value ?? '').trim()

  if (!text) {
    return ''
  }

  const fullYear = text.match(/20\d{2}/)

  if (fullYear) {
    return `${fullYear[0]}级`
  }

  const shortYear = text.match(/^(\d{2})级?$/)

  if (shortYear) {
    return `20${shortYear[1]}级`
  }

  return text
}

// 班级规范化：提取班号 -> 「软件工程4班」，兼容 4班、4、软工4班、软件工程4班
function normalizeClassName(value) {
  const text = String(value ?? '').trim()

  if (!text) {
    return ''
  }

  if (/^软件工程\d+班$/.test(text)) {
    return text
  }

  const classNo = text.match(/(\d+)\s*班?$/)

  if (classNo) {
    return `软件工程${Number(classNo[1])}班`
  }

  return text
}

// 统一表头格式，忽略空格、下划线、横线和括号（供学生/扣分导入共用）
function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\s\u3000_\-—（）()]/g, '')
    .toLowerCase()
}

/* ==================== 学生单个增删改 ==================== */

// 按 年级+班级名 查找班级，不存在则创建，返回班级 id
async function findOrCreateClass(connection, gradeName, className) {
  const [rows] = await connection.execute(
    'SELECT id FROM classes WHERE grade_name = ? AND class_name = ?',
    [gradeName, className]
  );

  if (rows.length) {
    return rows[0].id;
  }

  const [result] = await connection.execute(
    'INSERT INTO classes (grade_name, class_name) VALUES (?, ?)',
    [gradeName, className]
  );

  return result.insertId;
}

// 新增单个学生
app.post('/api/students', async (req, res, next) => {
  let connection;

  try {
    const body = req.body || {};
    const studentNo = String(body.studentNo ?? '').trim();
    const studentName = String(body.studentName ?? '').trim();
    const gradeName = normalizeGradeName(body.gradeName);
    const className = normalizeClassName(body.className);
    const dormBuilding = String(body.dormBuilding ?? '').trim().slice(0, 50);
    const dormRoom = String(body.dormRoom ?? '').trim().slice(0, 50);

    if (!studentNo || studentNo.length > 30) {
      return res.status(400).json({
        success: false,
        message: '请填写学号（最多30个字符）'
      });
    }

    if (!studentName || studentName.length > 50) {
      return res.status(400).json({
        success: false,
        message: '请填写姓名（最多50个字符）'
      });
    }

    if (!gradeName || !className) {
      return res.status(400).json({
        success: false,
        message: '请填写年级和班级（如 2025级 / 软件工程1班）'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [dup] = await connection.execute(
      'SELECT id FROM students WHERE student_no = ?',
      [studentNo]
    );

    if (dup.length) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: `学号「${studentNo}」已存在`
      });
    }

    const classId = await findOrCreateClass(connection, gradeName, className);

    // 新学生默认初始分为 100 分
    const [result] = await connection.execute(
      `INSERT INTO students
         (student_no, student_name, class_id, initial_score, dorm_building, dorm_room)
       VALUES (?, ?, ?, 100, ?, ?)`,
      [studentNo, studentName, classId, dormBuilding || null, dormRoom || null]
    );

    await connection.commit();

    logAudit(req, 'create_student', `添加学生：${studentName}（${studentNo}，${gradeName}${className}）`, 'student', result.insertId);

    res.status(201).json({
      success: true,
      message: '学生添加成功',
      data: { id: result.insertId }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// 编辑学生信息（姓名/学号/年级班级/宿舍）
app.put('/api/students/:id', async (req, res, next) => {
  let connection;

  try {
    const studentId = Number(req.params.id);
    const body = req.body || {};
    const studentNo = String(body.studentNo ?? '').trim();
    const studentName = String(body.studentName ?? '').trim();
    const gradeName = normalizeGradeName(body.gradeName);
    const className = normalizeClassName(body.className);
    const dormBuilding = String(body.dormBuilding ?? '').trim().slice(0, 50);
    const dormRoom = String(body.dormRoom ?? '').trim().slice(0, 50);

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).json({ success: false, message: '无效的学生' });
    }

    if (!studentNo || studentNo.length > 30) {
      return res.status(400).json({
        success: false,
        message: '请填写学号（最多30个字符）'
      });
    }

    if (!studentName || studentName.length > 50) {
      return res.status(400).json({
        success: false,
        message: '请填写姓名（最多50个字符）'
      });
    }

    if (!gradeName || !className) {
      return res.status(400).json({
        success: false,
        message: '请填写年级和班级'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.execute(
      'SELECT id FROM students WHERE id = ?',
      [studentId]
    );

    if (!existing.length) {
      await connection.rollback();

      return res.status(404).json({ success: false, message: '学生不存在' });
    }

    const [dup] = await connection.execute(
      'SELECT id FROM students WHERE student_no = ? AND id <> ?',
      [studentNo, studentId]
    );

    if (dup.length) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: `学号「${studentNo}」已被其他学生使用`
      });
    }

    const classId = await findOrCreateClass(connection, gradeName, className);

    await connection.execute(
      `UPDATE students
       SET student_no = ?, student_name = ?, class_id = ?, dorm_building = ?, dorm_room = ?
       WHERE id = ?`,
      [studentNo, studentName, classId, dormBuilding || null, dormRoom || null, studentId]
    );

    await connection.commit();

    logAudit(req, 'update_student', `更新学生：${studentName}（${studentNo}）`, 'student', studentId);

    res.json({ success: true, message: '学生信息已更新' });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// 删除学生（连同其扣分与调整记录，仅管理员）
app.delete('/api/students/:id', requireAdmin, async (req, res, next) => {
  let connection;

  try {
    const studentId = Number(req.params.id);

    if (!Number.isInteger(studentId) || studentId <= 0) {
      return res.status(400).json({ success: false, message: '无效的学生' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.execute(
      'SELECT student_no, student_name FROM students WHERE id = ?',
      [studentId]
    );

    if (!existing.length) {
      await connection.rollback();

      return res.status(404).json({ success: false, message: '学生不存在' });
    }

    await connection.execute('DELETE FROM violation_records WHERE student_id = ?', [studentId]);
    await connection.execute('DELETE FROM score_adjustments WHERE student_id = ?', [studentId]);
    await connection.execute('DELETE FROM students WHERE id = ?', [studentId]);

    await connection.commit();

    logAudit(req, 'delete_student', `删除学生：${existing[0].student_name}（${existing[0].student_no}）及其全部记录`, 'student', studentId);

    res.json({
      success: true,
      message: `学生「${existing[0].student_name}」及其全部记录已删除`
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});



app.get('/api/scores', async (req, res, next) => {
  try {
    const semester = await resolveSemester(req);

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先在数据库中设置一个有效学期'
      });
    }

    const [rows] = await pool.query(
      `SELECT
         s.id,
         s.student_no,
         s.student_name,
         c.grade_name,
         c.class_name,
         s.dorm_building,
         s.dorm_room,
         s.initial_score
           - COALESCE(v.total_deduction, 0)
           + COALESCE(a.total_adjustment, 0) AS current_score,
         COALESCE(v.total_deduction, 0) AS total_deduction,
         COALESCE(a.total_adjustment, 0) AS total_adjustment,
         COALESCE(v.record_count, 0) AS violation_count
       FROM students s
       JOIN classes c ON c.id = s.class_id
       LEFT JOIN (
         SELECT student_id, semester_id,
                SUM(points) AS total_deduction,
                COUNT(*) AS record_count
         FROM violation_records
         WHERE status = 'valid'
         GROUP BY student_id, semester_id
       ) v ON v.student_id = s.id
          AND v.semester_id = ?
       LEFT JOIN (
         SELECT student_id, semester_id,
                SUM(points_change) AS total_adjustment
         FROM score_adjustments
         WHERE status = 'valid'
         GROUP BY student_id, semester_id
       ) a ON a.student_id = s.id
          AND a.semester_id = ?
       ORDER BY current_score DESC, s.student_no ASC`,
      [semester.id, semester.id]
    );

    res.json({
      success: true,
      semester,
      data: rows
    });
  } catch (error) {
    next(error);
  }
});



/**
 * 手动调整学生品行分
 * 正数 = 加分，负数 = 减分
 */
app.post('/api/adjustments', async (req, res, next) => {
  let connection;

  try {
    const { studentId, pointsChange, reason } = req.body;

    // 检查学生 ID
    if (
      !Number.isInteger(Number(studentId)) ||
      Number(studentId) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: '请选择有效的学生'
      });
    }

    // 检查调整分数：必须是非零数字，最多两位小数
    const points = Number(pointsChange);

    if (
      !Number.isFinite(points) ||
      points === 0 ||
      Math.abs(points) > 100 ||
      !/^-?\d+(\.\d{1,2})?$/.test(String(pointsChange))
    ) {
      return res.status(400).json({
        success: false,
        message: '调整分数必须是非零数字，最多两位小数，且绝对值不能超过100'
      });
    }

    // 检查调整原因
    if (
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.trim().length > 200
    ) {
      return res.status(400).json({
        success: false,
        message: '请填写调整原因，最多200个字符'
      });
    }

    // 获取当前学期
    const semester = await getActiveSemester();

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先设置有效学期'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 确认学生存在
    const [students] = await connection.execute(
      'SELECT id FROM students WHERE id = ?',
      [Number(studentId)]
    );

    if (students.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: '没有找到该学生'
      });
    }

    // 写入品行分调整记录
    const [result] = await connection.execute(
      `INSERT INTO score_adjustments
       (student_id, semester_id, points_change, reason, status)
       VALUES (?, ?, ?, ?, 'valid')`,
      [
        Number(studentId),
        semester.id,
        points,
        reason.trim()
      ]
    );

    await connection.commit();

    logAudit(req, points > 0 ? 'add_bonus' : 'add_penalty', `手动${points > 0 ? '加分' : '减分'} ${points} 分，原因：${reason.trim()}`, 'student', Number(studentId));

    return res.status(201).json({
      success: true,
      message: points > 0 ? '手动加分成功' : '手动减分成功',
      data: {
        id: result.insertId,
        studentId: Number(studentId),
        semesterId: semester.id,
        pointsChange: points,
        reason: reason.trim()
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});


// 查询分数调整明细（手动加减分记录）
app.get('/api/adjustments', async (req, res, next) => {
  try {
    const semester = await resolveSemester(req);

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先设置有效学期'
      });
    }

    const page = Number(req.query.page);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 500);
    const baseFrom = `FROM score_adjustments a
       JOIN students s ON s.id = a.student_id
       JOIN classes c ON c.id = s.class_id
       WHERE a.semester_id = ?`;
    const countParams = [semester.id];

    if (Number.isInteger(page) && page > 0) {
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total ${baseFrom}`,
        countParams
      );
      const offset = (page - 1) * pageSize;
      const [rows] = await pool.query(
        `SELECT a.id, s.student_no, s.student_name, c.grade_name, c.class_name,
                a.points_change, a.reason, a.status, a.created_at
         ${baseFrom}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ? OFFSET ?`,
        [...countParams, pageSize, offset]
      );
      return res.json({ success: true, data: rows, total, page, pageSize });
    }

    const [rows] = await pool.query(
      `SELECT a.id, s.student_no, s.student_name, c.grade_name, c.class_name,
              a.points_change, a.reason, a.status, a.created_at
       ${baseFrom}
       ORDER BY a.created_at DESC, a.id DESC`,
      countParams
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// 撤销分数调整记录：撤销后不再参与品行分计算
app.patch('/api/adjustments/:id/revoke', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: '调整记录 ID 无效'
      });
    }

    const [rows] = await pool.query(
      `SELECT id, status
       FROM score_adjustments
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '没有找到这条调整记录'
      });
    }

    if (rows[0].status !== 'valid') {
      return res.status(400).json({
        success: false,
        message: '这条记录已经撤销，无需重复操作'
      });
    }

    const [result] = await pool.query(
      `UPDATE score_adjustments
       SET status = 'void'
       WHERE id = ? AND status = 'valid'`,
      [id]
    );

    if (result.affectedRows !== 1) {
      return res.status(409).json({
        success: false,
        message: '记录状态已发生变化，请刷新后重试'
      });
    }

    logAudit(req, 'revoke_adjustment', `撤销分数调整记录 #${id}`, 'adjustment', id);

    return res.json({
      success: true,
      message: '分数调整记录已撤销'
    });
  } catch (error) {
    next(error);
  }
});

// 查询违规扣分明细
app.get('/api/violations', async (req, res, next) => {
  try {
    const semester = await resolveSemester(req);

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先设置有效学期'
      });
    }

    const page = Number(req.query.page);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 20, 1), 500);
    const baseFrom = `FROM violation_records v
       JOIN students s ON s.id = v.student_id
       JOIN classes c ON c.id = s.class_id
       WHERE v.semester_id = ?`;
    const countParams = [semester.id];

    if (Number.isInteger(page) && page > 0) {
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total ${baseFrom}`,
        countParams
      );
      const offset = (page - 1) * pageSize;
      const [rows] = await pool.query(
        `SELECT v.id, s.student_no, s.student_name, c.grade_name, c.class_name,
                v.violation_name, v.points, v.violation_date, v.description, v.status, v.created_at
         ${baseFrom}
         ORDER BY v.violation_date DESC, v.id DESC
         LIMIT ? OFFSET ?`,
        [...countParams, pageSize, offset]
      );
      return res.json({ success: true, data: rows, total, page, pageSize });
    }

    const [rows] = await pool.query(
      `SELECT v.id, s.student_no, s.student_name, c.grade_name, c.class_name,
              v.violation_name, v.points, v.violation_date, v.description, v.status, v.created_at
       ${baseFrom}
       ORDER BY v.violation_date DESC, v.id DESC`,
      countParams
    );

    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// 新增违规记录：扣分数由数据库规则决定
app.post('/api/violations', async (req, res, next) => {
  let connection;

  try {
    const {
      studentId,
      ruleId,
      violationDate,
      description = '',
      customPoints = null,
      customName = ''
    } = req.body;

    if (
      !Number.isInteger(Number(studentId)) ||
      Number(studentId) <= 0 ||
      !Number.isInteger(Number(ruleId)) ||
      Number(ruleId) <= 0 ||
      typeof violationDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(violationDate) ||
      typeof description !== 'string' ||
      description.length > 500
    ) {
      return res.status(400).json({
        success: false,
        message: '请检查学生、扣分规则、日期和备注'
      });
    }

    const semester = await getActiveSemester();

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先设置有效学期'
      });
    }

    if (
      violationDate < String(semester.start_date).slice(0, 10) ||
      violationDate > String(semester.end_date).slice(0, 10)
    ) {
      return res.status(400).json({
        success: false,
        message: '违规日期不在当前学期范围内'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [students] = await connection.execute(
      'SELECT id FROM students WHERE id = ?',
      [Number(studentId)]
    );

    if (students.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: '没有找到该学生'
      });
    }

    const [rules] = await connection.execute(
      `SELECT id, rule_name, points
       FROM deduction_rules
       WHERE id = ? AND is_active = TRUE`,
      [Number(ruleId)]
    );

    if (rules.length === 0) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: '该扣分规则不存在或已停用'
      });
    }

    const rule = rules[0];

    // 「其他」规则：分值与名称由用户自定义输入
    let violationPoints = rule.points;
    let violationName = rule.rule_name;

    if (rule.rule_name === '其他') {
      const points = Number(customPoints);

      if (
        !Number.isFinite(points) ||
        points <= 0 ||
        points > 100 ||
        !/^\d+(\.\d{1,2})?$/.test(String(customPoints ?? ''))
      ) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: '自定义扣分分值必须为大于0且不超过100的数字，最多两位小数'
        });
      }

      violationPoints = points;

      const name = typeof customName === 'string' ? customName.trim() : '';

      if (name) {
        violationName = name.length > 100 ? name.slice(0, 100) : name;
      }
    }

    const [result] = await connection.execute(
      `INSERT INTO violation_records
       (student_id, semester_id, rule_id, violation_name,
        points, violation_date, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(studentId),
        semester.id,
        rule.id,
        violationName,
        violationPoints,
        violationDate,
        description.trim()
      ]
    );

    await connection.commit();

    logAudit(req, 'add_violation', `扣分：${violationName} ${violationPoints} 分（${violationDate}）`, 'student', Number(studentId));

    res.status(201).json({
      success: true,
      message: '扣分记录添加成功',
      data: {
        id: result.insertId,
        studentId: Number(studentId),
        semesterId: semester.id,
        violationName,
        points: violationPoints,
        violationDate
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});



/**
 * 宿舍卫生批量扣分：选择宿舍与分值，对该宿舍全体学生批量扣分
 */
app.post('/api/violations/dorm-batch', async (req, res, next) => {
  let connection;

  try {
    const {
      dormBuilding,
      dormRoom,
      points: rawPoints,
      violationDate,
      description = ''
    } = req.body;

    const points = Number(rawPoints);

    if (
      typeof dormBuilding !== 'string' ||
      !dormBuilding.trim() ||
      dormBuilding.trim().length > 50 ||
      typeof dormRoom !== 'string' ||
      !dormRoom.trim() ||
      dormRoom.trim().length > 50
    ) {
      return res.status(400).json({
        success: false,
        message: '请选择宿舍楼栋和宿舍号'
      });
    }

    if (
      !Number.isFinite(points) ||
      points <= 0 ||
      points > 100 ||
      !/^\d+(\.\d{1,2})?$/.test(String(rawPoints ?? ''))
    ) {
      return res.status(400).json({
        success: false,
        message: '扣分分值必须为大于0且不超过100的数字，最多两位小数'
      });
    }

    if (
      typeof violationDate !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(violationDate) ||
      typeof description !== 'string' ||
      description.length > 500
    ) {
      return res.status(400).json({
        success: false,
        message: '请检查扣分日期和备注'
      });
    }

    const semester = await getActiveSemester();

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先设置有效学期'
      });
    }

    if (
      violationDate < String(semester.start_date).slice(0, 10) ||
      violationDate > String(semester.end_date).slice(0, 10)
    ) {
      return res.status(400).json({
        success: false,
        message: '扣分日期不在当前学期范围内'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rules] = await connection.execute(
      `SELECT id, rule_name FROM deduction_rules
       WHERE rule_name = '宿舍卫生批量扣分' AND is_active = TRUE
       LIMIT 1`
    );

    if (rules.length === 0) {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: '宿舍卫生批量扣分规则不存在或已停用'
      });
    }

    const [students] = await connection.query(
      `SELECT id, student_no, student_name
       FROM students
       WHERE dorm_building = ? AND dorm_room = ?
       ORDER BY student_no`,
      [dormBuilding.trim(), dormRoom.trim()]
    );

    if (students.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: `${dormBuilding.trim()} ${dormRoom.trim()} 没有找到学生，请确认宿舍信息`
      });
    }

    for (const student of students) {
      await connection.execute(
        `INSERT INTO violation_records
         (student_id, semester_id, rule_id, violation_name,
          points, violation_date, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          student.id,
          semester.id,
          rules[0].id,
          rules[0].rule_name,
          points,
          violationDate,
          description.trim()
        ]
      );
    }

    await connection.commit();

    logAudit(req, 'dorm_batch_violation', `宿舍批量扣分：${dormBuilding.trim()} ${dormRoom.trim()}，${students.length} 人，${points} 分`, 'dorm', `${dormBuilding.trim()}-${dormRoom.trim()}`);

    return res.status(201).json({
      success: true,
      message: `已对 ${students.length} 名学生批量扣分（${dormBuilding.trim()} ${dormRoom.trim()}）`,
      data: {
        affectedCount: students.length,
        points,
        violationDate
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * 重置分数至100：撤销当前学期全部有效记录（保留历史，可追溯）
 */
app.post('/api/reset-scores', requireAdmin, async (req, res, next) => {
  let connection;

  try {
    const semester = await getActiveSemester();

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先设置有效学期'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [vResult] = await connection.execute(
      `UPDATE violation_records
       SET status = 'void'
       WHERE semester_id = ? AND status = 'valid'`,
      [semester.id]
    );

    const [aResult] = await connection.execute(
      `UPDATE score_adjustments
       SET status = 'void'
       WHERE semester_id = ? AND status = 'valid'`,
      [semester.id]
    );

    await connection.commit();

    logAudit(req, 'reset_scores', `重置当前学期分数：撤销 ${vResult.affectedRows} 条扣分、${aResult.affectedRows} 条调整`, 'semester', semester.id);

    return res.json({
      success: true,
      message: `已重置当前学期分数：撤销 ${vResult.affectedRows} 条扣分记录、${aResult.affectedRows} 条调整记录，全体学生回到初始分`,
      data: {
        revokedViolations: vResult.affectedRows,
        revokedAdjustments: aResult.affectedRows
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

/**
 * 清空当前学期记录：物理删除全部扣分与调整记录（不可恢复）
 */
app.post('/api/clear-records', requireAdmin, async (req, res, next) => {
  let connection;

  try {
    const semester = await getActiveSemester();

    if (!semester) {
      return res.status(400).json({
        success: false,
        message: '请先设置有效学期'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [vResult] = await connection.execute(
      'DELETE FROM violation_records WHERE semester_id = ?',
      [semester.id]
    );

    const [aResult] = await connection.execute(
      'DELETE FROM score_adjustments WHERE semester_id = ?',
      [semester.id]
    );

    await connection.commit();

    logAudit(req, 'clear_records', `清空当前学期记录：删除 ${vResult.affectedRows} 条扣分、${aResult.affectedRows} 条调整（不可恢复）`, 'semester', semester.id);

    return res.json({
      success: true,
      message: `已清空当前学期记录：删除 ${vResult.affectedRows} 条扣分记录、${aResult.affectedRows} 条调整记录`,
      data: {
        deletedViolations: vResult.affectedRows,
        deletedAdjustments: aResult.affectedRows
      }
    });
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => {});
    }

    next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.patch('/api/violations/:id/revoke', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        message: '违规记录 ID 无效'
      });
    }

    const [rows] = await pool.query(
      `SELECT id, status
       FROM violation_records
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: '没有找到这条违规记录'
      });
    }

    if (rows[0].status !== 'valid') {
      return res.status(400).json({
        success: false,
        message: '这条记录已经撤销，无需重复操作'
      });
    }

    const [result] = await pool.query(
      `UPDATE violation_records
       SET status = 'void'
       WHERE id = ? AND status = 'valid'`,
      [id]
    );

    if (result.affectedRows !== 1) {
      return res.status(409).json({
        success: false,
        message: '记录状态已发生变化，请刷新后重试'
      });
    }

    logAudit(req, 'revoke_violation', `撤销违规记录 #${id}`, 'violation', id);

    return res.json({
      success: true,
      message: '违规记录已撤销'
    });
  } catch (error) {
    next(error);
  }
});

/* ==================== 一键全库导出（管理员） ==================== */

app.get('/api/export', requireAdmin, async (req, res, next) => {
  try {
    const [
      users, classes, students, semesters,
      deductionRules, bonusRules, violationRecords,
      scoreAdjustments, auditLogs
    ] = await Promise.all([
      pool.query('SELECT id, username, real_name, role, status, created_at FROM users ORDER BY id'),
      pool.query('SELECT * FROM classes ORDER BY id'),
      pool.query('SELECT * FROM students ORDER BY id'),
      pool.query('SELECT * FROM semesters ORDER BY id'),
      pool.query('SELECT * FROM deduction_rules ORDER BY id'),
      pool.query('SELECT * FROM bonus_rules ORDER BY id'),
      pool.query('SELECT * FROM violation_records ORDER BY id'),
      pool.query('SELECT * FROM score_adjustments ORDER BY id'),
      pool.query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 5000')
    ]);

    const data = {
      exportTime: new Date().toISOString(),
      tables: {
        users: users[0],
        classes: classes[0],
        students: students[0],
        semesters: semesters[0],
        deduction_rules: deductionRules[0],
        bonus_rules: bonusRules[0],
        violation_records: violationRecords[0],
        score_adjustments: scoreAdjustments[0],
        audit_logs: auditLogs[0]
      }
    };

    logAudit(req, 'export_database', '导出全库数据', '', '');

    const filename = `student-moral-export-${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(data);
  } catch (error) {
    next(error);
  }
});




/**
 * 导入学生名单
 * Excel 表头：
 * 学号、姓名、年级、班级、宿舍楼栋、宿舍号
 */
app.post(
  '/api/students/import',
  requireAdmin,
  upload.single('file'),
  async (req, res, next) => {
    let connection;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: '请先选择 Excel 文件'
        });
      }

     
const workbook = XLSX.read(req.file.buffer, {
  type: 'buffer',
  cellDates: false
})

const sheetName = workbook.SheetNames[0]

if (!sheetName) {
  return res.status(400).json({
    success: false,
    message: 'Excel 文件中没有工作表'
  })
}

const sheet = workbook.Sheets[sheetName]

// 先按二维数组读取，不假设第一行就是表头
const matrix = XLSX.utils.sheet_to_json(sheet, {
  header: 1,
  defval: '',
  raw: false,
  blankrows: false
})

if (!matrix.length) {
  return res.status(400).json({
    success: false,
    message: 'Excel 文件没有学生数据'
  })
}

// 为常见字段准备别名
const headerAliases = {
  studentNo: ['学号', '学生学号', '学籍号', 'student_no'],
  studentName: ['姓名', '学生姓名', '学生名字', 'student_name'],
  gradeName: ['年级', '年级名称', '入学年级', 'grade_name'],
  className: ['班级', '班级名称', '行政班', '班级编号', '班级号', 'class_name'],
  dormBuilding: [
    '宿舍楼栋', '宿舍楼', '宿舍楼楼栋',
    '宿舍楼号', '楼栋', '公寓楼', 'dorm_building'
  ],
  dormRoom: [
    '宿舍号', '宿舍房间号', '房间号',
    '寝室号', '寝室', 'dorm_room'
  ]
}

const normalizedAliases = Object.fromEntries(
  Object.entries(headerAliases).map(([key, names]) => [
    key,
    names.map(normalizeHeader)
  ])
)

// 自动寻找真正的表头行
// 即使第一行是统计表标题，也可以继续向下查找
const headerIndex = matrix.findIndex(row => {
  const headers = row.map(normalizeHeader)

  return (
    headers.some(h => normalizedAliases.studentNo.includes(h)) &&
    headers.some(h => normalizedAliases.studentName.includes(h)) &&
    headers.some(h => normalizedAliases.gradeName.includes(h)) &&
    headers.some(h => normalizedAliases.className.includes(h))
  )
})

if (headerIndex === -1) {
  return res.status(400).json({
    success: false,
    message: '没有找到有效表头，请确认表格包含：年级、姓名、学号、班级'
  })
}

// 将真正表头之后的每一行转换成对象
const headers = matrix[headerIndex].map(value => String(value ?? '').trim())

const rows = matrix
  .slice(headerIndex + 1)
  .map((values, index) => {
    const row = {}

    headers.forEach((header, columnIndex) => {
      if (header) {
        row[header] = values[columnIndex] ?? ''
      }
    })

    // 记录原始 Excel 行号，便于报错定位
    row.__excelRow = headerIndex + index + 2

    return row
  })
  // 忽略完全空白的行
  .filter(row =>
    headers.some(header => header && String(row[header] ?? '').trim() !== '')
  )

if (!rows.length) {
  return res.status(400).json({
    success: false,
    message: '已找到表头，但表头后面没有学生数据'
  })
}


      
function readColumn(row, names) {
  const acceptedNames = names.map(normalizeHeader)

  const key = Object.keys(row).find(item =>
    acceptedNames.includes(normalizeHeader(item))
  )

  return key === undefined
    ? ''
    : String(row[key] ?? '').trim()
}

// 年级规范化：提取年份 -> 「2025级」，兼容 2025、2025级、25级 等
// （函数定义已提升到模块级，供导入与单个增改共用）

// 班级规范化：提取班号 -> 「软件工程4班」，兼容 4班、4、软工4班、软件工程4班


      const seenStudentNos = new Set();
      const validRows = [];
      const errors = [];

      rows.forEach((row, index) => {
        const excelRow = row.__excelRow || index + 2

        
const studentNo = readColumn(row, [
  '学号', '学生学号', '学籍号', 'student_no'
])

const studentName = readColumn(row, [
  '姓名', '学生姓名', '学生名字', 'student_name'
])

const gradeName = normalizeGradeName(readColumn(row, [
  '年级', '年级名称', '入学年级', 'grade_name'
]))

const className = normalizeClassName(readColumn(row, [
  '班级', '班级名称', '行政班', '班级编号', '班级号', 'class_name'
]))

const dormBuilding = readColumn(row, [
  '宿舍楼栋', '宿舍楼', '宿舍楼楼栋',
  '宿舍楼号', '楼栋', '公寓楼', 'dorm_building'
])

const dormRoom = readColumn(row, [
  '宿舍号', '宿舍房间号', '房间号',
  '寝室号', '寝室', 'dorm_room'
])


        if (
          !studentNo ||
          !studentName ||
          !gradeName ||
          !className ||
          !dormBuilding ||
          !dormRoom
        ) {
          errors.push({
            row: excelRow,
            studentNo,
            message: '学号、姓名、年级、班级、宿舍楼栋和宿舍号均不能为空'
          });
          return;
        }

        if (
          studentNo.length > 30 ||
          studentName.length > 50 ||
          gradeName.length > 50 ||
          className.length > 50 ||
          dormBuilding.length > 50 ||
          dormRoom.length > 50
        ) {
          errors.push({
            row: excelRow,
            studentNo,
            message: '字段长度超出限制'
          });
          return;
        }

        if (seenStudentNos.has(studentNo)) {
          errors.push({
            row: excelRow,
            studentNo,
            message: 'Excel 文件中存在重复学号'
          });
          return;
        }

        seenStudentNos.add(studentNo);

        validRows.push({
          studentNo,
          studentName,
          gradeName,
          className,
          dormBuilding,
          dormRoom
        });
      });

      if (!validRows.length) {
        return res.status(400).json({
          success: false,
          message: '没有可以导入的有效学生数据',
          errors
        });
      }

      connection = await pool.getConnection();
      await connection.beginTransaction();

      let imported = 0;
      let skipped = 0;

      for (const student of validRows) {
        // 已存在的学号不重复新增
        const [existing] = await connection.execute(
          'SELECT id FROM students WHERE student_no = ?',
          [student.studentNo]
        );

        if (existing.length > 0) {
          skipped++;
          continue;
        }

        // 查找班级；不存在时自动创建
        const [classRows] = await connection.execute(
          `SELECT id FROM classes
           WHERE grade_name = ? AND class_name = ?
           LIMIT 1`,
          [student.gradeName, student.className]
        );

        let classId;

        if (classRows.length > 0) {
          classId = classRows[0].id;
        } else {
          const [classResult] = await connection.execute(
            `INSERT INTO classes (grade_name, class_name)
             VALUES (?, ?)`,
            [student.gradeName, student.className]
          );

          classId = classResult.insertId;
        }

        // 新学生默认初始分为 100 分
        await connection.execute(
          `INSERT INTO students
           (
             student_no,
             student_name,
             class_id,
             initial_score,
             dorm_building,
             dorm_room
           )
           VALUES (?, ?, ?, 100.00, ?, ?)`,
          [
            student.studentNo,
            student.studentName,
            classId,
            student.dormBuilding,
            student.dormRoom
          ]
        );

        imported++;
      }

      await connection.commit();

      logAudit(req, 'import_students', `导入学生名单：新增 ${imported} 人，跳过 ${skipped} 人，错误 ${errors.length} 条`, 'students', '');

      return res.json({
        success: true,
        message: '学生名单导入处理完成',
        data: {
          totalRows: rows.length,
          imported,
          skipped,
          errorCount: errors.length,
          errors
        }
      });
    } catch (error) {
      if (connection) {
        await connection.rollback().catch(() => {});
      }

      next(error);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

/**
 * 批量导入扣分记录
 * Excel 表头：学号、姓名（可选）、违规类型、违规日期、备注（可选）
 * 扣分值由数据库中的规则决定，Excel 中不填分数
 */
app.post(
  '/api/violations/import',
  requireAdmin,
  upload.single('file'),
  async (req, res, next) => {
    let connection;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: '请先选择 Excel 文件'
        });
      }

      const workbook = XLSX.read(req.file.buffer, {
        type: 'buffer',
        cellDates: false
      });

      const sheetName = workbook.SheetNames[0];

      if (!sheetName) {
        return res.status(400).json({
          success: false,
          message: 'Excel 文件中没有工作表'
        });
      }

      const sheet = workbook.Sheets[sheetName];

      const matrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: '',
        raw: false,
        blankrows: false
      });

      // 原始值矩阵：日期单元格为 Excel 序列号，用于格式化文本解析失败时兜底
      const rawMatrix = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: '',
        raw: true,
        blankrows: false
      });

      if (!matrix.length) {
        return res.status(400).json({
          success: false,
          message: 'Excel 文件没有扣分数据'
        });
      }

      function readColumn(row, names) {
        const acceptedNames = names.map(normalizeHeader)

        const key = Object.keys(row).find(item =>
          acceptedNames.includes(normalizeHeader(item))
        )

        return key === undefined
          ? ''
          : String(row[key] ?? '').trim()
      }

      // 解析 Excel 中的日期：兼容 2026/3/5、2026-03-05、2026.3.5、Excel 日期序列号
      function parseExcelDate(value) {
        if (value === null || value === undefined || value === '') {
          return null
        }

        if (value instanceof Date) {
          if (Number.isNaN(value.getTime())) {
            return null
          }

          return [
            value.getFullYear(),
            String(value.getMonth() + 1).padStart(2, '0'),
            String(value.getDate()).padStart(2, '0')
          ].join('-')
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
          // Excel 日期序列号（1900 日期系统），大致覆盖 1954~2119 年
          if (value < 20000 || value > 80000) {
            return null
          }

          const date = new Date(Math.round((value - 25569) * 86400 * 1000))

          return date.toISOString().slice(0, 10)
        }

        const match = String(value).trim().match(
          /^(\d{4})[年./\-](\d{1,2})[月./\-](\d{1,2})日?$/
        )

        if (!match) {
          return null
        }

        const [, year, month, day] = match
        const dateText = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
        const parsed = new Date(`${dateText}T00:00:00`)

        return Number.isNaN(parsed.getTime()) ? null : dateText
      }

      const headerAliases = {
        studentNo: ['学号', '学生学号', '学籍号', 'student_no'],
        studentName: ['姓名', '学生姓名', 'student_name'],
        ruleName: [
          '违规类型', '扣分类型', '扣分规则', '违规名称',
          '规则名称', '违规项目', 'rule_name', 'violation_name'
        ],
        violationDate: [
          '违规日期', '扣分日期', '日期', '时间', 'violation_date'
        ],
        description: ['备注', '说明', '描述', '备注说明', 'description']
      }

      const normalizedAliases = Object.fromEntries(
        Object.entries(headerAliases).map(([key, names]) => [
          key,
          names.map(normalizeHeader)
        ])
      )

      // 自动寻找表头行：必须同时包含 学号、违规类型、违规日期
      const headerIndex = matrix.findIndex(row => {
        const headers = row.map(normalizeHeader)

        return (
          headers.some(h => normalizedAliases.studentNo.includes(h)) &&
          headers.some(h => normalizedAliases.ruleName.includes(h)) &&
          headers.some(h => normalizedAliases.violationDate.includes(h))
        )
      })

      if (headerIndex === -1) {
        return res.status(400).json({
          success: false,
          message: '没有找到有效表头，请确认表格包含：学号、违规类型、违规日期'
        })
      }

      const headers = matrix[headerIndex].map(value => String(value ?? '').trim())

      const rows = matrix
        .slice(headerIndex + 1)
        .map((values, index) => {
          const row = {}

          headers.forEach((header, columnIndex) => {
            if (header) {
              row[header] = values[columnIndex] ?? ''
            }
          })

          // 记录原始 Excel 行号和矩阵下标，便于报错定位与原始值兜底
          row.__excelRow = headerIndex + index + 2
          row.__matrixIndex = index + headerIndex + 1

          return row
        })
        .filter(row =>
          headers.some(header => header && String(row[header] ?? '').trim() !== '')
        )

      if (!rows.length) {
        return res.status(400).json({
          success: false,
          message: '已找到表头，但表头后面没有扣分数据'
        })
      }

      const validRows = [];
      const errors = [];

      rows.forEach(row => {
        const excelRow = row.__excelRow
        const rawRow = rawMatrix[row.__matrixIndex] || []

        const studentNo = readColumn(row, headerAliases.studentNo)
        const studentName = readColumn(row, headerAliases.studentName)
        const ruleName = readColumn(row, headerAliases.ruleName)
        const description = readColumn(row, headerAliases.description)

        // 先按格式化文本解析日期，失败时用原始值（Excel 序列号）兜底
        const violationDate =
          parseExcelDate(readColumn(row, headerAliases.violationDate)) ||
          parseExcelDate(rawRow[headers.findIndex(header =>
            normalizedAliases.violationDate.includes(normalizeHeader(header))
          )])

        if (!studentNo || !ruleName || !violationDate) {
          errors.push({
            row: excelRow,
            studentNo,
            message: '学号、违规类型和违规日期均不能为空，日期格式需为 2026-03-05 或 2026/3/5'
          });
          return;
        }

        if (
          studentNo.length > 30 ||
          studentName.length > 50 ||
          ruleName.length > 100 ||
          description.length > 500
        ) {
          errors.push({
            row: excelRow,
            studentNo,
            message: '字段长度超出限制'
          });
          return;
        }

        validRows.push({
          excelRow,
          studentNo,
          studentName,
          ruleName,
          violationDate,
          description
        });
      });

      if (!validRows.length) {
        return res.status(400).json({
          success: false,
          message: '没有可以导入的有效扣分数据',
          errors
        });
      }

      const semester = await getActiveSemester();

      if (!semester) {
        return res.status(400).json({
          success: false,
          message: '请先设置有效学期'
        });
      }

      const semesterStart = String(semester.start_date).slice(0, 10);
      const semesterEnd = String(semester.end_date).slice(0, 10);

      connection = await pool.getConnection();
      await connection.beginTransaction();

      let imported = 0;
      let skipped = 0;

      for (const item of validRows) {
        // 查找学生
        const [students] = await connection.execute(
          `SELECT id, student_name FROM students WHERE student_no = ? LIMIT 1`,
          [item.studentNo]
        );

        if (students.length === 0) {
          await connection.rollback();

          return res.status(400).json({
            success: false,
            message: `第 ${item.excelRow} 行导入失败：学号 ${item.studentNo} 不存在`,
            data: { imported, skipped, errorCount: errors.length + 1, errors }
          });
        }

        // 填了姓名时，与学号对应的学生姓名比对
        if (item.studentName && item.studentName !== students[0].student_name) {
          await connection.rollback();

          return res.status(400).json({
            success: false,
            message: `第 ${item.excelRow} 行导入失败：学号 ${item.studentNo} 对应的学生是「${students[0].student_name}」，与表格中的「${item.studentName}」不一致`,
            data: { imported, skipped, errorCount: errors.length + 1, errors }
          });
        }

        // 查找扣分规则（按名称精确匹配）
        const [rules] = await connection.execute(
          `SELECT id, rule_name, points
           FROM deduction_rules
           WHERE rule_name = ? AND is_active = TRUE
           LIMIT 1`,
          [item.ruleName]
        );

        if (rules.length === 0) {
          await connection.rollback();

          return res.status(400).json({
            success: false,
            message: `第 ${item.excelRow} 行导入失败：违规类型「${item.ruleName}」不存在或已停用，请与系统中的扣分规则名称保持一致`,
            data: { imported, skipped, errorCount: errors.length + 1, errors }
          });
        }

        // 校验日期在当前学期范围内
        if (item.violationDate < semesterStart || item.violationDate > semesterEnd) {
          await connection.rollback();

          return res.status(400).json({
            success: false,
            message: `第 ${item.excelRow} 行导入失败：违规日期 ${item.violationDate} 不在当前学期范围内（${semesterStart} ~ ${semesterEnd}）`,
            data: { imported, skipped, errorCount: errors.length + 1, errors }
          });
        }

        // 同一学生、同一规则、同一日期的有效记录已存在时跳过，防止重复导入
        const [duplicates] = await connection.execute(
          `SELECT id FROM violation_records
           WHERE student_id = ? AND rule_id = ? AND violation_date = ? AND status = 'valid'
           LIMIT 1`,
          [students[0].id, rules[0].id, item.violationDate]
        );

        if (duplicates.length > 0) {
          skipped++;
          continue;
        }

        await connection.execute(
          `INSERT INTO violation_records
           (student_id, semester_id, rule_id, violation_name,
            points, violation_date, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            students[0].id,
            semester.id,
            rules[0].id,
            rules[0].rule_name,
            rules[0].points,
            item.violationDate,
            item.description
          ]
        );

        imported++;
      }

      await connection.commit();

      const details = [
        `成功导入 ${imported} 条扣分记录`,
        `跳过重复记录 ${skipped} 条`,
        `数据错误 ${errors.length} 条`
      ];

      logAudit(req, 'import_violations', `导入扣分记录：成功 ${imported} 条，跳过 ${skipped} 条，错误 ${errors.length} 条`, 'violations', '');

      return res.json({
        success: true,
        message: `扣分记录导入处理完成：${details.join('，')}`,
        data: {
          totalRows: rows.length,
          imported,
          skipped,
          errorCount: errors.length,
          errors
        }
      });
    } catch (error) {
      if (connection) {
        await connection.rollback().catch(() => {});
      }

      next(error);
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }
);

// 统一错误处理
app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    success: false,
    message: '服务器处理失败，请检查后端终端日志'
  });
});

async function startServer() {
  try {
    await testConnection();
    await ensureUsersTable();
    await ensureAuditTable();
    await ensureBonusRulesTable();

    const port = Number(process.env.PORT || 3000);

    app.listen(port, () => {
      console.log(`后端服务已启动：http://localhost:${port}`);
    });
  } catch (error) {
    console.error('启动失败：', error.message);
    process.exit(1);
  }
}

startServer();
