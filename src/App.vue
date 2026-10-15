
<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import axios from 'axios'
import * as XLSX from 'xlsx'
import SearchSelect from './components/SearchSelect.vue'

const API_BASE = '/api'

/* ==================== 登录状态 ==================== */

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('sms_user') || 'null')
  } catch {
    return null
  }
}

const token = ref(localStorage.getItem('sms_token') || '')
const currentUser = ref(readStoredUser())

const isAdmin = computed(() => currentUser.value?.role === 'admin')

const loading = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const importing = ref(false)
const importFileInput = ref(null)
// 正在撤销的记录唯一键（类型-id），用于按钮 loading 状态
const cancelingKey = ref(null)
const activeTab = ref('overview')
const searchText = ref('')
const selectedGrade = ref('all')
const selectedClass = ref('all')
const recordTypeFilter = ref('all')

const students = ref([])
const rules = ref([])
const scores = ref([])
const violations = ref([])
const adjustments = ref([])
const semesters = ref([])
const activeSemester = ref(null)

// 学期切换：空字符串表示使用当前 active 学期
const currentSemesterId = ref('')

// 分页
const studentPage = ref(1)
const studentPageSize = 20
const studentTotal = ref(0)
const recordPage = ref(1)
const recordPageSize = 20
const recordTotal = ref(0)

// 修改密码弹窗
const showPwdModal = ref(false)
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })

// 新建学期弹窗
const showSemesterModal = ref(false)
const semesterForm = reactive({
  semesterName: '',
  startDate: '',
  endDate: '',
  activate: true,
})

// 审计日志
const auditLogs = ref([])
const auditTotal = ref(0)
const auditPage = ref(1)
const auditPageSize = 20
const auditActionFilter = ref('')
const auditUserFilter = ref('')
const auditLoading = ref(false)

const importingViolations = ref(false)
const violationImportInput = ref(null)

function getToday() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const form = reactive({
  studentId: '',
  ruleId: '',
  violationDate: getToday(),
  description: '',
  // 「其他」规则的自定义扣分
  customPoints: '',
  customName: '',
  // 「宿舍卫生批量扣分」规则
  dormBuilding: '',
  dormRoom: '',
  dormPoints: '',
})


const adjustmentSubmitting = ref(false)

const adjustmentForm = reactive({
  studentId: '',
  pointsChange: '',
  reason: '',
  bonusRuleId: '',
})

// 加分规则
const bonusRules = ref([])
const bonusRuleForm = reactive({ ruleName: '', points: '', description: '' })
const bonusRuleSubmitting = ref(false)

// 学生自助查询（免登录）
const showSelfQuery = ref(false)
const selfQueryNo = ref('')
const selfQueryResult = ref(null)
const selfQueryLoading = ref(false)
const selfQueryError = ref('')


const selectedRule = computed(() =>
  rules.value.find(item => Number(item.id) === Number(form.ruleId))
)

const isCustomRule = computed(
  () => selectedRule.value?.rule_name === '其他'
)

const isDormRule = computed(
  () => selectedRule.value?.rule_name === '宿舍卫生批量扣分'
)

// 规则下拉展示文案：普通规则显示分值，特殊规则显示说明
function ruleLabel(rule) {
  const points = Number(rule.points)

  if (rule.rule_name === '其他') return '其他 (自定义扣分)'
  if (rule.rule_name === '宿舍卫生批量扣分') return '宿舍卫生批量扣分 (按宿舍)'
  return `${rule.rule_name} (-${points.toFixed(points % 1 ? 2 : 0)}分/次)`
}

// 学生搜索下拉选项
const studentOptions = computed(() =>
  students.value.map(item => ({
    value: String(item.id),
    label: `${item.student_name}（${item.student_no}）`,
  }))
)

// 宿舍选项（来自学生数据去重）
const dormBuildings = computed(() =>
  [...new Set(
    students.value
      .map(item => item.dorm_building)
      .filter(Boolean)
  )].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))
)

const dormRooms = computed(() =>
  [...new Set(
    students.value
      .filter(item =>
        form.dormBuilding &&
        item.dorm_building === form.dormBuilding &&
        item.dorm_room
      )
      .map(item => item.dorm_room)
  )].sort((a, b) =>
    String(a).localeCompare(String(b), 'zh-CN', { numeric: true })
  )
)

const filteredScores = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()

  return scores.value.filter(item => {
    const matchesGrade =
      selectedGrade.value === 'all' ||
      String(item.grade_name) === selectedGrade.value

    const matchesClass =
      selectedClass.value === 'all' ||
      String(item.class_name) === selectedClass.value

    const matchesKeyword =
      !keyword ||
      String(item.student_name || '').toLowerCase().includes(keyword) ||
      String(item.student_no || '').toLowerCase().includes(keyword) ||
      String(item.class_name || '').toLowerCase().includes(keyword)

    return matchesGrade && matchesClass && matchesKeyword
  })
})

const rankedScores = computed(() =>
  [...filteredScores.value].sort(
    (a, b) =>
      Number(b.current_score) - Number(a.current_score) ||
      String(a.student_no).localeCompare(String(b.student_no))
  )
)

const gradeNames = computed(() =>
  [...new Set(scores.value.map(item => item.grade_name).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), 'zh-CN', { numeric: true }))
)

const classNames = computed(() =>
  [...new Set(
    scores.value
      .filter(item =>
        selectedGrade.value === 'all' ||
        String(item.grade_name) === selectedGrade.value
      )
      .map(item => item.class_name)
      .filter(Boolean)
  )].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN', { numeric: true }))
)

// 班级板块：年级 -> 班级 -> 学生（按品行分排名）
const gradeGroups = computed(() => {
  const groups = []
  const gradeMap = new Map()

  rankedScores.value.forEach(student => {
    const grade = String(student.grade_name || '未分组')
    const cls = String(student.class_name || '未分班')

    if (!gradeMap.has(grade)) {
      const group = { grade, classMap: new Map(), classes: [] }
      gradeMap.set(grade, group)
      groups.push(group)
    }

    const group = gradeMap.get(grade)

    if (!group.classMap.has(cls)) {
      const card = { name: cls, students: [] }
      group.classMap.set(cls, card)
      group.classes.push(card)
    }

    group.classMap.get(cls).students.push(student)
  })

  return groups
})

// 导出菜单：年级 -> 班级
const classMenus = computed(() =>
  gradeNames.value.map(grade => ({
    grade,
    classes: [...new Set(
      scores.value
        .filter(item => String(item.grade_name) === String(grade))
        .map(item => item.class_name)
        .filter(Boolean)
    )].sort((a, b) =>
      String(a).localeCompare(String(b), 'zh-CN', { numeric: true })
    ),
  }))
)

const totalStudents = computed(() => students.value.length)

const totalDeductions = computed(() =>
  violations.value.filter(item => item.status === 'valid').length
)

const averageScore = computed(() => {
  if (!scores.value.length) return '—'

  const total = scores.value.reduce(
    (sum, item) => sum + Number(item.current_score || 0),
    0
  )

  return (total / scores.value.length).toFixed(2)
})

const deductionTotal = computed(() =>
  scores.value.reduce(
    (sum, item) => sum + Number(item.total_deduction || 0),
    0
  ).toFixed(2)
)

// 合并违规扣分与分数调整两类记录，统一进入扣分明细
const allRecords = computed(() => {
  const violationRows = violations.value.map(item => ({
    type: 'violation',
    id: item.id,
    student_no: item.student_no,
    student_name: item.student_name,
    grade_name: item.grade_name,
    class_name: item.class_name,
    title: item.violation_name,
    points: -Number(item.points),
    date: String(item.violation_date).slice(0, 10),
    description: item.description || '',
    status: item.status,
  }))

  const adjustmentRows = adjustments.value.map(item => ({
    type: 'adjustment',
    id: item.id,
    student_no: item.student_no,
    student_name: item.student_name,
    grade_name: item.grade_name,
    class_name: item.class_name,
    title: item.reason,
    points: Number(item.points_change),
    date: String(item.created_at).slice(0, 10),
    description: '',
    status: item.status,
  }))

  return [...violationRows, ...adjustmentRows].sort(
    (a, b) => String(b.date).localeCompare(String(a.date))
  )
})

const filteredRecords = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()

  return allRecords.value.filter(item => {
    const matchesType =
      recordTypeFilter.value === 'all' ||
      item.type === recordTypeFilter.value

    const matchesGrade =
      selectedGrade.value === 'all' ||
      String(item.grade_name) === selectedGrade.value

    const matchesClass =
      selectedClass.value === 'all' ||
      String(item.class_name) === selectedClass.value

    const matchesKeyword =
      !keyword ||
      String(item.student_name || '').toLowerCase().includes(keyword) ||
      String(item.student_no || '').toLowerCase().includes(keyword) ||
      String(item.title || '').toLowerCase().includes(keyword)

    return matchesType && matchesGrade && matchesClass && matchesKeyword
  })
})

// 扣分明细前端分页
const paginatedRecords = computed(() => {
  const start = (recordPage.value - 1) * recordPageSize
  return filteredRecords.value.slice(start, start + recordPageSize)
})

// 学生列表前端分页（基于 studentList 的过滤结果）
const paginatedStudentList = computed(() => {
  const start = (studentPage.value - 1) * studentPageSize
  return studentList.value.slice(start, start + studentPageSize)
})

// 过滤条件变化时回到第一页
watch([searchText, recordTypeFilter, selectedGrade, selectedClass], () => {
  recordPage.value = 1
})
watch([searchText, selectedGrade, selectedClass], () => {
  studentPage.value = 1
})

async function requestData(url) {
  const response = await axios.get(`${API_BASE}${url}`)
  return response.data
}

