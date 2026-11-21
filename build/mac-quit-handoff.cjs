/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Standalone CommonJS for the packaged Node runtime. */
// Runs in the app's bundled Node outside Electron. ShipIt refuses to replace a running GUI app.
const { execFile, spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const { createConnection, createServer } = require('node:net')
const { basename, dirname, join } = require('node:path')
const { fileURLToPath } = require('node:url')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')

const run = promisify(execFile)
const [mode, socketPath, executable, parentPid, ...args] = process.argv.slice(2)
const bundle = dirname(dirname(dirname(executable)))
const label = 'com.aipoch.open-science.ShipIt'
const reopenWaitMs = 60_000

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function sameFile(path, original) {
  const current = await fs.lstat(path).catch(() => undefined)
  return current && current.dev === original.dev && current.ino === original.ino
}

// A crashed watcher can leave a Unix socket inode. Keep live peers and unrelated entries intact.
async function clearStaleSocket() {
  const entry = await fs.lstat(socketPath).catch(() => undefined)
  if (!entry?.isSocket() || entry.uid !== process.getuid()) return
  const probe = createConnection(socketPath)
  const stale = await new Promise((resolve) => {
    probe.once('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', (error) => resolve(error.code === 'ECONNREFUSED'))
  })
  if (stale && (await sameFile(socketPath, entry))) await fs.unlink(socketPath)
}

async function watch() {
  const [cache] = args
  const nativeCache = join(await fs.realpath(cache), label)
  if ((await fs.realpath(nativeCache)) !== nativeCache) return
  const receiptPath = join(nativeCache, 'ShipItState.plist')
  const receipt = await fs.readFile(receiptPath, 'utf8')
  const request = JSON.parse(receipt)
  if (
    request.launchAfterInstallation !== false ||
    request.bundleIdentifier !== 'com.aipoch.open-science' ||
    (await fs.realpath(fileURLToPath(request.targetBundleURL))) !== (await fs.realpath(bundle))
  )
    return
  const staged = fileURLToPath(request.updateBundleURL).replace(/\/$/, '')
  if ((await fs.realpath(staged)) !== staged) return
  const directory = dirname(staged)
  if (
    dirname(directory) !== nativeCache ||
    !/^update\.[A-Za-z0-9]+$/.test(basename(directory)) ||
    basename(staged) !== basename(bundle)
  )
    return
  const originalStage = await fs.lstat(directory)
  if (!originalStage.isDirectory() || originalStage.uid !== process.getuid()) return
  const peers = new Set()
  let accepting = true
  let firstOpen
  const server = createServer((peer) => {
    if (!accepting) return peer.destroy()
    peers.add(peer)
    peer.on('error', () => peer.destroy())
    peer.on('close', () => peers.delete(peer))
    peer.once('data', (message) => {
      if (!accepting || message.toString() !== 'reopen\n') return peer.destroy()
      firstOpen ??= performance.now()
      peer.write('waiting\n')
    })
  })
  await clearStaleSocket()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  const release = () => {
    if (!accepting) return
    accepting = false
    server.close()
    for (const peer of peers) peer.end()
    // Other installations can have active sockets in the same private directory.
    void fs.rmdir(dirname(socketPath)).catch(() => undefined)
  }
  process.send('armed')
  try {
    const deadline = performance.now() + 120_000
    let installerPid
    let nextJobCheck = 0
    while (performance.now() < deadline) {
      if (!(await sameFile(directory, originalStage))) break
      if (!installerPid && performance.now() >= nextJobCheck) {
        nextJobCheck = performance.now() + 1000
        // The receipt is shared across copies; pin the service executing inside this installation.
        const job = await run('/bin/launchctl', ['list', label], { timeout: 1000 }).catch(
          () => undefined
        )
        const pid = job && /"PID" = (\d+);/.exec(job.stdout)
        const program = job && /"Program" = "([^"]+)";/.exec(job.stdout)
        if (
          pid &&
          program &&
          (await fs.realpath(program[1]).catch(() => '')) ===
            (await fs
              .realpath(join(bundle, 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt'))
              .catch(() => null))
        )
          installerPid = Number(pid[1])
      } else if (installerPid && !alive(installerPid) && !alive(Number(parentPid))) {
        // A successful install removes this directory itself. Only reclaim an abandoned native
        // stage when its exact installer has exited and the original receipt still owns the inode.
        const finalJob = await run('/bin/launchctl', ['list', label], { timeout: 1000 }).catch(
          () => undefined
        )
        if (
          finalJob &&
          !/"PID" = \d+;/.test(finalJob.stdout) &&
          /"LastExitStatus" = 0;/.test(finalJob.stdout) &&
          (await fs.readFile(receiptPath, 'utf8').catch(() => '')) === receipt &&
          (await sameFile(directory, originalStage))
        )
          await fs.rm(directory, { recursive: true })
        break
      }
      if (firstOpen !== undefined && performance.now() - firstOpen >= reopenWaitMs) release()
      await delay(150)
    }
  } finally {
    release()
  }
}

async function reopen() {
  const originalExecutable = await fs.stat(executable)
  const peer = createConnection(socketPath)
  peer.on('connect', () => peer.write('reopen\n'))
  let armed = false
  let refused = false
  const timer = setTimeout(() => peer.destroy(), 1500)
  peer.once('data', (message) => {
    if (message.toString() !== 'waiting\n') return peer.destroy()
    clearTimeout(timer)
    armed = true
    process.send('armed')
    peer.setTimeout(reopenWaitMs + 5_000, () => peer.destroy())
  })
  await new Promise((resolve) => {
    peer.on('error', (error) => {
      refused = error.code === 'ECONNREFUSED'
      peer.destroy()
    })
    peer.once('close', resolve)
  })
  clearTimeout(timer)
  if (!armed) {
    if (refused) await clearStaleSocket()
    return
  }
  // The initiating Electron PID must really have exited. Never launch an app that the user has
  // moved away or replaced with an unrelated bundle while ShipIt was working.
  for (let i = 0; i < 40 && alive(Number(parentPid)); i++) await delay(50)
  if (alive(Number(parentPid))) return
  if (!(await sameFile(executable, originalExecutable)))
    await run(
      '/usr/bin/codesign',
      [
        '--verify',
        '-R=identifier "com.aipoch.open-science" and anchor apple generic and certificate leaf[subject.OU] = "87G9WFU9H3"',
        bundle
      ],
      { timeout: 15_000 }
    )
  spawn(executable, args, { detached: true, stdio: 'ignore' }).unref()
}

;(mode === 'watch' ? watch() : reopen()).catch(() => {
  process.exitCode = 1
})
