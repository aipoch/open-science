import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('e2e/browser/fixture'),
  resolve: {
    alias: { '@': resolve('src/renderer/src'), '@renderer': resolve('src/renderer/src') }
  },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 4178, strictPort: true, fs: { allow: [process.cwd()] } }
})