// 构造带学期参数的 URL
function withSemester(url) {
  if (!currentSemesterId.value) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}semester_id=${currentSemesterId.value}`
}

async function loadData() {
  loading.value = true
  errorMessage.value = ''

  try {
    const results = await Promise.all([
      requestData('/students'),
      requestData('/rules'),
      requestData(withSemester('/scores')),
      requestData(withSemester('/violations')),
      requestData('/semesters'),
      requestData(withSemester('/adjustments')),
      requestData('/bonus-rules'),
    ])

    students.value = results[0].data || []
    rules.value = results[1].data || []
    scores.value = results[2].data || []
    violations.value = results[3].data || []
    semesters.value = results[4].data || []
    activeSemester.value = results[2].semester || null
    adjustments.value = results[5].data || []
    bonusRules.value = results[6].data || []

    if (!form.ruleId && rules.value.length) {
      form.ruleId = String(rules.value[0].id)
    }

    if (
      form.studentId &&
      !students.value.some(
        student => Number(student.id) === Number(form.studentId)
      )
    ) {
      form.studentId = ''
    }

    if (form.studentId === '' && students.value.length) {
      form.studentId = String(students.value[0].id)
    }
    
if (
  adjustmentForm.studentId &&
  !students.value.some(
    student => Number(student.id) === Number(adjustmentForm.studentId)
  )
) {
  adjustmentForm.studentId = ''
}

if (adjustmentForm.studentId === '' && students.value.length) {
  adjustmentForm.studentId = String(students.value[0].id)
}

  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '无法读取数据，请确认 Node.js 后端和 MySQL 正常运行。'
  } finally {
    loading.value = false
  }
}

async function addViolation() {
  errorMessage.value = ''
  successMessage.value = ''

  if (!form.ruleId || !form.violationDate) {
    errorMessage.value = '请先选择扣分类型和违规日期。'
    return
  }

  if (!selectedRule.value) {
    errorMessage.value = '当前扣分规则不存在，请刷新页面。'
    return
  }

  // 宿舍卫生批量扣分：不需要选择学生，改为选择宿舍
  if (isDormRule.value) {
    if (!form.dormBuilding || !form.dormRoom) {
      errorMessage.value = '请选择宿舍楼栋和宿舍号。'
      return
    }

    const points = Number(form.dormPoints)

    if (
      !form.dormPoints ||
      !Number.isFinite(points) ||
      points <= 0 ||
      points > 100 ||
      !/^\d+(\.\d{1,2})?$/.test(String(form.dormPoints).trim())
    ) {
      errorMessage.value = '请输入大于0且不超过100的扣分分值，最多两位小数。'
      return
    }
  } else {
    if (!form.studentId) {
      errorMessage.value = '请先选择学生。'
      return
    }

    if (isCustomRule.value) {
      const points = Number(form.customPoints)

      if (
        !form.customPoints ||
        !Number.isFinite(points) ||
        points <= 0 ||
        points > 100 ||
        !/^\d+(\.\d{1,2})?$/.test(String(form.customPoints).trim())
      ) {
        errorMessage.value = '自定义扣分分值必须为大于0且不超过100的数字，最多两位小数。'
        return
      }
    }
  }

  if (
    activeSemester.value &&
    (
      form.violationDate < String(activeSemester.value.start_date).slice(0, 10) ||
      form.violationDate > String(activeSemester.value.end_date).slice(0, 10)
    )
  ) {
    errorMessage.value = '违规日期不在当前学期范围内，请检查日期。'
    return
  }

  submitting.value = true

  try {
    let response

    if (isDormRule.value) {
      response = await axios.post(`${API_BASE}/violations/dorm-batch`, {
        dormBuilding: form.dormBuilding,
        dormRoom: form.dormRoom,
        points: Number(form.dormPoints),
        violationDate: form.violationDate,
        description: form.description.trim(),
      })
    } else {
      response = await axios.post(`${API_BASE}/violations`, {
        studentId: Number(form.studentId),
        ruleId: Number(form.ruleId),
        violationDate: form.violationDate,
        description: form.description.trim(),
        customPoints: isCustomRule.value ? Number(form.customPoints) : null,
        customName: isCustomRule.value ? form.customName.trim() : '',
      })
    }

    successMessage.value = response.data.message || '扣分记录添加成功。'

    if (isCustomRule.value) {
      form.customPoints = ''
      form.customName = ''
    }

    if (isDormRule.value) {
      form.dormPoints = ''
    }

    form.description = ''

    await loadData()
    activeTab.value = 'records'
  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '添加失败，请检查后端终端中的错误信息。'
  } finally {
    submitting.value = false
  }
}


// 撤销记录：违规扣分与分数调整共用，撤销后不再参与品行分计算
async function revokeRecord(record) {
  errorMessage.value = ''
  successMessage.value = ''

  if (!record || record.status !== 'valid') {
    errorMessage.value = '这条记录已经撤销，不能重复操作。'
    return
  }

  const isViolation = record.type === 'violation'
  const points = Number(record.points)
  const pointsText = isViolation
    ? `扣分：${points.toFixed(2)} 分`
    : `分值变化：${points > 0 ? '+' : ''}${points.toFixed(2)} 分`

  const confirmed = window.confirm(
    `确定撤销这条${isViolation ? '违规扣分' : '分数调整'}记录吗？\n\n学生：${record.student_name}\n${isViolation ? '违规类型' : '调整原因'}：${record.title}\n${pointsText}\n\n撤销后，这条记录将不再参与品行分计算。`
  )

  if (!confirmed) return

  cancelingKey.value = `${record.type}-${record.id}`

  try {
    const url = isViolation
      ? `${API_BASE}/violations/${record.id}/revoke`
      : `${API_BASE}/adjustments/${record.id}/revoke`

    const response = await axios.patch(url)

    successMessage.value =
      response.data.message || '记录已撤销。'

    await loadData()
  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '撤销失败，请检查后端接口和终端报错。'
  } finally {
    cancelingKey.value = null
  }
}


function resetForm() {
  form.studentId = students.value.length
    ? String(students.value[0].id)
    : ''
  form.ruleId = rules.value.length
    ? String(rules.value[0].id)
    : ''
  form.violationDate = getToday()
  form.description = ''
  form.customPoints = ''
  form.customName = ''
  form.dormBuilding = ''
  form.dormRoom = ''
  form.dormPoints = ''
  errorMessage.value = ''
  successMessage.value = ''
}


function scopeScores(grade, className) {
  return scores.value.filter(item =>
    (!grade || String(item.grade_name) === String(grade)) &&
    (!className || String(item.class_name) === String(className))
  )
}

function scopeViolations(grade, className) {
  return violations.value.filter(item =>
    (!grade || String(item.grade_name) === String(grade)) &&
    (!className || String(item.class_name) === String(className))
  )
}

function buildScoreRows(list) {
  return [...list]
    .sort(
      (a, b) =>
        Number(b.current_score) - Number(a.current_score) ||
        String(a.student_no).localeCompare(String(b.student_no))
    )
    .map((item, index) => ({
      排名: index + 1,
      学号: item.student_no,
      姓名: item.student_name,
      年级: item.grade_name,
      班级: item.class_name,
      宿舍楼栋: item.dorm_building || '',
      宿舍号: item.dorm_room || '',
      初始分: Number(item.initial_score),
      累计扣分: Number(item.total_deduction || 0),
      分数调整: Number(item.total_adjustment || 0),
      当前品行分: Number(item.current_score),
      有效违规次数: Number(item.violation_count || 0),
      学期: activeSemester.value?.semester_name || '',
    }))
}

function buildViolationRows(list) {
  return [...list]
    .sort((a, b) =>
      String(b.violation_date).localeCompare(String(a.violation_date))
    )
    .map(item => ({
      日期: String(item.violation_date).slice(0, 10),
      学号: item.student_no,
      姓名: item.student_name,
      年级: item.grade_name,
      班级: item.class_name,
      违规类型: item.violation_name,
      扣分: Number(item.points),
      备注: item.description || '',
      状态: item.status === 'valid' ? '有效' : '已撤销',
    }))
}

// 导出指定范围数据：一个文件包含「品行分排名」与「扣分明细」两个工作表
function exportData(grade = '', className = '') {
  const scoreList = scopeScores(grade, className)
  const violationList = scopeViolations(grade, className)

  if (!scoreList.length && !violationList.length) {
    errorMessage.value = '所选范围内没有可导出的数据。'
    return
  }

  const scopeText = [grade, className].filter(Boolean).join('-')
  const workbook = XLSX.utils.book_new()

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(buildScoreRows(scoreList)),
    '品行分排名'
  )

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(buildViolationRows(violationList)),
    '扣分明细'
  )

  XLSX.writeFile(workbook, `${scopeText || '全部数据'}-品行分数据.xlsx`)

  successMessage.value = `已导出「${scopeText || '全部数据'}」的品行分排名与扣分明细。`
}


async function resetScores() {
  errorMessage.value = ''
  successMessage.value = ''

  const confirmed = window.confirm(
    '确定重置当前学期全部分数吗？\n\n所有有效扣分与调整记录将被撤销（历史记录保留、可追溯），全体学生品行分回到初始分 100。'
  )

  if (!confirmed) return

  try {
    const response = await axios.post(`${API_BASE}/reset-scores`)

    successMessage.value = response.data.message || '分数已重置。'

    await loadData()
  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '重置失败，请检查后端服务是否启动。'
  }
}


async function clearRecords() {
  errorMessage.value = ''
  successMessage.value = ''

  const confirmed = window.confirm(
    '警告：将物理删除当前学期的全部扣分与调整记录，此操作不可恢复！\n\n确定继续吗？'
  )

  if (!confirmed) return

  const confirmedAgain = window.confirm(
    '再次确认：真的要清空当前学期全部记录吗？删除后无法找回。'
  )

  if (!confirmedAgain) return

  try {
    const response = await axios.post(`${API_BASE}/clear-records`)

    successMessage.value = response.data.message || '记录已清空。'

    await loadData()
  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '清空失败，请检查后端服务是否启动。'
  }
}


function downloadTemplate() {
  const rows = [{
    学号: '请填写唯一学号',
    姓名: '请填写学生姓名',
    年级: '例如：2025级',
    班级: '例如：软件工程1班',
    宿舍楼栋: '例如：3号楼',
    宿舍号: '例如：502'
  }]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(rows),
    '学生名单模板'
  )
  XLSX.writeFile(workbook, '学生名单导入模板.xlsx')
}


function chooseStudentFile() {
  errorMessage.value = ''
  successMessage.value = ''
  importFileInput.value?.click()
}

async function importStudents(event) {
  const file = event.target.files?.[0]

  // 允许再次选择同一个文件
  event.target.value = ''

  if (!file) return

  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    errorMessage.value = '请选择 .xlsx 或 .xls 格式的 Excel 文件。'
    return
  }

  const formData = new FormData()
  formData.append('file', file)

  importing.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    const response = await axios.post(
      `${API_BASE}/students/import`,
      formData
    )

    const result = response.data
    const data = result.data || {}

    const details = [
      `成功导入 ${data.imported ?? 0} 名学生`,
      `跳过已存在学号 ${data.skipped ?? 0} 条`,
      `数据错误 ${data.errorCount ?? 0} 条`
    ]

    successMessage.value = `${result.message || '导入处理完成'}：${details.join('，')}。`

    if (data.errors?.length) {
      errorMessage.value = data.errors
        .map(item => `第 ${item.row} 行：${item.message}`)
        .join('；')
    }

    await loadData()
  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '学生名单导入失败，请检查后端是否启动，以及导入接口是否已添加。'
  } finally {
    importing.value = false
  }
}


function downloadViolationTemplate() {
  const rows = [{
    学号: '请填写学生学号',
    姓名: '可留空，填写后会自动校验是否与学号一致',
    违规类型: '必须与系统扣分规则名称一致，例如：迟到',
    违规日期: '例如：2026-03-05 或 2026/3/5',
    备注: '可选',
  }]

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(rows),
    '扣分记录导入模板'
  )
  XLSX.writeFile(workbook, '扣分记录导入模板.xlsx')
}


function chooseViolationFile() {
  errorMessage.value = ''
  successMessage.value = ''
  violationImportInput.value?.click()
}

async function importViolations(event) {
  const file = event.target.files?.[0]

  // 允许再次选择同一个文件
  event.target.value = ''

  if (!file) return

  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    errorMessage.value = '请选择 .xlsx 或 .xls 格式的 Excel 文件。'
    return
  }

  const formData = new FormData()
  formData.append('file', file)

  importingViolations.value = true
  errorMessage.value = ''
  successMessage.value = ''

  try {
    const response = await axios.post(
      `${API_BASE}/violations/import`,
      formData
    )

    const result = response.data
    const data = result.data || {}

    successMessage.value = result.message || '扣分记录导入处理完成。'

    if (data.errors?.length) {
      errorMessage.value = data.errors
        .map(item => `第 ${item.row} 行：${item.message}`)
        .join('；')
    }

    await loadData()
  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '扣分记录导入失败，请检查后端是否启动。'
  } finally {
    importingViolations.value = false
  }
}


async function submitAdjustment() {
  errorMessage.value = ''
  successMessage.value = ''

  if (!adjustmentForm.studentId) {
    errorMessage.value = '请先选择学生。'
    return
  }

  const rawPoints = String(adjustmentForm.pointsChange).trim()
  const points = Number(rawPoints)

  if (
    !rawPoints ||
    !Number.isFinite(points) ||
    points === 0 ||
    Math.abs(points) > 100 ||
    !/^-?\d+(\.\d{1,2})?$/.test(rawPoints)
  ) {
    errorMessage.value = '请输入不为零、绝对值不超过100且最多两位小数的分数。'
    return
  }

  if (!adjustmentForm.reason.trim()) {
    errorMessage.value = '请填写调整原因。'
    return
  }

  adjustmentSubmitting.value = true

  try {
    const response = await axios.post(`${API_BASE}/adjustments`, {
      studentId: Number(adjustmentForm.studentId),
      pointsChange: points,
      reason: adjustmentForm.reason.trim(),
    })

    successMessage.value =
      response.data.message || '品行分调整成功。'

    adjustmentForm.pointsChange = ''
    adjustmentForm.reason = ''
    adjustmentForm.bonusRuleId = ''

    // 重新读取排名和分数
    await loadData()
    activeTab.value = 'overview'
  } catch (error) {
    console.error(error)
    errorMessage.value =
      error.response?.data?.message ||
      '分数调整失败，请检查后端接口和终端报错。'
  } finally {
    adjustmentSubmitting.value = false
  }
}


/* ==================== 登录 / 退出 ==================== */

// 请求自动携带 token
axios.interceptors.request.use(config => {
  if (token.value) {
    config.headers.Authorization = `Bearer ${token.value}`
  }
  return config
})

// 登录失效（401）时自动回到登录页
axios.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 && currentUser.value) {
      logout(false)
    }
    return Promise.reject(error)
  }
)

const loginForm = reactive({ username: '', password: '' })
const loggingIn = ref(false)
const loginError = ref('')

async function handleLogin() {
  const username = loginForm.username.trim()

  if (!username || !loginForm.password) {
    loginError.value = '请输入用户名和密码。'
    return
  }

  loggingIn.value = true
  loginError.value = ''

  try {
    const response = await axios.post(`${API_BASE}/auth/login`, {
      username,
      password: loginForm.password,
    })

    token.value = response.data.token
    currentUser.value = response.data.user

    localStorage.setItem('sms_token', token.value)
    localStorage.setItem('sms_user', JSON.stringify(currentUser.value))

    loginForm.username = ''
    loginForm.password = ''

    await loadData()
  } catch (error) {
    loginError.value =
      error.response?.data?.message || '登录失败，请检查后端服务是否启动。'
  } finally {
    loggingIn.value = false
  }
}

function logout(clearMessage = true) {
  token.value = ''
  currentUser.value = null
  localStorage.removeItem('sms_token')
  localStorage.removeItem('sms_user')
  loginError.value = clearMessage ? '' : '登录已失效，请重新登录。'
}

function roleText(role) {
  return role === 'admin' ? '管理员' : '辅导员'
}

/* ==================== 学期管理 ==================== */

function switchSemester(id) {
  currentSemesterId.value = id === '' ? '' : String(id)
  studentPage.value = 1
  recordPage.value = 1
  loadData()
}

function openCreateSemester() {
  semesterForm.semesterName = ''
  semesterForm.startDate = getToday()
  semesterForm.endDate = getToday()
  semesterForm.activate = true
  showSemesterModal.value = true
}

async function createSemester() {
  if (!semesterForm.semesterName.trim()) {
    errorMessage.value = '请填写学期名称'
    return
  }
  if (!semesterForm.startDate || !semesterForm.endDate) {
    errorMessage.value = '请选择开始和结束日期'
    return
  }
  if (semesterForm.startDate >= semesterForm.endDate) {
    errorMessage.value = '开始日期必须早于结束日期'
    return
  }

  try {
    const res = await axios.post(`${API_BASE}/semesters`, {
      semesterName: semesterForm.semesterName.trim(),
      startDate: semesterForm.startDate,
      endDate: semesterForm.endDate,
      activate: semesterForm.activate,
    })
    showSemesterModal.value = false
    successMessage.value = res.data.message
    if (semesterForm.activate) {
      currentSemesterId.value = ''
    }
    loadData()
  } catch (error) {
    errorMessage.value = error.response?.data?.message || '创建学期失败'
  }
}

async function activateSemester(id) {
  try {
    await axios.patch(`${API_BASE}/semesters/${id}/activate`)
    currentSemesterId.value = ''
    successMessage.value = '学期已切换'
    loadData()
  } catch (error) {
    errorMessage.value = error.response?.data?.message || '切换学期失败'
  }
}

async function deleteSemester(id, name) {
  if (!confirm(`确定删除学期「${name}」吗？此操作不可恢复。`)) return
  try {
    await axios.delete(`${API_BASE}/semesters/${id}`)
    if (currentSemesterId.value === String(id)) currentSemesterId.value = ''
    successMessage.value = '学期已删除'
    loadData()
  } catch (error) {
    errorMessage.value = error.response?.data?.message || '删除学期失败'
  }
}

/* ==================== 修改密码 ==================== */

function openPwdModal() {
  pwdForm.oldPassword = ''
  pwdForm.newPassword = ''
  pwdForm.confirmPassword = ''
  showPwdModal.value = true
}

async function submitPwd() {
  if (!pwdForm.oldPassword || !pwdForm.newPassword || !pwdForm.confirmPassword) {
    errorMessage.value = '请填写全部密码字段'
    return
  }
  if (pwdForm.newPassword.length < 6) {
    errorMessage.value = '新密码至少 6 位'
    return
  }
  if (pwdForm.newPassword !== pwdForm.confirmPassword) {
    errorMessage.value = '两次输入的新密码不一致'
    return
  }

  try {
    const res = await axios.put(`${API_BASE}/auth/password`, {
      oldPassword: pwdForm.oldPassword,
      newPassword: pwdForm.newPassword,
    })
    showPwdModal.value = false
    successMessage.value = res.data.message
  } catch (error) {
    errorMessage.value = error.response?.data?.message || '密码修改失败'
  }
}

/* ==================== 审计日志 ==================== */

async function loadAuditLogs() {
  auditLoading.value = true
  try {
    const params = { page: auditPage.value, pageSize: auditPageSize }
    if (auditActionFilter.value) params.action = auditActionFilter.value
    if (auditUserFilter.value.trim()) params.username = auditUserFilter.value.trim()
    const res = await axios.get(`${API_BASE}/audit-logs`, { params })
    auditLogs.value = res.data.data || []
    auditTotal.value = res.data.total || 0
  } catch (error) {
    errorMessage.value = error.response?.data?.message || '审计日志读取失败'
  } finally {
    auditLoading.value = false
  }
}

const auditActionOptions = [
  { value: '', label: '全部操作' },
  { value: 'login', label: '登录' },
  { value: 'change_password', label: '修改密码' },
  { value: 'reset_user_password', label: '重置密码' },
  { value: 'create_user', label: '创建账号' },
  { value: 'delete_user', label: '删除账号' },
  { value: 'create_semester', label: '新建学期' },
  { value: 'switch_semester', label: '切换学期' },
  { value: 'delete_semester', label: '删除学期' },
  { value: 'create_student', label: '添加学生' },
  { value: 'update_student', label: '编辑学生' },
  { value: 'delete_student', label: '删除学生' },
  { value: 'import_students', label: '导入学生' },
  { value: 'import_violations', label: '导入扣分' },
  { value: 'add_violation', label: '扣分' },
  { value: 'dorm_batch_violation', label: '宿舍批量扣分' },
  { value: 'revoke_violation', label: '撤销扣分' },
  { value: 'add_bonus', label: '加分' },
  { value: 'add_penalty', label: '手动减分' },
  { value: 'revoke_adjustment', label: '撤销调整' },
  { value: 'reset_scores', label: '重置分数' },
  { value: 'clear_records', label: '清空记录' },
]


/* ==================== 账号管理（仅管理员） ==================== */

const users = ref([])
const userForm = reactive({
  username: '',
  password: '',
  realName: '',
  role: 'teacher',
})
const userSubmitting = ref(false)

async function loadUsers() {
  try {
    const response = await axios.get(`${API_BASE}/users`)
    users.value = response.data.data || []
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '账号列表读取失败。'
  }
}

async function addUser() {
  errorMessage.value = ''
  successMessage.value = ''

  if (!userForm.username.trim()) {
    errorMessage.value = '请填写用户名。'
    return
  }

  if (userForm.password.length < 6) {
    errorMessage.value = '密码至少 6 位。'
    return
  }

  userSubmitting.value = true

  try {
    const response = await axios.post(`${API_BASE}/users`, {
      username: userForm.username.trim(),
      password: userForm.password,
      realName: userForm.realName.trim(),
      role: userForm.role,
    })

    successMessage.value = response.data.message || '账号创建成功。'

    userForm.username = ''
    userForm.password = ''
    userForm.realName = ''
    userForm.role = 'teacher'

    await loadUsers()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '账号创建失败，请检查后端服务。'
  } finally {
    userSubmitting.value = false
  }
}

async function deleteUser(user) {
  if (!window.confirm(`确定删除账号「${user.username}」吗？`)) return

  try {
    const response = await axios.delete(`${API_BASE}/users/${user.id}`)
    successMessage.value = response.data.message || '账号已删除。'
    await loadUsers()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '删除失败，请检查后端服务。'
  }
}

async function resetUserPassword(user) {
  const password = window.prompt(
    `为账号「${user.username}」设置新密码（至少6位）：`
  )

  if (password === null) return

  if (password.length < 6) {
    errorMessage.value = '密码至少 6 位。'
    return
  }

  try {
    const response = await axios.put(`${API_BASE}/users/${user.id}/password`, {
      password,
    })

    successMessage.value = response.data.message || '密码已重置。'
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '重置失败，请检查后端服务。'
  }
}

async function toggleUserStatus(user) {
  const next = user.status === 'disabled' ? 'active' : 'disabled'
  const verb = next === 'disabled' ? '停用' : '启用'

  if (!window.confirm(`确定${verb}账号「${user.username}」吗？`)) return

  try {
    const response = await axios.patch(`${API_BASE}/users/${user.id}/status`, {
      status: next,
    })
    successMessage.value = response.data.message || `账号已${verb}。`
    await loadUsers()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || `${verb}失败，请检查后端服务。`
  }
}

async function exportDatabase() {
  try {
    const response = await axios.get(`${API_BASE}/export`, { responseType: 'blob' })
    const url = URL.createObjectURL(response.data)
    const a = document.createElement('a')
    a.href = url
    a.download = `student-moral-export-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    successMessage.value = '全库数据已导出。'
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '导出失败，请检查后端服务。'
  }
}

