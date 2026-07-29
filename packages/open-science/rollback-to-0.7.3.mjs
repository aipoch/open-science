/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep
} from 'node:path'

const TARGET_VERSION = '0.7.3'
const ROLLBACK_MANIFEST = 'rollback-to-0.7.3.json'
const CUTOVER_MARKER_SUFFIX = '.rollback-to-0.7.3.pending.json'
const PREPARED_MARKER_SUFFIX = '.prepared'
const DATA_DIRECTORIES = ['artifacts', 'notebooks', 'uploads', 'workspaces']
const CONFIG_EXCLUDED_DIRECTORIES = new Set([...DATA_DIRECTORIES, 'runtime'])
const TRANSIENT_CONFIG_FILES = new Set([
  'open-science.db-shm',
  'open-science.db-wal',
  'web-service.json'
])

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const canonicalPathForNewEntry = async (path) => {
  const suffix = []
  let cursor = resolve(path)
  while (!(await exists(cursor))) {
    const parent = dirname(cursor)
    if (parent === cursor)
      throw new Error(`No existing parent directory for rollback path: ${path}`)
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  return resolve(await realpath(cursor), ...suffix)
}

const assertSafeSourceRoot = async (path, label) => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link or junction: ${path}`)
  }
  if (!metadata.isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
  const canonical = await realpath(path)
  const canonicalHome = await realpath(homedir())
  if (samePath(canonical, parse(canonical).root) || samePath(canonical, canonicalHome)) {
    throw new Error(`${label} is too broad for rollback: ${path}`)
  }
  return canonical
}

const assertCopyEntryIsNotLink = async (path) => {
  if ((await lstat(path)).isSymbolicLink()) {
    throw new Error(`Rollback cannot isolate a symbolic link or junction: ${path}`)
  }
}

const samePath = (left, right) => {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

const isInsideOrEqual = (root, candidate) => {
  if (samePath(root, candidate)) return true
  const rel = relative(resolve(root), resolve(candidate))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

const formatStamp = (milliseconds) =>
  new Date(milliseconds)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')

const assertSafeStorageKey = (storageKey) => {
  if (typeof storageKey !== 'string' || !storageKey) {
    throw new Error('Rollback Version has no content storage key.')
  }
  const segments = storageKey.split(/[\\/]+/)
  if (
    isAbsolute(storageKey) ||
    /^[A-Za-z]:[\\/]|^[\\/]/.test(storageKey) ||
    segments.some((segment) => !segment || segment === '..')
  ) {
    throw new Error(`Rollback Version has an unsafe content storage key: ${storageKey}`)
  }
  return segments.join('/')
}

const versionIdFromLocator = (path, prefix) => {
  if (typeof path !== 'string' || !path.startsWith(prefix)) return undefined
  const encoded = path.slice(prefix.length).split('/').filter(Boolean).at(-1)
  if (!encoded) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

const resolveVersion = (kind, candidate, versions) => {
  const prefix = kind === 'upload' ? 'upload-version:' : 'artifact-version:'
  const versionId = candidate.versionId ?? versionIdFromLocator(candidate.path, prefix)
  if (!versionId) return undefined
  const version = versions.get(versionId)
  if (!version) {
    throw new Error(`Cannot materialize ${kind} Version ${versionId} for Open Science 0.7.3.`)
  }
  return version
}

const versionPath = (kind, candidate, versions) => {
  const version = resolveVersion(kind, candidate, versions)
  return version ? `$DATA/${version.storageKey}` : undefined
}

const legacyPath = (path, sourceDataRoot) => {
  if (typeof path !== 'string' || !path) return undefined
  if (path.startsWith('$DATA/')) return path
  if (!isAbsolute(path) || !isInsideOrEqual(sourceDataRoot, path)) return path
  const rel = relative(sourceDataRoot, path).split(sep).join('/')
  return rel ? `$DATA/${rel}` : undefined
}

const absoluteRollbackPath = (rollbackDataRoot, storageKey) =>
  resolve(rollbackDataRoot, ...assertSafeStorageKey(storageKey).split('/'))

const legacyPartPath = (path, context) => {
  if (typeof path !== 'string' || !path) return undefined
  if (path.startsWith('$DATA/')) {
    return absoluteRollbackPath(context.rollbackDataRoot, path.slice('$DATA/'.length))
  }
  if (!isAbsolute(path) || !isInsideOrEqual(context.sourceDataRoot, path)) return path
  return absoluteRollbackPath(
    context.rollbackDataRoot,
    relative(context.sourceDataRoot, path).split(sep).join('/')
  )
}

const convertUpload = (upload, context) => {
  if (!isRecord(upload)) return undefined
  const path =
    versionPath('upload', upload, context.uploadVersions) ??
    legacyPath(upload.path, context.sourceDataRoot)
  if (!path) {
    throw new Error(`Upload ${String(upload.id ?? '<unknown>')} has no 0.7.3-compatible path.`)
  }
  const converted = { ...upload, path }
  if (typeof upload.sha256 === 'string' && !converted.checksum) converted.checksum = upload.sha256
  delete converted.versionId
  delete converted.versionNumber
  delete converted.createdAt
  delete converted.sha256
  return converted
}

const convertArtifactReference = (reference, context) => {
  if (!isRecord(reference) || reference.type !== 'artifact') return reference
  if (reference.source !== 'upload' && reference.source !== 'artifact') return reference
  const version = resolveVersion(
    reference.source,
    reference,
    context[`${reference.source}Versions`]
  )
  const path = version
    ? absoluteRollbackPath(context.rollbackDataRoot, version.storageKey)
    : legacyPartPath(reference.path, context)
  if (!path) {
    throw new Error(`File reference ${String(reference.id ?? '<unknown>')} has no compatible path.`)
  }
  return { ...reference, path }
}

const convertArtifact = (artifact, context) => {
  if (!isRecord(artifact)) return undefined
  const path =
    versionPath('artifact', artifact, context.artifactVersions) ??
    legacyPath(artifact.path, context.sourceDataRoot)
  if (!path) {
    throw new Error(`Artifact ${String(artifact.id ?? '<unknown>')} has no 0.7.3-compatible path.`)
  }
  const converted = { ...artifact, path }
  delete converted.artifactId
  delete converted.versionId
  delete converted.versionNumber
  delete converted.checksum
  delete converted.createdAt
  delete converted.producerRunId
  delete converted.environment
  delete converted.fileUrl
  return converted
}

const resolveRollbackMessages = (source) => {
  const graph = source.conversationGraph
  if (!isRecord(graph)) return source.messages
  if (
    typeof graph.rootFrameId !== 'string' ||
    !Array.isArray(graph.frames) ||
    !Array.isArray(graph.branches) ||
    !Array.isArray(graph.messages)
  ) {
    throw new Error('Session Conversation Graph cannot be projected for Open Science 0.7.3.')
  }

  const rootFrame = graph.frames.find((frame) => isRecord(frame) && frame.id === graph.rootFrameId)
  if (!isRecord(rootFrame) || typeof rootFrame.activeBranchId !== 'string') {
    throw new Error('Session Conversation Graph has no active root Frame branch.')
  }
  const rootBranch = graph.branches.find(
    (branch) =>
      isRecord(branch) &&
      branch.id === rootFrame.activeBranchId &&
      branch.agentFrameId === graph.rootFrameId
  )
  if (!isRecord(rootBranch)) {
    throw new Error('Session Conversation Graph has no valid active root Message Branch.')
  }

  const messagesById = new Map(
    graph.messages
      .filter((message) => isRecord(message) && typeof message.id === 'string')
      .map((message) => [message.id, message])
  )
  const reversePath = []
  const seen = new Set()
  let currentId = rootBranch.headMessageId
  while (typeof currentId === 'string' && currentId) {
    if (seen.has(currentId)) throw new Error('Session Conversation Graph contains a Message cycle.')
    seen.add(currentId)
    const message = messagesById.get(currentId)
    if (!isRecord(message) || message.agentFrameId !== graph.rootFrameId) {
      throw new Error('Session root Message Branch references an invalid Message.')
    }
    reversePath.push(message)
    currentId = message.parentMessageId
  }
  return reversePath.reverse()
}

export const convertSessionToV073 = (value, context) => {
  if (!isRecord(value)) throw new Error('Session file is not an object.')
  const source = isRecord(value.session) ? value.session : value
  if (!Array.isArray(source.messages)) throw new Error('Session has no active Message projection.')

  const messages = resolveRollbackMessages(source).map((message) => {
    if (!isRecord(message)) throw new Error('Session contains an invalid Message.')
    const converted = { ...message }
    delete converted.agentFrameId
    delete converted.introducedOnBranchId
    delete converted.parentMessageId
    delete converted.revisionRootMessageId
    delete converted.supersedesMessageId
    delete converted.runtimeSegmentId
    if (Array.isArray(message.uploads)) {
      converted.uploads = message.uploads.map((upload) => convertUpload(upload, context))
    }
    if (Array.isArray(message.parts)) {
      converted.parts = message.parts.map((part) => convertArtifactReference(part, context))
    }
    return converted
  })
  const session = {
    ...source,
    cwd: legacyPath(source.cwd, context.sourceDataRoot) ?? source.cwd,
    messages
  }
  if (Array.isArray(source.artifacts)) {
    session.artifacts = source.artifacts.map((artifact) => convertArtifact(artifact, context))
  }
  delete session.conversationGraph
  return { version: 1, session }
}

const readVersionMap = (database, table, state) => {
  const found = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  if (!found) return new Map()
  const statement = database.prepare(
    `SELECT id, contentStorageKey, sizeBytes, checksum FROM "${table}" WHERE state = ?`
  )
  statement.setReadBigInts(true)
  const rows = statement.all(state)
  return new Map(
    rows.map((row) => {
      const checksum = String(row.checksum).toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(checksum)) {
        throw new Error(`${table} ${String(row.id)} has an invalid SHA-256 checksum.`)
      }
      return [
        String(row.id),
        {
          storageKey: assertSafeStorageKey(String(row.contentStorageKey)),
          sizeBytes: BigInt(row.sizeBytes),
          checksum
        }
      ]
    })
  )
}

const assertDatabaseIntegrity = (database, label) => {
  const rows = database.prepare('PRAGMA quick_check').all()
  if (rows.length !== 1 || String(rows[0]?.quick_check).toLowerCase() !== 'ok') {
    throw new Error(`${label} Open Science database failed SQLite quick_check.`)
  }
}

const readVersionIndexes = (databasePath) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assertDatabaseIntegrity(database, 'Source')
    return {
      uploadVersions: readVersionMap(database, 'UploadVersion', 'ready'),
      artifactVersions: readVersionMap(database, 'ArtifactVersion', 'finalized')
    }
  } finally {
    database.close()
  }
}

const validateCopiedDatabase = (databasePath) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assertDatabaseIntegrity(database, 'Copied')
  } finally {
    database.close()
  }
}

const sha256File = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

const validateVersionContents = async (indexes, dataRoot, label) => {
  for (const [kind, versions] of [
    ['Upload', indexes.uploadVersions],
    ['Artifact', indexes.artifactVersions]
  ]) {
    for (const [versionId, version] of versions) {
      const path = absoluteRollbackPath(dataRoot, version.storageKey)
      let metadata
      try {
        metadata = await lstat(path, { bigint: true })
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw new Error(`${label} ${kind} Version content is missing: ${versionId}`)
        }
        throw error
      }
      if (!metadata.isFile()) {
        throw new Error(`${label} ${kind} Version content is not a regular file: ${versionId}`)
      }
      if (metadata.size !== version.sizeBytes) {
        throw new Error(`${label} ${kind} Version size mismatch: ${versionId}`)
      }
      if ((await sha256File(path)) !== version.checksum) {
        throw new Error(`${label} ${kind} Version checksum mismatch: ${versionId}`)
      }
    }
  }
}

const resolveConfiguredDataRoot = async (configRoot) => {
  const settingsPath = join(configRoot, 'settings.json')
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (typeof settings.dataRoot === 'string' && isAbsolute(settings.dataRoot)) {
      return normalize(settings.dataRoot)
    }
  } catch {
    // Missing or malformed settings fall through to the same legacy/default discovery as the app.
  }
  const hasLegacyData = await Promise.all(
    DATA_DIRECTORIES.map((directory) => exists(join(configRoot, directory)))
  ).then((values) => values.some(Boolean))
  return hasLegacyData ? configRoot : join(homedir(), 'OpenScience')
}

const readActivatedRollback = async (configRoot, requestedOutput) => {
  try {
    const manifest = JSON.parse(await readFile(join(configRoot, ROLLBACK_MANIFEST), 'utf8'))
    if (!isRecord(manifest) || manifest.targetVersion !== TARGET_VERSION) return undefined
    if (typeof manifest.rollbackDataRoot !== 'string' || !isAbsolute(manifest.rollbackDataRoot)) {
      throw new Error('The activated rollback manifest has an invalid Data Root.')
    }
    if (requestedOutput && !samePath(manifest.rollbackDataRoot, requestedOutput)) {
      throw new Error(
        `A 0.7.3 rollback is already active at ${manifest.rollbackDataRoot}; its output cannot be changed in place.`
      )
    }
    if (!(await exists(manifest.rollbackDataRoot))) {
      throw new Error(`The activated rollback Data Root is missing: ${manifest.rollbackDataRoot}`)
    }
    return manifest
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

const cutoverMarkerPath = (configRoot) => `${configRoot}${CUTOVER_MARKER_SUFFIX}`

const preparedMarkerPath = (configRoot) =>
  `${cutoverMarkerPath(configRoot)}${PREPARED_MARKER_SUFFIX}`

const writeDurableJson = async (path, value) => {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (await exists(path)) throw new Error(`Rollback marker already exists: ${path}`)
    await rename(temporaryPath, path)
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

const syncTree = async (root) => {
  const metadata = await lstat(root)
  if (metadata.isSymbolicLink()) {
    throw new Error(`Rollback durability check found a symbolic link or junction: ${root}`)
  }
  if (metadata.isDirectory()) {
    for (const entry of await readdir(root)) await syncTree(join(root, entry))
    if (process.platform !== 'win32') {
      const directory = await open(root, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    return
  }
  if (!metadata.isFile()) {
    throw new Error(`Rollback durability check found an unsupported entry: ${root}`)
  }
  // FlushFileBuffers on Windows requires a write-capable handle for ordinary files.
  const file = await open(root, 'r+')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

const validateCutoverMarker = (marker, configRoot, path, expectedPhase) => {
  const phase = marker?.phase ?? 'prepared'
  if (
    !isRecord(marker) ||
    phase !== expectedPhase ||
    typeof marker.configRoot !== 'string' ||
    !samePath(marker.configRoot, configRoot) ||
    typeof marker.preservedConfigRoot !== 'string' ||
    typeof marker.stagingConfigRoot !== 'string' ||
    typeof marker.rollbackDataRoot !== 'string' ||
    dirname(marker.preservedConfigRoot) !== dirname(configRoot) ||
    dirname(marker.stagingConfigRoot) !== dirname(configRoot) ||
    !basename(marker.preservedConfigRoot).startsWith(`${basename(configRoot)}.before-rollback-`) ||
    !basename(marker.stagingConfigRoot).startsWith(`${basename(configRoot)}.rollback-staging-`)
  ) {
    throw new Error(`Invalid rollback cutover marker: ${path}`)
  }
  return marker
}

const readCutoverMarker = async (configRoot) => {
  const path = cutoverMarkerPath(configRoot)
  const preparedPath = preparedMarkerPath(configRoot)
  try {
    const marker = JSON.parse(await readFile(preparedPath, 'utf8'))
    return {
      path,
      preparedPath,
      ...validateCutoverMarker(marker, configRoot, preparedPath, 'prepared')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    const marker = JSON.parse(await readFile(path, 'utf8'))
    const phase = marker?.phase ?? 'prepared'
    if (phase !== 'preparing' && phase !== 'prepared') {
      throw new Error(`Invalid rollback cutover marker: ${path}`)
    }
    return { path, preparedPath, ...validateCutoverMarker(marker, configRoot, path, phase) }
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

const recoverInterruptedCutover = async (configRoot, requestedOutput) => {
  const marker = await readCutoverMarker(configRoot)
  if (!marker) return undefined
  if (requestedOutput && !samePath(marker.rollbackDataRoot, requestedOutput)) {
    throw new Error(
      `An interrupted 0.7.3 rollback already targets ${marker.rollbackDataRoot}; finish it before choosing another output.`
    )
  }
  const active = await readActivatedRollback(configRoot, requestedOutput)
  if (active) {
    await Promise.all([
      rm(marker.path, { force: true }),
      rm(marker.preparedPath, { force: true })
    ]).catch(() => undefined)
    return active
  }

  const configExists = await exists(configRoot)
  const preservedExists = await exists(marker.preservedConfigRoot)
  const stagingExists = await exists(marker.stagingConfigRoot)
  if (marker.phase === 'preparing') {
    await assertOffline(configRoot)
    if (!configExists || preservedExists) {
      throw new Error(
        `Interrupted rollback preparation has an unexpected Config Root state. Inspect ${configRoot} and ${marker.preservedConfigRoot} before continuing.`
      )
    }
    await Promise.all([
      rm(marker.stagingConfigRoot, { recursive: true, force: true }),
      rm(marker.rollbackDataRoot, { recursive: true, force: true }),
      rm(marker.path, { force: true }),
      rm(marker.preparedPath, { force: true })
    ])
    return undefined
  }
  if (!stagingExists) {
    throw new Error(
      `Interrupted rollback has no prepared Config Root. Restore ${marker.preservedConfigRoot} to ${configRoot} before continuing.`
    )
  }
  await assertOffline(configExists ? configRoot : marker.preservedConfigRoot)
  await validatePreparedRollback(marker)
  await assertOffline(configExists ? configRoot : marker.preservedConfigRoot)
  if (configExists) {
    if (preservedExists) {
      throw new Error(
        `Interrupted rollback has two possible newer Config Roots. Inspect ${configRoot} and ${marker.preservedConfigRoot} before continuing.`
      )
    }
    await activateRollbackConfig({
      configRoot,
      preservedConfigRoot: marker.preservedConfigRoot,
      stagingConfigRoot: marker.stagingConfigRoot
    })
  } else {
    if (!preservedExists) {
      throw new Error(
        `Interrupted rollback lost its preserved newer Config Root: ${marker.preservedConfigRoot}`
      )
    }
    await rename(marker.stagingConfigRoot, configRoot)
  }
  const recovered = await readActivatedRollback(configRoot, requestedOutput)
  if (!recovered)
    throw new Error('Interrupted rollback activation did not produce a valid manifest.')
  await Promise.all([rm(marker.path, { force: true }), rm(marker.preparedPath, { force: true })])
  return recovered
}

const assertOffline = async (configRoot) => {
  for (const suffix of ['-wal', '-shm']) {
    if (await exists(join(configRoot, `open-science.db${suffix}`))) {
      throw new Error(
        `Open Science may still be running (${`open-science.db${suffix}`} exists). Quit the app completely before rollback.`
      )
    }
  }
  try {
    const state = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
    if (Number.isInteger(state.pid) && state.pid > 0) {
      try {
        process.kill(state.pid, 0)
        throw new Error('Open Science is still running. Quit it completely before rollback.')
      } catch (error) {
        if (error?.code === 'EPERM') {
          throw new Error('Open Science is still running. Quit it completely before rollback.')
        }
        if (error?.code !== 'ESRCH') throw error
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === 'ENOENT') return
    throw error
  }
}

const copyRollbackData = async (sourceDataRoot, rollbackDataRoot) => {
  await mkdir(rollbackDataRoot, { recursive: false })
  for (const directory of DATA_DIRECTORIES) {
    const source = join(sourceDataRoot, directory)
    if (!(await exists(source))) continue
    await cp(source, join(rollbackDataRoot, directory), {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      filter: async (entry) => {
        await assertCopyEntryIsNotLink(entry)
        return true
      }
    })
  }
}

const copyRollbackConfig = async (configRoot, stagingConfigRoot, dataRoot) => {
  const nestedDataRoot = !samePath(configRoot, dataRoot) && isInsideOrEqual(configRoot, dataRoot)
  await cp(configRoot, stagingConfigRoot, {
    recursive: true,
    preserveTimestamps: true,
    errorOnExist: true,
    filter: async (source) => {
      const rel = relative(configRoot, source)
      if (!rel) return true
      if (nestedDataRoot && isInsideOrEqual(dataRoot, source)) return false
      const first = rel.split(sep)[0]
      const included = !CONFIG_EXCLUDED_DIRECTORIES.has(first) && !TRANSIENT_CONFIG_FILES.has(rel)
      if (included) await assertCopyEntryIsNotLink(source)
      return included
    }
  })
}

export const activateRollbackConfig = async ({
  configRoot,
  preservedConfigRoot,
  stagingConfigRoot,
  renamePath = rename
}) => {
  await renamePath(configRoot, preservedConfigRoot)
  try {
    await renamePath(stagingConfigRoot, configRoot)
  } catch (activationError) {
    try {
      await renamePath(preservedConfigRoot, configRoot)
    } catch (restoreError) {
      const error = new Error(
        [
          'Rollback activation failed and the original Config Root could not be restored automatically.',
          `Preserved newer Config Root: ${preservedConfigRoot}.`,
          `Prepared 0.7.3 Config Root: ${stagingConfigRoot}.`,
          `Restore one of them to ${configRoot} before starting Open Science.`
        ].join(' '),
        { cause: activationError }
      )
      error.code = 'rollback_cutover_recovery_required'
      error.preserveRollbackState = true
      error.restoreError = restoreError
      throw error
    }
    throw activationError
  }
}

const rewriteSettings = async (stagingConfigRoot, rollbackDataRoot) => {
  const settingsPath = join(stagingConfigRoot, 'settings.json')
  let settings = { version: 2 }
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (isRecord(parsed)) settings = parsed
  } catch {
    // A missing settings file is valid for a fresh install; the rollback copy receives a minimal one.
  }
  await writeFile(
    settingsPath,
    `${JSON.stringify({ ...settings, version: 2, dataRoot: rollbackDataRoot }, null, 2)}\n`,
    'utf8'
  )
}

const rewriteSessions = async (stagingConfigRoot, context) => {
  const sessionsRoot = join(stagingConfigRoot, 'sessions')
  if (!(await exists(sessionsRoot))) return { sessionsConverted: 0 }
  let sessionsConverted = 0
  for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectRoot = join(sessionsRoot, project.name)
    for (const file of await readdir(projectRoot, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const path = join(projectRoot, file.name)
      const converted = convertSessionToV073(JSON.parse(await readFile(path, 'utf8')), context)
      await writeFile(path, `${JSON.stringify(converted, null, 2)}\n`, 'utf8')
      sessionsConverted += 1
    }
  }
  return { sessionsConverted }
}

const targetPathFromLegacy = (rollbackDataRoot, storedPath) => {
  if (typeof storedPath !== 'string') return undefined
  if (isAbsolute(storedPath) && isInsideOrEqual(rollbackDataRoot, storedPath)) return storedPath
  if (!storedPath.startsWith('$DATA/')) return undefined
  const storageKey = assertSafeStorageKey(storedPath.slice('$DATA/'.length))
  const target = resolve(rollbackDataRoot, ...storageKey.split('/'))
  if (!isInsideOrEqual(rollbackDataRoot, target))
    throw new Error('Rollback path escapes Data Root.')
  return target
}

const validateConvertedSessions = async (stagingConfigRoot, rollbackDataRoot) => {
  const sessionsRoot = join(stagingConfigRoot, 'sessions')
  if (!(await exists(sessionsRoot))) return
  for (const project of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectRoot = join(sessionsRoot, project.name)
    for (const file of await readdir(projectRoot, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      const value = JSON.parse(await readFile(join(projectRoot, file.name), 'utf8'))
      if (value?.version !== 1 || !Array.isArray(value?.session?.messages)) {
        throw new Error(`Converted Session failed 0.7.3 validation: ${project.name}/${file.name}`)
      }
      const paths = [
        ...(value.session.artifacts ?? []).map((artifact) => artifact?.path),
        ...value.session.messages.flatMap((message) => [
          ...(message?.uploads ?? []).map((upload) => upload?.path),
          ...(message?.parts ?? []).map((part) => part?.path)
        ])
      ]
      for (const storedPath of paths) {
        const target = targetPathFromLegacy(rollbackDataRoot, storedPath)
        if (target && !(await exists(target))) {
          throw new Error(`Converted Session references missing rollback content: ${storedPath}`)
        }
      }
    }
  }
}

const validatePreparedRollback = async (marker) => {
  const configManifest = JSON.parse(
    await readFile(join(marker.stagingConfigRoot, ROLLBACK_MANIFEST), 'utf8')
  )
  const dataManifest = JSON.parse(
    await readFile(join(marker.rollbackDataRoot, ROLLBACK_MANIFEST), 'utf8')
  )
  for (const manifest of [configManifest, dataManifest]) {
    if (
      !isRecord(manifest) ||
      manifest.targetVersion !== TARGET_VERSION ||
      typeof manifest.originalConfigRoot !== 'string' ||
      typeof manifest.preservedConfigRoot !== 'string' ||
      typeof manifest.rollbackDataRoot !== 'string' ||
      !samePath(manifest.originalConfigRoot, marker.configRoot) ||
      !samePath(manifest.preservedConfigRoot, marker.preservedConfigRoot) ||
      !samePath(manifest.rollbackDataRoot, marker.rollbackDataRoot)
    ) {
      throw new Error('Prepared rollback manifest does not match its cutover marker.')
    }
  }
  validateCopiedDatabase(join(marker.stagingConfigRoot, 'open-science.db'))
  const indexes = readVersionIndexes(join(marker.stagingConfigRoot, 'open-science.db'))
  await validateVersionContents(indexes, marker.rollbackDataRoot, 'Prepared')
  await validateConvertedSessions(marker.stagingConfigRoot, marker.rollbackDataRoot)
  return configManifest
}

export const runRollbackToV073 = async (options = {}) => {
  if (options.confirm !== true) {
    throw new Error(
      'Rollback requires explicit confirmation. Re-run with --yes after closing Open Science.'
    )
  }
  const now = options.now ?? Date.now
  const stamp = formatStamp(now())
  const configRoot = resolve(options.configRoot ?? join(homedir(), '.open-science'))
  const requestedOutput = options.output ? resolve(options.output) : undefined
  const recoveredCutover = await recoverInterruptedCutover(configRoot, requestedOutput)
  if (recoveredCutover) return recoveredCutover
  if (!(await exists(configRoot))) throw new Error(`Config Root does not exist: ${configRoot}`)
  const activatedRollback = await readActivatedRollback(configRoot, requestedOutput)
  if (activatedRollback) return activatedRollback
  const dataRoot = resolve(options.dataRoot ?? (await resolveConfiguredDataRoot(configRoot)))
  const rollbackDataRoot = resolve(
    options.output ?? join(dirname(dataRoot), `${basename(dataRoot)}-Rollback-0.7.3-${stamp}`)
  )
  const stagingConfigRoot = `${configRoot}.rollback-staging-${stamp}`
  const preservedConfigRoot = `${configRoot}.before-rollback-${stamp}`
  const markerPath = cutoverMarkerPath(configRoot)
  const preparedPath = preparedMarkerPath(configRoot)
  const removeMarker = options.removeMarker ?? ((path) => rm(path, { force: true }))

  if (!(await exists(join(configRoot, 'open-science.db')))) {
    throw new Error(`Open Science database does not exist: ${join(configRoot, 'open-science.db')}`)
  }
  if (!(await exists(dataRoot))) throw new Error(`Data Root does not exist: ${dataRoot}`)
  const canonicalConfigRoot = await assertSafeSourceRoot(configRoot, 'Config Root')
  const canonicalDataRoot = await assertSafeSourceRoot(dataRoot, 'Data Root')
  const canonicalRollbackDataRoot = await canonicalPathForNewEntry(rollbackDataRoot)
  const lexicalRootRelationship =
    isInsideOrEqual(configRoot, dataRoot) || isInsideOrEqual(dataRoot, configRoot)
  const canonicalRootRelationship =
    isInsideOrEqual(canonicalConfigRoot, canonicalDataRoot) ||
    isInsideOrEqual(canonicalDataRoot, canonicalConfigRoot)
  if (lexicalRootRelationship !== canonicalRootRelationship) {
    throw new Error('Config Root and Data Root must not alias each other through symbolic paths.')
  }
  if (
    isInsideOrEqual(configRoot, rollbackDataRoot) ||
    isInsideOrEqual(dataRoot, rollbackDataRoot) ||
    isInsideOrEqual(rollbackDataRoot, configRoot) ||
    isInsideOrEqual(rollbackDataRoot, dataRoot) ||
    isInsideOrEqual(canonicalConfigRoot, canonicalRollbackDataRoot) ||
    isInsideOrEqual(canonicalDataRoot, canonicalRollbackDataRoot) ||
    isInsideOrEqual(canonicalRollbackDataRoot, canonicalConfigRoot) ||
    isInsideOrEqual(canonicalRollbackDataRoot, canonicalDataRoot)
  ) {
    throw new Error(
      'Rollback output must be separate from both the current Config Root and Data Root.'
    )
  }
  for (const target of [rollbackDataRoot, stagingConfigRoot, preservedConfigRoot]) {
    if (await exists(target)) throw new Error(`Rollback target already exists: ${target}`)
  }

  await assertOffline(configRoot)
  const indexes = readVersionIndexes(join(configRoot, 'open-science.db'))
  const context = { sourceDataRoot: dataRoot, rollbackDataRoot, ...indexes }
  const preparingMarker = {
    schemaVersion: 1,
    phase: 'preparing',
    configRoot,
    preservedConfigRoot,
    stagingConfigRoot,
    rollbackDataRoot
  }

  let activationCommitted = false
  try {
    await writeDurableJson(markerPath, preparingMarker)
    await validateVersionContents(indexes, dataRoot, 'Source')
    await copyRollbackData(dataRoot, rollbackDataRoot)
    await validateVersionContents(indexes, rollbackDataRoot, 'Copied')
    await copyRollbackConfig(configRoot, stagingConfigRoot, dataRoot)
    validateCopiedDatabase(join(stagingConfigRoot, 'open-science.db'))
    await rewriteSettings(stagingConfigRoot, rollbackDataRoot)
    const counts = await rewriteSessions(stagingConfigRoot, context)
    await validateConvertedSessions(stagingConfigRoot, rollbackDataRoot)

    const dataInsideConfig = isInsideOrEqual(configRoot, dataRoot)
    const preservedDataRoot = dataInsideConfig
      ? join(preservedConfigRoot, relative(configRoot, dataRoot))
      : dataRoot
    const manifest = {
      schemaVersion: 1,
      targetVersion: TARGET_VERSION,
      createdAt: new Date(now()).toISOString(),
      originalConfigRoot: configRoot,
      preservedConfigRoot,
      originalDataRoot: dataRoot,
      preservedDataRoot,
      rollbackDataRoot,
      sessionsConverted: counts.sessionsConverted
    }
    const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`
    await writeFile(join(stagingConfigRoot, ROLLBACK_MANIFEST), serializedManifest, 'utf8')
    await writeFile(join(rollbackDataRoot, ROLLBACK_MANIFEST), serializedManifest, 'utf8')
    const syncPrepared =
      options.syncPrepared ??
      (async () => {
        await syncTree(rollbackDataRoot)
        await syncTree(stagingConfigRoot)
      })
    await syncPrepared()
    await validatePreparedRollback(preparingMarker)
    await assertOffline(configRoot)
    await writeDurableJson(preparedPath, { ...preparingMarker, phase: 'prepared' })
    await assertOffline(configRoot)

    await activateRollbackConfig({
      configRoot,
      preservedConfigRoot,
      stagingConfigRoot,
      renamePath: options.renamePath
    })
    activationCommitted = true
    await Promise.all([removeMarker(markerPath), removeMarker(preparedPath)]).catch(() => undefined)
    return manifest
  } catch (error) {
    if (!activationCommitted && !error?.preserveRollbackState) {
      await Promise.all([
        rm(stagingConfigRoot, { recursive: true, force: true }),
        rm(rollbackDataRoot, { recursive: true, force: true }),
        rm(markerPath, { force: true }),
        rm(preparedPath, { force: true })
      ]).catch(() => undefined)
    }
    throw error
  }
}

export { TARGET_VERSION }
