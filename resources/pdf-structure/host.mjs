/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The supervisor event loop never performs PDF/WASM work. A job has exactly one Worker thread,
// no child process tree; parent pipe closure still works while inference occupies the Worker.
import { Worker } from 'node:worker_threads'
import { dirname } from 'node:path'
import { unlink, rmdir } from 'node:fs/promises'
import { inspectScratch } from './scratch.mjs'

let worker, request, interval, deadline
let stopping
const stop = (code, orphan = false) => {
  stopping ??= (async () => {
    clearInterval(interval)
    clearTimeout(deadline)
    // Killing the process after a bounded grace period stops all threads, but preserves uncertain
    // scratch ownership. Do not delete files if Worker termination cannot be established.
    const force = setTimeout(() => process.exit(code || 1), 5000)
    await worker?.terminate()
    if (orphan && request) {
      await inspectScratch(request.output, true)
      await unlink(request.input)
      await rmdir(dirname(request.input))
    }
    clearTimeout(force)
    process.exit(code)
  })().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
process.stdin.once('end', () => void stop(1, true))
process.stdin.once('error', () => void stop(1, true))
let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8')
  if (input.length > 8192 || request) {
    void stop(1)
    return
  }
  if (!input.endsWith('\n')) return
  try {
    request = JSON.parse(input)
    worker = new Worker(new URL('./literature-pdf-extract.mjs', import.meta.url), {
      argv: [
        request.input,
        request.assets,
        request.runtime,
        request.pages.join(','),
        request.output
      ],
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 512 }
    })
    worker.stdout.pipe(process.stdout)
    worker.stderr.pipe(process.stderr)
    worker.once('error', (error) => {
      console.error(error.message)
      void stop(1)
    })
    worker.once('exit', (code) => {
      if (!stopping) void stop(code)
    })
    deadline = setTimeout(() => {
      console.error('PDF execution deadline exceeded.')
      void stop(1)
    }, 120000)
    let inspecting = false
    interval = setInterval(async () => {
      if (inspecting || stopping) return
      inspecting = true
      try {
        // RSS includes the inference Worker and native/WASM allocations. This is a sampled watchdog,
        // not a kernel-enforced allocation limit. Input/pixel/output bounds complement it.
        if (
          process.memoryUsage().rss > 2 * 1024 ** 3 ||
          (await inspectScratch(request.output)) > 256 * 1024 ** 2
        ) {
          console.error('PDF execution resource limit exceeded.')
          void stop(1)
        }
      } catch (error) {
        console.error(error.message)
        void stop(1)
      } finally {
        inspecting = false
      }
    }, 250)
  } catch (error) {
    console.error(error.message)
    void stop(1)
  }
})
