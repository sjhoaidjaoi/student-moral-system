import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // 前端 /api 请求转发到本地 Node 后端，避免跨域与硬编码地址
      '/api': 'http://localhost:3000',
    },
  },
})
