/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { realpath, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevSession } from './dev-session.mjs'

export async function runDev({
  root = resolve(import.meta.dirname, '..'),
  args = process.argv.slice(2)
} = {}) {
  root = await realpath(root)
  if (args.some((arg) => arg === '--rendererOnly' || arg.startsWith('--rendererOnly=')))
    throw new Error('npm run dev requires a fresh main build; --rendererOnly is not supported.')
  const session = await createDevSession({ root })
  let child
  let stopping
  let interrupted = false
  const shutdown = () =>
    (stopping ??= (async () => {
      try {
        const result = await session.stop()
        if (!result.clean) {
          console.error(
            '[dev] Owned backend stopped with incomplete cleanup; recovery evidence was preserved.'
          )
          process.exitCode = 1
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM')
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          }, 5000)
          timer.unref()
          child.once('exit', () => clearTimeout(timer))
        }
      }
    })())
  const onSignal = () => {
    interrupted = true
    void shutdown().catch((error) => {
      console.error(`[dev] Shutdown failed: ${error.message}`)
      process.exitCode = 1
    })
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, onSignal)
  try {
    await rm(resolve(root, 'out/backend/dev-build.json'), { force: true })
    // Keep the existing preparation order. A failed step never launches Electron on old output.
    for (const command of [
      ['scripts/build-dev-packages.mjs'],
      ['scripts/native-components.mjs'],
      ['scripts/build-backend.mjs', '--development'],
      ['scripts/stage-node-runtime.mjs', '--reuse'],
      ['node_modules/electron-vite/bin/electron-vite.js', 'dev', ...args]
    ]) {
      if (interrupted) break
      const electronVite = command[0].includes('electron-vite')
      const env = { ...process.env }
      delete env.OPEN_SCIENCE_DEV_SESSION
      if (electronVite) {
        env.OPEN_SCIENCE_DEV_SESSION = session.environment
        // A canonical entry also lets the supervisor identify the backend's Electron parent.
        env.ELECTRON_ENTRY = root
      }
      const code = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, command, { cwd: root, env, stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', (code) => resolve(code ?? 1))
      })
      if (code !== 0) {
        if (!interrupted) process.exitCode = code
        break
      }
    }
  } finally {
    await shutdown()
    for (const signal of signals) process.off(signal, onSignal)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void runDev().catch((error) => {
    console.error(`[dev] ${error.message}`)
    process.exitCode = 1
  })
