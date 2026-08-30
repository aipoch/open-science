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
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} = require('node:fs')

const MAX_REQUEST_BYTES = 64 * 1024 * 1024
const MAX_INTERNAL_JSON_BYTES = 64 * 1024 * 1024
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const RECEIPT_NAME = /^receipt-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u
const CAPTURE_FILE = 'capture.json'
const ownershipFile = (token) => `.ownership-${assertSafeName(token)}`
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
const uniqueReasons = (values) => [...new Set([...BASELINE_REASONS, ...values])].sort()
const assertSafeName = (value) => {
  if (!SAFE_NAME.test(value)) throw new Error(`Unsafe file-evidence name: ${value}`)
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
const syncDirectory = () => {
  try {
    const descriptor = openSync('.', constants.O_RDONLY)
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error
  }
}
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
  writeFileSync(name, contents, {
    encoding: 'utf8',
    flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode: 0o600
  })
  const descriptor = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
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
const readReceipt = (name) => {
  const value = readJson(assertReceiptName(name), MAX_REQUEST_BYTES)
  if (!receiptShape(value) || value.receiptName !== name) {
    throw new Error(`Invalid file-evidence recovery receipt: ${name}`)
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
const removeOwnedDirectory = (name, expectedIdentity) => {
  const actual = entryIdentity(name)
  if (!actual) return false
  if (expectedIdentity && !sameIdentity(actual, expectedIdentity)) {
    throw new Error(`File-evidence owned directory identity changed: ${name}`)
  }
  rmSync(name, { recursive: true, force: true })
  return true
}
const removeReceipt = (receiptName) => {
  rmSync(assertReceiptName(receiptName), { force: true })
  syncDirectory()
}
const preparedStagingIdentity = (receipt) => {
  const actual = entryIdentity(receipt.stagingName)
  if (!actual) return undefined
  const entries = readdirSync(receipt.stagingName)
  if (entries.length === 0) return actual
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
const cleanupReceiptTargets = (receipt) => {
  let removedStagingEntries = 0
  let removedRunEntries = 0
  const stagingExpected =
    receipt.phase === 'prepared' ? preparedStagingIdentity(receipt) : receipt.stagingIdentity
  const stagingWasPresent = entryIdentity(receipt.stagingName) !== undefined
  if (stagingExpected && removeOwnedDirectory(receipt.stagingName, stagingExpected)) {
    removedStagingEntries += 1
  }
  const finalExpected =
    receipt.finalIdentity ?? (!stagingWasPresent ? receipt.stagingIdentity : undefined)
  if (finalExpected && removeOwnedDirectory(receipt.finalName, finalExpected)) {
    removedRunEntries += 1
  }
  removeReceipt(receipt.receiptName)
  return { removedStagingEntries, removedRunEntries }
}

const copyGeneration = (source, generation, relativePath, request, runBytesUsed, newBytesUsed) => {
  if (request.captureCancelled) {
    return { state: 'unavailable', reason: 'generation-freeze-failed' }
  }
  const temporaryName = `.incoming-${randomUUID()}`
  let sourceDescriptor
  let targetDescriptor
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
      runBytesUsed + before.size > request.maxRunBytes ||
      request.availableBytes - newBytesUsed - before.size < request.diskReserveBytes
    ) {
      return { state: 'unavailable', reason: 'generation-budget-exceeded' }
    }

    targetDescriptor = openSync(
      temporaryName,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    const hash = createHash('sha256')
    let position = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (position < before.size) {
      const bytesRead = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      )
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        written += writeSync(targetDescriptor, buffer, written, bytesRead - written)
      }
      position += bytesRead
    }
    const after = fstatSync(sourceDescriptor)
    if (
      position !== before.size ||
      fingerprint(before) !== fingerprint(after) ||
      fingerprint(after) !== fingerprint(source)
    ) {
      return { state: 'unavailable', reason: 'generation-freeze-failed' }
    }
    fsyncSync(targetDescriptor)
    closeSync(targetDescriptor)
    targetDescriptor = undefined

    const checksum = hash.digest('hex')
    const contentName = `sha256-${checksum}-${randomUUID()}`
    linkSync(temporaryName, contentName)
    rmSync(temporaryName, { force: true })
    return {
      state: 'available',
      generation: {
        generationId: generation.generationId,
        relativePath,
        checksum,
        sizeBytes: before.size,
        contentStorageKey: `${request.storageKeyPrefix}/${request.finalName}/${contentName}`,
        capturedAt: generation.capturedAt
      }
    }
  } finally {
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor)
    if (targetDescriptor !== undefined) closeSync(targetDescriptor)
    rmSync(temporaryName, { force: true })
  }
}

