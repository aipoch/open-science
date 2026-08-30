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
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} = require('node:fs')

const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const BASELINE_REASONS = [
  'file-reads-not-observed',
  'initial-file-generations-not-captured',
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
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
const fingerprint = (value) =>
  [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':')
const uniqueReasons = (values) => [...new Set([...BASELINE_REASONS, ...values])].sort()
const assertSafeName = (value) => {
  if (!SAFE_NAME.test(value)) throw new Error(`Unsafe file-evidence name: ${value}`)
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
const copyGeneration = (change, generation, request, bytesUsed) => {
  if (request.captureCancelled) {
    return { state: 'unavailable', reason: 'generation-freeze-failed' }
  }
  const temporaryName = `.incoming-${randomUUID()}`
  let source
  let target
  try {
    try {
      source = openSync(
        change.after.physicalPath,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
      )
    } catch {
      return { state: 'unavailable', reason: 'generation-freeze-failed' }
    }
    const before = fstatSync(source)
    if (!before.isFile() || fingerprint(before) !== fingerprint(change.after)) {
      return { state: 'unavailable', reason: 'generation-freeze-failed' }
    }
    if (
      before.size > request.maxGenerationBytes ||
      bytesUsed + before.size > request.maxRunBytes ||
      request.availableBytes - bytesUsed - before.size < request.diskReserveBytes
    ) {
      return { state: 'unavailable', reason: 'generation-budget-exceeded' }
    }

    target = openSync(
      temporaryName,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    const hash = createHash('sha256')
    let position = 0
    const buffer = Buffer.allocUnsafe(64 * 1024)
    while (position < before.size) {
      const bytesRead = readSync(
        source,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      )
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        written += writeSync(target, buffer, written, bytesRead - written)
      }
      position += bytesRead
    }
    const after = fstatSync(source)
    if (
      position !== before.size ||
      fingerprint(before) !== fingerprint(after) ||
      fingerprint(after) !== fingerprint(change.after)
    ) {
      return { state: 'unavailable', reason: 'generation-freeze-failed' }
    }
    fsyncSync(target)
    closeSync(target)
    target = undefined

    const checksum = hash.digest('hex')
    // Each relation is a distinct scientific generation even when its bytes match another
    // relation. Publish it with an unpredictable run-local name and a no-overwrite hard link.
    // linkSync fails on any pre-existing file or symlink, so collision handling never follows or
    // retains an attacker-controlled path.
    const contentName = `sha256-${checksum}-${randomUUID()}`
    linkSync(temporaryName, contentName)
    rmSync(temporaryName, { force: true })
    return {
      state: 'available',
      generation: {
        generationId: generation.generationId,
        relativePath: change.relativePath,
        checksum,
        sizeBytes: before.size,
        contentStorageKey: `file-evidence/${request.finalName}/${contentName}`,
        capturedAt: generation.capturedAt
      }
    }
  } finally {
    if (source !== undefined) closeSync(source)
    if (target !== undefined) closeSync(target)
    rmSync(temporaryName, { force: true })
  }
}

const persist = (request) => {
  // cwd is the storage capability: the parent binds this worker to the already-validated directory
  // object. Every evidence mutation below is relative to that bound object, never to a path that the
  // notebook process can redirect after validation.
  assertBoundRoot(request.expectedRootIdentity)
  const stagingName = assertSafeName(request.stagingName)
  const finalName = assertSafeName(request.finalName)
  mkdirSync(stagingName, { mode: 0o700 })
  const stagedPath = lstatSync(stagingName)
  if (stagedPath.isSymbolicLink() || !stagedPath.isDirectory()) {
    throw new Error('File-evidence staging path is not a real directory.')
  }
  const stagingIdentity = identity(stagedPath)
  process.chdir(stagingName)
  if (!sameIdentity(identity(statSync('.')), stagingIdentity)) {
    throw new Error('File-evidence staging directory changed before binding.')
  }
  process.chdir('..')
  assertBoundRoot(request.expectedRootIdentity)
  process.chdir(stagingName)
  if (!sameIdentity(identity(statSync('.')), stagingIdentity)) {
    throw new Error('File-evidence staging directory changed during binding.')
  }
  const relations = []
  const generations = []
  const reasons = [...request.reasonCodes]
  let bytesUsed = 0
  try {
    for (const item of request.changes) {
      const change = item.change
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
              }
            }
          : {})
      }
      if (change.after) {
        const frozen = copyGeneration(change, item.generation, request, bytesUsed)
        if (frozen.state === 'available') {
          relation.generation = frozen.generation
          bytesUsed += frozen.generation.sizeBytes
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
      request.publicationAvailableBytes - bytesUsed - Buffer.byteLength(serialized) <
        request.diskReserveBytes
    ) {
      throw new Error('File-evidence sidecar exceeds the reserved storage budget.')
    }
    writeFileSync('evidence.json', serialized, {
      encoding: 'utf8',
      flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      mode: 0o600
    })
    const evidenceDescriptor = openSync('evidence.json', constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      fsyncSync(evidenceDescriptor)
    } finally {
      closeSync(evidenceDescriptor)
    }
    syncDirectory()

    process.chdir('..')
    assertBoundRoot(request.expectedRootIdentity)
    if (!sameIdentity(identity(lstatSync(stagingName)), stagingIdentity)) {
      throw new Error('File-evidence staging directory identity changed.')
    }
    if (existsSync(finalName)) throw new Error('File-evidence Run already exists.')
    renameSync(stagingName, finalName)
    syncDirectory()
    return {
      ok: true,
      generations,
      fileEvidence: {
        schemaVersion: 1,
        evidenceId: request.evidenceId,
        state: sidecar.state,
        checksum: createHash('sha256').update(serialized).digest('hex'),
        storageKey: `file-evidence/${finalName}/evidence.json`,
        relationCount: relations.length,
        generationCount: generations.length,
        scientificOutputCount: request.scientificOutputs.length,
        managedRootsFinalState: sidecar.managedRootsFinalState,
        scientificOutputAnalysis: request.rootsAvailable ? 'partial' : 'unavailable',
        fileReads: sidecar.fileReads,
        externalPaths: sidecar.externalPaths,
        writerAttribution: sidecar.writerAttribution,
        reasonCodes
      }
    }
  } catch (error) {
    if (sameIdentity(identity(statSync('.')), stagingIdentity)) process.chdir('..')
    rmSync(stagingName, { recursive: true, force: true })
    throw error
  }
}

const reconcile = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  const retained = new Set(request.retainedFinalNames.map(assertSafeName))
  let removedStagingEntries = 0
  let removedRunEntries = 0
  for (const entry of require('node:fs').readdirSync('.', { withFileTypes: true })) {
    if (entry.name.startsWith('staging-')) {
      rmSync(entry.name, { recursive: true, force: true })
      removedStagingEntries += 1
    } else if (entry.name.startsWith('run-') && !retained.has(entry.name)) {
      rmSync(entry.name, { recursive: true, force: true })
      removedRunEntries += 1
    }
  }
  syncDirectory()
  return { ok: true, removedStagingEntries, removedRunEntries }
}

const cleanup = (request) => {
  assertBoundRoot(request.expectedRootIdentity)
  for (const name of request.names.map(assertSafeName)) {
    rmSync(name, { recursive: true, force: true })
  }
  syncDirectory()
  return { ok: true, removedStagingEntries: 0, removedRunEntries: 0 }
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
      request.operation === 'persist'
        ? persist(request)
        : request.operation === 'cleanup'
          ? cleanup(request)
          : reconcile(request)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
})
