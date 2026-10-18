import { spawn } from 'node:child_process'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const root = process.env.OPEN_SCIENCE_PROGRESS_FIXTURE
const { startWindowsInstallProgress } = await import(
  pathToFileURL(process.env.OPEN_SCIENCE_PROGRESS_MODULE).href
)
let ready
const progress = await startWindowsInstallProgress({
  installerPath: join(root, 'installer.exe'),
  applicationPath: join(root, 'installation', 'application.exe'),
  helperPath: process.env.OPEN_SCIENCE_PROGRESS_HELPER,
  appData: root,
  profilePath: join(root, 'profile'),
  targetVersion: '1.0.2',
  startupOptions: {
    configRoot: root,
    dataRoot: root,
    profilePath: join(root, 'profile'),
    port: 44100,
    host: '127.0.0.1',
    credentialStore: 'os'
  },
  logDirectory: root,
  translate: (text) => text,
  log: {
    debug: console.debug,
    warn: console.warn,
    error: console.error,
    info(message, details) {
      ready = details
    }
  }
})
await writeFile(join(root, 'helper-ready.json'), JSON.stringify(ready))
if (process.env.OPEN_SCIENCE_PROGRESS_SCENARIO === 'cancel') {
  while (
    await access(join(root, 'cancel-parent')).then(
      () => false,
      () => true
    )
  ) {
    await setTimeout(20)
  }
  progress.cancel()
  process.exit(0)
}
progress.handoff()
const installer = spawn(join(root, 'installer.exe'), ['installer'], {
  env: { ...process.env, OPEN_SCIENCE_PROGRESS_OPERATION: progress.operationId },
  stdio: 'ignore',
  windowsHide: false,
  detached: true
})
installer.unref()
const deadline = Date.now() + 90_000
while (
  await access(join(root, 'exit-parent')).then(
    () => false,
    () => true
  )
) {
  if (Date.now() > deadline) throw new Error('Parent exit barrier timed out')
  await setTimeout(20)
}
// Model the real old Electron's normal exit after the independent window is visible.
process.exit(0)