/* ==================== 加分规则管理 ==================== */

async function loadBonusRules() {
  try {
    const response = await axios.get(`${API_BASE}/bonus-rules`)
    bonusRules.value = response.data.data || []
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '加分规则读取失败。'
  }
}

async function addBonusRule() {
  errorMessage.value = ''
  successMessage.value = ''

  if (!bonusRuleForm.ruleName.trim()) {
    errorMessage.value = '请填写规则名称。'
    return
  }

  const pts = Number(bonusRuleForm.points)
  if (!Number.isFinite(pts) || pts < 0 || pts > 100) {
    errorMessage.value = '加分分值必须是 0-100 的数字。'
    return
  }

  bonusRuleSubmitting.value = true

  try {
    const response = await axios.post(`${API_BASE}/bonus-rules`, {
      ruleName: bonusRuleForm.ruleName.trim(),
      points: pts,
      description: bonusRuleForm.description.trim(),
    })

    successMessage.value = response.data.message || '加分规则创建成功。'
    bonusRuleForm.ruleName = ''
    bonusRuleForm.points = ''
    bonusRuleForm.description = ''
    await loadBonusRules()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '创建失败，请检查后端服务。'
  } finally {
    bonusRuleSubmitting.value = false
  }
}

async function deleteBonusRule(rule) {
  if (!window.confirm(`确定删除加分规则「${rule.rule_name}」吗？`)) return

  try {
    const response = await axios.delete(`${API_BASE}/bonus-rules/${rule.id}`)
    successMessage.value = response.data.message || '规则已删除。'
    await loadBonusRules()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '删除失败，请检查后端服务。'
  }
}

