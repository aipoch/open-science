import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@renderer': resolve('src/renderer/src')
      }
    },
    server: {
      // Don't watch git worktrees under .claude/worktrees — full source copies would trigger
      // needless rescans/HMR churn during dev.
      watch: { ignored: ['**/.claude/**'] }
    },
    plugins: [react(), tailwindcss()]
  }
})
