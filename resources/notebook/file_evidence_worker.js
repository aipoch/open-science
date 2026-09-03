'use strict'

const { createHash, randomUUID } = require('node:crypto')
const {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeSync
} = require('node:fs')
const { join } = require('node:path')

const MAX_REQUEST_BYTES = 64 * 1024 * 1024
const MAX_INTERNAL_JSON_BYTES = 64 * 1024 * 1024
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const ACTIVITY_KINDS = new Set(['notebook-run', 'compute-job'])
const RECEIPT_NAME = /^receipt-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u
const CAPTURE_FILE = 'capture.json'
const ACTIVITY_BLOBS_DIRECTORY = 'blobs'
const ownershipFile = (token) => `.ownership-${assertSafeName(token)}`
const projectOwnershipReceipt = (projectName) =>
  `.project-ownership-${assertSafeName(projectName)}.json`
const projectDeletionTombstone = (ownershipToken) => `deleting-${assertSafeName(ownershipToken)}`
const runDeletionTombstonePrefix = (ownershipToken, kind, legacyNotebook = false) =>
  `${legacyNotebook ? 'deleting-run' : 'deleting-activity'}-${assertSafeName(ownershipToken)}-${kind}`
const UUID_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const BLOB_NAME = /^sha256-[a-f0-9]{64}$/u
const BLOB_DELETION_TOMBSTONE_NAME =
  /^deleting-(sha256-[a-f0-9]{64})-([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u
const BASELINE_REASONS = [
  'file-reads-not-observed',
  'external-paths-not-observed',
  'remote-outputs-not-observed',
  'transient-files-not-captured',
  'delayed-writes-not-observed',
  'writer-not-isolated'
]

const fail = (message) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exitCode = 1
}

const identity = (value) => ({ dev: Number(value.dev), ino: Number(value.ino) })
const validIdentity = (value) => value && Number.isFinite(value.dev) && Number.isFinite(value.ino)
const sameIdentity = (left, right) =>
  validIdentity(left) && validIdentity(right) && left.dev === right.dev && left.ino === right.ino
const fingerprint = (value) =>
  [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':')
const quarantineFingerprint = (value) => [value.dev, value.ino, value.size, value.mtimeMs].join(':')
const uniqueReasons = (values) => [...new Set([...BASELINE_REASONS, ...values])].sort()
const assertSafeName = (value) => {
  if (!SAFE_NAME.test(value)) throw new Error(`Unsafe file-evidence name: ${value}`)
  return value
}
const assertActivityKind = (value) => {
  if (!ACTIVITY_KINDS.has(value)) throw new Error(`Unsafe file-evidence activity kind: ${value}`)
  return value
}
const assertReceiptName = (value) => {
  if (!RECEIPT_NAME.test(value)) throw new Error(`Unsafe file-evidence receipt name: ${value}`)
  return value
}
const assertStorageKeyPrefix = (value) => {
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value
      .split('/')
      .some((segment) => !SAFE_NAME.test(segment) || segment === '.' || segment === '..')
  ) {
    throw new Error('Unsafe file-evidence storage-key prefix.')
  }
  return value
}
const syncDirectoryPath = (path) => {
  try {
    const descriptor = openSync(path, constants.O_RDONLY)
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}
const syncDirectory = () => syncDirectoryPath('.')
const assertBoundRoot = (expected) => {
  const current = statSync('.')
  if (!current.isDirectory() || !sameIdentity(identity(current), expected)) {
    throw new Error('File-evidence worker is not bound to the expected directory.')
  }
}
const readRegularFile = (name, maxBytes) => {
  const descriptor = openSync(
    name,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  )
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new Error(`Invalid file-evidence file: ${name}`)
    }
    const result = Buffer.alloc(metadata.size)
    let position = 0
    while (position < result.length) {
      const bytesRead = readSync(descriptor, result, position, result.length - position, position)
      if (bytesRead === 0) break
      position += bytesRead
    }
    if (position !== result.length) throw new Error(`Truncated file-evidence file: ${name}`)
    return result
  } finally {
    closeSync(descriptor)
  }
}
const readJson = (name, maxBytes = MAX_INTERNAL_JSON_BYTES) =>
  JSON.parse(readRegularFile(name, maxBytes).toString('utf8'))
