/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { inflateSync } = require('node:zlib')
const { Buffer } = require('node:buffer')

const MiB = 1024 * 1024
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const digest = /^[A-Za-z0-9+/]{86}==$/
const within = (value, limit) => Number.isSafeInteger(value) && value > 0 && value <= limit

async function hashFile(file, signal) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('base64')
}

function worker(executable, args, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' })
    const cancel = () => child.kill()
    signal.addEventListener('abort', cancel, { once: true })
    child.once('error', reject)
    child.once('close', (code) => {
      signal.removeEventListener('abort', cancel)
      if (signal.aborted) reject(signal.reason)
      else if (code === 0) resolve()
      else reject(new Error('Windows delta worker failed (' + code + ')'))
    })
  })
}

async function downloadPatch(url, bytes, fetch, headers, signal, progress) {
  const response = await fetch(url.href, {
    headers,
    signal,
    credentials: 'omit',
    redirect: 'error'
  })
  if (!response.ok || !response.body) throw new Error('Unavailable Windows delta')
  const buffer = Buffer.allocUnsafe(bytes)
  let offset = 0
  const start = Date.now()
  for await (const chunk of response.body) {
    if (offset + chunk.length > bytes) throw new Error('Oversized Windows delta')
    buffer.set(chunk, offset)
    offset += chunk.length
    progress?.({
      bytesPerSecond: Math.round((offset * 1000) / Math.max(1, Date.now() - start)),
      delta: chunk.length,
      percent: (offset * 100) / bytes,
      total: bytes,
      transferred: offset
    })
  }
  if (offset !== bytes) throw new Error('Incomplete Windows delta')
  return buffer
}

async function applyWindowsDelta({
  fileInfo,
  from,
  target,
  oldFile,
  destination,
  token,
  fetch,
  headers,
  progress,
  logger,
  executable = path.join(__dirname, 'windows-delta.exe')
}) {
  const meta = fileInfo.info.windowsDelta
  const installer = fileInfo.info
  if (
    !meta ||
    meta.format !== 1 ||
    !stable.test(from) ||
    !stable.test(target) ||
    from !== meta.from ||
    fileInfo.url.protocol !== 'https:' ||
    !fileInfo.url.pathname.endsWith('-win-x64-setup.exe') ||
    !within(meta.size, 64 * MiB) ||
    !within(installer.size, 2048 * MiB) ||
    meta.size >= installer.size ||
    !within(meta.oldViewSize, 2048 * MiB) ||
    !within(meta.newViewSize, 2048 * MiB) ||
    ![meta.sha512, meta.sourceSha512, installer.sha512].every(
      (value) => typeof value === 'string' && digest.test(value)
    )
  )
    return false

  const controller = new AbortController()
  const { signal } = controller
  const cancel = () => controller.abort()
  token.onCancel(cancel)
  let temp
  try {
    signal.throwIfAborted()
    await fs.access(executable)
    const volume = await fs.statfs(path.dirname(destination), { bigint: true })
    const needed = meta.oldViewSize + meta.newViewSize + installer.size + meta.size + 32 * MiB
    if (
      volume.bavail * volume.bsize < BigInt(needed) ||
      (await hashFile(oldFile, signal)) !== meta.sourceSha512
    )
      return false
    const url = new URL(fileInfo.url)
    url.pathname += '.from-' + from + '.wex'
    const data = await downloadPatch(url, meta.size, fetch, headers, signal, progress)
    if (createHash('sha512').update(data).digest('base64') !== meta.sha512)
      throw new Error('Windows delta checksum mismatch')
    const length = data.readUInt32LE(0)
    const header = data.subarray(4, 4 + length)
    if (
      length <= 132 ||
      length > MiB ||
      4 + length >= data.length ||
      header.toString('ascii', 0, 4) !== 'WEX1' ||
      header.toString('base64', 4, 68) !== meta.sourceSha512 ||
      header.toString('base64', 68, 132) !== installer.sha512
    )
      throw new Error('Invalid Windows delta header')
    const rows = JSON.parse(
      inflateSync(header.subarray(132), { maxOutputLength: 4 * MiB }).toString('utf8')
    )
    if (!Array.isArray(rows) || rows.length > 100000) throw new Error('Invalid Windows delta plan')
    const plan = Buffer.alloc(rows.length * 12)
    for (const [index, row] of rows.entries()) {
      if (
        !Array.isArray(row) ||
        row.length !== 3 ||
        !row.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 2048 * MiB)
      )
        throw new Error('Invalid Windows delta region')
      row.forEach((value, column) => plan.writeUInt32LE(value, index * 12 + column * 4))
    }
    temp = await fs.mkdtemp(path.join(path.dirname(destination), 'windows-delta-'))
    const local = (name) => path.join(temp, name)
    await fs.writeFile(local('regions'), plan)
    await fs.writeFile(local('delta'), data.subarray(4 + length))
    await worker(executable, ['basis', oldFile, local('regions'), local('old')], signal)
    if ((await fs.stat(local('old'))).size !== meta.oldViewSize)
      throw new Error('Unexpected Windows delta basis size')
    await worker(executable, ['patch', local('old'), local('delta'), local('new')], signal)
    if ((await fs.stat(local('new'))).size !== meta.newViewSize)
      throw new Error('Unexpected Windows delta output size')
    await fs.unlink(local('old'))
    await worker(
      executable,
      ['restore', local('new'), local('setup'), String(installer.size)],
      signal
    )
    if ((await hashFile(local('setup'), signal)) !== installer.sha512)
      throw new Error('Reconstructed installer checksum mismatch')
    signal.throwIfAborted()
    // The stock downloader fetches the versioned blockmap again if its cache is empty.
    await fs.rm(path.join(path.dirname(destination), 'current.blockmap'), { force: true })
    await fs.rm(path.join(path.dirname(oldFile), 'current.blockmap'), { force: true })
    await fs.rename(local('setup'), destination)
    return true
  } catch (error) {
    if (signal.aborted) throw error
    logger.warn('Windows delta unavailable, using blockmap: ' + error.message)
    return false
  } finally {
    cancel()
    token.removeListener('cancel', cancel)
    if (temp) await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 })
  }
}

module.exports = { applyWindowsDelta }