async function toggleBonusRuleStatus(rule) {
  const next = rule.is_active ? false : true
  const verb = next ? '启用' : '停用'

  try {
    await axios.patch(`${API_BASE}/bonus-rules/${rule.id}`, { isActive: next })
    successMessage.value = `规则已${verb}。`
    await loadBonusRules()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || `${verb}失败。`
  }
}

// 在手动调整表单中选了加分规则后，自动填入分值和原因
function applyBonusRule(rule) {
  if (!rule) {
    adjustmentForm.bonusRuleId = ''
    return
  }
  adjustmentForm.bonusRuleId = String(rule.id)
  if (rule.rule_name !== '其他') {
    adjustmentForm.pointsChange = String(rule.points)
    if (!adjustmentForm.reason) {
      adjustmentForm.reason = rule.rule_name
    }
  } else {
    adjustmentForm.pointsChange = ''
  }
}

/* ==================== 学生自助查询（免登录） ==================== */

async function handleSelfQuery() {
  selfQueryError.value = ''
  selfQueryResult.value = null

  const no = selfQueryNo.value.trim()
  if (!no) {
    selfQueryError.value = '请输入学号'
    return
  }

  selfQueryLoading.value = true

  try {
    const response = await axios.get(`${API_BASE}/public/score`, {
      params: { studentNo: no },
    })
    selfQueryResult.value = response.data
  } catch (error) {
    selfQueryError.value =
      error.response?.data?.message || '查询失败，请检查学号是否正确。'
  } finally {
    selfQueryLoading.value = false
  }
}

/* ==================== 学生管理 ==================== */

const showStudentForm = ref(false)
const studentSaving = ref(false)
const studentForm = reactive({
  id: '',
  studentNo: '',
  studentName: '',
  gradeName: '',
  className: '',
  dormBuilding: '',
  dormRoom: '',
})

const studentList = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()

  return students.value.filter(item => {
    const matchesGrade =
      selectedGrade.value === 'all' ||
      String(item.grade_name) === selectedGrade.value

    const matchesClass =
      selectedClass.value === 'all' ||
      String(item.class_name) === selectedClass.value

    const matchesKeyword =
      !keyword ||
      String(item.student_name || '').toLowerCase().includes(keyword) ||
      String(item.student_no || '').toLowerCase().includes(keyword) ||
      String(item.class_name || '').toLowerCase().includes(keyword)

    return matchesGrade && matchesClass && matchesKeyword
  })
})

function openStudentForm(student = null) {
  errorMessage.value = ''
  successMessage.value = ''
  showStudentForm.value = true

  studentForm.id = student ? String(student.id) : ''
  studentForm.studentNo = student?.student_no || ''
  studentForm.studentName = student?.student_name || ''
  studentForm.gradeName = student?.grade_name || ''
  studentForm.className = student?.class_name || ''
  studentForm.dormBuilding = student?.dorm_building || ''
  studentForm.dormRoom = student?.dorm_room || ''
}

function closeStudentForm() {
  showStudentForm.value = false
}

async function saveStudent() {
  errorMessage.value = ''
  successMessage.value = ''

  if (!studentForm.studentNo.trim()) {
    errorMessage.value = '请填写学号。'
    return
  }

  if (!studentForm.studentName.trim()) {
    errorMessage.value = '请填写姓名。'
    return
  }

  if (!studentForm.gradeName.trim() || !studentForm.className.trim()) {
    errorMessage.value = '请填写年级和班级（如 2025级 / 软件工程1班）。'
    return
  }

  studentSaving.value = true

  try {
    const payload = {
      studentNo: studentForm.studentNo.trim(),
      studentName: studentForm.studentName.trim(),
      gradeName: studentForm.gradeName.trim(),
      className: studentForm.className.trim(),
      dormBuilding: studentForm.dormBuilding.trim(),
      dormRoom: studentForm.dormRoom.trim(),
    }

    const response = studentForm.id
      ? await axios.put(`${API_BASE}/students/${studentForm.id}`, payload)
      : await axios.post(`${API_BASE}/students`, payload)

    successMessage.value = response.data.message || '保存成功。'
    closeStudentForm()
    await loadData()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '保存失败，请检查后端服务。'
  } finally {
    studentSaving.value = false
  }
}

async function deleteStudent(student) {
  errorMessage.value = ''
  successMessage.value = ''

  const confirmed = window.confirm(
    `确定删除学生「${student.student_name}（${student.student_no}）」吗？\n\n该学生的全部扣分与调整记录将一并删除，此操作不可恢复。`
  )

  if (!confirmed) return

  try {
    const response = await axios.delete(`${API_BASE}/students/${student.id}`)
    successMessage.value = response.data.message || '学生已删除。'
    await loadData()
  } catch (error) {
    errorMessage.value =
      error.response?.data?.message || '删除失败，该操作需要管理员权限。'
  }
}

/* ==================== 学生个人档案 ==================== */

const profileStudent = ref(null)

const profileRecords = computed(() => {
  if (!profileStudent.value) return []

  return allRecords.value.filter(
    item =>
      String(item.student_no) === String(profileStudent.value.student_no)
  )
})

// 分数走势：从初始分开始，按日期顺序累加每条有效记录
const profileTrend = computed(() => {
  if (!profileStudent.value) return []

  const initial = Number(profileStudent.value.initial_score ?? 100)
  const records = profileRecords.value
    .filter(item => item.status === 'valid')
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))

  const points = [{ label: '初始', score: initial }]
  let running = initial

  records.forEach(item => {
    running += Number(item.points)
    points.push({ label: item.label || item.date, score: Math.round(running * 100) / 100 })
  })

  return points
})

const profileTrendSvg = computed(() => {
  const data = profileTrend.value

  if (!data.length) return null

  const width = 640
  const height = 180
  const padX = 44
  const padY = 26

  const values = data.map(item => item.score)
  let min = Math.min(...values)
  let max = Math.max(...values)

  if (min === max) {
    min -= 2
    max += 2
  }

  const spanX = Math.max(data.length - 1, 1)
  const spanY = max - min

  const coords = data.map((item, index) => ({
    x: padX + (index / spanX) * (width - padX * 2),
    y: padY + (1 - (item.score - min) / spanY) * (height - padY * 2),
    label: item.label,
    score: item.score,
  }))

  return {
    width,
    height,
    coords,
    polyline: coords
      .map(item => `${item.x.toFixed(1)},${item.y.toFixed(1)}`)
      .join(' '),
    min,
    max,
  }
})

function openProfile(student) {
  profileStudent.value = student
}

function closeProfile() {
  profileStudent.value = null
}

/* ==================== 统计图表 ==================== */

// 班级平均品行分
const classScoreStats = computed(() => {
  const map = new Map()

  scores.value.forEach(item => {
    const key = `${item.grade_name}·${item.class_name}`

    if (!map.has(key)) {
      map.set(key, { name: key, total: 0, count: 0 })
    }

    const entry = map.get(key)
    entry.total += Number(item.current_score || 0)
    entry.count += 1
  })

  return [...map.values()]
    .map(item => ({
      name: item.name,
      avg: item.total / item.count,
      count: item.count,
    }))
    .sort((a, b) => b.avg - a.avg)
})

// 违规类型 Top（当前学期有效记录）
const violationTypeStats = computed(() => {
  const map = new Map()

  violations.value
    .filter(item => item.status === 'valid')
    .forEach(item => {
      const name = item.violation_name || '未分类'

      if (!map.has(name)) {
        map.set(name, { name, count: 0, points: 0 })
      }

      const entry = map.get(name)
      entry.count += 1
      entry.points += Number(item.points || 0)
    })

  return [...map.values()].sort((a, b) => b.count - a.count)
})

// 月度扣分趋势（当前学期有效记录）
const monthlyTrend = computed(() => {
  const map = new Map()

  violations.value
    .filter(item => item.status === 'valid')
    .forEach(item => {
      const month = String(item.violation_date).slice(0, 7)

      if (!map.has(month)) {
        map.set(month, { month, count: 0, points: 0 })
      }

      const entry = map.get(month)
      entry.count += 1
      entry.points += Number(item.points || 0)
    })

  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month))
})

const maxViolationTypeCount = computed(() =>
  Math.max(1, ...violationTypeStats.value.map(item => item.count))
)

const maxMonthlyPoints = computed(() =>
  Math.max(1, ...monthlyTrend.value.map(item => item.points))
)

/* ==================== Tab 切换 ==================== */

function switchTab(tab) {
  activeTab.value = tab

  if (tab === 'users' && isAdmin.value) {
    loadUsers()
  }
  if (tab === 'bonusRules' && isAdmin.value) {
    loadBonusRules()
  }
  if (tab === 'audit' && isAdmin.value) {
    auditPage.value = 1
    loadAuditLogs()
  }
}

onMounted(() => {
  if (token.value) {
    loadData()
  }
})
</script>

