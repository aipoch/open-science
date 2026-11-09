import { execFile, type ExecFileException } from 'node:child_process'
import { lstat, open, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
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

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ESRCH'
}

async function linuxOpenInodes(device: bigint): Promise<Set<string>> {
  const inodes = new Set<string>()
  const uid = process.geteuid!()
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    const dir = `/proc/${pid}/fd`
    try {
      // Startup logs are private to this user. Use the effective UID from status:
      // procfs can report root ownership on a nondumpable same-user process.
      const status = await readFile(`/proc/${pid}/status`, 'utf8')
      const owner = /^Uid:\s+\d+\s+(\d+)/m.exec(status)
      if (!owner) throw new Error('Could not inspect process ownership')
      if (Number(owner[1]) !== uid) continue
      for (const fd of await readdir(dir)) {
        try {
          const file = await stat(join(dir, fd), { bigint: true })
          if (file.dev === device && file.isFile()) inodes.add('i' + file.ino)
        } catch (error) {
          if (!isGone(error)) throw error
        }
      }
    } catch (error) {
      if (!isGone(error)) throw error
    }
  }
  return inodes
}

// A hardened same-user process can deny procfs inspection. When system Python is
// available, ask the kernel for an exclusive lease on each candidate instead.
const removeWithLinuxLease = `
import fcntl, os, signal, stat, sys

signal.signal(signal.SIGIO, signal.SIG_IGN)
directory = os.open(sys.argv[1], os.O_DIRECTORY | os.O_NOFOLLOW)
for name in sys.argv[2:]:
    try:
        fd = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            opened = os.fstat(fd)
            if stat.S_ISREG(opened.st_mode):
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
                if os.path.samestat(opened, os.stat(name, dir_fd=directory, follow_symlinks=False)):
                    os.unlink(name, dir_fd=directory)
        finally:
            os.close(fd)
    except OSError:
        continue
`

async function macOpenInodes(root: string): Promise<Set<string>> {
  const { stdout, stderr } = await run('/usr/sbin/lsof', ['-nP', '-F0i', '+d', root], {
    timeout: 10000
  }).catch((error: ExecFileException & { stdout: string; stderr: string }) => {
    // lsof exits 1 when any selected file has no open handles.
    if (error.code === 1 && !error.killed && !error.signal) return error
    throw error
  })
  if (stderr) return new Set()
  return new Set(stdout.split('\0').filter((field) => /^i\d+$/.test(field)))
}

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
    const { ino, dev } = await probe.stat({ bigint: true })
    if (process.platform === 'linux') {
      try {
        openInodes = await linuxOpenInodes(dev)
      } catch (error) {
        if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        for (let i = 0; i < stale.length; i += 100) {
          await run(
            '/usr/bin/python3',
            ['-I', '-S', '-c', removeWithLinuxLease, root, ...stale.slice(i, i + 100)],
            { timeout: 10000 }
          )
        }
        return
      }
    } else {
      openInodes = await macOpenInodes(root)
    }
    if (!openInodes.has('i' + ino)) return
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
