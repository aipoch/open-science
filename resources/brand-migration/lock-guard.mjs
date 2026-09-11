import { spawn } from 'node:child_process'

// A kernel lock serializes *recovery itself*. It is released on death/EOF, unlike another
// mkdir lock. Keep the guard inode forever: deleting it would let two processes lock different
// inodes under the same name. The helper receives the path over stdin, never shell interpolation.
const posix = `import os, sys, fcntl, stat
p = sys.stdin.readline().rstrip('\\n')
f = os.open(p, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
s = os.fstat(f)
if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1: raise RuntimeError('Unsafe guard inode')
fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
print('locked', flush=True)
sys.stdin.buffer.read()
`
const windows = `$ErrorActionPreference = 'Stop'
$p = [Console]::ReadLine()
$f = [IO.File]::Open($p, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadToEnd() | Out-Null } finally { $f.Dispose() }`

export async function acquireKernelGuard(path) {
  const child =
    process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windows], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      : spawn('python3', ['-c', posix], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let diagnostic = ''
  let ended = false
  const exited = new Promise((resolve) =>
    child.once('exit', () => {
      ended = true
      resolve()
    })
  )
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk
  })
  child.stdin.on('error', () => {})
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Migration kernel lock probe timed out')),
        10000
      )
      const fail = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      child.once('error', fail)
      child.once('exit', () =>
        fail(
          new Error(
            `Migration kernel lock unavailable or active; POSIX requires python3 with fcntl. ${diagnostic.trim()}`
          )
        )
      )
      child.stdout.on('data', (chunk) => {
        output += chunk
        if (output === 'locked\n' || output === 'locked\r\n') {
          clearTimeout(timer)
          resolve()
        }
      })
      child.stdin.write(`${path}\n`)
    })
  } catch (error) {
    child.stdin.destroy()
    if (!ended) child.kill()
    throw error
  }
  return {
    assertHeld() {
      if (ended || child.exitCode !== null)
        throw new Error('Migration kernel lock helper exited; operation stopped')
    },
    async release() {
      child.stdin.end()
      await exited
    }
  }
}
