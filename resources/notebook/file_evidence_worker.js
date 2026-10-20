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
const REGISTERED_INPUT_SOURCE_KINDS = new Set(['upload-version', 'artifact-version'])
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
const evidenceReasons = (request, values) => {
  const baseline = BASELINE_REASONS.filter((reason) => {
    if (reason === 'file-reads-not-observed') return request.fileReads !== 'complete'
    if (reason === 'external-paths-not-observed') return request.externalPaths !== 'complete'
    return request.writerAttribution !== 'complete'
  })
  return [...new Set([...baseline, ...values])].sort()
}
const assertSafeName = (value) => {
  if (!SAFE_NAME.test(value)) throw new Error(`Unsafe file-evidence name: ${value}`)
  return value
}
const assertActivityKind = (value) => {
  if (!ACTIVITY_KINDS.has(value)) throw new Error(`Unsafe file-evidence activity kind: ${value}`)
  return value
}
const assertRegisteredInput = (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(
      (field) => !['sourceKind', 'inputFileVersionId', 'checksum'].includes(field)
    ) ||
    !REGISTERED_INPUT_SOURCE_KINDS.has(value.sourceKind) ||
    typeof value.inputFileVersionId !== 'string' ||
    value.inputFileVersionId.length === 0 ||
    value.inputFileVersionId.length > 512 ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.checksum)
  ) {
    throw new Error('Invalid registered input identity in file evidence.')
  }
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
  replaceReceipt(temporaryName, name)
  syncDirectory()
}
// A Windows reader without FILE_SHARE_DELETE can transiently deny replacement even after
// our own handles have closed. Keep the old receipt visible until the same durable temporary
// file can be renamed atomically. Waiting is confined to this disposable worker process.
const RECEIPT_REPLACEMENT_DELAYS_MS = [25, 50, 100, 200, 400, 800]
const replacementSnapshot = (name) => {
  try {
    const metadata = lstatSync(name)
    // Identity alone misses in-place writes while a reader blocks the rename.
    return metadata.isFile() ? fingerprint(metadata) : 'unsafe'
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent'
    throw error
  }
}
const replaceReceipt = (temporaryName, name) => {
  if (process.platform !== 'win32') {
    renameSync(temporaryName, name)
    return
  }
  const source = replacementSnapshot(temporaryName)
  const destination = replacementSnapshot(name)
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temporaryName, name)
      return
    } catch (error) {
      const delay = RECEIPT_REPLACEMENT_DELAYS_MS[attempt]
      if (
        delay === undefined ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
        source === 'absent' ||
        source === 'unsafe' ||
        destination === 'unsafe'
      ) {
        // Preserve both the previous receipt and the durable unpublished temporary file on
        // failure, as before. Never delete the destination or weaken its permissions.
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
      if (
        replacementSnapshot(temporaryName) !== source ||
        replacementSnapshot(name) !== destination
      ) {
        throw new Error('File-evidence receipt changed during atomic replacement.')
      }
    }
  }
}
const RECEIPT_REQUIRED_FIELDS = [
  'schemaVersion',
  'phase',
  'receiptName',
  'stagingName',
  'finalName',
  'activityId',
  'activityKind',
  'evidenceId',
  'storageKeyPrefix',
  'ownershipToken'
]
const receiptFields = (...phaseFields) =>
  new Set([...RECEIPT_REQUIRED_FIELDS, 'parentActivityId', ...phaseFields])