<template>
  <div class="app-shell">
    <!-- 登录页 -->
    <div v-if="!currentUser" class="login-wrap">
      <!-- 学生自助查询 -->
      <form v-if="showSelfQuery" class="login-card" @submit.prevent="handleSelfQuery">
        <div class="brand-icon">🔍</div>
        <h1>品行分自助查询</h1>
        <p class="login-sub">输入学号查询个人品行分</p>

        <div class="form-field">
          <label for="self-query-no">学号</label>
          <input
            id="self-query-no"
            v-model="selfQueryNo"
            type="text"
            placeholder="请输入学号"
            required
          />
        </div>

        <p v-if="selfQueryError" class="login-error">{{ selfQueryError }}</p>

        <button type="submit" class="btn btn-teal login-btn" :disabled="selfQueryLoading">
          {{ selfQueryLoading ? '查询中...' : '查 询' }}
        </button>

        <button type="button" class="btn btn-light btn-small" style="margin-top:8px;" @click="showSelfQuery = false; selfQueryResult = null; selfQueryError = ''">
          ← 返回登录
        </button>

        <!-- 查询结果 -->
        <div v-if="selfQueryResult" class="self-query-result">
          <div class="sq-header">
            <h3>{{ selfQueryResult.data.student_name }}</h3>
            <span class="sq-no">学号：{{ selfQueryResult.data.student_no }}</span>
          </div>
          <p class="sq-info">
            {{ selfQueryResult.data.grade_name }} {{ selfQueryResult.data.class_name }}
            ｜ 学期：{{ selfQueryResult.semester.semester_name }}
          </p>
          <div class="sq-score">
            <span>当前品行分</span>
            <strong>{{ Number(selfQueryResult.data.current_score).toFixed(2) }}</strong>
          </div>
          <div class="sq-summary">
            <small>初始分 {{ Number(selfQueryResult.data.initial_score).toFixed(1) }}</small>
            <small class="sq-deduction">扣分 -{{ Number(selfQueryResult.data.total_deduction).toFixed(1) }}</small>
            <small class="sq-bonus">加分 +{{ Number(selfQueryResult.data.total_adjustment).toFixed(1) }}</small>
          </div>

          <div v-if="selfQueryResult.data.violations.length" class="sq-section">
            <h4>扣分明细</h4>
            <table class="sq-table">
              <thead><tr><th>项目</th><th>分值</th><th>日期</th></tr></thead>
              <tbody>
                <tr v-for="(v, i) in selfQueryResult.data.violations" :key="'v' + i">
                  <td>{{ v.violation_name }}</td>
                  <td>-{{ Number(v.points) }}</td>
                  <td>{{ String(v.violation_date).slice(0, 10) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="selfQueryResult.data.adjustments.length" class="sq-section">
            <h4>加分/调整明细</h4>
            <table class="sq-table">
              <thead><tr><th>分值</th><th>原因</th><th>日期</th></tr></thead>
              <tbody>
                <tr v-for="(a, i) in selfQueryResult.data.adjustments" :key="'a' + i">
                  <td>{{ Number(a.points_change) > 0 ? '+' : '' }}{{ Number(a.points_change) }}</td>
                  <td>{{ a.reason }}</td>
                  <td>{{ String(a.created_at).slice(0, 10) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </form>

      <!-- 登录表单 -->
      <form v-else class="login-card" @submit.prevent="handleLogin">
        <div class="brand-icon">⚖</div>
        <h1>学生品行分管理系统</h1>
        <p class="login-sub">请登录后使用</p>

        <div class="form-field">
          <label for="login-username">用户名</label>
          <input
            id="login-username"
            v-model="loginForm.username"
            type="text"
            autocomplete="username"
            placeholder="请输入用户名"
          />
        </div>

        <div class="form-field">
          <label for="login-password">密码</label>
          <input
            id="login-password"
            v-model="loginForm.password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
          />
        </div>

        <p v-if="loginError" class="login-error">{{ loginError }}</p>

        <button type="submit" class="btn btn-purple login-btn" :disabled="loggingIn">
          {{ loggingIn ? '正在登录...' : '登 录' }}
        </button>

        <button type="button" class="btn btn-light btn-small" style="margin-top:8px;" @click="showSelfQuery = true">
          🔍 学生自助查询
        </button>

        <small class="login-hint">首次使用默认管理员：admin / admin123</small>
      </form>
    </div>

    <template v-else>
    <header class="top-header">
      <div class="brand-row">
        <div class="brand-icon">⚖</div>
        <div>
          <h1>学生品行分管理系统</h1>
          <p>云端管理准备中 <span>｜</span> 数据实时读取 <span>｜</span> 期末评奖评优辅助</p>
        </div>
        <div class="header-user">
          <span class="user-chip">
            {{ currentUser.realName || currentUser.username }}（{{ roleText(currentUser.role) }}）
          </span>
          <button class="btn btn-light btn-small" @click="openPwdModal">修改密码</button>
          <button class="btn btn-light btn-small" @click="logout()">退出登录</button>
        </div>
      </div>
    </header>

    <main class="main-content">
      <div class="connection-bar">
        <div class="connection-left">
          <span class="status-dot" :class="{ loading }"></span>
          <span>{{ loading ? '正在同步数据库...' : '数据库接口已连接（本地开发环境）' }}</span>
          <span v-if="activeSemester" class="semester-tag">
            {{ activeSemester.semester_name }}
          </span>
        </div>
        <div class="connection-right">
          <div class="semester-switch">
            <label class="switch-label">学期：</label>
            <select
              class="input input-small"
              :value="currentSemesterId"
              @change="switchSemester($event.target.value)"
            >
              <option value="">当前学期（{{ activeSemester?.semester_name || '未设置' }}）</option>
              <option
                v-for="s in semesters"
                :key="s.id"
                :value="String(s.id)"
              >
                {{ s.semester_name }}{{ s.status === 'active' ? '（当前）' : '' }}
              </option>
            </select>
            <button
              v-if="isAdmin"
              class="btn btn-purple btn-small"
              @click="openCreateSemester"
            >
              + 新建
            </button>
          </div>
          <button class="btn btn-purple btn-small" @click="loadData">
            ↻ 刷新数据
          </button>
        </div>
      </div>

      <div v-if="errorMessage" class="notice notice-error" role="alert">
        <span>{{ errorMessage }}</span>
        <button class="notice-close" @click="errorMessage = ''">×</button>
      </div>

      <div v-if="successMessage" class="notice notice-success" role="status">
        <span>✓ {{ successMessage }}</span>
        <button class="notice-close" @click="successMessage = ''">×</button>
      </div>

      <section class="stats-grid">
        <article class="stat-card stat-blue">
          <div class="stat-icon">♙</div>
          <div>
            <p>学生总人数</p>
            <strong>{{ totalStudents }}</strong>
            <small>已录入学生</small>
          </div>
        </article>
        <article class="stat-card stat-teal">
          <div class="stat-icon">▤</div>
          <div>
            <p>有效违规记录</p>
            <strong>{{ totalDeductions }}</strong>
            <small>当前学期</small>
          </div>
        </article>
        <article class="stat-card stat-purple">
          <div class="stat-icon">★</div>
          <div>
            <p>平均品行分</p>
            <strong>{{ averageScore }}</strong>
            <small>当前学生平均分</small>
          </div>
        </article>
        <article class="stat-card stat-orange">
          <div class="stat-icon">−</div>
          <div>
            <p>累计扣分</p>
            <strong>{{ deductionTotal }}</strong>
            <small>有效记录合计</small>
          </div>
        </article>
      </section>

      <!-- 统计图表 -->
      <section class="charts-grid">
        <article class="chart-card">
          <h3>班级平均品行分</h3>
          <div class="chart-bars">
            <div
              v-for="item in classScoreStats.slice(0, 12)"
              :key="item.name"
              class="chart-bar-row"
            >
              <span class="chart-bar-label">{{ item.name }}</span>
              <div class="chart-bar-track">
                <div
                  class="chart-bar-fill"
                  :class="{ 'bar-low': item.avg < 85 }"
                  :style="{ width: Math.min(item.avg, 100) + '%' }"
                ></div>
              </div>
              <span class="chart-bar-value">{{ item.avg.toFixed(1) }}</span>
            </div>
            <p v-if="!classScoreStats.length" class="empty-state">暂无数据</p>
          </div>
        </article>

        <article class="chart-card">
          <h3>违规类型 Top（有效）</h3>
          <div class="chart-bars">
            <div
              v-for="item in violationTypeStats.slice(0, 8)"
              :key="item.name"
              class="chart-bar-row"
            >
              <span class="chart-bar-label">{{ item.name }}</span>
              <div class="chart-bar-track">
                <div
                  class="chart-bar-fill bar-red"
                  :style="{ width: (item.count / maxViolationTypeCount) * 100 + '%' }"
                ></div>
              </div>
              <span class="chart-bar-value">{{ item.count }} 次</span>
            </div>
            <p v-if="!violationTypeStats.length" class="empty-state">暂无违规记录</p>
          </div>
        </article>

        <article class="chart-card">
          <h3>月度扣分趋势（有效）</h3>
          <div class="chart-bars">
            <div
              v-for="item in monthlyTrend"
              :key="item.month"
              class="chart-bar-row"
            >
              <span class="chart-bar-label">{{ item.month }}</span>
              <div class="chart-bar-track">
                <div
                  class="chart-bar-fill bar-orange"
                  :style="{ width: (item.points / maxMonthlyPoints) * 100 + '%' }"
                ></div>
              </div>
              <span class="chart-bar-value">-{{ item.points.toFixed(1) }}</span>
            </div>
            <p v-if="!monthlyTrend.length" class="empty-state">暂无扣分记录</p>
          </div>
        </article>
      </section>

      <section class="toolbar">
        <div class="toolbar-left">
          <button class="btn btn-teal" @click="downloadTemplate">
            ⇩ 下载名单模板
          </button>
          <button
            v-if="isAdmin"
            class="btn btn-teal"
            :disabled="importing"
            @click="chooseStudentFile"
          >
            {{ importing ? '正在导入...' : '♙ 导入学生名单' }}
          </button>

<input
  ref="importFileInput"
  type="file"
  accept=".xlsx,.xls"
  style="display: none"
  @change="importStudents"
/>
          <button class="btn btn-teal" @click="downloadViolationTemplate">
            ⇩ 下载扣分模板
          </button>
          <button
            v-if="isAdmin"
            class="btn btn-teal"
            :disabled="importingViolations"
            @click="chooseViolationFile"
          >
            {{ importingViolations ? '正在导入...' : '⊖ 导入扣分记录' }}
          </button>

          <input
            ref="violationImportInput"
            type="file"
            accept=".xlsx,.xls"
            style="display: none"
            @change="importViolations"
          />
        </div>
        <div class="toolbar-right">
          <div class="dropdown-wrap">
            <button class="btn btn-green">
              ▣ 导出数据 ▾
            </button>
            <div class="dropdown-menu dropdown-menu-scroll">
              <button @click="exportData()">⬇ 全部数据（排名+明细）</button>
              <template v-if="classMenus.length">
                <p class="menu-group-title">按年级导出</p>
                <button
                  v-for="menu in classMenus"
                  :key="'grade-' + menu.grade"
                  @click="exportData(menu.grade)"
                >
                  {{ menu.grade }}（排名+明细）
                </button>
                <p class="menu-group-title">按班级导出</p>
                <template v-for="menu in classMenus" :key="'gc-' + menu.grade">
                  <button
                    v-for="cls in menu.classes"
                    :key="'class-' + menu.grade + '-' + cls"
                    @click="exportData(menu.grade, cls)"
                  >
                    {{ menu.grade }} · {{ cls }}
                  </button>
                </template>
              </template>
            </div>
          </div>
          <button v-if="isAdmin" class="btn btn-yellow" @click="resetScores">
            ↶ 重置分数至100
          </button>
          <button v-if="isAdmin" class="btn btn-red" @click="clearRecords">
            ▤ 清空本学期记录
          </button>
        </div>
      </section>

      <section class="panel entry-panel">
        <div class="section-heading">
          <span class="heading-mark"></span>
          <span class="heading-icon">♧</span>
          <h2>手动添加扣分</h2>
        </div>

        <form class="entry-form" @submit.prevent="addViolation">
          <template v-if="!isDormRule">
            <div class="form-field">
              <label for="student">学生姓名 / 学号 <span class="required">*</span></label>
              <SearchSelect
                v-model="form.studentId"
                :options="studentOptions"
                placeholder="请选择学生，可输入姓名或学号搜索"
                empty-text="暂无学生，请先导入学生名单"
              />
            </div>
          </template>

          <template v-else>
            <div class="form-field">
              <label for="dorm-building">宿舍楼栋 <span class="required">*</span></label>
              <select id="dorm-building" v-model="form.dormBuilding" required>
                <option value="" disabled>请选择楼栋</option>
                <option
                  v-for="building in dormBuildings"
                  :key="building"
                  :value="building"
                >
                  {{ building }}
                </option>
              </select>
            </div>

            <div class="form-field">
              <label for="dorm-room">宿舍号 <span class="required">*</span></label>
              <select id="dorm-room" v-model="form.dormRoom" required :disabled="!form.dormBuilding">
                <option value="" disabled>
                  {{ form.dormBuilding ? '请选择宿舍号' : '请先选择楼栋' }}
                </option>
                <option v-for="room in dormRooms" :key="room" :value="room">
                  {{ room }}
                </option>
              </select>
              <small class="field-help">
                将对该宿舍的全体学生批量扣分
              </small>
            </div>
          </template>

          <div class="form-field">
            <label for="rule">扣分类型 <span class="required">*</span></label>
            <select id="rule" v-model="form.ruleId" required>
              <option value="" disabled>请选择扣分类型</option>
              <option v-for="rule in rules" :key="rule.id" :value="String(rule.id)">
                {{ ruleLabel(rule) }}
              </option>
            </select>
            <small v-if="selectedRule && !isCustomRule && !isDormRule" class="field-help">
              当前规则：扣 {{ Number(selectedRule.points).toFixed(2) }} 分
            </small>
          </div>

          <div v-if="isCustomRule" class="form-field">
            <label for="custom-points">自定义扣分分值 <span class="required">*</span></label>
            <input
              id="custom-points"
              v-model="form.customPoints"
              type="number"
              step="0.01"
              min="0.01"
              max="100"
              placeholder="例如：1 表示扣 1 分"
              required
            />
          </div>

          <div v-if="isCustomRule" class="form-field">
            <label for="custom-name">扣分项目名称</label>
            <input
              id="custom-name"
              v-model="form.customName"
              type="text"
              maxlength="100"
              placeholder="可选，例如：破坏公物"
            />
          </div>

          <div v-if="isDormRule" class="form-field">
            <label for="dorm-points">扣分分值 <span class="required">*</span></label>
            <input
              id="dorm-points"
              v-model="form.dormPoints"
              type="number"
              step="0.01"
              min="0.01"
              max="100"
              placeholder="例如：2 表示每人扣 2 分"
              required
            />
          </div>

          <div class="form-field">
            <label for="date">违规日期</label>
            <input id="date" v-model="form.violationDate" type="date" required />
          </div>

          <div class="form-field">
            <label for="description">备注</label>
            <input
              id="description"
              v-model="form.description"
              type="text"
              maxlength="500"
              placeholder="可选，补充违规情况"
            />
          </div>

          <div class="form-actions">
            <button type="button" class="btn btn-gray" @click="resetForm">
              ↶ 重置
            </button>
            <button
              type="submit"
              class="btn btn-green"
              :disabled="submitting || !rules.length || (isDormRule ? false : !students.length)"
            >
              {{
                submitting
                  ? '正在保存...'
                  : isDormRule
                    ? '＋ 按宿舍批量扣分'
                    : '＋ 添加扣分'
              }}
            </button>
          </div>
        </form>
      </section>

      
<section class="panel entry-panel">
  <div class="section-heading">
    <span class="heading-mark purple-mark"></span>
    <span class="heading-icon">★</span>
    <h2>手动调整品行分</h2>
  </div>

  <form class="entry-form" @submit.prevent="submitAdjustment">
    <div class="form-field">
      <label for="adjustment-student">选择学生</label>
      <SearchSelect
        v-model="adjustmentForm.studentId"
        :options="studentOptions"
        placeholder="请选择学生，可输入姓名或学号搜索"
        empty-text="暂无学生，请先导入学生名单"
      />
    </div>

    <div class="form-field">
      <label for="adjustment-bonus-rule">加分规则（可选）</label>
      <select
        id="adjustment-bonus-rule"
        :value="adjustmentForm.bonusRuleId || ''"
        @change="applyBonusRule(bonusRules.find(r => String(r.id) === $event.target.value))"
      >
        <option value="">不使用规则</option>
        <option v-for="rule in bonusRules.filter(r => r.is_active)" :key="rule.id" :value="String(rule.id)">
          {{ rule.rule_name }}（+{{ Number(rule.points) }}）
        </option>
      </select>
      <small class="field-help">选择加分规则后自动填入分值和原因</small>
    </div>

    <div class="form-field">
      <label for="adjustment-points">调整分数</label>
      <input
        id="adjustment-points"
        v-model="adjustmentForm.pointsChange"
        type="number"
        step="0.01"
        min="-100"
        max="100"
        placeholder="加分填正数，减分填负数"
        required
      />
      <small class="field-help">
        例如：5 表示加5分，-3 表示减3分
      </small>
    </div>

    <div class="form-field">
      <label for="adjustment-reason">调整原因</label>
      <input
        id="adjustment-reason"
        v-model="adjustmentForm.reason"
        type="text"
        maxlength="200"
        placeholder="例如：参加校级竞赛获奖"
        required
      />
    </div>

    <div class="form-actions">
      <button
        type="button"
        class="btn btn-gray"
        @click="adjustmentForm.pointsChange = ''; adjustmentForm.reason = ''; adjustmentForm.bonusRuleId = ''; errorMessage = ''; successMessage = ''"
      >
        重置
      </button>

      <button
        type="submit"
        class="btn btn-green"
        :disabled="adjustmentSubmitting || !students.length"
      >
        {{
          adjustmentSubmitting
            ? '正在提交...'
            : '提交分数调整'
        }}
      </button>
    </div>
  </form>
</section>


      <section class="import-help">
        <div class="help-title">ⓘ 批量导入说明</div>
        <p>☑ 学生名单：可先下载模板填写；导入时年级/班级自动规范化（如 25 → 2025级、4班 → 软件工程4班）。学生也可在「学生管理」页单个添加或编辑。</p>
        <p>☑ 扣分记录：先下载扣分模板，填写学号、违规类型（需与系统规则名称一致）和违规日期，批量导入后自动进入扣分明细。</p>
        <p>☑ 分数调整：手动加分/减分会保存为调整记录，可在扣分明细中查询与撤销，撤销后不参与品行分计算。</p>
        <p>☑ 分数统计：按当前有效学期的有效记录计算。</p>
        <p>☑ 数据导出：可导出当前品行分排名和违规扣分明细。</p>
      </section>

      <section class="ranking-section">
        <div class="tab-bar">
          <button
            class="tab-button"
            :class="{ active: activeTab === 'overview' }"
            @click="switchTab('overview')"
          >
            ◩ 整体板块
          </button>
          <button
            class="tab-button"
            :class="{ active: activeTab === 'class' }"
            @click="switchTab('class')"
          >
            ▦ 班级板块
          </button>
          <button
            class="tab-button"
            :class="{ active: activeTab === 'records' }"
            @click="switchTab('records')"
          >
            ☷ 扣分明细
          </button>
          <button
            class="tab-button"
            :class="{ active: activeTab === 'students' }"
            @click="switchTab('students')"
          >
            ♙ 学生管理
          </button>
          <button
            v-if="isAdmin"
            class="tab-button"
            :class="{ active: activeTab === 'bonusRules' }"
            @click="switchTab('bonusRules')"
          >
            ✚ 加分规则
          </button>
          <button
            v-if="isAdmin"
            class="tab-button"
            :class="{ active: activeTab === 'users' }"
            @click="switchTab('users')"
          >
            👤 账号管理
          </button>
          <button
            v-if="isAdmin"
            class="tab-button"
            :class="{ active: activeTab === 'audit' }"
            @click="switchTab('audit')"
          >
            📜 操作审计
          </button>
        </div>

        <div class="panel ranking-panel">
          <div class="section-heading">
            <span class="heading-mark purple-mark"></span>
            <h2>
              {{
                activeTab === 'records'
                  ? '扣分明细（违规扣分 + 分数调整）'
                  : activeTab === 'class'
                    ? '班级品行分排名'
                    : activeTab === 'students'
                      ? '学生信息管理'
                      : activeTab === 'bonusRules'
                        ? '加分规则管理'
                        : activeTab === 'users'
                          ? '系统账号管理'
                          : '个人品行分排名'
              }}
            </h2>
          </div>

          <div v-if="activeTab !== 'users' && activeTab !== 'bonusRules'" class="filters">
            <input
              v-model="searchText"
              type="search"
              placeholder="搜索学生姓名、学号或记录原因..."
            />
            <select v-model="selectedGrade" @change="selectedClass = 'all'">
              <option value="all">全部年级</option>
              <option v-for="name in gradeNames" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <select v-model="selectedClass">
              <option value="all">全部班级</option>
              <option v-for="name in classNames" :key="name" :value="name">
                {{ name }}
              </option>
            </select>
            <select v-if="activeTab === 'records'" v-model="recordTypeFilter">
              <option value="all">全部记录</option>
              <option value="violation">违规扣分</option>
              <option value="adjustment">分数调整</option>
            </select>
            <button class="btn btn-light" @click="loadData">刷新</button>
          </div>

          <template v-if="activeTab === 'overview' || activeTab === 'class'">
            <div v-if="activeTab === 'overview'" class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>排名</th>
                    <th>学号</th>
                    <th>学生姓名</th>
                    <th>年级</th>
<th>班级</th>
<th>宿舍楼栋</th>
<th>宿舍号</th>
<th>累计扣分</th>
                    <th>违规次数</th>
                    <th>当前品行分</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(student, index) in rankedScores" :key="student.id">
                    <td>
                      <span class="rank-badge" :class="'rank-' + (index + 1)">
                        {{ index + 1 }}
                      </span>
                    </td>
                    <td>{{ student.student_no }}</td>
                    <td class="student-name">
                      <button type="button" class="link-btn" @click="openProfile(student)">
                        {{ student.student_name }}
                      </button>
                    </td>
                    <td>{{ student.grade_name }}</td>
<td>{{ student.class_name }}</td>
<td>{{ student.dorm_building || '—' }}</td>
<td>{{ student.dorm_room || '—' }}</td>
<td class="score-negative">
                      {{ Number(student.total_deduction || 0).toFixed(2) }}
                    </td>
                    <td>{{ student.violation_count || 0 }}</td>
                    <td>
                      <strong class="score-value">
                        {{ Number(student.current_score).toFixed(2) }}
                      </strong>
                    </td>
                  </tr>
                  <tr v-if="!rankedScores.length">
                    <td colspan="10" class="empty-state">
                      {{ loading ? '正在加载数据...' : '暂无学生数据，请检查学生名单。' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-else class="grade-sections">
              <section
                v-for="group in gradeGroups"
                :key="group.grade"
                class="grade-section"
              >
                <div class="grade-title">
                  <span class="grade-icon">🎓</span>
                  <h3>{{ group.grade }}</h3>
                  <span class="grade-meta">
                    {{ group.classes.length }} 个班 ·
                    {{
                      group.classes.reduce(
                        (sum, card) => sum + card.students.length,
                        0
                      )
                    }}
                    人
                  </span>
                </div>

                <div class="class-grid">
                  <article
                    v-for="card in group.classes"
                    :key="group.grade + '-' + card.name"
                    class="class-card-v2"
                  >
                    <header class="class-card-head">
                      <span class="class-card-icon">🏫</span>
                      <strong>{{ card.name }}</strong>
                      <span class="class-card-count">
                        (共{{ card.students.length }}人)
                      </span>
                    </header>
                    <div class="class-card-body">
                      <div
                        v-for="(student, index) in card.students"
                        :key="student.id"
                        class="class-rank-row"
                      >
                        <span class="rank-medal" :class="'medal-' + (index + 1)">
                          {{ index < 3 ? ['🥇', '🥈', '🥉'][index] : index + 1 }}
                        </span>
                        <span class="class-student">
                          <button type="button" class="link-btn" @click="openProfile(student)">
                            {{ student.student_name }}
                          </button>
                        </span>
                        <span class="class-dorm">
                          🛏 {{ student.dorm_building || '—' }} {{ student.dorm_room || '' }}
                        </span>
                        <strong class="class-score">
                          {{ Number(student.current_score).toFixed(1) }}分
                        </strong>
                      </div>
                    </div>
                  </article>
                </div>
              </section>

              <p v-if="!gradeGroups.length" class="empty-state">
                暂无班级数据
              </p>
            </div>
          </template>

          <div v-else-if="activeTab === 'records'" class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>学号</th>
                  <th>学生姓名</th>
                  <th>班级</th>
                  <th>类型 / 原因</th>
                  <th>分值变化</th>
                  <th>备注</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in paginatedRecords" :key="record.type + '-' + record.id">
                  <td>{{ record.date }}</td>
                  <td>{{ record.student_no }}</td>
                  <td class="student-name">{{ record.student_name }}</td>
                  <td>{{ record.class_name }}</td>
                  <td>
                    <span
                      class="record-type"
                      :class="record.type === 'violation' ? 'type-violation' : 'type-adjustment'"
                    >
                      {{ record.type === 'violation' ? '违规' : '调整' }}
                    </span>
                    {{ record.title }}
                  </td>
                  <td :class="record.points < 0 ? 'score-negative' : 'score-positive'">
                    {{ record.points > 0 ? '+' : '' }}{{ record.points.toFixed(2) }}
                  </td>
                  <td class="description-cell">{{ record.description || '—' }}</td>
                  <td>
                    <span
                      class="status-tag"
                      :class="record.status === 'valid' ? 'status-valid' : 'status-void'"
                    >
                      {{ record.status === 'valid' ? '有效' : '已撤销' }}
                    </span>
                  </td>
                  <td>
                    <button
                      v-if="record.status === 'valid' && isAdmin"
                      type="button"
                      class="btn btn-red btn-small"
                      :disabled="cancelingKey === record.type + '-' + record.id"
                      @click="revokeRecord(record)"
                    >
                      {{
                        cancelingKey === record.type + '-' + record.id
                          ? '正在撤销...'
                          : '撤销'
                      }}
                    </button>

                    <span v-else class="text-muted">
                      —
                    </span>
                  </td>
                </tr>
                <tr v-if="!filteredRecords.length">
                  <td colspan="9" class="empty-state">
                    {{ loading ? '正在加载数据...' : '当前没有扣分记录。' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="filteredRecords.length > recordPageSize" class="pagination">
            <span>共 {{ filteredRecords.length }} 条</span>
            <button class="btn btn-small" :disabled="recordPage <= 1" @click="recordPage--">上一页</button>
            <span>第 {{ recordPage }} / {{ Math.ceil(filteredRecords.length / recordPageSize) }} 页</span>
            <button class="btn btn-small" :disabled="recordPage * recordPageSize >= filteredRecords.length" @click="recordPage++">下一页</button>
          </div>

          <!-- 学生管理 -->
          <div v-else-if="activeTab === 'students'" class="manage-panel">
            <div class="manage-toolbar">
              <button class="btn btn-purple" @click="openStudentForm()">
                ＋ 添加学生
              </button>
              <span class="text-muted">
                共 {{ studentList.length }} 名学生；年级/班级会自动规范化（如 25 → 2025级、4班 → 软件工程4班）
              </span>
            </div>

            <form v-if="showStudentForm" class="manage-form" @submit.prevent="saveStudent">
              <div class="form-field">
                <label>学号 <span class="required">*</span></label>
                <input
                  v-model="studentForm.studentNo"
                  type="text"
                  maxlength="30"
                  placeholder="请填写唯一学号"
                  required
                />
              </div>

              <div class="form-field">
                <label>姓名 <span class="required">*</span></label>
                <input
                  v-model="studentForm.studentName"
                  type="text"
                  maxlength="50"
                  placeholder="请填写姓名"
                  required
                />
              </div>

              <div class="form-field">
                <label>年级 <span class="required">*</span></label>
                <input
                  v-model="studentForm.gradeName"
                  type="text"
                  maxlength="20"
                  placeholder="如：2025级（填 25 自动转为 2025级）"
                  required
                />
              </div>

              <div class="form-field">
                <label>班级 <span class="required">*</span></label>
                <input
                  v-model="studentForm.className"
                  type="text"
                  maxlength="30"
                  placeholder="如：软件工程4班（填 4班 自动规范）"
                  required
                />
              </div>

              <div class="form-field">
                <label>宿舍楼栋</label>
                <input
                  v-model="studentForm.dormBuilding"
                  type="text"
                  maxlength="50"
                  placeholder="可选，如：3号楼"
                />
              </div>

              <div class="form-field">
                <label>宿舍号</label>
                <input
                  v-model="studentForm.dormRoom"
                  type="text"
                  maxlength="50"
                  placeholder="可选，如：502"
                />
              </div>

              <div class="form-actions">
                <button type="button" class="btn btn-gray" @click="closeStudentForm">
                  取消
                </button>
                <button type="submit" class="btn btn-green" :disabled="studentSaving">
                  {{
                    studentSaving
                      ? '正在保存...'
                      : studentForm.id
                        ? '保存修改'
                        : '＋ 添加学生'
                  }}
                </button>
              </div>
            </form>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>学号</th>
                    <th>姓名</th>
                    <th>年级</th>
                    <th>班级</th>
                    <th>宿舍楼栋</th>
                    <th>宿舍号</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="student in paginatedStudentList" :key="student.id">
                    <td>{{ student.student_no }}</td>
                    <td>{{ student.student_name }}</td>
                    <td>{{ student.grade_name }}</td>
                    <td>{{ student.class_name }}</td>
                    <td>{{ student.dorm_building || '—' }}</td>
                    <td>{{ student.dorm_room || '—' }}</td>
                    <td class="action-cell">
                      <button
                        type="button"
                        class="btn btn-light btn-small"
                        @click="openStudentForm(student)"
                      >
                        编辑
                      </button>
                      <button
                        v-if="isAdmin"
                        type="button"
                        class="btn btn-red btn-small"
                        @click="deleteStudent(student)"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                  <tr v-if="!studentList.length">
                    <td colspan="7" class="empty-state">
                      {{ loading ? '正在加载数据...' : '暂无学生，可点击「添加学生」或导入名单。' }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="studentList.length > studentPageSize" class="pagination">
              <span>共 {{ studentList.length }} 名</span>
              <button class="btn btn-small" :disabled="studentPage <= 1" @click="studentPage--">上一页</button>
              <span>第 {{ studentPage }} / {{ Math.ceil(studentList.length / studentPageSize) }} 页</span>
              <button class="btn btn-small" :disabled="studentPage * studentPageSize >= studentList.length" @click="studentPage++">下一页</button>
            </div>
          </div>

          <!-- 加分规则管理（仅管理员） -->
          <div v-else-if="activeTab === 'bonusRules'" class="manage-panel">
            <form class="manage-form" @submit.prevent="addBonusRule">
              <div class="form-field">
                <label>规则名称 <span class="required">*</span></label>
                <input
                  v-model="bonusRuleForm.ruleName"
                  type="text"
                  maxlength="100"
                  placeholder="如：竞赛获奖"
                  required
                />
              </div>

              <div class="form-field">
                <label>加分分值 <span class="required">*</span></label>
                <input
                  v-model="bonusRuleForm.points"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  placeholder="如：5"
                  required
                />
              </div>

              <div class="form-field">
                <label>说明</label>
                <input
                  v-model="bonusRuleForm.description"
                  type="text"
                  maxlength="255"
                  placeholder="规则描述，可选"
                />
              </div>

              <div class="form-actions">
                <button type="submit" class="btn btn-green" :disabled="bonusRuleSubmitting">
                  {{ bonusRuleSubmitting ? '正在创建...' : '＋ 创建规则' }}
                </button>
              </div>
            </form>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>规则名称</th>
                    <th>分值</th>
                    <th>说明</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="rule in bonusRules" :key="rule.id">
                    <td>{{ rule.rule_name }}</td>
                    <td>+{{ Number(rule.points) }}</td>
                    <td>{{ rule.description || '—' }}</td>
                    <td>
                      <span :class="rule.is_active ? 'status-active' : 'status-disabled'">
                        {{ rule.is_active ? '启用' : '停用' }}
                      </span>
                    </td>
                    <td class="action-cell">
                      <button
                        type="button"
                        class="btn btn-light btn-small"
                        @click="toggleBonusRuleStatus(rule)"
                      >
                        {{ rule.is_active ? '停用' : '启用' }}
                      </button>
                      <button
                        type="button"
                        class="btn btn-red btn-small"
                        @click="deleteBonusRule(rule)"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                  <tr v-if="!bonusRules.length">
                    <td colspan="5" class="empty-state">暂无加分规则</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- 账号管理（仅管理员） -->
          <div v-else-if="activeTab === 'users'" class="manage-panel">
            <form class="manage-form" @submit.prevent="addUser">
              <div class="form-field">
                <label>用户名 <span class="required">*</span></label>
                <input
                  v-model="userForm.username"
                  type="text"
                  maxlength="50"
                  placeholder="登录用户名"
                  required
                />
              </div>

              <div class="form-field">
                <label>密码 <span class="required">*</span></label>
                <input
                  v-model="userForm.password"
                  type="password"
                  placeholder="至少 6 位"
                  required
                />
              </div>

              <div class="form-field">
                <label>姓名</label>
                <input
                  v-model="userForm.realName"
                  type="text"
                  maxlength="50"
                  placeholder="真实姓名，可选"
                />
              </div>

              <div class="form-field">
                <label>角色 <span class="required">*</span></label>
                <select v-model="userForm.role" required>
                  <option value="teacher">辅导员（日常扣分/调整）</option>
                  <option value="admin">管理员（全部权限）</option>
                </select>
              </div>

              <div class="form-actions">
                <button type="submit" class="btn btn-purple" :disabled="userSubmitting">
                  {{ userSubmitting ? '正在创建...' : '＋ 创建账号' }}
                </button>
              </div>
            </form>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>用户名</th>
                    <th>姓名</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>创建时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="user in users" :key="user.id">
                    <td>{{ user.username }}</td>
                    <td>{{ user.real_name || '—' }}</td>
                    <td>{{ roleText(user.role) }}</td>
                    <td>
                      <span :class="user.status === 'disabled' ? 'status-disabled' : 'status-active'">
                        {{ user.status === 'disabled' ? '停用' : '正常' }}
                      </span>
                    </td>
                    <td>{{ String(user.created_at).slice(0, 10) }}</td>
                    <td class="action-cell">
                      <button
                        type="button"
                        class="btn btn-light btn-small"
                        @click="resetUserPassword(user)"
                      >
                        重置密码
                      </button>
                      <button
                        v-if="user.id !== currentUser.id"
                        type="button"
                        :class="user.status === 'disabled' ? 'btn btn-green btn-small' : 'btn btn-yellow btn-small'"
                        @click="toggleUserStatus(user)"
                      >
                        {{ user.status === 'disabled' ? '启用' : '停用' }}
                      </button>
                      <button
                        v-if="user.id !== currentUser.id"
                        type="button"
                        class="btn btn-red btn-small"
                        @click="deleteUser(user)"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                  <tr v-if="!users.length">
                    <td colspan="6" class="empty-state">暂无账号</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="manage-toolbar" style="margin-top:16px;justify-content:flex-end;">
              <button class="btn btn-teal btn-small" @click="exportDatabase">
                ⬇ 导出全库数据
              </button>
            </div>
          </div>

          <!-- 操作审计（仅管理员） -->
          <div v-else-if="activeTab === 'audit'" class="manage-panel">
            <div class="manage-toolbar" style="flex-wrap:wrap;gap:12px;">
              <div class="form-field" style="margin-bottom:0;">
                <label>操作类型</label>
                <select v-model="auditActionFilter" class="input" style="width:160px;" @change="auditPage=1;loadAuditLogs()">
                  <option v-for="o in auditActionOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </div>
              <div class="form-field" style="margin-bottom:0;">
                <label>操作人</label>
                <input v-model="auditUserFilter" class="input" placeholder="用户名" style="width:140px;" @keyup.enter="auditPage=1;loadAuditLogs()">
              </div>
              <button class="btn btn-purple btn-small" style="align-self:flex-end;" @click="auditPage=1;loadAuditLogs()">查询</button>
            </div>
            <div class="table-wrap" style="margin-top:16px;">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>操作人</th>
                    <th>操作</th>
                    <th>详情</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="log in auditLogs" :key="log.id">
                    <td>{{ String(log.created_at).replace('T', ' ').slice(0, 16) }}</td>
                    <td>{{ log.username || '—' }}</td>
                    <td><span class="badge">{{ log.action_label }}</span></td>
                    <td style="text-align:left;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" :title="log.detail">{{ log.detail || '—' }}</td>
                    <td>{{ log.ip || '—' }}</td>
                  </tr>
                  <tr v-if="!auditLoading && !auditLogs.length">
                    <td colspan="5" class="empty-state">暂无审计日志</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="pagination">
              <span>共 {{ auditTotal }} 条</span>
              <button class="btn btn-small" :disabled="auditPage <= 1" @click="auditPage--;loadAuditLogs()">上一页</button>
              <span>第 {{ auditPage }} 页</span>
              <button class="btn btn-small" :disabled="auditPage * auditPageSize >= auditTotal" @click="auditPage++;loadAuditLogs()">下一页</button>
            </div>
          </div>

          <div class="table-footer">
            <span>
              {{
                activeTab === 'records'
                  ? `共 ${filteredRecords.length} 条记录`
                  : activeTab === 'students'
                    ? `共 ${studentList.length} 名学生`
                    : activeTab === 'users'
                      ? `共 ${users.length} 个账号`
                      : `共 ${rankedScores.length} 名学生`
              }}
            </span>
            <span>数据来源：MySQL</span>
          </div>
        </div>
      </section>

      <!-- 学生个人档案 -->
      <div v-if="profileStudent" class="modal-overlay" @click.self="closeProfile">
        <div class="modal-card">
          <header class="modal-head">
            <div>
              <h3>
                {{ profileStudent.student_name }}
                <small>（{{ profileStudent.student_no }}）</small>
              </h3>
              <p>
                {{ profileStudent.grade_name }} · {{ profileStudent.class_name }}
                · 宿舍 {{ profileStudent.dorm_building || '—' }} {{ profileStudent.dorm_room || '' }}
              </p>
            </div>
            <button class="notice-close" @click="closeProfile">×</button>
          </header>

          <div class="profile-stats">
            <div>
              <small>初始分</small>
              <strong>{{ Number(profileStudent.initial_score ?? 100).toFixed(1) }}</strong>
            </div>
            <div>
              <small>当前品行分</small>
              <strong class="score-value">
                {{ Number(profileStudent.current_score).toFixed(1) }}
              </strong>
            </div>
            <div>
              <small>累计扣分</small>
              <strong class="score-negative">
                {{ Number(profileStudent.total_deduction || 0).toFixed(1) }}
              </strong>
            </div>
            <div>
              <small>分数调整</small>
              <strong class="score-positive">
                {{ Number(profileStudent.total_adjustment || 0).toFixed(1) }}
              </strong>
            </div>
            <div>
              <small>有效违规次数</small>
              <strong>{{ profileStudent.violation_count || 0 }}</strong>
            </div>
          </div>

          <div class="profile-trend">
            <h4>分数走势（有效记录）</h4>
            <svg
              v-if="profileTrendSvg"
              :viewBox="`0 0 ${profileTrendSvg.width} ${profileTrendSvg.height}`"
              class="trend-svg"
              role="img"
            >
              <text
                :x="8"
                :y="profileTrendSvg.coords[0].y + 4"
                class="trend-label"
              >
                {{ profileTrendSvg.max.toFixed(0) }}
              </text>
              <polyline
                :points="profileTrendSvg.polyline"
                fill="none"
                stroke="#7268d9"
                stroke-width="2.5"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
              <circle
                v-for="(point, index) in profileTrendSvg.coords"
                :key="index"
                :cx="point.x"
                :cy="point.y"
                r="3.5"
                fill="#7268d9"
              >
                <title>{{ point.label }}：{{ point.score }}分</title>
              </circle>
            </svg>
          </div>

          <div class="profile-records">
            <h4>全部记录（{{ profileRecords.length }} 条）</h4>
            <div class="table-wrap profile-table">
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>类型</th>
                    <th>内容</th>
                    <th>分值</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="record in profileRecords" :key="record.type + '-' + record.id">
                    <td>{{ record.date }}</td>
                    <td>
                      <span
                        class="record-type"
                        :class="record.type === 'violation' ? 'type-violation' : 'type-adjustment'"
                      >
                        {{ record.type === 'violation' ? '违规' : '调整' }}
                      </span>
                    </td>
                    <td>{{ record.title }}<span v-if="record.description" class="text-muted">（{{ record.description }}）</span></td>
                    <td :class="record.points < 0 ? 'score-negative' : 'score-positive'">
                      {{ record.points > 0 ? '+' : '' }}{{ record.points.toFixed(2) }}
                    </td>
                    <td>
                      <span
                        class="status-tag"
                        :class="record.status === 'valid' ? 'status-valid' : 'status-void'"
                      >
                        {{ record.status === 'valid' ? '有效' : '已撤销' }}
                      </span>
                    </td>
                  </tr>
                  <tr v-if="!profileRecords.length">
                    <td colspan="5" class="empty-state">该学生暂无扣分与调整记录</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- 修改密码弹窗 -->
      <div v-if="showPwdModal" class="modal-overlay" @click.self="showPwdModal = false">
        <div class="modal-card" style="max-width:420px;">
          <header class="modal-head">
            <h3>修改密码</h3>
            <button class="notice-close" @click="showPwdModal = false">×</button>
          </header>
          <form class="manage-form modal-form" @submit.prevent="submitPwd">
            <div class="form-field">
              <label>原密码</label>
              <input v-model="pwdForm.oldPassword" type="password" class="input" autocomplete="current-password" />
            </div>
            <div class="form-field">
              <label>新密码（至少 6 位）</label>
              <input v-model="pwdForm.newPassword" type="password" class="input" autocomplete="new-password" />
            </div>
            <div class="form-field">
              <label>确认新密码</label>
              <input v-model="pwdForm.confirmPassword" type="password" class="input" autocomplete="new-password" />
            </div>
            <div style="display:flex;gap:12px;justify-content:flex-end;">
              <button type="button" class="btn btn-light" @click="showPwdModal = false">取消</button>
              <button type="submit" class="btn btn-purple">确认修改</button>
            </div>
          </form>
        </div>
      </div>

      <!-- 新建学期弹窗 -->
      <div v-if="showSemesterModal" class="modal-overlay" @click.self="showSemesterModal = false">
        <div class="modal-card" style="max-width:480px;">
          <header class="modal-head">
            <h3>新建学期</h3>
            <button class="notice-close" @click="showSemesterModal = false">×</button>
          </header>
          <form class="manage-form modal-form" @submit.prevent="createSemester">
            <div class="form-field">
              <label>学期名称</label>
              <input v-model="semesterForm.semesterName" class="input" placeholder="如 2026-2027学年第一学期" />
            </div>
            <div class="form-field" style="display:flex;gap:16px;">
              <div style="flex:1;">
                <label>开始日期</label>
                <input v-model="semesterForm.startDate" type="date" class="input" />
              </div>
              <div style="flex:1;">
                <label>结束日期</label>
                <input v-model="semesterForm.endDate" type="date" class="input" />
              </div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" v-model="semesterForm.activate" />
              创建后立即设为当前学期
            </label>
            <div style="display:flex;gap:12px;justify-content:flex-end;">
              <button type="button" class="btn btn-light" @click="showSemesterModal = false">取消</button>
              <button type="submit" class="btn btn-purple">创建</button>
            </div>
          </form>
        </div>
      </div>

      <footer class="page-footer">
        学生品行分管理系统 · 期末评奖评优数据辅助工具
      </footer>
    </main>
    </template>
  </div>
</template>
