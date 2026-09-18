import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const fixtureRoot = resolve('e2e/browser/fixture')

export default defineConfig({
  root: fixtureRoot,
  resolve: {
    alias: { '@': resolve('src/renderer/src'), '@renderer': resolve('src/renderer/src') }
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve('out/browser-tests'),
    emptyOutDir: true,
    rollupOptions: {
      // New regression pages must be emitted too, rather than silently serving index.html.
      input: readdirSync(fixtureRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => resolve(fixtureRoot, entry.name))
        .sort()
    }
  },
  preview: { host: '127.0.0.1', port: 4178, strictPort: true },
  server: { host: '127.0.0.1', port: 4178, strictPort: true, fs: { allow: [process.cwd()] } }
})