const RECEIPT_FIELDS_BY_PHASE = new Map([
  ['prepared', receiptFields()],
  ['allocated', receiptFields('stagingIdentity')],
  ['capturing', receiptFields('stagingIdentity', 'captureChecksum')],
  ['published', receiptFields('stagingIdentity', 'captureChecksum', 'finalIdentity')]
])
const receiptShape = (value) => {
  const expectedFields =
    value && typeof value === 'object' ? RECEIPT_FIELDS_BY_PHASE.get(value.phase) : undefined
  if (
    !expectedFields ||
    value.schemaVersion !== 1 ||
    RECEIPT_REQUIRED_FIELDS.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !expectedFields.has(field))
  ) {
    return false
  }
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
    assertSafeName(value.activityId)
    assertSafeName(value.evidenceId)
    assertSafeName(value.stagingName)
    assertSafeName(value.finalName)
    assertSafeName(value.ownershipToken)
    assertStorageKeyPrefix(value.storageKeyPrefix)
  } catch {
    return false
  }
  if (
    value.receiptName !== `receipt-${value.activityId}.json` ||
    value.finalName !== `activity-${value.activityId}`
  ) {
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

const releaseUnusedInitialBlobs = (initialRelations, retainedGenerations, blobPool, request) => {
  const retainedChecksums = new Set(retainedGenerations.map((generation) => generation.checksum))
  const unused = new Map(
    initialRelations.flatMap(({ generation }) =>
      generation && !retainedChecksums.has(generation.checksum)
        ? [[generation.checksum, generation]]
        : []
    )
  )
  if (unused.size === 0) return
  const directoryIdentity = entryIdentity(ACTIVITY_BLOBS_DIRECTORY)
  if (!directoryIdentity) throw new Error('File-evidence Activity blob directory is unsafe.')
  for (const generation of unused.values()) {
    const name = `sha256-${generation.checksum}`
    if (
      !BLOB_NAME.test(name) ||
      generation.contentStorageKey !==
        `${request.storageKeyPrefix}/${request.finalName}/${ACTIVITY_BLOBS_DIRECTORY}/${name}`
    ) {
      throw new Error('Unused file-evidence generation has an invalid storage key.')
    }
    const path = join(ACTIVITY_BLOBS_DIRECTORY, name)
    const metadata = lstatSync(path)
    const pooled = lstatSync(join(blobPool.path, name))
    if (
      !sameIdentity(entryIdentity(ACTIVITY_BLOBS_DIRECTORY), directoryIdentity) ||
      !sameIdentity(entryIdentity(blobPool.path), blobPool.identity) ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      pooled.isSymbolicLink() ||
      !pooled.isFile() ||
      !sameIdentity(identity(metadata), identity(pooled))
    ) {
      throw new Error('Unused file-evidence blob no longer matches its owned pool.')
    }
    rmSync(path)
  }
  syncDirectoryPath(ACTIVITY_BLOBS_DIRECTORY)
  sweepBlobPool(blobPool)
}
// Maintenance consumes completed owner records, never directory names as deletion authority.
// Every native sidecar in the Project participates in the reference set, including other lanes.
const compactHistory = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const pool = bindBlobPool(request)
  const prefix = pool.storageKeyPrefix.replace(/\/blobs$/, '')
  if (!/^execution-file-evidence\/[^/]+$/.test(prefix)) return { ok: true, maintainedFiles: 0 }
  const projectRoot = join(pool.path, '..')
  const references = new Set()
  const sidecars = new Map()
  const directories = []
  const metadataSnapshots = []
  let entries = 0
  let metadataBytes = 0
  const started = Date.now()
  const projectName = prefix.split('/')[1]
  try {
    const receiptPath = join(projectRoot, '..', projectOwnershipReceipt(projectName))
    const metadata = lstatSync(receiptPath)
    const receipt = JSON.parse(readRegularFile(receiptPath, MAX_REQUEST_BYTES).toString('utf8'))
    if (!projectOwnershipShape(receipt, projectName) || receipt.phase !== 'owned')
      return { ok: true, maintainedFiles: 0 }
    verifyProjectMarker(projectRoot, receipt.ownershipToken)
    if (fingerprint(lstatSync(receiptPath)) !== fingerprint(metadata))
      return { ok: true, maintainedFiles: 0 }
    metadataSnapshots.push([receiptPath, fingerprint(metadata)])
  } catch {
    return { ok: true, maintainedFiles: 0 }
  }
  const scan = (directory, key, depth) => {
    if (depth > 5 || Date.now() - started > 1000) throw new Error('History scan budget exceeded.')
    const before = lstatSync(directory)
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error('Unsafe history directory.')
    directories.push([directory, identity(before)])
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 10000) throw new Error('History entry budget exceeded.')
      if (entry.isSymbolicLink()) throw new Error('History contains a symbolic link.')
      if (RECEIPT_NAME.test(entry.name) || /^(staging-|deleting-)/.test(entry.name))
        throw new Error('History contains unfinished work.')
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'blobs') scan(path, `${key}/${entry.name}`, depth + 1)
      } else if (entry.name === 'evidence.json') {
        const beforeRead = lstatSync(path)
        const bytes = readRegularFile(path, 8 * 1024 * 1024 - metadataBytes)
        if (fingerprint(lstatSync(path)) !== fingerprint(beforeRead))
          throw new Error('History changed while reading.')
        metadataSnapshots.push([path, fingerprint(beforeRead)])
        metadataBytes += bytes.length
        const value = JSON.parse(bytes.toString('utf8'))
        const onlyFields = (object, fields) =>
          object &&
          typeof object === 'object' &&
          !Array.isArray(object) &&
          Object.keys(object).every((field) => fields.includes(field))
        if (
          !onlyFields(value, [
            'schemaVersion',
            'evidenceId',
            'activityId',
            'activityKind',
            'parentActivityId',
            'state',
            'observedRoots',
            'initialViewState',
            'managedRootsFinalState',
            'fileReads',
            'externalPaths',
            'writerAttribution',
            'reasonCodes',
            'scientificOutputs',
            'relations',
            'predecessorGenerations'
          ])
        )
          throw new Error('Unknown history fields.')
        if (
          value.schemaVersion !== 1 ||
          !ACTIVITY_KINDS.has(value.activityKind) ||
          !['available', 'partial', 'unavailable'].includes(value.state) ||
          !Array.isArray(value.relations) ||
          (value.predecessorGenerations !== undefined &&
            !Array.isArray(value.predecessorGenerations))
        )
          throw new Error('Unknown historical evidence format.')
        if (
          value.relations.some(
            (relation) =>
              !onlyFields(relation, [
                'relation',
                'relativePath',
                'pathPortability',
                'authority',
                'before',
                'previousGenerationId',
                'previousReasonCode',
                'generation',
                'reasonCode',
                'registeredInput'
              ]) ||
              ![
                'present-before',
                'staged-input',
                'created',
                'modified',
                'deleted',
                'harvested-output',
                'remote-input-reference'
              ].includes(relation.relation)
          )
        )
          throw new Error('Unknown history relation fields.')
        const generations = [
          ...value.relations.flatMap((relation) =>
            relation.generation ? [relation.generation] : []
          ),
          ...(value.predecessorGenerations ?? [])
        ]
        const ids = new Set()
        for (const generation of generations) {
          if (
            !onlyFields(generation, [
              'generationId',
              'relativePath',
              'checksum',
              'sizeBytes',
              'contentStorageKey',
              'capturedAt'
            ]) ||
            typeof generation.generationId !== 'string' ||
            !/^[a-f0-9]{64}$/.test(generation.checksum) ||
            !Number.isSafeInteger(generation.sizeBytes) ||
            generation.sizeBytes < 0 ||
            typeof generation.contentStorageKey !== 'string' ||
            !generation.contentStorageKey.startsWith(`${prefix}/`) ||
            !generation.contentStorageKey.endsWith(`/blobs/sha256-${generation.checksum}`) ||
            generation.contentStorageKey.split('/').some((part) => !SAFE_NAME.test(part))
          )
            throw new Error('Invalid historical generation.')
          ids.add(generation.generationId)
          if (generation.contentStorageKey.startsWith(`${pool.storageKeyPrefix}/`))
            throw new Error('Pool-addressed legacy content needs a separate migration.')
          references.add(generation.contentStorageKey)
        }
        // Historical filtering could discard the predecessor mapping. Its bytes are unproven.
        if (
          value.relations.some(
            (relation) => relation.previousGenerationId && !ids.has(relation.previousGenerationId)
          )
        )
          throw new Error('Unresolved historical predecessor.')
        sidecars.set(`${key}/evidence.json`, {
          value,
          checksum: createHash('sha256').update(bytes).digest('hex')
        })
      } else if (entry.name === '.session-package-owner' && depth === 1 && entry.isFile()) {
        const metadata = lstatSync(path)
        const operation = readRegularFile(path, 36).toString('utf8')
        if (
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(operation) ||
          fingerprint(lstatSync(path)) !== fingerprint(metadata)
        )
          throw new Error('Invalid package ownership marker.')
        // A surviving import stage also protects publication interrupted by a host restart.
        if (entryExists(join(projectRoot, '..', '..', 'session-package-imports', operation)))
          throw new Error('History contains an unfinished import.')
        metadataSnapshots.push([path, fingerprint(metadata)])
      } else if (!/^\.ownership-[A-Za-z0-9-]+$/.test(entry.name) || !entry.isFile()) {
        throw new Error('Unknown history entry.')
      }
    }
  }
  try {
    scan(projectRoot, prefix, 0)
  } catch {
    return { ok: true, maintainedFiles: 0 }
  }
  let maintainedFiles = 0
  let measuredBytes = 0
  for (const owner of request.retained.slice(0, 32)) {
    const record = sidecars.get(owner.storageKey)
    if (
      !record ||
      record.checksum !== owner.checksum ||
      record.value.evidenceId !== owner.evidenceId ||
      record.value.activityId !== owner.activityId ||
      record.value.activityKind !== owner.activityKind
    )
      continue
    const expectedKey = `${request.storageKeyPrefix}/${assertSafeName(owner.finalName)}/evidence.json`
    if (owner.storageKey !== expectedKey) continue
    const activity = owner.finalName
    const marker = readdirSync(activity).filter((name) => /^\.ownership-[A-Za-z0-9-]+$/.test(name))
    if (marker.length !== 1 || lstatSync(join(activity, marker[0])).size !== 0) continue
    const blobs = join(activity, ACTIVITY_BLOBS_DIRECTORY)
    if (!entryIdentity(blobs)) continue
    const blobDirectory = entryIdentity(blobs)
    for (const name of readdirSync(blobs)) {
      if (
        maintainedFiles >= 64 ||
        measuredBytes >= 256 * 1024 * 1024 ||
        Date.now() - started > 3000
      )
        return { ok: true, maintainedFiles }
      if (!BLOB_NAME.test(name)) continue
      const path = join(blobs, name)
      const pooledPath = join(pool.path, name)
      const before = lstatSync(path)
      if (!before.isFile() || before.isSymbolicLink() || !entryExists(pooledPath)) continue
      const pooled = lstatSync(pooledPath)
      if (!pooled.isFile() || pooled.isSymbolicLink() || pooled.size !== before.size) continue
      const referenced =
        references.has(`${request.storageKeyPrefix}/${activity}/blobs/${name}`) ||
        references.has(`${pool.storageKeyPrefix}/${name}`)
      if (referenced && sameIdentity(identity(before), identity(pooled))) continue
      if (before.size > 1024 * 1024 * 1024) continue
      measuredBytes += before.size
      // Filenames alone never prove equality or ownership. Revalidate immediately before mutation.
      try {
        verifyBlob(path, before.size, name.slice(7))
        verifyBlob(pooledPath, pooled.size, name.slice(7))
        for (const [directory, expected] of directories)
          if (!sameIdentity(entryIdentity(directory), expected)) throw new Error('History moved.')
        for (const [metadataPath, expected] of metadataSnapshots)
          if (fingerprint(lstatSync(metadataPath)) !== expected)
            throw new Error('History references changed.')
        if (
          !sameIdentity(entryIdentity(blobs), blobDirectory) ||
          fingerprint(lstatSync(path)) !== fingerprint(before) ||
          fingerprint(lstatSync(pooledPath)) !== fingerprint(pooled) ||
          createHash('sha256')
            .update(readRegularFile(join(activity, 'evidence.json'), MAX_INTERNAL_JSON_BYTES))
            .digest('hex') !== owner.checksum
        )
          throw new Error('History changed.')
        if (!referenced) {
          rmSync(path)
        } else {
          // Atomic replacement preserves every logical path and the old bytes until publication.
          const temporary = join(blobs, `.compact-${name}`)
          // Resume only our verified hardlink left by an interrupted atomic replacement.
          if (entryExists(temporary)) {
            const stale = lstatSync(temporary)
            if (
              !stale.isFile() ||
              stale.isSymbolicLink() ||
              !sameIdentity(identity(stale), identity(pooled))
            )
              continue
            rmSync(temporary)
          }
          try {
            linkSync(pooledPath, temporary)
            verifyBlob(temporary, before.size, name.slice(7))
            if (
              !sameIdentity(identity(lstatSync(temporary)), identity(pooled)) ||
              fingerprint(lstatSync(path)) !== fingerprint(before) ||
              !sameIdentity(entryIdentity(blobs), blobDirectory)
            )
              throw new Error('History changed before replacement.')
            renameSync(temporary, path)
          } finally {
            rmSync(temporary, { force: true })
          }
        }
        syncDirectoryPath(blobs)
        maintainedFiles++
      } catch {
        // A failed optimization never authorizes removal of the original content.
        continue
      }
    }
  }
  // The existing pool sweeper only unlinks verified objects with no remaining hardlink owner.
  sweepBlobPool(pool)
  return { ok: true, maintainedFiles }
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

