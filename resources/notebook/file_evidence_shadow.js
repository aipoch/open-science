'use strict'

const fs = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const { dirname, join } = require('node:path')
const { deflateRawSync, inflateRawSync } = require('node:zlib')

const directoryName = '.shadow-evidence'
const projectMarker = '.shadow-evidence-v1'
const digestPattern = /^[a-f0-9]{64}$/u
const maxBytes = 64 * 1024 * 1024
const graceMs = 14 * 24 * 3600 * 1000
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const metadata = (path) => fs.lstatSync(path, { throwIfNoEntry: false })
const requireDirectory = (path) => {
  if (!metadata(path)?.isDirectory()) throw new Error('Unsafe shadow evidence directory.')
}
const ensureDirectory = (path, syncDirectory) => {
  if (!metadata(path)) {
    fs.mkdirSync(path, { mode: 0o700 })
    syncDirectory(dirname(path))
  }
  requireDirectory(path)
}
const checkCapacity = (path, size, reserve) => {
  const { bavail, bsize } = fs.statfsSync(path)
  if (size > maxBytes || bavail * bsize - size < reserve)
    throw new Error('Insufficient space for shadow evidence.')
}
const sorted = (files) => [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
const list = (files) => sorted(files).map(([path, [checksum, size]]) => [path, checksum, size])
const asMap = (rows) => new Map(rows.map(([path, checksum, size]) => [path, [checksum, size]]))

// The caller binds the lane and serializes each worker request. Never resolve a delta outside it.
const readView = (views, hash, readFile, depth = 0) => {
  if (depth > 64 || !digestPattern.test(hash)) throw new Error('Invalid shadow evidence view.')
  const body = JSON.parse(readFile(join(views, hash), maxBytes))
  let rows = body.rows
  let chain = 0
  if (!rows) {
    const base = readView(views, body.base, readFile, depth + 1)
    const files = asMap(base.rows)
    for (const path of body.removed) files.delete(path)
    for (const [path, checksum, size] of body.changed) files.set(path, [checksum, size])
    rows = list(files)
    chain = base.chain + 1
  }
  if (digest(JSON.stringify(rows)) !== hash)
    throw new Error('Shadow evidence view checksum mismatch.')
  return { rows, hash, chain }
}
const putView = (views, rows, base, io) => {
  const hash = digest(JSON.stringify(rows))
  const path = join(views, hash)
  if (metadata(path)) return readView(views, hash, io.readFile)
  let body = { rows }
  let chain = 0
  if (base && base.chain < 64) {
    const before = asMap(base.rows)
    const changed = []
    for (const row of rows) {
      const previous = before.get(row[0])
      if (previous?.[0] !== row[1] || previous?.[1] !== row[2]) changed.push(row)
      before.delete(row[0])
    }
    const delta = { base: base.hash, changed, removed: [...before.keys()] }
    if (JSON.stringify(delta).length < JSON.stringify(body).length) {
      body = delta
      chain = base.chain + 1
    }
  }
  const encoded = JSON.stringify(body)
  checkCapacity(views, Buffer.byteLength(encoded), io.reserveBytes)
  const temp = join(views, '.tmp-' + randomUUID())
  try {
    io.writeExclusive(temp, encoded)
    fs.renameSync(temp, path)
    io.syncDirectory(views)
  } finally {
    fs.rmSync(temp, { force: true })
  }
  return { rows, hash, chain }
}

// Only the append path can repair a torn tail. GC is read-only. Offsets count raw bytes,
// including a Windows zero-filled suffix after the last newline.
const scanLog = (path, io, visit) => {
  if (!metadata(path)) return { length: 0, complete: 0 }
  const bytes = io.readFile(path, maxBytes)
  let start = 0
  while (start < bytes.length) {
    const end = bytes.indexOf(10, start)
    if (end < 0) break
    const line = bytes.subarray(start, end)
    const tab = line.lastIndexOf(9)
    if (tab < 0 || digest(line.subarray(0, tab)) !== line.subarray(tab + 1).toString())
      throw new Error('Shadow evidence log checksum mismatch.')
    const record = JSON.parse(line.subarray(0, tab))
    if (record.version !== 1 || !digestPattern.test(record.pre) || !digestPattern.test(record.post))
      throw new Error('Invalid shadow evidence record.')
    visit(record)
    start = end + 1
  }
  return { length: bytes.length, complete: start }
}
const append = (lane, capture, sidecar, serialized, io) => {
  const marker = join(io.projectRoot, projectMarker)
  if (!metadata(marker)) {
    io.writeExclusive(marker, '')
    io.syncDirectory(io.projectRoot)
  }
  const root = join(lane, directoryName)
  ensureDirectory(root, io.syncDirectory)
  const views = join(root, 'views')
  ensureDirectory(views, io.syncDirectory)
  const log = join(root, 'log.jsonl')
  let previous
  let existing
  const { length, complete } = scanLog(log, io, (record) => {
    previous = record.post
    if (record.activityId === sidecar.activityId) existing = record.checksum
  })
  const checksum = digest(serialized)
  if (existing && existing !== checksum) throw new Error('Conflicting shadow evidence publication.')
  const files = new Map()
  const observe = (relation) => {
    const g = relation.generation
    if (g) files.set(g.relativePath, [g.checksum, g.sizeBytes])
    else files.delete(relation.relativePath)
  }
  for (const relation of capture.relations) observe(relation)
  const base = previous ? readView(views, previous, io.readFile) : undefined
  const pre = putView(views, list(files), base, io)
  for (const relation of sidecar.relations) {
    if (relation.relation !== 'present-before') observe(relation)
  }
  const post = putView(views, list(files), pre, io)
  const indexes = [pre, post].map(
    (view) => new Map(view.rows.map(([path, sum], index) => [path, { sum, index }]))
  )
  const encode = (g) => {
    for (let view = 0; view < indexes.length; view++) {
      const entry = indexes[view].get(g.relativePath)
      if (entry?.sum === g.checksum) return [view, entry.index, g.generationId, g.capturedAt]
    }
    throw new Error('Generation missing from shadow views.')
  }
  const packed = mapGenerations(sidecar, encode)
  const record = {
    version: 1,
    activityId: sidecar.activityId,
    pre: pre.hash,
    post: post.hash,
    checksum,
    projection: deflateRawSync(JSON.stringify(packed)).toString('base64')
  }
  const prefix = io.storageKeyPrefix
  if (!projectSidecar(record, [pre.rows, post.rows], prefix).equals(serialized))
    throw new Error('Shadow evidence projection differs from native evidence.')
  const json = JSON.stringify(record)
  const line = Buffer.from(json + '\t' + digest(json) + '\n')
  if (!existing && complete + line.length > maxBytes)
    throw new Error('Shadow evidence log exceeds its limit.')
  if (!existing) checkCapacity(root, line.length, io.reserveBytes)
  const fd = fs.openSync(
    log,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600
  )
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== length)
      throw new Error('Shadow log changed during publication.')
    if (complete !== length) fs.ftruncateSync(fd, complete)
    if (!existing) {
      let offset = 0
      while (offset < line.length) {
        const written = fs.writeSync(fd, line, offset, line.length - offset, complete + offset)
        if (!written) throw new Error('Shadow log append made no progress.')
        offset += written
      }
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  io.syncDirectory(root)
}
const mapGenerations = (sidecar, transform) => {
  const result = { ...sidecar }
  result.relations = sidecar.relations.map((r) =>
    r.generation ? { ...r, generation: transform(r.generation) } : r
  )
  if (sidecar.predecessorGenerations)
    result.predecessorGenerations = sidecar.predecessorGenerations.map(transform)
  return result
}

const projectSidecar = (record, views, activityPrefix) => {
  const packed = JSON.parse(
    inflateRawSync(Buffer.from(record.projection, 'base64'), { maxOutputLength: maxBytes })
  )
  const sidecar = mapGenerations(packed, ([view, index, generationId, capturedAt]) => {
    const [relativePath, checksum, sizeBytes] = views[view][index]
    return {
      generationId,
      relativePath,
      checksum,
      sizeBytes,
      contentStorageKey: activityPrefix + '/blobs/sha256-' + checksum,
      capturedAt
    }
  })
  const bytes = Buffer.from(JSON.stringify(sidecar, null, 2) + '\n')
  if (digest(bytes) !== record.checksum)
    throw new Error('Shadow evidence projection checksum mismatch.')
  return bytes
}

const protectedBlobs = (pool, io) => {
  const live = new Set()
  const project = dirname(pool.path)
  const active = Boolean(metadata(join(project, projectMarker)))
  if (!/^execution-file-evidence\/[^/]+\/blobs$/u.test(pool.storageKeyPrefix))
    return { live, active: false }
  if (!active) return { live, active }
  const markLane = (lane) => {
    io.markPending(lane, live)
    const root = join(lane, directoryName)
    if (!metadata(root)) return
    requireDirectory(root)
    const views = join(root, 'views')
    requireDirectory(views)
    const hashes = new Set()
    scanLog(join(root, 'log.jsonl'), io, (record) => {
      hashes.add(record.pre)
      hashes.add(record.post)
    })
    for (const hash of hashes) {
      for (const [, checksum] of readView(views, hash, io.readFile).rows)
        live.add('sha256-' + checksum)
    }
  }
  for (const entry of fs.readdirSync(project, { withFileTypes: true })) {
    if (entry.name === 'blobs' || !entry.isDirectory()) continue
    const session = join(project, entry.name)
    markLane(session)
    const frames = join(session, 'frames')
    if (!metadata(frames)) continue
    requireDirectory(frames)
    for (const frame of fs.readdirSync(frames, { withFileTypes: true })) {
      if (frame.isDirectory()) markLane(join(frames, frame.name))
    }
  }
  return { live, active }
}
module.exports = { append, directoryName, graceMs, protectedBlobs, projectMarker }
