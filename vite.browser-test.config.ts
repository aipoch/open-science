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
  build: {
    outDir: resolve('out/browser-tests'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: resolve('e2e/browser/fixture/index.html'),
        csv: resolve('e2e/browser/fixture/csv-preview.html'),
        clipboard: resolve('e2e/browser/fixture/message-clipboard.html')
      }
    }
  },
  preview: { host: '127.0.0.1', port: 4178, strictPort: true },
  server: { host: '127.0.0.1', port: 4178, strictPort: true, fs: { allow: [process.cwd()] } }
})
