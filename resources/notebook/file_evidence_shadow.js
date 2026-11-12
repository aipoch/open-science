'use strict'

const fs = require('node:fs')
const { expandProjection, mapGenerations } = require('./file_evidence_codec.mjs')
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
const planView = (views, rows, base, io) => {
  const hash = digest(JSON.stringify(rows))
  const path = join(views, hash)
  if (base?.hash === hash) return base
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
  return { rows, hash, chain, encoded }
}
const publishView = (views, view, io) => {
  if (!view.encoded) return
  const temp = join(views, '.tmp-' + randomUUID())
  try {
    io.writeExclusive(temp, view.encoded)
    fs.renameSync(temp, join(views, view.hash))
    io.syncDirectory(views)
  } finally {
    fs.rmSync(temp, { force: true })
  }
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
const logIdentity = (stat) =>
  stat && [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

const observeLog = (path) =>
  logIdentity(fs.lstatSync(path, { bigint: true, throwIfNoEntry: false }))

const scanForAppend = (log, activityId, io) => {
  const identity = observeLog(log)
  let previous
  let match
  let duplicate = false
  const committedViews = new Set()
  const offsets = scanLog(log, io, (record) => {
    committedViews.add(record.pre)
    committedViews.add(record.post)
    previous = record.post
    if (record.activityId === activityId) {
      duplicate = Boolean(match)
      match = record
    }
  })
  if (observeLog(log) !== identity) throw new Error('Shadow log changed during publication.')
  return { ...offsets, identity, previous, match, duplicate, committedViews }
}

const append = (lane, capture, sidecar, serialized, io) => {
  const marker = join(io.projectRoot, projectMarker)
  if (!io.verifyOnly && !metadata(marker)) {
    io.writeExclusive(marker, '')
    io.syncDirectory(io.projectRoot)
  }
  const root = join(lane, directoryName)
  if (!io.verifyOnly) ensureDirectory(root, io.syncDirectory)
  else if (metadata(root)) requireDirectory(root)
  const views = join(root, 'views')
  if (!io.verifyOnly) ensureDirectory(views, io.syncDirectory)
  else if (metadata(views)) requireDirectory(views)
  const log = join(root, 'log.jsonl')
  const { length, complete, previous, committedViews, match, identity } =
    io.appendState ?? scanForAppend(log, sidecar.activityId, io)
  if (io.appendState && observeLog(log) !== identity)
    throw new Error('Shadow log changed during publication.')
  const existing = match?.checksum
  // v1 only encodes a delta against this record's pre-view or the previous
  // committed post-view. Every committed base is itself named in the verified log.
  // Clean only our unpublished files, under the same worker queue that writes them.
  for (const file of io.verifyOnly ? [] : fs.readdirSync(views, { withFileTypes: true })) {
    if (
      file.isFile() &&
      !committedViews.has(file.name) &&
      (digestPattern.test(file.name) || /^\.tmp-[0-9a-f-]{36}$/u.test(file.name))
    )
      fs.unlinkSync(join(views, file.name))
  }
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
  // Previous is only a compression base. Each activity must preserve the pre-state
  // captured at its own begin, including overlapping runs completed in reverse order.
  const pre = planView(views, list(files), base, io)
  for (const relation of sidecar.relations) {
    if (relation.relation !== 'present-before') observe(relation)
  }
  const post = planView(views, list(files), pre, io)
  const indexes = [pre, post].map(
    (view) => new Map(view.rows.map(([path, sum], index) => [path, { sum, index }]))
  )
  const encode = (g) => {
    for (let view = 0; view < indexes.length; view++) {
      const entry = indexes[view].get(g.relativePath)
      if (entry?.sum === g.checksum) return [view, entry.index, g.generationId, g.capturedAt]
    }
    if (io.publishHistoricalContent) return null
    throw new Error('Generation missing from shadow views.')
  }
  const packed = mapGenerations(sidecar, encode)
  if (
    io.publishHistoricalContent &&
    (packed.relations.some((r) => r.generation === null) ||
      packed.predecessorGenerations?.includes(null))
  )
    return
  const record = {
    version: 1,
    ...(io.poolAddressed ? { poolAddressed: true } : {}),
    activityId: sidecar.activityId,
    pre: pre.hash,
    post: post.hash,
    checksum,
    projection: deflateRawSync(JSON.stringify(packed)).toString('base64')
  }
  const prefix = io.storageKeyPrefix
  const projected = decodeSidecar(record, [pre.rows, post.rows], prefix)
  if (!projected.equals(serialized)) {
    if (io.publishHistoricalContent) return
    throw new Error('Shadow evidence projection differs from native evidence.')
  }
  const json = JSON.stringify(record)
  const line = Buffer.from(json + '\t' + digest(json) + '\n')
  if (!existing && complete + line.length > maxBytes)
    throw new Error('Shadow evidence log exceeds its limit.')
  const planned = pre.hash === post.hash ? [pre] : [pre, post]
  const added = planned.reduce(
    (sum, view) => sum + Buffer.byteLength(view.encoded ?? ''),
    existing ? 0 : line.length
  )
  if (!Number.isFinite(io.projectLimit) || io.projectUsage() + added > io.projectLimit)
    throw new Error('Shadow evidence exceeds the project budget.')
  checkCapacity(lane, added, io.reserveBytes)
  if (io.verifyOnly) return
  io.publishHistoricalContent?.(views)
  for (const view of planned) publishView(views, view, io)
  const fd = fs.openSync(
    log,
    (identity === undefined ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0) |
      fs.constants.O_RDWR |
      fs.constants.O_NOFOLLOW,
    0o600
  )
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.size !== BigInt(length) ||
      (identity !== undefined && logIdentity(stat) !== identity)
    )
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
const decodeSidecar = (record, views, activityPrefix) => {
  const packed = JSON.parse(
    inflateRawSync(Buffer.from(record.projection, 'base64'), { maxOutputLength: maxBytes })
  )
  return expandProjection(packed, views, activityPrefix)
}
const projectSidecar = (record, views, activityPrefix) => {
  const bytes = decodeSidecar(record, views, activityPrefix)
  if (digest(bytes) !== record.checksum)
    throw new Error('Shadow evidence projection checksum mismatch.')
  return bytes
}

// Settlement owns this scan synchronously; preflight and retries obtain a fresh one.
const inspectNativePublication = (lane, id, prefix, io) => {
  const root = join(lane, directoryName)
  if (metadata(root)) requireDirectory(root)
  const appendState = scanForAppend(join(root, 'log.jsonl'), id, io)
  const record = appendState.match
  if (!record) return { appendState }
  if (!record.poolAddressed || appendState.duplicate)
    throw new Error('Conflicting native evidence record.')
  const views = join(root, 'views')
  requireDirectory(views)
  return {
    committed: projectSidecar(
      record,
      [record.pre, record.post].map((hash) => readView(views, hash, io.readFile).rows),
      prefix
    )
  }
}
const visitLanes = (project, visit) => {
  for (const entry of fs.readdirSync(project, { withFileTypes: true })) {
    if (entry.name === 'blobs' || !entry.isDirectory()) continue
    const session = join(project, entry.name)
    visit(session)
    const frames = join(session, 'frames')
    if (!metadata(frames)) continue
    requireDirectory(frames)
    for (const frame of fs.readdirSync(frames, { withFileTypes: true })) {
      if (frame.isDirectory()) visit(join(frames, frame.name))
    }
  }
}

// Count private view and log bytes across all lanes sharing the pool budget. Never
// descend through arbitrary entries in an evidence directory.
const projectBytes = (pool, includeUnactivated = false) => {
  const project = dirname(pool.path)
  if (
    !/^execution-file-evidence\/[^/]+\/blobs$/u.test(pool.storageKeyPrefix) ||
    (!includeUnactivated && !metadata(join(project, projectMarker)))
  )
    return 0
  let bytes = 0
  visitLanes(project, (lane) => {
    const root = join(lane, directoryName)
    if (!metadata(root)) return
    requireDirectory(root)
    const log = metadata(join(root, 'log.jsonl'))
    if (log?.isFile()) bytes += log.size
    const views = join(root, 'views')
    if (!metadata(views)) return
    requireDirectory(views)
    for (const file of fs.readdirSync(views, { withFileTypes: true })) {
      if (file.isFile()) bytes += fs.lstatSync(join(views, file.name)).size
    }
  })
  return bytes
}

const protectedBlobs = (pool, io) => {
  const live = new Set()
  const project = dirname(pool.path)
  const active = Boolean(metadata(join(project, projectMarker)))
  if (!/^execution-file-evidence\/[^/]+\/blobs$/u.test(pool.storageKeyPrefix))
    return { live, active: false }
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
  visitLanes(project, markLane)
  return { live, active }
}
module.exports = {
  append,
  inspectNativePublication,
  directoryName,
  graceMs,
  protectedBlobs,
  projectMarker,
  projectBytes
}
