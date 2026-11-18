/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { runOnnxWorker } from './onnx-process.mjs'

// Keep native Canvas loaded while its Worker releases references on Windows.
if (process.platform === 'win32') {
  const require = createRequire(import.meta.url)
  createRequire(require.resolve('@napi-rs/canvas'))('./js-binding')
}
const controller = new AbortController()
let stopping = false,
  force,
  sending = false
const stop = () => {
  if (stopping) return
  stopping = true
  controller.abort()
  // An unresponsive native Worker cannot keep an orphaned process alive.
  force = setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000)
}
process.once('disconnect', stop)
process.on('message', (message) => {
  if (message?.type === 'onnx:stop') stop()
})
process.once('SIGTERM', stop)
process.stdout.on('error', stop)
process.stderr.on('error', stop)
if (!process.connected) process.exit(1)
const report = () => {
  if (!process.connected) {
    stop()
    return
  }
  if (sending) return
  sending = true
  process.send({ type: 'onnx:rss', rssBytes: process.memoryUsage().rss }, (error) => {
    sending = false
    if (error) stop()
  })
}
report()
const interval = setInterval(report, 100)
let code = 0
try {
  await runOnnxWorker(process.argv.slice(2), controller.signal)
} catch (error) {
  code = 1
  console.error(error.message)
  if (process.connected)
    await new Promise((resolve) => {
      process.send({ type: 'onnx:error', message: String(error.message).slice(0, 4096) }, () =>
        resolve()
      )
    })
} finally {
  clearInterval(interval)
  clearTimeout(force)
}
// Worker exit and forwarded writes were joined; now release the process's native allocator.
process.exit(code)
