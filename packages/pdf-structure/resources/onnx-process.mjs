/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { Worker } from 'node:worker_threads'
import { Writable } from 'node:stream'
import { fork } from 'node:child_process'

export const runOnnxWorker = async (args, signal) => {
  console.log(JSON.stringify({ phase: './literature-pdf-onnx.mjs' }))
  const worker = new Worker(new URL('./literature-pdf-onnx.mjs', import.meta.url), {
    argv: args,
    execArgv: [],
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512 }
  })
  let failure,
    code,
    didExit = false,
    stopping
  const exited = new Promise((resolve) =>
    worker.once('exit', (value) => {
      code = value
      didExit = true
      resolve()
    })
  )
  worker.once('error', (error) => {
    failure ??= error
  })
  const stop = () =>
    (stopping ??= (async () => {
      try {
        if (!didExit) await worker.terminate()
      } finally {
        await exited
      }
    })())
  const pipeError = (error) => {
    failure ??= error
    // A failed destination unpipes/pauses its source. Drain owned stdio so
    // termination/exit cannot wait forever on backpressure.
    worker.stdout.unpipe()
    worker.stderr.unpipe()
    worker.stdout.resume()
    worker.stderr.resume()
    void stop().catch((error) => {
      failure ??= error
    })
  }
  const streams = [worker.stdout, worker.stderr]
  const drained = Promise.all(
    streams.map(
      (stream) =>
        new Promise((resolve) => {
          stream.once('end', resolve)
          stream.once('close', resolve)
          stream.once('error', (error) => {
            pipeError(error)
            resolve()
          })
        })
    )
  )
  // Readable end does not wait for the destination's asynchronous write callbacks.
  // End only owned bridges; their finish proves forwarding, without ending parent stdio.
  const forwards = [process.stdout, process.stderr].map(
    (destination) =>
      new Writable({
        write(chunk, encoding, done) {
          try {
            destination.write(chunk, encoding, done)
          } catch (error) {
            done(error)
          }
        }
      })
  )
  const forwarded = Promise.all(
    forwards.map(
      (stream) =>
        new Promise((resolve) => {
          stream.once('finish', resolve)
          stream.once('close', resolve)
          stream.on('error', pipeError)
        })
    )
  )
  const aborted = () => pipeError(Error('ONNX process cancelled.'))
  signal?.addEventListener('abort', aborted, { once: true })
  if (signal?.aborted) aborted()
  process.stdout.on('error', pipeError)
  process.stderr.on('error', pipeError)
  try {
    worker.stdout.pipe(forwards[0], { end: false })
    worker.stderr.pipe(forwards[1], { end: false })
    await exited
    await drained
    forwards.forEach((stream) => stream.end())
    await forwarded
    if (failure) throw failure
    if (code !== 0) throw Error(`ONNX worker exited unsuccessfully (${code})`)
  } finally {
    worker.stdout.unpipe()
    worker.stderr.unpipe()
    worker.stdout.resume()
    worker.stderr.resume()
    try {
      await stop()
      await drained
      forwards.forEach((stream) => stream.end())
      await forwarded
    } finally {
      worker.stdout.unpipe()
      worker.stderr.unpipe()
      signal?.removeEventListener('abort', aborted)
      process.stdout.removeListener('error', pipeError)
      process.stderr.removeListener('error', pipeError)
    }
  }
}

// Only host owns this child. IPC loss also ends it if host itself is forcibly terminated.
export const createOnnxProcess = (
  args,
  onMemory,
  stdout = process.stdout,
  stderr = process.stderr
) => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete env.NODE_OPTIONS
  const child = fork(new URL('./literature-pdf-onnx-host.mjs', import.meta.url), args, {
    env,
    execArgv: ['--max-old-space-size=512'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
  let failure,
    stopping,
    closed = false,
    rssBytes = 0
  let code, signal
  const exited = new Promise((resolve) =>
    child.once('close', (value, reason) => {
      closed = true
      rssBytes = 0
      code = value
      signal = reason
      resolve()
    })
  )
  const stop = () =>
    (stopping ??= (async () => {
      if (closed) return
      const force = setTimeout(() => child.kill('SIGKILL'), 1500)
      try {
        if (child.connected)
          child.send({ type: 'onnx:stop' }, (error) => {
            if (error && !closed) child.kill('SIGKILL')
          })
        else child.kill('SIGTERM')
        await exited
      } finally {
        clearTimeout(force)
      }
    })())
  const fail = (error) => {
    failure ??= error
    child.stdout.unpipe()
    child.stderr.unpipe()
    child.stdout.resume()
    child.stderr.resume()
    void stop().catch((error) => {
      failure ??= error
    })
  }
  child.on('error', fail)
  child.on('message', (message) => {
    if (closed) return
    if (message?.type === 'onnx:error' && typeof message.message === 'string') {
      failure ??= Error(message.message.slice(0, 4096))
      return
    }
    if (message?.type !== 'onnx:rss') return
    if (!Number.isSafeInteger(message.rssBytes) || message.rssBytes <= 0) {
      fail(Error('Invalid ONNX process memory sample.'))
      return
    }
    rssBytes = message.rssBytes
    try {
      onMemory(rssBytes)
    } catch (error) {
      fail(error)
    }
  })
  const forwards = [stdout, stderr].map(
    (destination) =>
      new Writable({
        write(chunk, encoding, done) {
          try {
            destination.write(chunk, encoding, done)
          } catch (error) {
            done(error)
          }
        }
      })
  )
  const forwarded = Promise.all(
    forwards.map(
      (stream) =>
        new Promise((resolve) => {
          stream.once('finish', resolve)
          stream.once('close', resolve)
          stream.on('error', (error) => {
            fail(error)
            resolve()
          })
        })
    )
  )
  stdout.on('error', fail)
  stderr.on('error', fail)
  const result = (async () => {
    try {
      child.stdout.pipe(forwards[0], { end: false })
      child.stderr.pipe(forwards[1], { end: false })
      await exited
      forwards.forEach((stream) => stream.end())
      await forwarded
      if (failure) throw failure
      if (code !== 0 || signal)
        throw Error(`ONNX process exited unsuccessfully (${signal ?? code})`)
    } finally {
      child.stdout.unpipe()
      child.stderr.unpipe()
      child.stdout.resume()
      child.stderr.resume()
      try {
        await stop()
        forwards.forEach((stream) => stream.end())
        await forwarded
      } finally {
        stdout.removeListener('error', fail)
        stderr.removeListener('error', fail)
      }
    }
  })()
  // Callers attach their result handler immediately after installing their owner.
  return {
    result,
    stop,
    stdout: child.stdout,
    get rssBytes() {
      return rssBytes
    }
  }
}

export const requestOnnxProcess = (port) =>
  new Promise((resolve, reject) => {
    if (!port) {
      reject(Error('ONNX requires its owning PDF supervisor.'))
      return
    }
    const cleanup = () => {
      port.removeListener('message', message)
      port.removeListener('close', close)
    }
    const close = () => {
      cleanup()
      reject(Error('PDF supervisor disconnected.'))
    }
    const message = (value) => {
      if (value?.type !== 'onnx:complete') return
      cleanup()
      if (value.error) reject(Error(value.error))
      else resolve()
    }
    port.on('message', message)
    port.once('close', close)
    try {
      port.postMessage({ type: 'onnx:start' })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
