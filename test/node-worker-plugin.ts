import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from 'vite'

// Exercise the same worker boundary as electron-vite in Node tests, without replacing work with a
// synchronous mock. Each generated worker is bundled once and removed after the test runner closes.
export const nodeWorkerTestPlugin = (): Plugin => {
  let directory: string | undefined
  const entries = new Map<string, string>()
  return {
    name: 'test-node-worker',
    enforce: 'pre',
    load(id) {
      if (!id.endsWith('?nodeWorker')) return
      const entry = id.slice(0, -'?nodeWorker'.length)
      let output = entries.get(entry)
      if (!output) {
        directory ??= mkdtempSync(join(tmpdir(), 'open-science-workers-'))
        output = join(directory, `${entries.size}.cjs`)
        buildSync({
          entryPoints: [entry],
          outfile: output,
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node22'
        })
        entries.set(entry, output)
      }
      return `import { Worker } from 'node:worker_threads'; export default (options) => new Worker(${JSON.stringify(output)},options);`
    },
    closeBundle() {
      if (directory) rmSync(directory, { recursive: true, force: true })
    }
  }
}
