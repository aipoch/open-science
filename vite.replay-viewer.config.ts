import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The scoped viewer has no preload or management client. Both hosts serve this same bundle.
export default defineConfig({
  root: resolve('src/renderer/replay-viewer'),
  resolve: {
    alias: { '@': resolve('src/renderer/src'), '@renderer': resolve('src/renderer/src') }
  },
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve('out/replay-viewer'), emptyOutDir: true }
})
