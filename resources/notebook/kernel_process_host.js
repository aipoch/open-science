// Crash-safe admission host for persistent notebook kernels. It atomically promotes the parent's
// pending ownership intent to an active, PID-addressable receipt before starting the actual loop.
// A restarted main process can atomically cancel a still-pending host; only the winner may proceed.
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const [, , pendingPath, receiptId, executable, ...args] = process.argv
if (!pendingPath || !receiptId || !executable) process.exit(125)

const pendingSuffix = `.pending.${receiptId}.json`
if (!pendingPath.endsWith(pendingSuffix)) process.exit(125)
const activePath = `${pendingPath.slice(0, -pendingSuffix.length)}.active.${process.pid}.${receiptId}.json`

try {
  try {
    fs.renameSync(pendingPath, activePath)
  } catch (error) {
    if (error.code !== 'ENOENT' || !fs.existsSync(activePath)) throw error
  }
  const record = JSON.parse(fs.readFileSync(activePath, 'utf8'))
  if (record.receiptId !== receiptId || (record.pid !== undefined && record.pid !== process.pid)) {
    process.exit(125)
  }
  const updated = { ...record, pid: process.pid, commandIdentityMarker: receiptId }
  const temporary = `${activePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
  const descriptor = fs.openSync(temporary, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, activePath)
} catch {
  // Recovery may have atomically claimed the pending intent first. In that case this host never
  // crosses admission and must not start a kernel.
  process.exit(125)
}

const inheritedDescriptors = Number(process.env.OPEN_SCIENCE_KERNEL_INHERITED_FDS || '0')
const stdio = ['inherit', 'inherit', 'inherit']
for (let index = 0; index < inheritedDescriptors; index += 1) stdio.push('inherit')

const child = spawn(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio,
  windowsHide: true
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try {
      child.kill(signal)
    } catch {
      // A concurrent child exit already completed the requested stop.
    }
  })
}

child.once('error', () => process.exit(126))
child.once('exit', (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal)
    } catch {
      process.exit(1)
    }
    return
  }
  process.exit(code ?? 1)
})
