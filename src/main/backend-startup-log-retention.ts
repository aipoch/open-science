import { execFile, type ExecFileException } from 'node:child_process'
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveWindowsPowerShellExecutable } from './windows-powershell'

const run = promisify(execFile)
const retentionCount = 20
const startupLog = /^desktop-backend-\d{1,10}-(\d{13})\.log$/

// FileShare.None and DeleteOnClose check for conflicting handles and delete through
// the same handle. An independently running backend may still have inherited stdout.
const removeExclusive = `
foreach ($name in ($env:OPEN_SCIENCE_PRUNE_LOGS | ConvertFrom-Json)) {
  $path = [IO.Path]::Combine([Environment]::CurrentDirectory, $name)
  try {
    if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) { continue }
    [IO.FileStream]::new($path, 'Open', 'ReadWrite', 'None', 4096, 'DeleteOnClose').Dispose()
  } catch [IO.IOException] {} catch [UnauthorizedAccessException] {}
}`

export async function pruneBackendStartupLogs(directory: string, current: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) return
  const root = await realpath(directory)
  const entries = await readdir(root, { withFileTypes: true })
  const files = entries.flatMap((entry) => {
    const match = entry.isFile() && startupLog.exec(entry.name)
    return match ? [{ name: entry.name, timestamp: Number(match[1]) }] : []
  })
  files.sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name))
  const stale = files
    .slice(retentionCount)
    .map((file) => file.name)
    .filter((name) => name !== current)
  if (!stale.length) return

  if (process.platform === 'win32') {
    // Bound the environment value even on the first cleanup after an upgrade.
    for (let i = 0; i < stale.length; i += 100) {
      await run(
        resolveWindowsPowerShellExecutable(),
        ['-NoProfile', '-NonInteractive', '-Command', removeExclusive],
        {
          cwd: root,
          windowsHide: true,
          timeout: 10000,
          env: { ...process.env, OPEN_SCIENCE_PRUNE_LOGS: JSON.stringify(stale.slice(i, i + 100)) }
        }
      )
    }
    return
  }

  // POSIX permits unlinking open files. Inspect real descriptors rather than using
  // the filename PID, which belongs to the launcher, not the detached writer.
  const probe = await open(join(root, current), 'r')
  let openInodes: Set<string>
  try {
    const { stdout, stderr } = await run(
      process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof',
      ['-nP', '-F0i', '+d', root],
      { timeout: 10000 }
    ).catch((error: ExecFileException & { stdout: string; stderr: string }) => {
      // lsof exits 1 when any selected file has no open handles.
      if (error.code === 1 && !error.killed && !error.signal) return error
      throw error
    })
    openInodes = new Set(stdout.split('\0').filter((field) => /^i\d+$/.test(field)))
    const { ino } = await probe.stat({ bigint: true })
    if (stderr || !openInodes.has('i' + ino)) return
  } finally {
    await probe.close()
  }
  for (const name of stale) {
    if ((await realpath(directory)) !== root || !(await lstat(directory)).isDirectory()) return
    const path = join(root, name)
    const info = await lstat(path, { bigint: true }).catch(() => undefined)
    if (info?.isFile() && !openInodes.has('i' + info.ino)) await unlink(path).catch(() => undefined)
  }
}