const begin = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
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
    runId: request.runId,
    evidenceId: request.evidenceId,
    storageKeyPrefix,
    ownershipToken: randomUUID()
  }
  publishExclusiveFile(receiptName, `${JSON.stringify(receipt, null, 2)}\n`)
  let stagingIdentity
  try {
    mkdirSync(stagingName, { mode: 0o700 })
    stagingIdentity = identity(lstatSync(stagingName))
    process.chdir(stagingName)
    if (!sameIdentity(identity(statSync('.')), stagingIdentity)) {
      throw new Error('File-evidence staging directory changed during capture binding.')
    }
    writeExclusiveFile(ownershipFile(receipt.ownershipToken), '')
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
        newBytesUsed
      )
      const relation = {
        relation: 'available-before',
        relativePath: item.file.relativePath,
        pathPortability: 'relative',
        authority: 'advisory'
      }
      if (frozen.state === 'available') {
        relation.generation = frozen.generation
        bytesUsed += frozen.generation.sizeBytes
        newBytesUsed += frozen.generation.sizeBytes
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
      runId: request.runId,
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
      capturedInitialGenerations: relations.filter((item) => item.generation).length
    }
  } catch (error) {
    try {
      if (stagingIdentity && sameIdentity(identity(statSync('.')), stagingIdentity))
        process.chdir('..')
      assertBoundRoot(request.expectedRootIdentity)
      removeOwnedDirectory(stagingName, stagingIdentity)
      removeReceipt(receiptName)
    } catch {
      // Keep the original failure. A durable receipt remains for startup reconciliation if cleanup fails.
    }
    throw error
  }
}

