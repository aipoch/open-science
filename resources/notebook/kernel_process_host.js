// Crash-safe admission host for persistent notebook kernels. It atomically promotes the parent's
// pending ownership intent to an active, PID-addressable receipt before starting the actual loop.
// A restarted main process can atomically cancel a still-pending host; only the winner may proceed.
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { Socket } = require('node:net')
const { join, win32 } = require('node:path')

const [, , pendingPath, receiptId, ...launchArgs] = process.argv
const childEnv = { ...process.env }
if (launchArgs[0] === '--restore-electron-run-as-node') {
  launchArgs.shift()
  try {
    const original = JSON.parse(launchArgs.shift())
    if (original === null) delete childEnv.ELECTRON_RUN_AS_NODE
    else if (typeof original === 'string') childEnv.ELECTRON_RUN_AS_NODE = original
    else process.exit(125)
  } catch {
    process.exit(125)
  }
}
const [executable, ...args] = launchArgs
if (!pendingPath || !receiptId || !executable) process.exit(125)

const pendingSuffix = `.pending.${receiptId}.json`
if (!pendingPath.endsWith(pendingSuffix)) process.exit(125)
const activePath = `${pendingPath.slice(0, -pendingSuffix.length)}.active.${process.pid}.${receiptId}.json`
const jobName =
  process.platform === 'win32' ? `Local\\OpenScience.Delegation.${receiptId}` : undefined

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
  const updated = {
    ...record,
    pid: process.pid,
    commandIdentityMarker: receiptId,
    ...(jobName ? { jobName } : {})
  }
  const temporary = `${activePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 })
  const descriptor = fs.openSync(temporary, 'r+')
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

function spawnContainedWindowsChild() {
  if (inheritedDescriptors !== 0) throw new Error('Unexpected Windows inherited descriptors')
  // Scripts and .node files are both unpacked in desktop packages; their package's JS entry
  // can remain in app.asar, which ordinary Node cannot resolve from this executable script.
  const native = require(
    join(
      __dirname,
      '../../node_modules/@aipoch/process-tree-native/build/Release/process_tree_native.node'
    )
  )
  const command = win32.isAbsolute(executable)
    ? executable
    : [process.cwd(), ...(childEnv.PATH ?? childEnv.Path ?? '').split(';')]
        .flatMap((directory) => [
          win32.resolve(directory, executable),
          win32.resolve(directory, `${executable}.exe`)
        ])
        .find((candidate) => fs.existsSync(candidate))
  if (!command) throw new Error('Windows host executable is unavailable')
  const environment = Object.keys(childEnv)
    .sort()
    .filter((key) => childEnv[key] !== undefined)
    .map((key) => `${key}=${childEnv[key]}`)
  const owned = native.spawnWindowsOwnedProcess(
    jobName,
    command,
    args,
    environment,
    process.cwd(),
    false
  )
  const child = new EventEmitter()
  const streams = owned.fds.map(
    (fd, index) => new Socket({ fd, readable: index !== 0, writable: index === 0 })
  )
  process.stdin.pipe(streams[0])
  streams[1].pipe(process.stdout, { end: false })
  streams[2].pipe(process.stderr, { end: false })
  streams.forEach((stream) => stream.on('error', () => native.reapWindowsOwnedJob(jobName)))
  child.kill = () => native.reapWindowsOwnedJob(jobName)
  const poll = setInterval(() => {
    const code = native.windowsOwnedProcessExitCode(owned.handle)
    if (code === null || !native.reapWindowsOwnedJob(jobName)) return
    clearInterval(poll)
    streams[0].destroy()
    // Drain output before reporting completion. The named Job has already confirmed all members
    // exited, including descendants whose intermediate parent exited before recovery began.
    Promise.all(
      streams
        .slice(1)
        .map((stream) =>
          stream.destroyed ? undefined : new Promise((resolve) => stream.once('close', resolve))
        )
    ).then(() => child.emit('exit', code))
  }, 20)
  return child
}

const child =
  process.platform === 'win32'
    ? spawnContainedWindowsChild()
    : spawn(executable, args, {
        cwd: process.cwd(),
        // Shell callers need Node mode for this Electron host only, not for the user's command.
        // Existing kernel callers keep their original environment unless they request restoration.
        env: childEnv,
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

const finish = (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal)
    } catch {
      process.exit(1)
    }
    return
  }
  process.exit(code ?? 1)
}

// Only the parent can create this IPC channel. It is not inherited by the workload, and stdout is
// never used as containment evidence. A wrapper killed before native-host exit sends no receipt.
const reportExit = (code, signal) => {
  if (process.send) process.send('kernel-child-exited', () => finish(code, signal))
  else finish(code, signal)
}
child.once('error', () => reportExit(126))
child.once('exit', reportExit)
