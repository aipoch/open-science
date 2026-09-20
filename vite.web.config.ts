import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/renderer/web'),
  resolve: {
    alias: {
      // The decoder's browser entry requires document; its default/worker entry is DOM-free.
      'decode-named-character-reference': createRequire(import.meta.url).resolve(
        'decode-named-character-reference'
      ),
      '@': resolve('src/renderer/src'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true
  }
})