// The host supplies only a verified same-Project Version identity, never the mutable input.
// Keep the private link only when it still identifies those exact bytes; otherwise copy normally.
const linkImmutableInput = (source, temporaryName, size, checksum) => {
  if (!source || typeof source.physicalPath !== 'string' || !validIdentity(source)) return false
  let linked = false
  try {
    const metadata = lstatSync(source.physicalPath)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      !sameIdentity(identity(metadata), source)
    )
      return false
    linkSync(source.physicalPath, temporaryName)
    linked = true
    const retained = lstatSync(temporaryName)
    if (
      !retained.isFile() ||
      retained.isSymbolicLink() ||
      !sameIdentity(identity(retained), source)
    )
      throw new Error('Immutable input changed before retention.')
    verifyBlob(temporaryName, size, checksum)
    return true
  } catch {
    if (linked) rmSync(temporaryName)
    return false
  }
}

const copyGeneration = (
  source,
  generation,
  relativePath,
  request,
  runBytesUsed,
  newBytesUsed,
  blobPool,
  existingBlobBytes,
  immutableSource
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
    let sharedImmutable = false
    if (existsSync(blobPath)) {
      verifyBlob(blobPath, before.size, checksum)
      bindRunBlob(blobPath, contentName, before.size, checksum)
    } else {
      if (existingBlobBytes + before.size > request.maxEvidenceBytes) {
        return { state: 'unavailable', reason: 'generation-budget-exceeded' }
      }
      sharedImmutable =
        !sameIdentity(identity(before), immutableSource) &&
        linkImmutableInput(immutableSource, temporaryName, before.size, checksum)
      if (!sharedImmutable) {
        const filesystem = statfsSync(blobPool.path)
        const currentAvailableBytes = Math.min(
          request.availableBytes - newBytesUsed,
          filesystem.bavail * filesystem.bsize
        )
        if (currentAvailableBytes - before.size < request.diskReserveBytes) {
          return { state: 'unavailable', reason: 'generation-budget-exceeded' }
        }
        targetDescriptor = openSync(
          temporaryName,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600
        )
        const copied = streamDescriptor(sourceDescriptor, before.size, targetDescriptor)
        if (copied.bytesRead !== before.size || copied.checksum !== checksum) {
          return { state: 'unavailable', reason: 'generation-freeze-failed' }
        }
        fsyncSync(targetDescriptor)
        closeSync(targetDescriptor)
        targetDescriptor = undefined
      }
      const afterCopy = fstatSync(sourceDescriptor)
      if (
        fingerprint(before) !== fingerprint(afterCopy) ||
        fingerprint(afterCopy) !== fingerprint(source)
      ) {
        return { state: 'unavailable', reason: 'generation-freeze-failed' }
      }
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
      newBytes: publishedNewBlob && !sharedImmutable ? before.size : 0,
      newPoolBytes: publishedNewBlob ? before.size : 0,
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
  let existingBlobBytes = blobPoolBytes(blobPool)
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
      const registeredInput =
        item.registeredInput === undefined ? undefined : assertRegisteredInput(item.registeredInput)
      const frozen = copyGeneration(
        item.file,
        item.generation,
        item.file.relativePath,
        request,
        bytesUsed,
        newBytesUsed,
        blobPool,
        existingBlobBytes,
        registeredInput ? item.immutableSource : undefined
      )
      const relation = {
        relation: item.relation === 'staged-input' ? 'staged-input' : 'present-before',
        relativePath: item.file.relativePath,
        pathPortability: 'relative',
        authority: item.relation === 'staged-input' ? 'explicit-transfer' : 'advisory'
      }
      if (frozen.state === 'available') {
        if (registeredInput && frozen.generation.checksum !== registeredInput.checksum) {
          throw new Error('Registered input checksum does not match its frozen generation.')
        }
        relation.generation = frozen.generation
        if (registeredInput) relation.registeredInput = registeredInput
        bytesUsed += frozen.generation.sizeBytes
        newBytesUsed += frozen.newBytes
        existingBlobBytes += frozen.newPoolBytes
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
  let existingBlobBytes = blobPoolBytes(blobPool)
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
    const readPaths = Array.isArray(request.readPaths)
      ? new Set(request.readPaths.filter((path) => typeof path === 'string'))
      : null
    const relations = capture.relations.filter(
      (relation) =>
        relation.relation !== 'present-before' || !readPaths || readPaths.has(relation.relativePath)
    )
    const generations = []
    const reasons = [
      ...request.reasonCodes,
      ...relations.flatMap((relation) => (relation.reasonCode ? [relation.reasonCode] : [])),
      ...(capture.initialViewState === 'unavailable'
        ? ['initial-file-generations-not-captured']
        : [])
    ]
    // Keep predecessor bytes even when the final read set excludes their initial relation.
    const retainedInitialIds = new Set([
      ...relations.flatMap(({ generation }) => (generation ? [generation.generationId] : [])),
      ...request.changes.flatMap(({ change }) => {
        const previous = change.before && baselineByPath.get(change.relativePath)
        return previous ? [previous.generationId] : []
      })
    ])
    const retainedInitialGenerations = capture.relations.flatMap(({ generation }) =>
      generation && retainedInitialIds.has(generation.generationId) ? [generation] : []
    )
    let bytesUsed = retainedInitialGenerations.reduce(
      (sum, generation) => sum + generation.sizeBytes,
      0
    )
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
          existingBlobBytes += frozen.newPoolBytes
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

    const reasonCodes = evidenceReasons(request, reasons)
    const requestedEvidenceState = ['available', 'partial', 'unavailable'].includes(
      request.evidenceState
    )
      ? request.evidenceState
      : request.rootsAvailable
        ? 'partial'
        : 'unavailable'
    const evidenceState =
      requestedEvidenceState === 'available' && reasonCodes.length > 0
        ? 'partial'
        : requestedEvidenceState
    const relationGenerationIds = new Set(
      relations.map((relation) => relation.generation?.generationId)
    )
    const previousGenerationIds = new Set(
      relations.map((relation) => relation.previousGenerationId)
    )
    const predecessorGenerations = retainedInitialGenerations.filter(
      (generation) =>
        previousGenerationIds.has(generation.generationId) &&
        !relationGenerationIds.has(generation.generationId)
    )
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
      fileReads: ['complete', 'partial', 'unavailable'].includes(request.fileReads)
        ? request.fileReads
        : 'unavailable',
      externalPaths: ['complete', 'partial', 'unavailable'].includes(request.externalPaths)
        ? request.externalPaths
        : 'unavailable',
      writerAttribution: ['complete', 'partial', 'unavailable'].includes(request.writerAttribution)
        ? request.writerAttribution
        : 'unavailable',
      reasonCodes,
      scientificOutputs: request.scientificOutputs,
      ...(predecessorGenerations.length ? { predecessorGenerations } : {}),
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

    releaseUnusedInitialBlobs(
      capture.relations,
      [
        ...retainedInitialGenerations,
        ...relations.flatMap(({ generation }) => (generation ? [generation] : []))
      ],
      blobPool,
      request
    )

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

const reconcile = (request, sweepBlobs = true) => {
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
    removedBlobEntries: sweepBlobs ? sweepBlobPool(blobPool) : 0
  }
}

// The caller holds the same evidence mutation queue used by single-Activity operations.
// Keep ownership/identity validation inside the worker; batching must never trust directory names
// or turn an unsafe Project/Session path into a cleanup target.
const reconcileComputeProject = (request) => {
  ensureProject(request)
  const rootPath = process.cwd()
  const projectName = assertSafeName(request.projectName)
  const projectIdentity = entryIdentity(projectName)
  process.chdir(projectName)
  let result
  try {
    assertBoundRoot(projectIdentity)
    const projectPath = process.cwd()
    const ensureDirectory = (name) => {
      assertSafeName(name)
      if (!entryExists(name)) mkdirSync(name, { mode: 0o700 })
      const actual = entryIdentity(name)
      if (!actual) throw new Error('Unsafe file-evidence recovery directory.')
      return actual
    }
    const blobIdentity = ensureDirectory('blobs')
    const binding = {
      blobRoot: join(projectPath, 'blobs'),
      expectedBlobRootIdentity: blobIdentity,
      blobStorageKeyPrefix: `execution-file-evidence/${projectName}/blobs`
    }
    let removedStagingEntries = 0
    let removedActivityEntries = 0
    for (const session of request.sessions) {
      const sessionName = assertSafeName(session.sessionName)
      if (sessionName === 'blobs') throw new Error('Reserved file-evidence Session name.')
      assertBoundRoot(projectIdentity)
      const sessionIdentity = ensureDirectory(sessionName)
      process.chdir(sessionName)
      try {
        const result = reconcile(
          {
            ...binding,
            expectedRootIdentity: sessionIdentity,
            retained: session.retained,
            deferredActivityIds: session.deferredActivityIds,
            deferredActivityKinds: ['notebook-run']
          },
          false
        )
        removedStagingEntries += result.removedStagingEntries
        removedActivityEntries += result.removedActivityEntries
      } finally {
        process.chdir(projectPath)
      }
      assertBoundRoot(projectIdentity)
      if (!sameIdentity(entryIdentity(sessionName), sessionIdentity)) {
        throw new Error('File-evidence Session directory changed during recovery.')
      }
    }
    result = {
      ok: true,
      removedStagingEntries,
      removedActivityEntries,
      removedBlobEntries: sweepBlobPool(bindBlobPool(binding))
    }
  } finally {
    process.chdir(rootPath)
  }
  assertBoundRoot(request.expectedRootIdentity)
  if (!sameIdentity(entryIdentity(projectName), projectIdentity)) {
    throw new Error('File-evidence Project directory changed during recovery.')
  }
  return result
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
      request.operation === 'compact-history'
        ? compactHistory(request)
        : request.operation === 'begin'
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
                        : request.operation === 'reconcile-compute-project'
                          ? reconcileComputeProject(request)
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
