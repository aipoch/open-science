/* eslint-disable @typescript-eslint/explicit-function-return-type */
// The supervisor never performs PDF/WASM work. Extraction and optional OCR run in
// Worker threads; ORT has one directly owned process with an IPC-loss exit barrier.
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { unlink, rmdir } from 'node:fs/promises'
import { inspectScratch } from './scratch.mjs'
import { createOnnxProcess } from './onnx-process.mjs'

// Retain the Windows native binding without initializing the Canvas font wrapper.
if (process.platform === 'win32') {
  const require = createRequire(import.meta.url)
  createRequire(require.resolve('@napi-rs/canvas'))('./js-binding')
}

let worker, request, interval, deadline, onnx
let onnxStarted = false
let lastPhase = 'startup'
let heapLimitDetected = false
let heapLimitReported = false
let stopping
let startedAt
const resourceLimits = {
  heapMb: 512,
  rssBytes: 2 * 1024 ** 3,
  scratchBytes: 256 * 1024 ** 2,
  deadlineMs: 120000
}
const reportResourceLimit = (reason, measurements = {}) => {
  const stats = {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    rssBytes: process.memoryUsage().rss + (onnx?.rssBytes ?? 0),
    ...measurements,
    workerHeapLimitMb: resourceLimits.heapMb,
    rssLimitBytes: resourceLimits.rssBytes,
    scratchLimitBytes: resourceLimits.scratchBytes,
    deadlineMs: resourceLimits.deadlineMs
  }
  // Keep diagnostics bounded and independent of PDF contents or file paths.
  const observed = Object.fromEntries(
    Object.entries(stats).filter(([, value]) => Number.isSafeInteger(value) && value >= 0)
  )
  console.error(
    `PDF execution resource limit exceeded. Last phase: ${lastPhase}. Reason: ${reason}. Stats: ${JSON.stringify(observed)}`
  )
}
const isHeapLimitError = (message) =>
  /(?:JavaScript|JS) heap out of memory|reached heap limit|reaching memory limit/i.test(message)
const reportWorkerError = (message) => {
  if (isHeapLimitError(message)) {
    heapLimitDetected = true
    if (heapLimitReported) return
    heapLimitReported = true
    reportResourceLimit('worker-heap')
    return
  }
  console.error(message)
}
const stop = (code, orphan = false) => {
  stopping ??= (async () => {
    clearInterval(interval)
    clearTimeout(deadline)
    // Killing the process after a bounded grace period stops all threads, but preserves uncertain
    // scratch ownership. Do not delete files if Worker termination cannot be established.
    const force = setTimeout(() => process.exit(code || 1), 5000)
    await onnx?.stop()
    await worker?.terminate()
    if (orphan && request) {
      await inspectScratch(request.output, true)
      await unlink(request.input)
      await rmdir(dirname(request.input))
    }
    if (process.connected && process.send)
      await new Promise((resolve, reject) => {
        process.send({ type: 'pdf:stopped' }, (error) => (error ? reject(error) : resolve()))
      })
    clearTimeout(force)
    process.exit(code)
  })().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
const observePhase = (chunk) => {
  for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
    const match = line.match(/\{"phase":"([^"]+)"/u)
    if (match) lastPhase = match[1].slice(0, 160)
  }
}
const checkRss = () => {
  const hostRssBytes = process.memoryUsage().rss
  const childRssBytes = onnx?.rssBytes ?? 0
  const rssBytes = hostRssBytes + childRssBytes
  if (!stopping && rssBytes > resourceLimits.rssBytes) {
    reportResourceLimit('process-rss', { rssBytes, hostRssBytes, childRssBytes })
    void stop(1)
  }
  return rssBytes
}
process.stdout.on('error', () => void stop(1))
process.stderr.on('error', () => void stop(1))
process.on('message', (message) => {
  if (message?.type === 'pdf:stop') void stop(1)
})
process.stdin.once('end', () => void stop(1, true))
process.stdin.once('error', () => void stop(1, true))
let input = ''
process.stdin.on('data', (chunk) => {
  if (stopping) return
  input += chunk.toString('utf8')
  if (input.length > 8192 || request) {
    void stop(1)
    return
  }
  if (!input.endsWith('\n')) return
  try {
    request = JSON.parse(input)
    startedAt = Date.now()
    worker = new Worker(new URL('./literature-pdf-extract.mjs', import.meta.url), {
      argv: [
        request.input,
        request.assets,
        request.runtime,
        request.pages.join(','),
        request.output
      ],
      workerData: { ocr: request.ocr },
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: resourceLimits.heapMb }
    })
    worker.on('message', (message) => {
      if (message?.type !== 'onnx:start') return
      if (onnxStarted || stopping) {
        void stop(1)
        return
      }
      onnxStarted = true
      try {
        onnx = createOnnxProcess(
          [
            request.input,
            request.assets,
            request.runtime,
            request.pages.join(','),
            join(request.output, 'inference'),
            'production'
          ],
          () => checkRss()
        )
        onnx.stdout.on('data', observePhase)
        void onnx.result.then(
          () => {
            if (!stopping) worker.postMessage({ type: 'onnx:complete' })
          },
          (error) => {
            if (!stopping) {
              reportWorkerError(error.message)
              void stop(1)
            }
          }
        )
      } catch (error) {
        console.error(error.message)
        void stop(1)
      }
    })
    worker.stdout.pipe(process.stdout)
    worker.stdout.on('data', observePhase)
    worker.stderr.on('data', (chunk) => {
      const message = chunk.toString('utf8')
      if (isHeapLimitError(message)) heapLimitDetected = true
      process.stderr.write(chunk)
    })
    worker.once('error', (error) => {
      reportWorkerError(heapLimitDetected ? 'JavaScript heap out of memory' : error.message)
      void stop(1)
    })
    worker.once('exit', (code) => {
      if (!stopping) {
        if (code && heapLimitDetected) {
          reportWorkerError('JavaScript heap out of memory')
        }
        void stop(code)
      }
    })
    deadline = setTimeout(() => {
      console.error(`PDF execution deadline exceeded. Last phase: ${lastPhase}`)
      void stop(1)
    }, resourceLimits.deadlineMs)
    let inspecting = false
    interval = setInterval(async () => {
      if (inspecting || stopping) return
      inspecting = true
      try {
        // Sum both processes, including all their Workers/native/WASM allocations.
        // This remains a sampled watchdog rather than a kernel-enforced allocation limit.
        const rssBytes = checkRss()
        if (stopping) return
        const scratchBytes = await inspectScratch(request.output)
        if (scratchBytes > resourceLimits.scratchBytes) {
          reportResourceLimit('scratch-bytes', { rssBytes, scratchBytes })
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