const writeExclusiveFile = (name, contents) => {
  // Windows FlushFileBuffers requires a writable handle. Reopening the exclusive file with
  // O_RDONLY makes fsync fail with EPERM even when the file itself is writable — the same
  // contract as src/main/storage/file-durability.ts.
  const descriptor = openSync(
    name,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  )
  try {
    const bytes = Buffer.from(contents, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset)
      if (written <= 0) throw new Error('Exclusive file-evidence write made no progress.')
      offset += written
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
const publishExclusiveFile = (name, contents) => {
  const temporaryName = `.publish-${randomUUID()}.tmp`
  try {
    writeExclusiveFile(temporaryName, contents)
    linkSync(temporaryName, name)
    rmSync(temporaryName, { force: true })
    syncDirectory()
  } finally {
    rmSync(temporaryName, { force: true })
  }
}
const replaceJson = (name, value) => {
  const temporaryName = `.receipt-${randomUUID()}.tmp`
  writeExclusiveFile(temporaryName, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryName, name)
  syncDirectory()
}
const receiptShape = (value) => {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) return false
  if (!['prepared', 'allocated', 'capturing', 'published'].includes(value.phase)) return false
  if (
    typeof value.activityId !== 'string' ||
    !ACTIVITY_KINDS.has(value.activityKind) ||
    (value.parentActivityId !== undefined && typeof value.parentActivityId !== 'string') ||
    typeof value.evidenceId !== 'string' ||
    typeof value.storageKeyPrefix !== 'string' ||
    typeof value.ownershipToken !== 'string'
  ) {
    return false
  }
  try {
    assertReceiptName(value.receiptName)
    assertSafeName(value.stagingName)
    assertSafeName(value.finalName)
    assertSafeName(value.ownershipToken)
    assertStorageKeyPrefix(value.storageKeyPrefix)
  } catch {
    return false
  }
  if (value.phase !== 'prepared') {
    if (!validIdentity(value.stagingIdentity)) return false
  }
  if (value.phase === 'capturing' || value.phase === 'published') {
    if (
      typeof value.captureChecksum !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.captureChecksum)
    ) {
      return false
    }
  }
  if (value.phase === 'published' && !validIdentity(value.finalIdentity)) return false
  return true
}
const LEGACY_NOTEBOOK_RECEIPT_BASE_FIELDS = [
  'schemaVersion',
  'phase',
  'receiptName',
  'stagingName',
  'finalName',
  'runId',
  'evidenceId',
  'storageKeyPrefix',
  'ownershipToken'
]
const LEGACY_NOTEBOOK_RECEIPT_FIELDS_BY_PHASE = new Map([
  ['prepared', new Set(LEGACY_NOTEBOOK_RECEIPT_BASE_FIELDS)],
  ['allocated', new Set([...LEGACY_NOTEBOOK_RECEIPT_BASE_FIELDS, 'stagingIdentity'])],
  [
    'capturing',
    new Set([...LEGACY_NOTEBOOK_RECEIPT_BASE_FIELDS, 'stagingIdentity', 'captureChecksum'])
  ],
  [
    'published',
    new Set([
      ...LEGACY_NOTEBOOK_RECEIPT_BASE_FIELDS,
      'stagingIdentity',
      'captureChecksum',
      'finalIdentity'
    ])
  ]
])
const legacyNotebookReceiptShape = (value) => {
  const expectedFields =
    value && typeof value === 'object'
      ? LEGACY_NOTEBOOK_RECEIPT_FIELDS_BY_PHASE.get(value.phase)
      : undefined
  if (
    !expectedFields ||
    Object.keys(value).length !== expectedFields.size ||
    Object.keys(value).some((field) => !expectedFields.has(field)) ||
    value.schemaVersion !== 1
  ) {
    return false
  }
  if (
    typeof value.runId !== 'string' ||
    typeof value.evidenceId !== 'string' ||
    typeof value.storageKeyPrefix !== 'string' ||
    typeof value.ownershipToken !== 'string'
  ) {
    return false
  }
  try {
    assertReceiptName(value.receiptName)
    assertSafeName(value.stagingName)
    assertSafeName(value.finalName)
    assertSafeName(value.ownershipToken)
    assertStorageKeyPrefix(value.storageKeyPrefix)
  } catch {
    return false
  }
  if (value.phase !== 'prepared' && !validIdentity(value.stagingIdentity)) return false
  if (
    (value.phase === 'capturing' || value.phase === 'published') &&
    (typeof value.captureChecksum !== 'string' || !/^[a-f0-9]{64}$/u.test(value.captureChecksum))
  ) {
    return false
  }
  return value.phase !== 'published' || validIdentity(value.finalIdentity)
}
const readReceipt = (name) => {
  const value = readJson(assertReceiptName(name), MAX_REQUEST_BYTES)
  if (!receiptShape(value) || value.receiptName !== name) {
    throw new Error(`Invalid file-evidence recovery receipt: ${name}`)
  }
  return value
}
const readLegacyNotebookReceipt = (name) => {
  const value = readJson(assertReceiptName(name), MAX_REQUEST_BYTES)
  if (!legacyNotebookReceiptShape(value) || value.receiptName !== name) {
    throw new Error(`Invalid legacy Notebook file-evidence recovery receipt: ${name}`)
  }
  return value
}
const entryIdentity = (name) => {
  try {
    const metadata = lstatSync(name)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined
    return identity(metadata)
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}
const entryExists = (name) => {
  try {
    lstatSync(name)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}
const verifyOwnershipMarker = (directoryName, ownershipToken, ownerLabel) => {
  let marker
  try {
    marker = lstatSync(join(directoryName, ownershipFile(ownershipToken)))
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
    throw new Error(`${ownerLabel} ownership marker mismatch.`)
  }
  if (marker.isSymbolicLink() || !marker.isFile() || marker.size !== 0) {
    throw new Error(`${ownerLabel} ownership marker mismatch.`)
  }
}
const removeRunTombstone = (name, expectedIdentity, ownershipToken) => {
  const actual = entryIdentity(name)
  if (!actual) {
    if (entryExists(name)) throw new Error(`File-evidence Activity quarantine is unsafe: ${name}`)
    return false
  }
  if (!sameIdentity(actual, expectedIdentity)) {
    throw new Error(`File-evidence Activity quarantine identity changed: ${name}`)
  }
  const rootPath = process.cwd()
  const rootIdentity = identity(statSync('.'))
  const markerName = ownershipFile(ownershipToken)
  process.chdir(name)
  try {
    if (!sameIdentity(identity(statSync('.')), expectedIdentity)) {
      throw new Error(`File-evidence Activity quarantine identity changed: ${name}`)
    }
    let entries = readdirSync('.')
    if (entries.includes(markerName)) {
      verifyOwnershipMarker('.', ownershipToken, 'File-evidence Activity')
      for (const entry of entries) {
        if (entry !== markerName) rmSync(entry, { recursive: true, force: true })
      }
      syncDirectory()
      verifyOwnershipMarker('.', ownershipToken, 'File-evidence Activity')
      rmSync(markerName)
      syncDirectory()
      entries = readdirSync('.')
    }
    if (entries.length !== 0) {
      throw new Error('File-evidence Activity quarantine lost its ownership marker.')
    }
  } finally {
    process.chdir(rootPath)
  }
  assertBoundRoot(rootIdentity)
  const revalidated = entryIdentity(name)
  if (!revalidated || !sameIdentity(revalidated, expectedIdentity)) {
    throw new Error(`File-evidence Activity quarantine identity changed: ${name}`)
  }
  rmdirSync(name)
  syncDirectory()
  return true
}
const findRunDeletionTombstone = (ownershipToken, kind, legacyNotebook = false) => {
  const prefix = runDeletionTombstonePrefix(ownershipToken, kind, legacyNotebook)
  const matches = []
  for (const entry of readdirSync('.')) {
    if (entry !== prefix && !entry.startsWith(`${prefix}-`)) continue
    const suffix = entry.slice(prefix.length + 1)
    if (!UUID_NAME.test(suffix)) {
      throw new Error(`Unsafe file-evidence Run quarantine name: ${entry}`)
    }
    matches.push(entry)
  }
  if (matches.length > 1) {
    throw new Error('Multiple file-evidence Run quarantines exist.')
  }
  return matches[0]
}
const removeReceiptOwnedDirectory = (
  name,
  expectedIdentity,
  ownershipToken,
  kind,
  legacyNotebook = false
) => {
  if (!validIdentity(expectedIdentity)) {
    throw new Error(`File-evidence owned directory identity is missing: ${name}`)
  }
  const existingQuarantineName = findRunDeletionTombstone(ownershipToken, kind, legacyNotebook)
  const actual = entryIdentity(name)
  const quarantineIdentity = existingQuarantineName
    ? entryIdentity(existingQuarantineName)
    : undefined
  if (entryExists(name) && !actual) {
    throw new Error(`File-evidence owned directory is unsafe: ${name}`)
  }
  if (existingQuarantineName && entryExists(existingQuarantineName) && !quarantineIdentity) {
    throw new Error(`File-evidence Activity quarantine is unsafe: ${existingQuarantineName}`)
  }
  if (actual && quarantineIdentity) {
    throw new Error('File-evidence Activity cleanup source and quarantine both exist.')
  }
  if (existingQuarantineName && quarantineIdentity) {
    return removeRunTombstone(existingQuarantineName, expectedIdentity, ownershipToken)
  }
  if (!actual) return false
  if (!sameIdentity(actual, expectedIdentity)) {
    throw new Error(`File-evidence owned directory identity changed: ${name}`)
  }
  verifyOwnershipMarker(name, ownershipToken, 'File-evidence Activity')
  const quarantineName = `${runDeletionTombstonePrefix(ownershipToken, kind, legacyNotebook)}-${randomUUID()}`
  renameSync(name, quarantineName)
  syncDirectory()
  return removeRunTombstone(quarantineName, expectedIdentity, ownershipToken)
}
const removeProjectTombstone = (name, ownershipToken, expectedRootIdentity) => {
  const expectedIdentity = entryIdentity(name)
  if (!expectedIdentity) return false
  const rootPath = process.cwd()
  const markerName = ownershipFile(ownershipToken)
  process.chdir(name)
  try {
    if (!sameIdentity(identity(statSync('.')), expectedIdentity)) {
      throw new Error('Notebook file-evidence Project tombstone changed before deletion.')
    }
    let entries = readdirSync('.')
    if (entries.includes(markerName)) {
      verifyProjectMarker('.', ownershipToken)
      for (const entry of entries) {
        if (entry !== markerName) rmSync(entry, { recursive: true, force: true })
      }
      syncDirectory()
      verifyProjectMarker('.', ownershipToken)
      rmSync(markerName)
      syncDirectory()
      entries = readdirSync('.')
    }
    if (entries.length !== 0) {
      throw new Error('Notebook file-evidence Project tombstone lost its ownership marker.')
    }
  } finally {
    process.chdir(rootPath)
  }
  assertBoundRoot(expectedRootIdentity)
  const actualIdentity = entryIdentity(name)
  if (!actualIdentity || !sameIdentity(actualIdentity, expectedIdentity)) {
    throw new Error('Notebook file-evidence Project tombstone changed during deletion.')
  }
  rmdirSync(name)
  return true
}
const projectOwnershipShape = (value, projectName) => {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    !['prepared', 'owned', 'deleting'].includes(value.phase) ||
    value.projectName !== projectName ||
    typeof value.ownershipToken !== 'string'
  ) {
    return false
  }
  try {
    assertSafeName(value.projectName)
    assertSafeName(value.ownershipToken)
    if (
      value.phase === 'deleting' &&
      value.tombstoneName !== projectDeletionTombstone(value.ownershipToken)
    ) {
      return false
    }
  } catch {
    return false
  }
  return true
}
const readProjectOwnership = (projectName) => {
  const receiptName = projectOwnershipReceipt(projectName)
  const value = readJson(receiptName, MAX_REQUEST_BYTES)
  if (!projectOwnershipShape(value, projectName)) {
    throw new Error(`Invalid file-evidence Project ownership receipt: ${receiptName}`)
  }
  return { ...value, receiptName }
}
const verifyProjectMarker = (directoryName, ownershipToken) => {
  verifyOwnershipMarker(directoryName, ownershipToken, 'Notebook file-evidence Project')
}
const verifyOwnedProject = (receipt) => {
  const actual = entryIdentity(receipt.projectName)
  if (!actual) {
    throw new Error('Notebook file-evidence Project directory is missing or unsafe.')
  }
  verifyProjectMarker(receipt.projectName, receipt.ownershipToken)
  return actual
}
const ensureProject = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const projectName = assertSafeName(request.projectName)
  const receiptName = projectOwnershipReceipt(projectName)
  if (!existsSync(receiptName)) {
    if (entryExists(projectName)) {
      throw new Error('Notebook file-evidence Project directory has no ownership receipt.')
    }
    publishExclusiveFile(
      receiptName,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          phase: 'prepared',
          projectName,
          ownershipToken: randomUUID()
        },
        null,
        2
      )}\n`
    )
  }
  const receipt = readProjectOwnership(projectName)
  if (receipt.phase === 'deleting') {
    throw new Error('Notebook file-evidence Project deletion is still in progress.')
  }
  if (receipt.phase === 'owned') {
    verifyOwnedProject(receipt)
    return { ok: true, projectOwned: true }
  }

  if (entryExists(projectDeletionTombstone(receipt.ownershipToken))) {
    throw new Error('Prepared Notebook file-evidence Project has a deletion tombstone.')
  }

  let projectIdentity = entryIdentity(projectName)
  if (!projectIdentity) {
    mkdirSync(projectName, { mode: 0o700 })
    projectIdentity = identity(lstatSync(projectName))
  }
  const entries = readdirSync(projectName)
  if (entries.length === 0) {
    process.chdir(projectName)
    try {
      if (!sameIdentity(identity(statSync('.')), projectIdentity)) {
        throw new Error('Notebook file-evidence Project directory changed during ownership.')
      }
      writeExclusiveFile(ownershipFile(receipt.ownershipToken), '')
      syncDirectory()
    } finally {
      process.chdir('..')
    }
    assertBoundRoot(request.expectedRootIdentity)
  } else if (entries.length === 1 && entries[0] === ownershipFile(receipt.ownershipToken)) {
    verifyProjectMarker(projectName, receipt.ownershipToken)
  } else {
    throw new Error('Prepared Notebook file-evidence Project ownership is not recoverable.')
  }
  replaceJson(receiptName, {
    schemaVersion: 1,
    phase: 'owned',
    projectName,
    ownershipToken: receipt.ownershipToken
  })
  return { ok: true, projectOwned: true }
}
const removeReceipt = (receiptName) => {
  rmSync(assertReceiptName(receiptName), { force: true })
  syncDirectory()
}
const preparedStagingIdentity = (receipt) => {
  const actual = entryIdentity(receipt.stagingName)
  if (!actual) {
    if (entryExists(receipt.stagingName)) {
      throw new Error(`Prepared file-evidence staging directory is unsafe: ${receipt.stagingName}`)
    }
    return undefined
  }
  const entries = readdirSync(receipt.stagingName)
  const markerName = ownershipFile(receipt.ownershipToken)
  if (!entries.includes(markerName)) {
    throw new Error(
      `Prepared file-evidence staging directory has no ownership marker: ${receipt.stagingName}`
    )
  }
  const marker = lstatSync(`${receipt.stagingName}/${markerName}`)
  if (marker.isSymbolicLink() || !marker.isFile() || marker.size !== 0) {
    throw new Error(
      `Prepared file-evidence staging ownership marker mismatch: ${receipt.stagingName}`
    )
  }
  return actual
}
const cleanupReceiptTargets = (receipt, legacyNotebook = false) => {
  let removedStagingEntries = 0
  let removedActivityEntries = 0
  const stagingExpected =
    receipt.phase === 'prepared' ? preparedStagingIdentity(receipt) : receipt.stagingIdentity
  const stagingWasPresent = entryIdentity(receipt.stagingName) !== undefined
  const stagingRemoved =
    stagingExpected &&
    removeReceiptOwnedDirectory(
      receipt.stagingName,
      stagingExpected,
      receipt.ownershipToken,
      'staging',
      legacyNotebook
    )
  if (stagingRemoved) {
    removedStagingEntries += 1
  }
  const finalExpected =
    receipt.finalIdentity ?? (!stagingWasPresent ? receipt.stagingIdentity : undefined)
  if (
    finalExpected &&
    removeReceiptOwnedDirectory(
      receipt.finalName,
      finalExpected,
      receipt.ownershipToken,
      'final',
      legacyNotebook
    )
  ) {
    removedActivityEntries += 1
  }
  removeReceipt(receipt.receiptName)
  return { removedStagingEntries, removedActivityEntries }
}

const bindBlobPool = (request) => {
  if (
    typeof request.blobRoot !== 'string' ||
    !validIdentity(request.expectedBlobRootIdentity) ||
    typeof request.blobStorageKeyPrefix !== 'string'
  ) {
    throw new Error('Missing file-evidence blob-pool identity.')
  }
  assertStorageKeyPrefix(request.blobStorageKeyPrefix)
  const actual = entryIdentity(request.blobRoot)
  if (!actual || !sameIdentity(actual, request.expectedBlobRootIdentity)) {
    throw new Error('File-evidence blob-pool identity mismatch.')
  }
  return {
    path: request.blobRoot,
    identity: actual,
    storageKeyPrefix: request.blobStorageKeyPrefix
  }
}
const verifyBlob = (path, expectedSize, expectedChecksum) => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  )
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.size !== expectedSize) {
      throw new Error('File-evidence blob metadata mismatch.')
    }
    const hash = createHash('sha256')
    let position = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (position < metadata.size) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, metadata.size - position),
        position
      )
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if (position !== metadata.size || hash.digest('hex') !== expectedChecksum) {
      throw new Error('File-evidence blob checksum mismatch.')
    }
  } finally {
    closeSync(descriptor)
  }
}
const blobEntry = (name) => {
  if (BLOB_NAME.test(name)) return { blobName: name, quarantined: false }
  const match = BLOB_DELETION_TOMBSTONE_NAME.exec(name)
  return match ? { blobName: match[1], quarantined: true } : undefined
}
const blobPoolBytes = (blobPool) => {
  let bytes = 0
  for (const entry of readdirSync(blobPool.path, { withFileTypes: true })) {
    const parsed = blobEntry(entry.name)
    if (!entry.isFile() || entry.isSymbolicLink() || !parsed) {
      throw new Error(`Unsafe file-evidence blob-pool entry: ${entry.name}`)
    }
    const metadata = lstatSync(join(blobPool.path, entry.name))
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Unsafe file-evidence blob: ${entry.name}`)
    }
    if (parsed.quarantined) {
      if (metadata.nlink !== 1) {
        throw new Error(`Unsafe file-evidence blob quarantine links: ${entry.name}`)
      }
      verifyBlob(
        join(blobPool.path, entry.name),
        metadata.size,
        parsed.blobName.slice('sha256-'.length)
      )
    }
    bytes += metadata.size
  }
  return bytes
}
const sweepBlobPool = (blobPool) => {
  const actual = entryIdentity(blobPool.path)
  if (!actual || !sameIdentity(actual, blobPool.identity)) {
    throw new Error('File-evidence blob-pool identity changed before cleanup.')
  }
  const orphaned = []
  const quarantined = []
  const seenBlobNames = new Set()
  for (const entry of readdirSync(blobPool.path, { withFileTypes: true })) {
    const parsed = blobEntry(entry.name)
    if (!entry.isFile() || entry.isSymbolicLink() || !parsed) {
      throw new Error(`Unsafe file-evidence blob-pool entry: ${entry.name}`)
    }
    if (seenBlobNames.has(parsed.blobName)) {
      throw new Error(`Multiple file-evidence blob entries exist: ${parsed.blobName}`)
    }
    seenBlobNames.add(parsed.blobName)
    const blobPath = join(blobPool.path, entry.name)
    const metadata = lstatSync(blobPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Unsafe file-evidence blob: ${entry.name}`)
    }
    if (parsed.quarantined) {
      if (metadata.nlink !== 1) {
        throw new Error(`Unsafe file-evidence blob quarantine links: ${entry.name}`)
      }
      verifyBlob(blobPath, metadata.size, parsed.blobName.slice('sha256-'.length))
      quarantined.push({ name: entry.name, fingerprint: fingerprint(metadata) })
    } else if (metadata.nlink === 1) {
      orphaned.push({ name: entry.name, fingerprint: fingerprint(metadata) })
    }
  }
  if (!sameIdentity(entryIdentity(blobPool.path), blobPool.identity)) {
    throw new Error('File-evidence blob-pool identity changed during cleanup scan.')
  }
  for (const candidate of [...quarantined, ...orphaned]) {
    const metadata = lstatSync(join(blobPool.path, candidate.name))
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      fingerprint(metadata) !== candidate.fingerprint
    ) {
      throw new Error(`File-evidence orphan changed during cleanup: ${candidate.name}`)
    }
  }
  for (const tombstone of quarantined) {
    rmSync(join(blobPool.path, tombstone.name))
    syncDirectoryPath(blobPool.path)
  }
  for (const orphan of orphaned) {
    const sourcePath = join(blobPool.path, orphan.name)
    const tombstoneName = `deleting-${orphan.name}-${randomUUID()}`
    const tombstonePath = join(blobPool.path, tombstoneName)
    const metadata = lstatSync(sourcePath)
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      fingerprint(metadata) !== orphan.fingerprint
    ) {
      throw new Error(`File-evidence orphan changed before quarantine: ${orphan.name}`)
    }
    renameSync(sourcePath, tombstonePath)
    syncDirectoryPath(blobPool.path)
    const quarantinedMetadata = lstatSync(tombstonePath)
    if (
      quarantinedMetadata.isSymbolicLink() ||
      !quarantinedMetadata.isFile() ||
      quarantinedMetadata.nlink !== 1 ||
      quarantineFingerprint(quarantinedMetadata) !== quarantineFingerprint(metadata)
    ) {
      throw new Error(`File-evidence orphan changed during quarantine: ${orphan.name}`)
    }
    verifyBlob(tombstonePath, quarantinedMetadata.size, orphan.name.slice('sha256-'.length))
    rmSync(tombstonePath)
    syncDirectoryPath(blobPool.path)
  }
  return quarantined.length + orphaned.length
}
const bindRunBlob = (blobPath, contentName, expectedSize, expectedChecksum) => {
  if (!entryExists(ACTIVITY_BLOBS_DIRECTORY)) {
    mkdirSync(ACTIVITY_BLOBS_DIRECTORY, { mode: 0o700 })
    syncDirectory()
  }
  const activityBlobDirectory = entryIdentity(ACTIVITY_BLOBS_DIRECTORY)
  if (!activityBlobDirectory) throw new Error('File-evidence Activity blob directory is unsafe.')
  const activityBlobPath = join(ACTIVITY_BLOBS_DIRECTORY, contentName)
  try {
    linkSync(blobPath, activityBlobPath)
    syncDirectoryPath(ACTIVITY_BLOBS_DIRECTORY)
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error
  }
  verifyBlob(activityBlobPath, expectedSize, expectedChecksum)
  const poolMetadata = lstatSync(blobPath)
  const runMetadata = lstatSync(activityBlobPath)
  if (
    poolMetadata.isSymbolicLink() ||
    runMetadata.isSymbolicLink() ||
    !poolMetadata.isFile() ||
    !runMetadata.isFile() ||
    !sameIdentity(identity(poolMetadata), identity(runMetadata))
  ) {
    throw new Error('File-evidence Activity blob does not match the Project CAS blob.')
  }
  return activityBlobPath
}
const streamDescriptor = (sourceDescriptor, size, targetDescriptor) => {
  const hash = createHash('sha256')
  let position = 0
  const buffer = Buffer.allocUnsafe(64 * 1024)
  while (position < size) {
    const bytesRead = readSync(
      sourceDescriptor,
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position
    )
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    if (targetDescriptor !== undefined) {
      let written = 0
      while (written < bytesRead) {
        written += writeSync(targetDescriptor, buffer, written, bytesRead - written)
      }
    }
    position += bytesRead
  }
  return { bytesRead: position, checksum: hash.digest('hex') }
}

const copyGeneration = (
  source,
  generation,
  relativePath,
  request,
  runBytesUsed,
  newBytesUsed,
  blobPool,
  existingBlobBytes
) => {
  if (request.captureCancelled) {
    return { state: 'unavailable', reason: 'generation-freeze-failed' }
  }
  const temporaryName = `.incoming-${randomUUID()}`
  let sourceDescriptor
  let targetDescriptor
  let publishedBlobPath
  try {
    try {
      sourceDescriptor = openSync(
        source.physicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
      )
    } catch {
      return { state: 'unavailable', reason: 'generation-freeze-failed' }
    }
    const before = fstatSync(sourceDescriptor)
    if (!before.isFile() || fingerprint(before) !== fingerprint(source)) {
      return { state: 'unavailable', reason: 'generation-freeze-failed' }
    }
    if (
      before.size > request.maxGenerationBytes ||
      runBytesUsed + before.size > request.maxActivityBytes
    ) {
      return { state: 'unavailable', reason: 'generation-budget-exceeded' }
    }

    const hashed = streamDescriptor(sourceDescriptor, before.size)
    const afterHash = fstatSync(sourceDescriptor)
    if (
      hashed.bytesRead !== before.size ||
      fingerprint(before) !== fingerprint(afterHash) ||
      fingerprint(afterHash) !== fingerprint(source)
    ) {
      return { state: 'unavailable', reason: 'generation-freeze-failed' }
    }
    const checksum = hashed.checksum
    const contentName = `sha256-${checksum}`
    const blobPath = join(blobPool.path, contentName)
    let publishedNewBlob = false
    if (existsSync(blobPath)) {
      verifyBlob(blobPath, before.size, checksum)
      bindRunBlob(blobPath, contentName, before.size, checksum)
    } else {
      const filesystem = statfsSync(blobPool.path)
      const currentAvailableBytes = Math.min(
        request.availableBytes - newBytesUsed,
        filesystem.bavail * filesystem.bsize
      )
      if (
        existingBlobBytes + newBytesUsed + before.size > request.maxEvidenceBytes ||
        currentAvailableBytes - before.size < request.diskReserveBytes
      ) {
        return { state: 'unavailable', reason: 'generation-budget-exceeded' }
      }
      targetDescriptor = openSync(
        temporaryName,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600
      )
      const copied = streamDescriptor(sourceDescriptor, before.size, targetDescriptor)
      const afterCopy = fstatSync(sourceDescriptor)
      if (
        copied.bytesRead !== before.size ||
        copied.checksum !== checksum ||
        fingerprint(before) !== fingerprint(afterCopy) ||
        fingerprint(afterCopy) !== fingerprint(source)
      ) {
        return { state: 'unavailable', reason: 'generation-freeze-failed' }
      }
      fsyncSync(targetDescriptor)
      closeSync(targetDescriptor)
      targetDescriptor = undefined
      try {
        linkSync(temporaryName, blobPath)
        syncDirectoryPath(blobPool.path)
        publishedNewBlob = true
        publishedBlobPath = blobPath
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
        verifyBlob(blobPath, before.size, checksum)
      }
      bindRunBlob(blobPath, contentName, before.size, checksum)
    }
    rmSync(temporaryName, { force: true })
    publishedBlobPath = undefined
    return {
      state: 'available',
      newBytes: publishedNewBlob ? before.size : 0,
      generation: {
        generationId: generation.generationId,
        relativePath,
        checksum,
        sizeBytes: before.size,
        contentStorageKey: `${request.storageKeyPrefix}/${request.finalName}/${ACTIVITY_BLOBS_DIRECTORY}/${contentName}`,
        capturedAt: generation.capturedAt
      }
    }
  } finally {
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor)
    if (targetDescriptor !== undefined) closeSync(targetDescriptor)
    rmSync(temporaryName, { force: true })
    if (publishedBlobPath) {
      const metadata = lstatSync(publishedBlobPath)
      if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1) {
        rmSync(publishedBlobPath)
        syncDirectoryPath(blobPool.path)
      }
    }
  }
}

const begin = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const blobPool = bindBlobPool(request)
  const existingBlobBytes = blobPoolBytes(blobPool)
  if (!Number.isFinite(request.maxEvidenceBytes) || request.maxEvidenceBytes < 0) {
    throw new Error('Invalid file-evidence Project budget.')
  }
  const receiptName = assertReceiptName(request.receiptName)
  const stagingName = assertSafeName(request.stagingName)
  const finalName = assertSafeName(request.finalName)
  const storageKeyPrefix = assertStorageKeyPrefix(request.storageKeyPrefix)
  const receipt = {
    schemaVersion: 1,
    phase: 'prepared',
    receiptName,
    stagingName,
    finalName,
    activityId: request.activityId,
    activityKind: assertActivityKind(request.activityKind),
    ...(request.parentActivityId
      ? { parentActivityId: assertSafeName(request.parentActivityId) }
      : {}),
    evidenceId: request.evidenceId,
    storageKeyPrefix,
    ownershipToken: randomUUID()
  }
  publishExclusiveFile(receiptName, `${JSON.stringify(receipt, null, 2)}\n`)
  let stagingIdentity
  let ownershipMarkerPublished = false
  try {
    mkdirSync(stagingName, { mode: 0o700 })
    stagingIdentity = identity(lstatSync(stagingName))
    process.chdir(stagingName)
    if (!sameIdentity(identity(statSync('.')), stagingIdentity)) {
      throw new Error('File-evidence staging directory changed during capture binding.')
    }
    writeExclusiveFile(ownershipFile(receipt.ownershipToken), '')
    ownershipMarkerPublished = true
    syncDirectory()
    process.chdir('..')
    assertBoundRoot(request.expectedRootIdentity)
    replaceJson(receiptName, {
      ...receipt,
      phase: 'allocated',
      stagingIdentity
    })
    process.chdir(stagingName)
    if (!sameIdentity(identity(statSync('.')), stagingIdentity)) {
      throw new Error('File-evidence staging directory changed after allocation.')
    }
    const relations = []
    let bytesUsed = 0
    let newBytesUsed = 0
    const reasons = []
    for (const item of request.initialFiles) {
      const frozen = copyGeneration(
        item.file,
        item.generation,
        item.file.relativePath,
        request,
        bytesUsed,
        newBytesUsed,
        blobPool,
        existingBlobBytes
      )
      const relation = {
        relation: item.relation === 'staged-input' ? 'staged-input' : 'present-before',
        relativePath: item.file.relativePath,
        pathPortability: 'relative',
        authority: item.relation === 'staged-input' ? 'explicit-transfer' : 'advisory'
      }
      if (frozen.state === 'available') {
        relation.generation = frozen.generation
        bytesUsed += frozen.generation.sizeBytes
        newBytesUsed += frozen.newBytes
      } else {
        relation.reasonCode = frozen.reason
        reasons.push(frozen.reason)
      }
      relations.push(relation)
    }
    const initialViewState =
      request.initialViewState === 'unavailable'
        ? 'unavailable'
        : request.initialViewState === 'partial' || reasons.length > 0
          ? 'partial'
          : 'complete'
    if (initialViewState !== 'complete') reasons.push('initial-file-generations-not-captured')
    const capture = {
      schemaVersion: 1,
      activityId: request.activityId,
      activityKind: receipt.activityKind,
      ...(receipt.parentActivityId ? { parentActivityId: receipt.parentActivityId } : {}),
      initialViewState,
      reasonCodes: [...new Set(reasons)].sort(),
      bytesUsed,
      relations
    }
    const serialized = `${JSON.stringify(capture, null, 2)}\n`
    writeExclusiveFile(CAPTURE_FILE, serialized)
    syncDirectory()
    const captureChecksum = createHash('sha256').update(serialized).digest('hex')
    process.chdir('..')
    assertBoundRoot(request.expectedRootIdentity)
    replaceJson(receiptName, {
      ...receipt,
      phase: 'capturing',
      stagingIdentity,
      captureChecksum
    })
    return {
      ok: true,
      capturedInitialGenerations: relations.filter((item) => item.generation).length,
      initialGenerations: relations.flatMap((item) =>
        item.generation
          ? [
              {
                relativePath: item.relativePath,
                generationId: item.generation.generationId,
                checksum: item.generation.checksum,
                sizeBytes: item.generation.sizeBytes
              }
            ]
          : []
      )
    }
  } catch (error) {
    try {
      if (stagingIdentity && sameIdentity(identity(statSync('.')), stagingIdentity))
        process.chdir('..')
      assertBoundRoot(request.expectedRootIdentity)
      if (stagingIdentity && ownershipMarkerPublished) {
        removeReceiptOwnedDirectory(stagingName, stagingIdentity, receipt.ownershipToken, 'staging')
        removeReceipt(receiptName)
        sweepBlobPool(blobPool)
      }
    } catch {
      // Keep the original failure. A durable receipt remains for startup reconciliation if cleanup fails.
    }
    throw error
  }
}

const ensureCapture = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  bindBlobPool(request)
  const receiptName = assertReceiptName(request.receiptName)
  const stagingName = assertSafeName(request.stagingName)
  const finalName = assertSafeName(request.finalName)
  const activityKind = assertActivityKind(request.activityKind)
  const storageKeyPrefix = assertStorageKeyPrefix(request.storageKeyPrefix)
  if (entryExists(receiptName)) {
    const receipt = readReceipt(receiptName)
    if (
      (receipt.phase !== 'capturing' && receipt.phase !== 'published') ||
      receipt.stagingName !== stagingName ||
      receipt.finalName !== finalName ||
      receipt.activityId !== request.activityId ||
      receipt.activityKind !== activityKind ||
      receipt.parentActivityId !== request.parentActivityId ||
      receipt.evidenceId !== request.evidenceId ||
      receipt.storageKeyPrefix !== storageKeyPrefix
    ) {
      throw new Error('Compute recovery capture does not match its recovery receipt.')
    }
    return { ok: true, captureReady: true, initialized: false }
  }
  if (entryExists(finalName)) {
    throw new Error('Published Compute file-evidence Activity has no recovery receipt.')
  }
  begin(request)
  return { ok: true, captureReady: true, initialized: true }
}

const persist = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const blobPool = bindBlobPool(request)
  const existingBlobBytes = blobPoolBytes(blobPool)
  if (!Number.isFinite(request.maxEvidenceBytes) || request.maxEvidenceBytes < 0) {
    throw new Error('Invalid file-evidence Project budget.')
  }
  const receipt = readReceipt(request.receiptName)
  if (
    (receipt.phase !== 'capturing' && receipt.phase !== 'published') ||
    receipt.activityId !== request.activityId ||
    receipt.activityKind !== request.activityKind ||
    receipt.parentActivityId !== request.parentActivityId ||
    receipt.evidenceId !== request.evidenceId ||
    receipt.stagingName !== request.stagingName ||
    receipt.finalName !== request.finalName ||
    receipt.storageKeyPrefix !== request.storageKeyPrefix
  ) {
    throw new Error('File-evidence persistence does not match its recovery receipt.')
  }
  if (receipt.phase === 'published') {
    const expectedIdentity = receipt.finalIdentity ?? receipt.stagingIdentity
    const actualIdentity = entryIdentity(receipt.finalName)
    if (!actualIdentity || !expectedIdentity || !sameIdentity(actualIdentity, expectedIdentity)) {
      throw new Error('Published file-evidence directory identity mismatch.')
    }
    verifyOwnershipMarker(receipt.finalName, receipt.ownershipToken, 'File-evidence Activity')
    process.chdir(receipt.finalName)
    try {
      const serialized = readRegularFile('evidence.json', MAX_INTERNAL_JSON_BYTES)
      const sidecar = JSON.parse(serialized.toString('utf8'))
      if (
        sidecar.schemaVersion !== 1 ||
        sidecar.activityId !== request.activityId ||
        sidecar.activityKind !== request.activityKind ||
        sidecar.parentActivityId !== request.parentActivityId ||
        sidecar.evidenceId !== request.evidenceId ||
        !Array.isArray(sidecar.relations) ||
        !Array.isArray(sidecar.scientificOutputs) ||
        !Array.isArray(sidecar.reasonCodes)
      ) {
        throw new Error('Invalid published file-evidence sidecar.')
      }
      return {
        ok: true,
        generations: [],
        fileEvidence: {
          schemaVersion: 1,
          activityId: request.activityId,
          activityKind: request.activityKind,
          ...(request.parentActivityId ? { parentActivityId: request.parentActivityId } : {}),
          evidenceId: request.evidenceId,
          state: sidecar.state,
          checksum: createHash('sha256').update(serialized).digest('hex'),
          storageKey: `${request.storageKeyPrefix}/${receipt.finalName}/evidence.json`,
          relationCount: sidecar.relations.length,
          generationCount: sidecar.relations.filter((relation) => relation.generation).length,
          scientificOutputCount: sidecar.scientificOutputs.length,
          initialViewState: sidecar.initialViewState,
          managedRootsFinalState: sidecar.managedRootsFinalState,
          scientificOutputAnalysis:
            sidecar.state === 'available'
              ? 'complete'
              : sidecar.managedRootsFinalState === 'unavailable'
                ? 'unavailable'
                : 'partial',
          fileReads: sidecar.fileReads,
          externalPaths: sidecar.externalPaths,
          writerAttribution: sidecar.writerAttribution,
          reasonCodes: sidecar.reasonCodes
        }
      }
    } finally {
      process.chdir('..')
      assertBoundRoot(request.expectedRootIdentity)
    }
  }
  const stagingIdentity = entryIdentity(receipt.stagingName)
  if (!stagingIdentity || !sameIdentity(stagingIdentity, receipt.stagingIdentity)) {
    throw new Error('File-evidence staging directory identity changed.')
  }
  process.chdir(receipt.stagingName)
  if (!sameIdentity(identity(statSync('.')), receipt.stagingIdentity)) {
    throw new Error('File-evidence staging directory changed before publication.')
  }

  try {
    const captureBytes = readRegularFile(CAPTURE_FILE, MAX_INTERNAL_JSON_BYTES)
    if (createHash('sha256').update(captureBytes).digest('hex') !== receipt.captureChecksum) {
      throw new Error('File-evidence initial capture checksum mismatch.')
    }
    const capture = JSON.parse(captureBytes.toString('utf8'))
    if (
      capture.schemaVersion !== 1 ||
      capture.activityId !== request.activityId ||
      capture.activityKind !== request.activityKind ||
      capture.parentActivityId !== request.parentActivityId ||
      !Array.isArray(capture.relations)
    ) {
      throw new Error('Invalid file-evidence initial capture.')
    }
    const baselineByPath = new Map(
      capture.relations
        .filter((relation) => relation.generation)
        .map((relation) => [relation.relativePath, relation.generation])
    )
    const relations = [...capture.relations]
    const generations = []
    const reasons = [...request.reasonCodes, ...capture.reasonCodes]
    let bytesUsed = Number(capture.bytesUsed) || 0
    let newBytesUsed = 0
    for (const item of request.changes) {
      const change = item.change
      const previousGeneration = baselineByPath.get(change.relativePath)
      const relation = {
        relation: change.relation,
        relativePath: change.relativePath,
        pathPortability: change.pathPortability === 'absolute' ? 'absolute' : 'relative',
        authority: change.authority === 'explicit-transfer' ? 'explicit-transfer' : 'advisory',
        ...(change.before
          ? {
              before: {
                size: change.before.size,
                mtimeMs: change.before.mtimeMs,
                ctimeMs: change.before.ctimeMs
              },
              ...(previousGeneration
                ? { previousGenerationId: previousGeneration.generationId }
                : { previousReasonCode: 'initial-file-generations-not-captured' })
            }
          : {})
      }
      if (change.before && !previousGeneration)
        reasons.push('initial-file-generations-not-captured')
      if (change.after) {
        const frozen = copyGeneration(
          change.after,
          item.generation,
          change.relativePath,
          request,
          bytesUsed,
          newBytesUsed,
          blobPool,
          existingBlobBytes
        )
        if (frozen.state === 'available') {
          relation.generation = frozen.generation
          bytesUsed += frozen.generation.sizeBytes
          newBytesUsed += frozen.newBytes
          generations.push({
            path: change.after.path,
            generationId: frozen.generation.generationId,
            checksum: frozen.generation.checksum
          })
        } else {
          relation.reasonCode = frozen.reason
          reasons.push(frozen.reason)
        }
      }
      relations.push(relation)
    }

    const reasonCodes = uniqueReasons(reasons)
    const evidenceState = ['available', 'partial', 'unavailable'].includes(request.evidenceState)
      ? request.evidenceState
      : request.rootsAvailable
        ? 'partial'
        : 'unavailable'
    const sidecar = {
      schemaVersion: 1,
      evidenceId: request.evidenceId,
      activityId: request.activityId,
      activityKind: request.activityKind,
      ...(request.parentActivityId ? { parentActivityId: request.parentActivityId } : {}),
      state: evidenceState,
      observedRoots: request.rootKinds,
      initialViewState: capture.initialViewState,
      managedRootsFinalState:
        evidenceState === 'available'
          ? 'complete'
          : request.rootsAvailable
            ? 'partial'
            : 'unavailable',
      fileReads: 'unavailable',
      externalPaths: 'unavailable',
      writerAttribution: 'unavailable',
      reasonCodes,
      scientificOutputs: request.scientificOutputs,
      relations
    }
    const serialized = `${JSON.stringify(sidecar, null, 2)}\n`
    if (
      bytesUsed + Buffer.byteLength(serialized) > request.maxActivityBytes ||
      request.availableBytes - newBytesUsed - Buffer.byteLength(serialized) <
        request.diskReserveBytes
    ) {
      throw new Error('File-evidence sidecar exceeds the reserved storage budget.')
    }
    rmSync(CAPTURE_FILE, { force: true })
    writeExclusiveFile('evidence.json', serialized)
    syncDirectory()

    process.chdir('..')
    assertBoundRoot(request.expectedRootIdentity)
    if (!sameIdentity(entryIdentity(receipt.stagingName), receipt.stagingIdentity)) {
      throw new Error('File-evidence staging directory identity changed before rename.')
    }
    if (existsSync(receipt.finalName)) throw new Error('File-evidence Activity already exists.')
    renameSync(receipt.stagingName, receipt.finalName)
    syncDirectory()
    replaceJson(receipt.receiptName, {
      ...receipt,
      phase: 'published',
      finalIdentity: receipt.stagingIdentity
    })
    return {
      ok: true,
      generations,
      fileEvidence: {
        schemaVersion: 1,
        activityId: request.activityId,
        activityKind: request.activityKind,
        ...(request.parentActivityId ? { parentActivityId: request.parentActivityId } : {}),
        evidenceId: request.evidenceId,
        state: sidecar.state,
        checksum: createHash('sha256').update(serialized).digest('hex'),
        storageKey: `${request.storageKeyPrefix}/${receipt.finalName}/evidence.json`,
        relationCount: relations.length,
        generationCount: relations.filter((relation) => relation.generation).length,
        scientificOutputCount: request.scientificOutputs.length,
        initialViewState: sidecar.initialViewState,
        managedRootsFinalState: sidecar.managedRootsFinalState,
        scientificOutputAnalysis:
          evidenceState === 'available'
            ? 'complete'
            : request.rootsAvailable
              ? 'partial'
              : 'unavailable',
        fileReads: sidecar.fileReads,
        externalPaths: sidecar.externalPaths,
        writerAttribution: sidecar.writerAttribution,
        reasonCodes
      }
    }
  } catch (error) {
    if (sameIdentity(identity(statSync('.')), receipt.stagingIdentity)) process.chdir('..')
    throw error
  }
}

const recoverPublished = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const receiptName = assertReceiptName(request.receiptName)
  if (!entryExists(receiptName)) {
    return { ok: true, recoveredFileEvidence: null }
  }
  const receipt = readReceipt(receiptName)
  if (receipt.phase !== 'published') {
    return { ok: true, recoveredFileEvidence: null }
  }
  const result = persist({ ...request, operation: 'persist' })
  return { ok: true, recoveredFileEvidence: result.fileEvidence }
}

const verifyPublishedEvidence = (receipt, expected) => {
  const expectedIdentity = receipt.finalIdentity ?? receipt.stagingIdentity
  const actualIdentity = entryIdentity(receipt.finalName)
  if (!actualIdentity || !expectedIdentity || !sameIdentity(actualIdentity, expectedIdentity)) {
    throw new Error('Published file-evidence directory identity mismatch.')
  }
  verifyOwnershipMarker(receipt.finalName, receipt.ownershipToken, 'File-evidence Activity')
  process.chdir(receipt.finalName)
  try {
    const bytes = readRegularFile('evidence.json', MAX_INTERNAL_JSON_BYTES)
    if (createHash('sha256').update(bytes).digest('hex') !== expected.checksum) {
      throw new Error('Published file-evidence checksum mismatch.')
    }
    const sidecar = JSON.parse(bytes.toString('utf8'))
    if (
      sidecar.schemaVersion !== 1 ||
      sidecar.activityId !== expected.activityId ||
      sidecar.activityKind !== expected.activityKind ||
      sidecar.parentActivityId !== expected.parentActivityId ||
      sidecar.evidenceId !== expected.evidenceId
    ) {
      throw new Error('Published file-evidence identity mismatch.')
    }
  } finally {
    process.chdir('..')
  }
  assertBoundRoot(expected.expectedRootIdentity)
  const storageKey = `${receipt.storageKeyPrefix}/${receipt.finalName}/evidence.json`
  if (storageKey !== expected.storageKey)
    throw new Error('Published file-evidence storage key mismatch.')
}

const complete = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const receipt = readReceipt(request.receiptName)
  if (
    receipt.phase !== 'published' ||
    receipt.activityId !== request.activityId ||
    receipt.activityKind !== request.activityKind ||
    receipt.parentActivityId !== request.parentActivityId ||
    receipt.evidenceId !== request.evidenceId
  ) {
    throw new Error('File-evidence completion does not match its recovery receipt.')
  }
  verifyPublishedEvidence(receipt, request)
  removeReceipt(receipt.receiptName)
  return { ok: true, removedStagingEntries: 0, removedActivityEntries: 0 }
}

const reconcile = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const blobPool = bindBlobPool(request)
  const retained = new Map(request.retained.map((item) => [item.activityId, item]))
  let removedStagingEntries = 0
  let removedActivityEntries = 0
  for (const entry of readdirSync('.', { withFileTypes: true })) {
    if (!RECEIPT_NAME.test(entry.name)) continue
    if (!entry.isFile()) throw new Error(`Unsafe file-evidence recovery receipt: ${entry.name}`)
    const receipt = readReceipt(entry.name)
    const expected = retained.get(receipt.activityId)
    if (expected) {
      if (
        expected.receiptName !== receipt.receiptName ||
        expected.finalName !== receipt.finalName ||
        expected.evidenceId !== receipt.evidenceId ||
        expected.activityKind !== receipt.activityKind ||
        expected.parentActivityId !== receipt.parentActivityId
      ) {
        throw new Error('Retained file-evidence does not match its recovery receipt.')
      }
      verifyPublishedEvidence(receipt, {
        ...expected,
        expectedRootIdentity: request.expectedRootIdentity
      })
      removeReceipt(receipt.receiptName)
      continue
    }
    if (
      request.deferredActivityIds.includes(receipt.activityId) ||
      request.deferredActivityKinds.includes(receipt.activityKind)
    )
      continue
    const removed = cleanupReceiptTargets(receipt)
    removedStagingEntries += removed.removedStagingEntries
    removedActivityEntries += removed.removedActivityEntries
  }
  return {
    ok: true,
    removedStagingEntries,
    removedActivityEntries,
    removedBlobEntries: sweepBlobPool(blobPool)
  }
}

const verifyLegacyNotebookPublishedEvidence = (receipt, expected) => {
  const expectedIdentity = receipt.finalIdentity ?? receipt.stagingIdentity
  const actualIdentity = entryIdentity(receipt.finalName)
  if (!actualIdentity || !expectedIdentity || !sameIdentity(actualIdentity, expectedIdentity)) {
    throw new Error('Published legacy Notebook file-evidence directory identity mismatch.')
  }
  verifyOwnershipMarker(receipt.finalName, receipt.ownershipToken, 'Notebook file-evidence Run')
  process.chdir(receipt.finalName)
  try {
    const bytes = readRegularFile('evidence.json', MAX_INTERNAL_JSON_BYTES)
    if (createHash('sha256').update(bytes).digest('hex') !== expected.checksum) {
      throw new Error('Published legacy Notebook file-evidence checksum mismatch.')
    }
    const sidecar = JSON.parse(bytes.toString('utf8'))
    if (
      sidecar.schemaVersion !== 1 ||
      sidecar.runId !== expected.runId ||
      sidecar.evidenceId !== expected.evidenceId
    ) {
      throw new Error('Published legacy Notebook file-evidence identity mismatch.')
    }
  } finally {
    process.chdir('..')
  }
  assertBoundRoot(expected.expectedRootIdentity)
  const storageKey = `${receipt.storageKeyPrefix}/${receipt.finalName}/evidence.json`
  if (storageKey !== expected.storageKey) {
    throw new Error('Published legacy Notebook file-evidence storage key mismatch.')
  }
}

const reconcileLegacyNotebook = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const blobPool = bindBlobPool(request)
  const retained = new Map(request.retained.map((item) => [item.runId, item]))
  let removedStagingEntries = 0
  let removedActivityEntries = 0
  for (const entry of readdirSync('.', { withFileTypes: true })) {
    if (!RECEIPT_NAME.test(entry.name)) continue
    if (!entry.isFile()) {
      throw new Error(`Unsafe legacy Notebook file-evidence recovery receipt: ${entry.name}`)
    }
    const receipt = readLegacyNotebookReceipt(entry.name)
    const expected = retained.get(receipt.runId)
    if (expected) {
      if (
        expected.receiptName !== receipt.receiptName ||
        expected.finalName !== receipt.finalName ||
        expected.evidenceId !== receipt.evidenceId
      ) {
        throw new Error('Retained legacy Notebook evidence does not match its recovery receipt.')
      }
      verifyLegacyNotebookPublishedEvidence(receipt, {
        ...expected,
        expectedRootIdentity: request.expectedRootIdentity
      })
      removeReceipt(receipt.receiptName)
      continue
    }
    const removed = cleanupReceiptTargets(receipt, true)
    removedStagingEntries += removed.removedStagingEntries
    removedActivityEntries += removed.removedActivityEntries
  }
  return {
    ok: true,
    removedStagingEntries,
    removedActivityEntries,
    removedBlobEntries: sweepBlobPool(blobPool)
  }
}

const cleanup = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const blobPool = bindBlobPool(request)
  const receiptName = assertReceiptName(request.receiptName)
  let removed = { removedStagingEntries: 0, removedActivityEntries: 0 }
  if (entryExists(receiptName)) {
    const receipt = readReceipt(receiptName)
    if (!request.preservePublished || !entryExists(receipt.finalName)) {
      removed = cleanupReceiptTargets(receipt)
    }
  }
  return { ok: true, ...removed, removedBlobEntries: sweepBlobPool(blobPool) }
}

const deleteProject = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const projectName = assertSafeName(request.projectName)
  const receiptName = projectOwnershipReceipt(projectName)
  if (!existsSync(receiptName)) {
    if (entryExists(projectName)) {
      throw new Error('Notebook file-evidence Project directory has no ownership receipt.')
    }
    return { ok: true, removedProjectEntries: 0 }
  }
  let receipt = readProjectOwnership(projectName)
  if (receipt.phase === 'prepared') {
    ensureProject(request)
    receipt = readProjectOwnership(projectName)
  }
  const tombstoneName = projectDeletionTombstone(receipt.ownershipToken)

  if (receipt.phase === 'owned') {
    const projectPresent = entryExists(projectName)
    const tombstonePresent = entryExists(tombstoneName)
    const projectIdentity = entryIdentity(projectName)
    const tombstoneIdentity = entryIdentity(tombstoneName)
    if (projectPresent && !projectIdentity) {
      throw new Error('Notebook file-evidence Project directory is unsafe.')
    }
    if (tombstonePresent && !tombstoneIdentity) {
      throw new Error('Notebook file-evidence Project deletion tombstone is unsafe.')
    }
    if (projectIdentity && tombstoneIdentity) {
      throw new Error('Notebook file-evidence Project and deletion tombstone both exist.')
    }
    if (projectIdentity) {
      verifyProjectMarker(projectName, receipt.ownershipToken)
      renameSync(projectName, tombstoneName)
      syncDirectory()
      const renamedIdentity = entryIdentity(tombstoneName)
      if (!renamedIdentity || !sameIdentity(projectIdentity, renamedIdentity)) {
        throw new Error('Notebook file-evidence Project changed during deletion rename.')
      }
    } else if (tombstoneIdentity) {
      verifyProjectMarker(tombstoneName, receipt.ownershipToken)
    } else {
      rmSync(receiptName, { force: true })
      syncDirectory()
      return { ok: true, removedProjectEntries: 0 }
    }
    replaceJson(receiptName, {
      schemaVersion: 1,
      phase: 'deleting',
      projectName,
      ownershipToken: receipt.ownershipToken,
      tombstoneName
    })
    receipt = readProjectOwnership(projectName)
  }

  if (entryIdentity(projectName)) {
    throw new Error('Notebook file-evidence Project reappeared during deletion.')
  }
  if (entryExists(projectName)) {
    throw new Error('Notebook file-evidence Project path is unsafe during deletion.')
  }
  const tombstonePresent = entryExists(receipt.tombstoneName)
  if (tombstonePresent && !entryIdentity(receipt.tombstoneName)) {
    throw new Error('Notebook file-evidence Project deletion tombstone is unsafe.')
  }
  const removed = removeProjectTombstone(
    receipt.tombstoneName,
    receipt.ownershipToken,
    request.expectedRootIdentity
  )
  syncDirectory()
  rmSync(receiptName, { force: true })
  syncDirectory()
  return { ok: true, removedProjectEntries: removed ? 1 : 0 }
}

let requestText = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  requestText += chunk
  if (Buffer.byteLength(requestText) > MAX_REQUEST_BYTES) {
    fail('File-evidence worker request is too large.')
    process.stdin.destroy()
  }
})
process.stdin.on('end', () => {
  if (process.exitCode) return
  try {
    const request = JSON.parse(requestText)
    const result =
      request.operation === 'begin'
        ? begin(request)
        : request.operation === 'ensure-capture'
          ? ensureCapture(request)
          : request.operation === 'ensure-project'
            ? ensureProject(request)
            : request.operation === 'persist'
              ? persist(request)
              : request.operation === 'recover-published'
                ? recoverPublished(request)
                : request.operation === 'complete'
                  ? complete(request)
                  : request.operation === 'cleanup'
                    ? cleanup(request)
                    : request.operation === 'delete-project'
                      ? deleteProject(request)
                      : request.operation === 'reconcile'
                        ? reconcile(request)
                        : request.operation === 'reconcile-legacy-notebook'
                          ? reconcileLegacyNotebook(request)
                          : (() => {
                              throw new Error('Unsupported file-evidence worker operation.')
                            })()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
})