const persist = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const receipt = readReceipt(request.receiptName)
  if (
    receipt.phase !== 'capturing' ||
    receipt.runId !== request.runId ||
    receipt.evidenceId !== request.evidenceId ||
    receipt.stagingName !== request.stagingName ||
    receipt.finalName !== request.finalName ||
    receipt.storageKeyPrefix !== request.storageKeyPrefix
  ) {
    throw new Error('File-evidence persistence does not match its recovery receipt.')
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
      capture.runId !== request.runId ||
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
        pathPortability: 'relative',
        authority: 'advisory',
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
          newBytesUsed
        )
        if (frozen.state === 'available') {
          relation.generation = frozen.generation
          bytesUsed += frozen.generation.sizeBytes
          newBytesUsed += frozen.generation.sizeBytes
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
    const sidecar = {
      schemaVersion: 1,
      evidenceId: request.evidenceId,
      runId: request.runId,
      state: request.rootsAvailable ? 'partial' : 'unavailable',
      observedRoots: request.rootKinds,
      initialViewState: capture.initialViewState,
      managedRootsFinalState: request.rootsAvailable ? 'partial' : 'unavailable',
      fileReads: 'unavailable',
      externalPaths: 'unavailable',
      writerAttribution: 'unavailable',
      reasonCodes,
      scientificOutputs: request.scientificOutputs,
      relations
    }
    const serialized = `${JSON.stringify(sidecar, null, 2)}\n`
    if (
      bytesUsed + Buffer.byteLength(serialized) > request.maxRunBytes ||
      request.availableBytes - newBytesUsed - Buffer.byteLength(serialized) <
        request.diskReserveBytes
    ) {
      throw new Error('File-evidence sidecar exceeds the reserved storage budget.')
    }
    rmSync(CAPTURE_FILE, { force: true })
    rmSync(ownershipFile(receipt.ownershipToken), { force: true })
    writeExclusiveFile('evidence.json', serialized)
    syncDirectory()

    process.chdir('..')
    assertBoundRoot(request.expectedRootIdentity)
    if (!sameIdentity(entryIdentity(receipt.stagingName), receipt.stagingIdentity)) {
      throw new Error('File-evidence staging directory identity changed before rename.')
    }
    if (existsSync(receipt.finalName)) throw new Error('File-evidence Run already exists.')
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
        evidenceId: request.evidenceId,
        state: sidecar.state,
        checksum: createHash('sha256').update(serialized).digest('hex'),
        storageKey: `${request.storageKeyPrefix}/${receipt.finalName}/evidence.json`,
        relationCount: relations.length,
        generationCount: relations.filter((relation) => relation.generation).length,
        scientificOutputCount: request.scientificOutputs.length,
        initialViewState: sidecar.initialViewState,
        managedRootsFinalState: sidecar.managedRootsFinalState,
        scientificOutputAnalysis: request.rootsAvailable ? 'partial' : 'unavailable',
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

const verifyPublishedEvidence = (receipt, expected) => {
  const expectedIdentity = receipt.finalIdentity ?? receipt.stagingIdentity
  const actualIdentity = entryIdentity(receipt.finalName)
  if (!actualIdentity || !expectedIdentity || !sameIdentity(actualIdentity, expectedIdentity)) {
    throw new Error('Published file-evidence directory identity mismatch.')
  }
  process.chdir(receipt.finalName)
  try {
    const bytes = readRegularFile('evidence.json', MAX_INTERNAL_JSON_BYTES)
    if (createHash('sha256').update(bytes).digest('hex') !== expected.checksum) {
      throw new Error('Published file-evidence checksum mismatch.')
    }
    const sidecar = JSON.parse(bytes.toString('utf8'))
    if (
      sidecar.schemaVersion !== 1 ||
      sidecar.runId !== expected.runId ||
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
    receipt.runId !== request.runId ||
    receipt.evidenceId !== request.evidenceId
  ) {
    throw new Error('File-evidence completion does not match its recovery receipt.')
  }
  verifyPublishedEvidence(receipt, request)
  removeReceipt(receipt.receiptName)
  return { ok: true, removedStagingEntries: 0, removedRunEntries: 0 }
}

const reconcile = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const retained = new Map(request.retained.map((item) => [item.runId, item]))
  let removedStagingEntries = 0
  let removedRunEntries = 0
  for (const entry of readdirSync('.', { withFileTypes: true })) {
    if (!RECEIPT_NAME.test(entry.name)) continue
    if (!entry.isFile()) throw new Error(`Unsafe file-evidence recovery receipt: ${entry.name}`)
    const receipt = readReceipt(entry.name)
    const expected = retained.get(receipt.runId)
    if (expected) {
      if (
        expected.receiptName !== receipt.receiptName ||
        expected.finalName !== receipt.finalName ||
        expected.evidenceId !== receipt.evidenceId
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
    const removed = cleanupReceiptTargets(receipt)
    removedStagingEntries += removed.removedStagingEntries
    removedRunEntries += removed.removedRunEntries
  }
  return { ok: true, removedStagingEntries, removedRunEntries }
}

const cleanup = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const receipt = readReceipt(request.receiptName)
  return { ok: true, ...cleanupReceiptTargets(receipt) }
}

const deleteProject = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const projectName = assertSafeName(request.projectName)
  if (!existsSync(projectName)) return { ok: true, removedProjectEntries: 0 }
  const projectIdentity = entryIdentity(projectName)
  if (!projectIdentity) {
    throw new Error('Unsafe Notebook file-evidence Project directory.')
  }
  removeOwnedDirectory(projectName, projectIdentity)
  syncDirectory()
  return { ok: true, removedProjectEntries: 1 }
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
        : request.operation === 'persist'
          ? persist(request)
          : request.operation === 'complete'
            ? complete(request)
            : request.operation === 'cleanup'
              ? cleanup(request)
              : request.operation === 'delete-project'
                ? deleteProject(request)
                : request.operation === 'reconcile'
                  ? reconcile(request)
                  : (() => {
                      throw new Error('Unsupported file-evidence worker operation.')
                    })()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
})
