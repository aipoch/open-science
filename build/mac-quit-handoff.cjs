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
const label = 'com.aipoch.open-science.ShipIt'
const reopenWaitMs = 60_000

// Each peer sends one newline-terminated handshake, then keeps the socket open until release.
function readHandoffLine(peer, onLine) {
  let pending = Buffer.alloc(0)
  function receive(chunk) {
    const newline = chunk.indexOf(0x0a)
    const fragment = newline === -1 ? chunk : chunk.subarray(0, newline)
    if (pending.length + fragment.length > 1024) {
      peer.off('data', receive)
      peer.destroy()
      return
    }
    pending = Buffer.concat([pending, fragment])
    if (newline === -1) return
    peer.off('data', receive)
    onLine(pending.toString('utf8'))
  }
  peer.on('data', receive)
}

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

function missing(path) {
  return fs.lstat(path).then(
    () => false,
    (error) => error.code === 'ENOENT'
  )
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

async function watch(bundle) {
  const [cache, targetVersion] = args
  if (!targetVersion) return
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
  const originalBundle = await fs.lstat(bundle)
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
    readHandoffLine(peer, (message) => {
      if (!accepting || message !== 'reopen') return peer.destroy()
      firstOpen ??= performance.now()
      peer.write(JSON.stringify({ targetVersion }) + '\n')
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
  // Pin the original directory before the GUI exits. The child releases it on EOF, including
  // observer crashes. It consults Foundation only after a stopped installer and a missing target.
  const witness = spawn(
    join(bundle, 'Contents/MacOS/mac-open-after-update'),
    ['--check-trashed-install'],
    {
      cwd: bundle,
      stdio: ['pipe', 'ignore', 'ignore']
    }
  )
  witness.stdin.on('error', () => {})
  const trashed = new Promise((resolve) => {
    witness.once('error', () => resolve(false))
    witness.once('exit', (code) => resolve(code === 0))
  })
  const shipItPath = await fs
    .realpath(join(bundle, 'Contents/Frameworks/Squirrel.framework/Resources/ShipIt'))
    .catch(() => null)
  try {
    let announced = false
    const deadline = performance.now() + 120_000
    let installerPid
    let installerProgram
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
        if (pid && program && (await fs.realpath(program[1]).catch(() => '')) === shipItPath) {
          installerPid = Number(pid[1])
          installerProgram = program[1]
        }
      } else if (installerPid && !alive(installerPid) && !alive(Number(parentPid))) {
        // A successful install removes this directory itself. Only reclaim an abandoned native
        // stage when its exact installer has exited and the original receipt still owns the inode.
        const finalJob = await run('/bin/launchctl', ['list', label], { timeout: 1000 }).catch(
          () => undefined
        )
        if (
          !finalJob ||
          /"PID" = \d+;/.test(finalJob.stdout) ||
          /"Program" = "([^"]+)";/.exec(finalJob.stdout)?.[1] !== installerProgram
        )
          break
        const targetMissing = await missing(bundle)
        let abandoned =
          (await sameFile(bundle, originalBundle)) && /"LastExitStatus" = 0;/.test(finalJob.stdout)
        if (targetMissing && /"LastExitStatus" = (?:0|19968);/.test(finalJob.stdout)) {
          // ShipIt reports EX_CONFIG (78 << 8) when its target disappears during signature checks.
          const timeout = setTimeout(() => witness.kill(), 2500)
          witness.stdin.end('T')
          try {
            abandoned = (await trashed) && (await missing(bundle))
          } finally {
            clearTimeout(timeout)
          }
        }
        if (
          abandoned &&
          (await fs.readFile(receiptPath, 'utf8').catch(() => '')) === receipt &&
          (await sameFile(directory, originalStage))
        )
          await fs.rm(directory, { recursive: true })
        break
      }
      if (!announced) {
        announced = true
        process.send('armed')
      }
      if (firstOpen !== undefined && performance.now() - firstOpen >= reopenWaitMs) release()
      await delay(150)
    }
  } finally {
    witness.stdin.end()
    release()
  }
}

async function reopen(bundle) {
  const originalExecutable = await fs.stat(executable)
  let sender
  let senderDone
  let targetVersion
  let request
  const peer = createConnection(socketPath)
  peer.on('connect', () => peer.write('reopen\n'))
  let armed = false
  let refused = false
  const timer = setTimeout(() => peer.destroy(), 1500)
  readHandoffLine(peer, (message) => {
    try {
      targetVersion = JSON.parse(message).targetVersion
    } catch {
      return peer.destroy()
    }
    if (typeof targetVersion !== 'string' || !targetVersion) return peer.destroy()
    // Load the native sender while A is still installed. B may predate this helper.
    sender = spawn(join(bundle, 'Contents/MacOS/mac-open-after-update'), [], {
      stdio: ['pipe', 'ignore', 'ignore']
    })
    sender.stdin.on('error', () => peer.destroy())
    senderDone = new Promise((resolve) => {
      sender.once('error', () => {
        peer.destroy()
        resolve(false)
      })
      sender.once('exit', (code) => resolve(code === 0))
    })
    sender.once('spawn', () => {
      clearTimeout(timer)
      process.on('message', (message) => {
        request = message
      })
      armed = true
      process.send('armed')
      peer.setTimeout(reopenWaitMs + 5_000, () => peer.destroy())
    })
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
    sender?.stdin.end()
    if (refused) await clearStaleSocket()
    return
  }
  // The initiating Electron PID must really have exited. Never launch an app that the user has
  // moved away or replaced with an unrelated bundle while ShipIt was working.
  for (let i = 0; i < 40 && alive(Number(parentPid)); i++) await delay(50)
  if (alive(Number(parentPid)) || !request) {
    sender.stdin.end()
    return
  }
  const replaced = !(await sameFile(executable, originalExecutable))
  if (replaced)
    await run(
      '/usr/bin/codesign',
      [
        '--verify',
        '-R=identifier "com.aipoch.open-science" and anchor apple generic and certificate leaf[subject.OU] = "87G9WFU9H3"',
        bundle
      ],
      { timeout: 15_000 }
    )
  const installed =
    replaced &&
    (
      await run(
        '/usr/bin/plutil',
        ['-extract', 'CFBundleShortVersionString', 'raw', join(bundle, 'Contents/Info.plist')],
        { timeout: 3000 }
      )
    ).stdout.trim() === targetVersion
  // A failed replacement must never deliver a document or browser transfer to the old version.
  sender.stdin.end(
    JSON.stringify({
      bundle,
      args: request.args,
      urls: installed ? request.urls : [],
      // A plain activation is satisfied by reopening the current app.
      openInterrupted: !installed && request.urls.some((url) => url !== 'open-science://open')
    })
  )
  if (!(await senderDone)) process.exitCode = 1
}

if (require.main === module) {
  const bundle = dirname(dirname(dirname(executable)))
  const handoff = mode === 'watch' ? watch(bundle) : reopen(bundle)
  handoff.catch(() => {
    // Close the native sender's pipe on a verification error as well.
    process.exit(1)
  })
}

module.exports = { readHandoffLine }
