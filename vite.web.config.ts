import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve('src/renderer/web'),
  // Match the desktop renderer: the shared journal import worker emits split modules.
  worker: { format: 'es' },
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
  // Prebundle linked CommonJS leaves when serving the renderer in development.
  optimizeDeps: {
    include: [
      '@aipoch/connector-mcp-client/oauth-redirect',
      '@aipoch/compute',
      '@aipoch/diagnostics',
      '@aipoch/providers',
      '@aipoch/providers/errors',
      '@aipoch/providers/transport',
      '@aipoch/skills/document',
      '@aipoch/notebook-analysis/contracts',
      '@aipoch/environment/contracts',
      '@aipoch/specialists',
      '@aipoch/reproducibility/contracts',
      '@aipoch/reproducibility/comparison',
      '@aipoch/reproducibility/execution-context'
    ]
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve('out/web'),
    // Local npm packages resolve outside node_modules through their file: links.
    commonjsOptions: {
      include: [
        /node_modules/,
        /packages[\\/](?:connector-(?:core|mcp-client)|compute|diagnostics|providers|skills|specialists)[\\/]dist/,
        /packages[\\/](?:notebook-analysis|environment|reproducibility)[\\/]dist/
      ]
    },
    emptyOutDir: true
  }
})
