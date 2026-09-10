import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The progress helper is a separate Electron process. The real application remains pre-ready,
// so Chromium cannot acquire the profile while the offline transaction owns it.
export async function openProgressWindow(locale) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  if (typeof locale === 'string') env.OPEN_SCIENCE_MIGRATION_LOCALE = locale
  const child = spawn(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.url)), 'progress-window.cjs'),
      '--brand-migration-progress-window'
    ],
    {
      env,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      windowsHide: false
    }
  )
  let exited = false
  let settled = false
  const pids = [child.pid]
  const closed = new Promise((resolve) =>
    child.once('exit', () => {
      exited = true
      resolve()
    })
  )
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Migration progress window did not become ready'))
    }, 30000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error('Migration progress window exited before it was ready'))
    })
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        clearTimeout(timer)
        resolve()
      }
      if (message?.type === 'processes' && Array.isArray(message.pids))
        pids.splice(0, pids.length, child.pid, ...message.pids.filter(Number.isSafeInteger))
    })
  })
  const send = (message) => {
    if (exited || !child.connected)
      throw new Error('Migration progress window was closed; restart to resume safely')
    child.send(message)
  }
  return {
    pids,
    update(event) {
      if (!settled) send({ type: 'progress', event })
    },
    async complete() {
      settled = true
      send({ type: 'complete' })
      await closed
    },
    async fail(error) {
      settled = true
      if (!exited) {
        send({ type: 'failed', error: String(error.message ?? error) })
        await closed
      }
    }
  }
}
