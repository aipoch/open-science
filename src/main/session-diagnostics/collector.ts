import { isNotebookRunReference } from '../notebook/run-record-reference'
import { mergePendingRuns, pendingDirectoryIdentity } from '../notebook/pending-run-files'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { appendFile, lstat, mkdir, open, opendir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as tar from 'tar'
import type {
  SessionDiagnosticItem,
  SessionDiagnosticIdentity,
  SessionDiagnosticWorkerInput,
  SessionDiagnosticWorkerResult
} from '../../shared/session-diagnostics'
import { arch, homedir, release } from 'node:os'
import { projectDiagnosticSession, projectDiagnosticLog } from './projection'
import { readDiagnosticDatabase } from './database'
import { projectDiagnosticNotebook, type DiagnosticNotebookCodeCoverage } from './notebook'
import { projectDiagnosticEnvironment } from './environment'
import { sessionJournalPath, SessionJournalStore } from '../session-persistence/journal'
import { diagnosticText } from './detail'
import { exportResourceJournal, inspectResourceJournal } from './resources'

const FILE_LIMIT = 8 * 1024 * 1024
const TOTAL_LIMIT = 32 * 1024 * 1024
const ENVIRONMENT_MANIFEST_LIMIT = 32 * 1024 * 1024
const ENVIRONMENT_MANIFEST_DIRECTORY = join('runtime', 'provenance', 'environment-manifests')
const digestPattern = /^[a-f0-9]{64}$/
const digest = (contents: string): string => createHash('sha256').update(contents).digest('hex')
const SESSION_JOURNAL_READ_LIMIT = 32 * 1024 * 1024
const BACKEND_LOG_TAIL_BYTES = 256 * 1024
const safeSegment = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value)
class DiagnosticCollectionError extends Error {}
class NotebookSnapshotChangedError extends DiagnosticCollectionError {}
const ownsDiagnosticSession = (
  value: Record<string, unknown>,
  projectId: string,
  sessionId: string
): boolean => {
  // v1/v2 files wrap the Session; legacy files store the Session object directly.
  const candidate = 'session' in value ? value.session : value
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  const session = candidate as Record<string, unknown>
  return (
    session.id === sessionId && (session.projectId === undefined || session.projectId === projectId)
  )
}
const resolveStorageKey = (root: string, key: string): string => {
  if (!key || isAbsolute(key) || key.includes('\\')) {
    throw new Error('Invalid diagnostic storage key.')
  }
  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid diagnostic storage key.')
  }

  const candidate = resolve(root, ...segments)
  const relativePath = relative(resolve(root), candidate)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Invalid diagnostic storage key.')
  }
  return candidate
}
const diagnosticFailure = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' &&
    /^(?:ENOENT|EACCES|EPERM|EIO|ENOSPC|SQLITE_BUSY|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_ERROR)$/.test(
      code
    )
    ? `Diagnostic source failed (${code})`
    : 'Diagnostic source unavailable or collection failed'
}
type Source = SessionDiagnosticItem & {
  path?: string
  root: string
  output: string
  expectedChecksum?: string
  frameId?: string
  tailBytes?: number
}

// Check every descendant boundary, not only the final file, before any source access.
async function checkPath(root: string, path: string): Promise<void> {
  const suffix = relative(resolve(root), resolve(path))
  if (suffix.startsWith('..') || suffix === '')
    throw new DiagnosticCollectionError('Invalid diagnostic source path')
  let current = resolve(root)
  for (const segment of ['', ...suffix.split(/[\\/]/)]) {
    current = segment ? join(current, segment) : current
    if ((await lstat(current)).isSymbolicLink())
      throw new DiagnosticCollectionError('Symbolic links are not diagnostic sources')
  }
}

async function inspectSource(source: Source): Promise<Source> {
  try {
    if (source.kind === 'resource-log') return source
    if (source.kind === 'sensitive-evidence' || source.kind === 'environment')
      return { ...source, available: true }
    if (!source.path && source.reason) return source
    if (!source.path) throw new DiagnosticCollectionError('Source is unavailable')
    await checkPath(source.root, source.path)
    const stat = await lstat(source.path)
    if (!stat.isFile()) throw new DiagnosticCollectionError('Source is not a regular file')
    const probe = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    await probe.close()
    return {
      ...source,
      available: true,
      ...(source.kind === 'database' ? {} : { sizeBytes: stat.size })
    }
  } catch (error) {
    return {
      ...source,
      available: false,
      reason: diagnosticFailure(error)
    }
  }
}

async function discoverSessionSources(
  input: SessionDiagnosticWorkerInput & SessionDiagnosticIdentity
): Promise<Source[]> {
  const project = join(input.configRoot, 'sessions', input.projectId)
  const notebookRoot = join(input.dataRoot, 'notebooks', input.projectId, input.sessionId)
  const legacySessionPath = join(project, `${input.sessionId}.json`)
  const journalPath = sessionJournalPath(legacySessionPath)
  const sessionPath = await lstat(journalPath)
    .then(() => journalPath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return legacySessionPath
      throw error
    })
  const sources: Source[] = [
    {
      id: 'session',
      name: 'session.json',
      kind: 'session',
      available: false,
      root: input.configRoot,
      path: sessionPath,
      output: 'session.json'
    },
    {
      id: 'notebook',
      name: 'notebook/run.json',
      kind: 'notebook',
      available: false,
      root: input.dataRoot,
      path: join(notebookRoot, 'run.json'),
      output: 'notebook/run.json'
    }
  ]
  try {
    await checkPath(input.configRoot, project)
    const dir = await opendir(project)
    let visited = 0
    let found = 0
    for await (const entry of dir) {
      if (++visited > 10000 || found >= 20) break
      if (
        !entry.name.startsWith(`${input.sessionId}.json.invalid-`) ||
        !/\.invalid-\d+-\d+$/.test(entry.name)
      )
        continue
      found++
      sources.push({
        id: `invalid:${entry.name}`,
        name: entry.name,
        kind: 'invalid-session',
        available: false,
        root: input.configRoot,
        path: join(project, entry.name),
        output: `session-invalid/${entry.name}.txt`
      })
    }
  } catch {
    /* Missing project still leaves the primary missing item visible. */
  }
  try {
    const framesRoot = join(notebookRoot, 'frames')
    await checkPath(input.dataRoot, framesRoot)
    const frames = await opendir(framesRoot)
    let visited = 0
    let found = 0
    for await (const entry of frames) {
      if (++visited > 10000 || found >= 20) {
        sources.push({
          id: 'notebook:frames-limited',
          name: 'notebook/frames/…',
          kind: 'notebook',
          available: false,
          reason: 'Notebook frame discovery limit reached',
          root: input.dataRoot,
          output: 'notebook/frames'
        })
        break
      }
      if (!entry.isDirectory() || !safeSegment(entry.name)) continue
      found++
      sources.push({
        id: `notebook:frame:${entry.name}`,
        name: `notebook/frames/${entry.name}/run.json`,
        kind: 'notebook',
        available: false,
        root: input.dataRoot,
        frameId: entry.name,
        path: join(framesRoot, entry.name, 'run.json'),
        output: `notebook/frames/${entry.name}/run.json`
      })
    }
  } catch {
    /* An absent or inaccessible frame tree does not hide the root Notebook source. */
  }
  sources.push({
    id: 'database',
    name: 'Session database records',
    kind: 'database',
    available: false,
    root: input.configRoot,
    path: join(input.configRoot, 'open-science.db'),
    output: 'db'
  })
  if (input.sensitiveContent) {
    sources.push({
      id: 'sensitive-evidence',
      name: 'Sensitive-content evidence (redacted)',
      kind: 'sensitive-evidence',
      available: true,
      root: input.dataRoot,
      output: 'sensitive-content/evidence.json'
    })
    const keys = [
      ...new Set(
        input.sensitiveContent.evidence
          .map((evidence) => evidence.sourceStorageKey)
          .filter((key): key is string => Boolean(key))
      )
    ].slice(0, 20)
    const retainedSources = new Map(
      (input.sensitiveContentSources ?? []).map((source) => [source.storageKey, source])
    )
    for (const [index, key] of keys.entries()) {
      let path: string | undefined
      const retained = retainedSources.get(key)
      try {
        path = retained
          ? resolveStorageKey(retained.root, retained.relativePath)
          : resolveStorageKey(input.dataRoot, key)
      } catch {
        /* Invalid storage keys remain visible as unavailable diagnostic items. */
      }
      const label = basename(key).slice(0, 120) || `file-${index}`
      sources.push({
        id: `sensitive-file:${index}`,
        name: key.slice(0, 240),
        kind: 'sensitive-file',
        available: false,
        root: retained?.root ?? input.dataRoot,
        path,
        expectedChecksum: retained?.checksum,
        output: `sensitive-content/files/${index}-${label}`
      })
    }
  }
  return sources
}

async function discover(input: SessionDiagnosticWorkerInput): Promise<Source[]> {
  const sources: Source[] = input.scope === 'application' ? [] : await discoverSessionSources(input)
  sources.push({
    id: 'environment',
    name: 'environment.json',
    kind: 'environment',
    available: true,
    root: input.configRoot,
    path: join(input.configRoot, 'settings.json'),
    output: 'environment.json'
  })
  for (let index = 0; index < 3; index++) {
    const name = index === 0 ? 'main.log' : `main.${index}.log`
    sources.push({
      id: `log:${name}`,
      name,
      kind: 'log',
      available: false,
      root: input.logPath ? dirname(input.logPath) : input.configRoot,
      path: input.logPath ? join(dirname(input.logPath), name) : undefined,
      output: `logs/${name}`
    })
  }
  if (input.desktopLogPath) {
    for (let index = 0; index < 3; index++) {
      const name = index === 0 ? 'main.log' : `main.${index}.log`
      sources.push({
        id: `desktop-log:${name}`,
        name: `Desktop: ${name}`,
        kind: 'log',
        available: false,
        root: dirname(input.desktopLogPath),
        path: join(dirname(input.desktopLogPath), name),
        output: `logs/desktop/${name}`
      })
    }
  }
  if (input.legacyDesktopLogPath) {
    for (let index = 0; index < 3; index++) {
      const name = index === 0 ? 'main.log' : `main.${index}.log`
      sources.push({
        id: `desktop-legacy-log:${name}`,
        name: `Desktop (earlier version): ${name}`,
        kind: 'log',
        available: false,
        root: dirname(input.legacyDesktopLogPath),
        path: join(dirname(input.legacyDesktopLogPath), name),
        output: `logs/desktop-legacy/${name}`
      })
    }
  }
  const backendLogsRoot = join(input.configRoot, 'logs')
  try {
    await checkPath(input.configRoot, backendLogsRoot)
    const directory = await opendir(backendLogsRoot)
    const recent: { name: string; timestamp: number }[] = []
    let visited = 0
    let found = 0
    for await (const entry of directory) {
      if (++visited > 10_000) break
      const match = /^desktop-backend-\d{1,10}-(\d{13})\.log$/.exec(entry.name)
      if (!entry.isFile() || !match) continue
      found++
      recent.push({ name: entry.name, timestamp: Number(match[1]) })
      recent.sort((a, b) => b.timestamp - a.timestamp || b.name.localeCompare(a.name))
      if (recent.length > 20) recent.pop()
    }
    for (const { name } of recent)
      sources.push({
        id: `backend-log:${name}`,
        name,
        kind: 'log',
        available: false,
        root: input.configRoot,
        path: join(backendLogsRoot, name),
        output: `logs/backend/${name}`,
        tailBytes: BACKEND_LOG_TAIL_BYTES
      })
    if (found > recent.length || visited > 10_000)
      sources.push({
        id: 'backend-log:limited',
        name: 'desktop-backend-…',
        kind: 'log',
        available: false,
        reason: `Backend log discovery limited: ${found - recent.length} older files omitted${visited > 10_000 ? '; directory scan limit reached' : ''}`,
        root: input.configRoot,
        output: 'logs/backend'
      })
  } catch (error) {
    // Missing/inaccessible startup logs stay observable in the diagnostic manifest.
    sources.push({
      id: 'backend-log:unavailable',
      name: 'desktop-backend-…',
      kind: 'log',
      available: false,
      reason: diagnosticFailure(error),
      root: input.configRoot,
      output: 'logs/backend'
    })
  }
  sources.push({
    id: 'resource-logs',
    name: 'logs/resources',
    kind: 'resource-log',
    root: input.configRoot,
    output: 'logs/resources',
    ...(await inspectResourceJournal(input.configRoot))
  })
  return Promise.all(sources.map(inspectSource))
}

async function readSource(source: Source): Promise<{
  text: string
  note?: string
  partial?: boolean
  readBytes?: number
  boundaryProbeBytes?: number
  omittedBytes?: number
}> {
  await checkPath(source.root, source.path!)
  const handle = await open(source.path!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || (!source.tailBytes && before.size > FILE_LIMIT))
      throw new DiagnosticCollectionError('Source exceeds file limit or is not regular')
    const start = Math.max(0, before.size - (source.tailBytes ?? before.size))
    // One preceding byte distinguishes a complete first record from a cut-off line.
    // It is not part of the bounded tail payload and is accounted for separately.
    const boundaryProbe = start > 0 ? 1 : 0
    const readStart = start - boundaryProbe
    const buffer = Buffer.alloc(before.size - readStart)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        readStart + offset
      )
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    // A newline in the probe preserves the complete first record. Otherwise omit the
    // partial line, which may begin inside a UTF-8 sequence or JSON record.
    const firstLine = start > 0 ? buffer.subarray(0, offset).indexOf(10) : -1
    const skip = start > 0 ? (firstLine < 0 ? offset : firstLine + 1) : 0
    const text = buffer.subarray(skip, offset).toString('utf8')
    const tailMetadata = source.tailBytes
      ? {
          readBytes: Math.max(0, offset - boundaryProbe),
          boundaryProbeBytes: Math.min(boundaryProbe, offset),
          omittedBytes: readStart + skip
        }
      : {}
    if (source.kind === 'log') {
      const current = await lstat(source.path!).catch(() => undefined)
      const rotated = !current || current.ino !== before.ino || current.dev !== before.dev
      const truncated = readStart + offset < before.size || after.size < before.size
      if (rotated || truncated)
        return {
          text,
          ...tailMetadata,
          partial: true,
          note: 'Log rotated or truncated during collection; retained available bytes from the initially opened file'
        }
      return {
        text,
        ...tailMetadata,
        // The bounded tail is the requested log projection, not a collection failure.
        partial: false,
        note: 'Log snapshot contains at most the file size at open time; later appended bytes are excluded'
      }
    }
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new DiagnosticCollectionError('Source changed during collection')
    return { text }
  } finally {
    await handle.close()
  }
}

const sourceReadLimit = (source: Source): number =>
  source.kind === 'session' && source.path?.endsWith('.jsonl')
    ? SESSION_JOURNAL_READ_LIMIT
    : FILE_LIMIT

// Reconstruct JSONL through the ordinary diagnostic redaction path. It remains a read-only
// observation: no recovery, migration or file cleanup is performed during collection.
async function readSessionSource(source: Source): ReturnType<typeof readSource> {
  if (!source.path!.endsWith('.jsonl')) return readSource(source)
  await checkPath(source.root, source.path!)
  const journal = new SessionJournalStore({
    maxBytes: FILE_LIMIT,
    maxReplayBytes: sourceReadLimit(source),
    maxCacheEntries: 0
  })
  const reconstructed = await journal.read(source.path!)
  if (reconstructed?.format !== 'journal')
    throw new DiagnosticCollectionError('Session journal is unavailable')
  return { text: JSON.stringify(reconstructed.document) }
}

async function readBinarySource(source: Source): Promise<Buffer> {
  await checkPath(source.root, source.path!)
  const handle = await open(source.path!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > FILE_LIMIT)
      throw new DiagnosticCollectionError('Source exceeds file limit or is not regular')
    const buffer = Buffer.alloc(before.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new DiagnosticCollectionError('Source changed during collection')
    if (source.expectedChecksum) {
      const checksum = createHash('sha256').update(buffer).digest('hex')
      if (checksum !== source.expectedChecksum)
        throw new DiagnosticCollectionError('Source changed since sensitive-content detection')
    }
    return buffer
  } finally {
    await handle.close()
  }
}

const environmentManifestChecksumForRun = (run: Record<string, unknown>): string | undefined => {
  if (typeof run.environmentManifestChecksum === 'string') return run.environmentManifestChecksum
  const capture = run.environmentCapture
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) return undefined
  const state = capture as Record<string, unknown>
  return state.state === 'available' || state.state === 'partial'
    ? typeof state.manifestChecksum === 'string'
      ? state.manifestChecksum
      : undefined
    : undefined
}

const environmentManifestPath = (dataRoot: string, checksum: string): string =>
  join(dataRoot, ENVIRONMENT_MANIFEST_DIRECTORY, `${checksum}.json`)

export async function runSessionDiagnosticWorker(
  input: SessionDiagnosticWorkerInput
): Promise<SessionDiagnosticWorkerResult> {
  const encode = (value: unknown): string =>
    JSON.stringify(
      value,
      (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry),
      2
    )
  const log: string[] = []
  const record = (message: string): void => {
    log.push(`${new Date().toISOString()} ${message}`)
  }
  let partial = false
  try {
    if (
      input.scope === 'application'
        ? input.projectId !== undefined || input.sessionId !== undefined
        : !safeSegment(input.projectId) || !safeSegment(input.sessionId)
    )
      throw new DiagnosticCollectionError('Invalid session identity')
    const sources = await discover(input)
    if (input.action === 'inspect')
      return {
        kind: 'inspection',
        inspection: {
          items: sources.map((item) => ({
            id: item.id,
            kind: item.kind,
            name: item.name,
            available: item.available,
            sizeBytes: item.sizeBytes,
            reason: item.reason
          }))
        }
      }
    if (!input.directory)
      throw new DiagnosticCollectionError('Diagnostic output directory is missing')
    const content = join(input.directory, 'content')
    await mkdir(content, { mode: 0o700 })
    const files: string[] = []
    const outputFailures: { output: string; reason: string }[] = []
    let total = 0
    const write = async (
      name: string,
      value: string | Uint8Array,
      required = false
    ): Promise<void> => {
      const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
      if (bytes > FILE_LIMIT || total + bytes > TOTAL_LIMIT - (required ? 0 : 1024 * 1024))
        throw new DiagnosticCollectionError('Diagnostic output size limit exceeded')
      await mkdir(dirname(join(content, name)), { recursive: true, mode: 0o700 })
      await writeFile(join(content, name), value, { flag: 'wx', mode: 0o600 })
      total += bytes
      files.push(name)
    }
    const writeBestEffort = async (
      name: string,
      produce: () => string | Uint8Array | Promise<string | Uint8Array>,
      state?: { status: string; reason?: string },
      required = false
    ): Promise<boolean> => {
      try {
        await write(name, await produce(), required)
        return true
      } catch (error) {
        partial = true
        const reason = diagnosticFailure(error)
        outputFailures.push({ output: name, reason })
        if (state && state.status === 'exported') state.status = 'partial'
        if (state) state.reason = reason
        record(`Diagnostic output ${name} failed: ${reason}`)
        return false
      }
    }
    const exportedEnvironmentManifestChecksums = new Set<string>()
    const exportEnvironmentManifests = async (
      value: Record<string, unknown>,
      state: { status: string; reason?: string }
    ): Promise<void> => {
      const runs = Array.isArray(value.runs) ? value.runs.slice(-100) : []
      for (const entry of runs) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const checksum = environmentManifestChecksumForRun(entry as Record<string, unknown>)
        if (!checksum || exportedEnvironmentManifestChecksums.has(checksum)) continue
        exportedEnvironmentManifestChecksums.add(checksum)
        if (!digestPattern.test(checksum)) {
          partial = true
          if (state.status === 'exported') state.status = 'partial'
          state.reason = 'Environment manifest reference is invalid'
          record('Notebook environment manifest reference is invalid')
          continue
        }
        const inlineManifest =
          entry.environmentManifest &&
          typeof entry.environmentManifest === 'object' &&
          !Array.isArray(entry.environmentManifest)
            ? (entry.environmentManifest as Record<string, unknown>)
            : undefined
        const inlineContents =
          inlineManifest &&
          inlineManifest.schemaVersion === 1 &&
          inlineManifest.captureKind === 'completed-run' &&
          Array.isArray(inlineManifest.packages)
            ? `${JSON.stringify(inlineManifest, null, 2)}\n`
            : undefined
        const path = environmentManifestPath(input.dataRoot, checksum)
        const output = `notebook/environment-manifests/${checksum}.json`
        try {
          if (inlineContents && digest(inlineContents) === checksum) {
            if (Buffer.byteLength(inlineContents) > FILE_LIMIT) {
              partial = true
              if (state.status === 'exported') state.status = 'partial'
              state.reason = 'Environment manifest exceeds diagnostic output limit'
              record('Notebook environment manifest exceeds diagnostic output limit')
              await writeBestEffort(
                `${output}.metadata.json`,
                () =>
                  encode({
                    checksum,
                    sizeBytes: Buffer.byteLength(inlineContents),
                    omissionReason: 'source-size-limit'
                  }),
                state
              )
            } else await writeBestEffort(output, () => inlineContents, state)
            continue
          }
          await checkPath(input.dataRoot, path)
          const before = await lstat(path)
          if (!before.isFile() || before.isSymbolicLink())
            throw new DiagnosticCollectionError('Environment manifest is not a regular file')
          if (before.size > ENVIRONMENT_MANIFEST_LIMIT)
            throw new DiagnosticCollectionError('Environment manifest exceeds file limit')
          const contents = await readFile(path, 'utf8')
          const after = await lstat(path)
          if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            digest(contents) !== checksum
          )
            throw new DiagnosticCollectionError('Environment manifest checksum mismatch')
          const parsed = JSON.parse(contents) as Record<string, unknown>
          if (
            !parsed ||
            Array.isArray(parsed) ||
            parsed.schemaVersion !== 1 ||
            parsed.captureKind !== 'completed-run' ||
            !Array.isArray(parsed.packages)
          )
            throw new DiagnosticCollectionError('Environment manifest shape is invalid')
          if (Buffer.byteLength(contents) > FILE_LIMIT) {
            partial = true
            if (state.status === 'exported') state.status = 'partial'
            state.reason = 'Environment manifest exceeds diagnostic output limit'
            record('Notebook environment manifest exceeds diagnostic output limit')
            await writeBestEffort(
              `${output}.metadata.json`,
              () =>
                encode({
                  checksum,
                  sizeBytes: Buffer.byteLength(contents),
                  omissionReason: 'source-size-limit'
                }),
              state
            )
          } else {
            await writeBestEffort(output, () => contents, state)
          }
        } catch (error) {
          partial = true
          if (state.status === 'exported') state.status = 'partial'
          state.reason = diagnosticFailure(error)
          record(`Notebook environment manifest unavailable: ${diagnosticFailure(error)}`)
          await writeBestEffort(
            `${output}.metadata.json`,
            () => encode({ checksum, omissionReason: 'source-unavailable-or-integrity-failure' }),
            state
          )
        }
      }
    }
    const hydrateNotebookRunReferences = async (
      value: Record<string, unknown>,
      source: Source,
      state: { status: string; reason?: string }
    ): Promise<Record<string, unknown>> => {
      if (!Array.isArray(value.runs)) return value
      const runs = [...value.runs]
      const firstRetained = Math.max(0, runs.length - 100)
      for (let index = firstRetained; index < runs.length; index++) {
        const reference = runs[index]
        if (!isNotebookRunReference(reference)) continue
        const path = join(dirname(source.path!), '.run-records', `${reference.sha256}.json`)
        try {
          await checkPath(source.root, path)
          const before = await lstat(path)
          if (!before.isFile() || before.isSymbolicLink() || before.size > FILE_LIMIT)
            throw new DiagnosticCollectionError('Notebook run record is unavailable')
          const contents = await readFile(path, 'utf8')
          const after = await lstat(path)
          if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.size !== reference.bytes ||
            digest(contents) !== reference.sha256
          )
            throw new DiagnosticCollectionError('Notebook run record checksum mismatch')
          const run = JSON.parse(contents) as Record<string, unknown>
          if (!run || Array.isArray(run) || run.runId !== reference.runId)
            throw new DiagnosticCollectionError('Notebook run record identity mismatch')
          runs[index] = run
        } catch (error) {
          partial = true
          if (state.status === 'exported') state.status = 'partial'
          state.reason = diagnosticFailure(error)
          record(`Notebook run record unavailable: ${diagnosticFailure(error)}`)
          runs[index] = { unavailable: 'run-record-unavailable', runId: reference.runId }
        }
      }
      return { ...value, runs }
    }
    const selected = new Set(
      (input.selectedItems ?? []).filter((id) => sources.some((source) => source.id === id))
    )
    const selectedNotebookSources = sources.filter(
      (source) => selected.has(source.id) && source.kind === 'notebook'
    )
    const includeExecutionCode =
      input.includeExecutionCode === true && selectedNotebookSources.length > 0
    const notebookCoverage = {
      selectedSources: selectedNotebookSources.length,
      projectedSources: 0,
      included: 0,
      missing: 0,
      truncated: 0
    }
    const textOptions = { configRoot: input.configRoot, dataRoot: input.dataRoot, home: homedir() }
    if (selected.size !== new Set(input.selectedItems ?? []).size) {
      partial = true
      record('Unknown diagnostic selection omitted')
    }
    const databaseMetadata: Record<string, unknown> = {}
    const statuses: {
      id: string
      selected: boolean
      status: string
      reason?: string
      collectedAt: string
      arrayCounts?: unknown
      executionCodeCoverage?: DiagnosticNotebookCodeCoverage
      output?: string
      scope?: 'target-session' | 'global' | 'unknown'
      sourceMetadata?: unknown
    }[] = sources
      .filter((source) => !selected.has(source.id))
      .map((source) => ({
        id: source.id,
        selected: false,
        status: source.available ? 'skipped' : 'missing',
        reason: source.reason,
        collectedAt: new Date().toISOString(),
        output: source.output,
        scope:
          source.kind === 'log' || source.kind === 'resource-log' || source.kind === 'environment'
            ? 'global'
            : source.kind === 'sensitive-file'
              ? 'unknown'
              : 'target-session'
      }))
    for (const id of selected) {
      const source = sources.find((candidate) => candidate.id === id)
      const state = {
        id,
        selected: true,
        status: 'exported',
        reason: undefined as string | undefined,
        arrayCounts: undefined as unknown,
        executionCodeCoverage: undefined as DiagnosticNotebookCodeCoverage | undefined,
        collectedAt: new Date().toISOString(),
        output: source?.output,
        scope:
          source?.kind === 'log' ||
          source?.kind === 'resource-log' ||
          source?.kind === 'environment'
            ? ('global' as const)
            : source?.kind === 'sensitive-file'
              ? ('unknown' as const)
              : ('target-session' as const),
        sourceMetadata: undefined as unknown
      }
      statuses.push(state)
      try {
        if (
          !source?.available ||
          (source.kind !== 'sensitive-evidence' && source.kind !== 'resource-log' && !source.path)
        )
          throw new DiagnosticCollectionError(source?.reason ?? 'Source is no longer discoverable')
        if (source.kind === 'resource-log') {
          const snapshot = await exportResourceJournal(input.configRoot, content)
          files.push(...snapshot.files)
          state.sourceMetadata = snapshot.metadata
          if (snapshot.partial) {
            partial = true
            state.status = 'partial'
          }
          await writeBestEffort(
            'logs/resources/metadata.json',
            () =>
              encode({
                ...snapshot.metadata,
                policy:
                  'Incident segments first; independent 64 MiB resource budget. Complete structural records from files at open time. No source mutation; later appends excluded.'
              }),
            state
          )
        } else if (source.kind === 'sensitive-evidence') {
          await writeBestEffort(
            source.output,
            () => encode(input.sensitiveContent ?? {}),
            state,
            true
          )
        } else if (source.kind === 'environment') {
          let settings: unknown
          let settingsStatus = 'available'
          try {
            const observation = await readSource(source)
            try {
              settings = JSON.parse(observation.text)
              if (!settings || typeof settings !== 'object' || Array.isArray(settings))
                settingsStatus = 'invalid-json'
            } catch {
              settingsStatus = 'invalid-json'
            }
          } catch (error) {
            const code =
              error && typeof error === 'object' && 'code' in error ? error.code : undefined
            settingsStatus = code === 'ENOENT' ? 'missing' : 'unavailable'
          }
          if (settingsStatus !== 'available') {
            settings = undefined
            partial = true
            state.status = 'partial'
            record(
              `Stored settings source ${settingsStatus}; environment snapshot has version facts only`
            )
          }
          state.sourceMetadata = {
            settingsStatus,
            source: 'configRoot/settings.json',
            observation: 'stored-at-export'
          }
          await writeBestEffort(
            source.output,
            () => encode(projectDiagnosticEnvironment(settings, input.appVersion)),
            state
          )
        } else if (source.kind === 'sensitive-file') {
          const stat = await lstat(source.path!)
          if (stat.size > FILE_LIMIT) {
            await writeBestEffort(
              `${source.output}.metadata.json`,
              () =>
                encode({
                  sizeBytes: stat.size,
                  mtimeMs: stat.mtimeMs,
                  omissionReason: 'source-size-limit'
                }),
              state
            )
            partial = true
            state.status = 'truncated'
            record('Sensitive-content source exceeds read budget; file metadata retained')
          } else {
            await writeBestEffort(source.output, () => readBinarySource(source), state)
          }
        } else if (source.kind === 'database' && input.scope !== 'application') {
          await checkPath(source.root, source.path!)
          for (const result of readDiagnosticDatabase(
            source.path!,
            input.projectId,
            input.sessionId,
            textOptions
          )) {
            if (result.error) {
              partial = true
              state.status = 'partial'
              record(`Database table query failed (${result.table}): ${result.error}`)
              continue
            }
            await writeBestEffort(`db/${result.table}.json`, () => encode(result.rows), state)
            if (result.metadata) {
              databaseMetadata[result.table] = result.metadata
              if (result.metadata.missingColumns?.length) {
                partial = true
                state.status = 'partial'
                record(`DB ${result.table}: schema columns unavailable`)
              }
            }
            if (result.truncated) {
              partial = true
              state.status = 'truncated'
              record(`DB ${result.table}: truncated at row, cell or byte limit`)
            }
          }
        } else {
          const stat = await lstat(source.path!)
          const metadata = { sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
          state.sourceMetadata = metadata
          if (stat.size > sourceReadLimit(source) && !source.tailBytes) {
            await writeBestEffort(
              `${source.output}.metadata.json`,
              () => encode({ ...metadata, omissionReason: 'source-size-limit' }),
              state
            )
            partial = true
            state.status = 'truncated'
            record('Source exceeds read budget; file metadata retained')
          } else {
            const observation =
              source.kind === 'session' ? await readSessionSource(source) : await readSource(source)
            if (observation.note) record(observation.note)
            if (observation.partial) {
              partial = true
              state.status = 'partial'
            }
            if (
              input.scope !== 'application' &&
              (source.kind === 'session' ||
                source.kind === 'invalid-session' ||
                source.kind === 'notebook')
            ) {
              let parsed: unknown
              try {
                parsed = JSON.parse(observation.text)
              } catch {
                /* Invalid input contributes metadata only. */
              }
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                if (source.kind === 'notebook') {
                  try {
                    const rows = (parsed as { runs?: Array<{ runId: string }> }).runs
                    if (Array.isArray(rows) && input.projectId && input.sessionId) {
                      await checkPath(source.root, dirname(source.path!))
                      const pending = await pendingDirectoryIdentity(source.path!)
                      await mergePendingRuns(
                        source.path!,
                        {
                          projectId: input.projectId,
                          sessionId: input.sessionId,
                          frameId: source.frameId ?? null
                        },
                        rows,
                        (run) => typeof run === 'object' && run !== null && 'runId' in run,
                        sourceReadLimit(source) - stat.size
                      )
                      // A checkpoint can replace the manifest and remove the entire hot directory during the read.
                      const current = await lstat(source.path!)
                      if (
                        current.dev !== stat.dev ||
                        current.ino !== stat.ino ||
                        current.size !== stat.size ||
                        current.ctimeMs !== stat.ctimeMs ||
                        current.mtimeMs !== stat.mtimeMs ||
                        pending !== (await pendingDirectoryIdentity(source.path!))
                      )
                        throw new NotebookSnapshotChangedError()
                    }
                    const hydratedNotebook = await hydrateNotebookRunReferences(
                      parsed as Record<string, unknown>,
                      source,
                      state
                    )
                    const projection = projectDiagnosticNotebook(
                      hydratedNotebook,
                      {
                        projectId: input.projectId,
                        sessionId: input.sessionId,
                        frameId: source.frameId
                      },
                      textOptions,
                      includeExecutionCode
                    )
                    const truncation = projection.truncation as Record<string, number>
                    state.arrayCounts = { runs: projection.runCounts, truncation }
                    // Runs outside the recent-history window are intentionally filtered.
                    if (
                      Object.entries(truncation).some(
                        ([key, count]) => key !== 'omittedRuns' && count > 0
                      )
                    ) {
                      partial = true
                      state.status = 'truncated'
                      record('Notebook diagnostic projection truncated; omission counts recorded')
                    }
                    const codeCoverage = includeExecutionCode
                      ? (projection.executionCodeCoverage as DiagnosticNotebookCodeCoverage)
                      : undefined
                    if (codeCoverage) {
                      if (codeCoverage.missing > 0) {
                        partial = true
                        if (state.status === 'exported') state.status = 'partial'
                        record('Notebook execution code missing for retained runs')
                      }
                      if (codeCoverage.truncated > 0) {
                        partial = true
                        state.status = 'truncated'
                        record('Notebook execution code truncated at per-run limit')
                      }
                    }
                    const written = await writeBestEffort(
                      source.output,
                      () => encode({ ...projection, sourceMetadata: metadata }),
                      state
                    )
                    if (written) {
                      notebookCoverage.projectedSources++
                      if (codeCoverage) {
                        state.executionCodeCoverage = codeCoverage
                        for (const key of ['included', 'missing', 'truncated'] as const)
                          notebookCoverage[key] += codeCoverage[key]
                      }
                    } else {
                      state.status = 'partial'
                    }
                    await exportEnvironmentManifests(hydratedNotebook, state)
                  } catch (error) {
                    const changed = error instanceof NotebookSnapshotChangedError
                    await writeBestEffort(
                      `${source.output}.metadata.json`,
                      () =>
                        encode({
                          ...metadata,
                          omissionReason: changed ? 'source-changed' : 'invalid-scope-or-shape'
                        }),
                      state
                    )
                    partial = true
                    state.status = 'partial'
                    record(
                      changed
                        ? 'Notebook changed during collection; content omitted'
                        : 'Notebook document scope or shape invalid; content omitted'
                    )
                  }
                } else {
                  if (
                    !ownsDiagnosticSession(
                      parsed as Record<string, unknown>,
                      input.projectId,
                      input.sessionId
                    )
                  ) {
                    await writeBestEffort(
                      `${source.output}.metadata.json`,
                      () => encode({ ...metadata, omissionReason: 'identity-mismatch-or-missing' }),
                      state
                    )
                    partial = true
                    state.status = 'partial'
                    record('Session document identity unavailable or mismatched; content omitted')
                  } else {
                    const projection = projectDiagnosticSession(parsed, textOptions)
                    state.arrayCounts = projection.arrayCounts
                    if (projection.truncated) {
                      partial = true
                      state.status = 'truncated'
                      record(
                        'Session arrays truncated; source, retained and omitted counts recorded'
                      )
                    }
                    await writeBestEffort(
                      source.output,
                      () => encode({ ...projection, sourceMetadata: metadata }),
                      state
                    )
                  }
                }
              } else {
                await writeBestEffort(
                  `${source.output}.metadata.json`,
                  () => encode({ ...metadata, omissionReason: 'invalid-json' }),
                  state
                )
                partial = true
                state.status = 'partial'
                record('invalid-json: file metadata retained and content omitted')
              }
            } else {
              let omittedLines = 0
              let missingEventTextRecords = 0
              const projected: string[] = []
              let earliest: string | undefined
              let latest: string | undefined
              let nativeError = false
              for (const line of observation.text.split('\n')) {
                if (!line.trim()) continue
                try {
                  const entry = projectDiagnosticLog(JSON.parse(line), textOptions)
                  if (Object.keys(entry).length) {
                    projected.push(JSON.stringify(entry))
                    if (typeof entry.event !== 'string' || !entry.event.trim())
                      missingEventTextRecords++
                    if (typeof entry.t === 'string') {
                      if (earliest === undefined || entry.t < earliest) earliest = entry.t
                      if (latest === undefined || entry.t > latest) latest = entry.t
                    }
                  } else omittedLines++
                } catch {
                  // stderr also contains ordinary output. Retain only recognized fatal/errors
                  // and their stack frames, never the whole raw process stream.
                  const beginsError =
                    /^(?:#\s*)?(?:FATAL ERROR:|Fatal process out of memory:|Fatal error in\b|Check failed:|(?:[\w.]*Error|Exception)(?: \[[A-Z][A-Z0-9_]+\])?:)/.test(
                      line.trim()
                    )
                  const stackLine =
                    /^\s*(?:----- (?:Native|JavaScript) stack trace -----|at\s|\d+:\s+(?:0x)?[\da-fA-F]+\b)/.test(
                      line
                    )
                  if (source.tailBytes && (beginsError || (nativeError && stackLine))) {
                    projected.push(
                      JSON.stringify({
                        level: 'error',
                        event: diagnosticText(line, textOptions, 2_000)
                      })
                    )
                    nativeError = true
                  } else {
                    if (line.trim() !== '#') nativeError = false
                    omittedLines++
                  }
                }
              }
              await writeBestEffort(
                source.output,
                () => projected.join('\n') + (projected.length ? '\n' : ''),
                state
              )
              await writeBestEffort(
                `${source.output}.metadata.json`,
                () =>
                  encode({
                    ...metadata,
                    ...(source.tailBytes
                      ? {
                          readBytes: observation.readBytes,
                          boundaryProbeBytes: observation.boundaryProbeBytes,
                          omittedBytes: observation.omittedBytes
                        }
                      : {}),
                    retainedRecords: projected.length,
                    omittedLines,
                    missingEventTextRecords,
                    omissionPolicy:
                      'Bounded event and error text is credential/path-redacted; arbitrary payloads omitted.',
                    timeRange: earliest === undefined ? null : { earliest, latest }
                  }),
                state
              )
              state.sourceMetadata = {
                ...metadata,
                ...(source.tailBytes
                  ? {
                      readBytes: observation.readBytes,
                      boundaryProbeBytes: observation.boundaryProbeBytes,
                      omittedBytes: observation.omittedBytes
                    }
                  : {}),
                retainedRecords: projected.length,
                omittedLines,
                missingEventTextRecords
              }
              // Backend captures include arbitrary stdout; filtering it is expected.
              // Canonical logs should be structured, so omitted records indicate lost evidence.
              if (omittedLines) {
                if (!source.tailBytes) {
                  partial = true
                  state.status = 'partial'
                }
                record('Unstructured log records omitted')
              }
              if (missingEventTextRecords) {
                partial = true
                state.status = 'partial'
                record('Retained log records without event text counted in source metadata')
              }
            }
          }
        }
        record(`Selected source collection status: ${state.status}`)
      } catch (error) {
        partial = true
        state.status = 'failed'
        state.reason = diagnosticFailure(error)
        record(state.reason)
      }
    }
    const availableEntries = async (): Promise<string[]> => {
      const available: string[] = []
      for (const name of files) {
        try {
          const path = join(content, name)
          const stat = await lstat(path)
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new DiagnosticCollectionError('Archive entry is not a regular file')
          const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try {
            const chunk = Buffer.alloc(64 * 1024)
            let offset = 0
            while (offset < stat.size) {
              const read = await handle.read(
                chunk,
                0,
                Math.min(chunk.length, stat.size - offset),
                offset
              )
              if (!read.bytesRead)
                throw new DiagnosticCollectionError('Archive entry changed during collection')
              offset += read.bytesRead
            }
          } finally {
            await handle.close()
          }
          available.push(name)
        } catch {
          partial = true
          outputFailures.push({
            output: name,
            reason: 'Diagnostic output unavailable before archive creation'
          })
          const owner = statuses.find(
            (status) =>
              status.output === name ||
              (status.output && name.startsWith(`${status.output}.`)) ||
              (status.id === 'database' && name.startsWith('db/')) ||
              (status.id === 'resource-logs' && name.startsWith('logs/resources/'))
          )
          if (owner?.status === 'exported') owner.status = 'partial'
          record(`Diagnostic output ${name} unavailable before archive creation`)
        }
      }
      files.splice(0, files.length, ...available)
      return available
    }
    await availableEntries()
    await writeBestEffort(
      'README.txt',
      () =>
        `Local diagnostic observations, not a restore package. No upload or LLM is involved. Start with manifest.json for selected, missing, failed and truncated sources, then inspect session.json, notebook run histories, db/*.json, Runtime logs/main*.log and Desktop logs/desktop/main*.log. Optional logs/resources/*.jsonl contains structural system commit memory, PID/birth identities and session activity across application sessions, including retained pre-failure incident segments. Its separate 64 MiB budget does not consume the 32 MiB general export budget. Resource metadata lists incomplete, unavailable or rotated segments; original journals are never cleared. Backend startup logs/backend/desktop-backend-*.log contain projected structured records and recognized native fatal/exception stacks from at most the last 256 KiB of each of the newest 20 files; unrelated process output is omitted. A one-byte boundary probe preserves complete records at the tail edge; metadata accounts for probe, tail and omitted bytes separately. environment.json contains stored settings observed at export time and App/OS/runtime versions; it does not prove effective settings at failure time. Session, Notebook and DB records are scoped to the selected session. Logs are application-global and may include other sessions; they must not be attributed to this session without matching identities. Event messages, exception stacks/causes and Notebook stderr/traceback are bounded and credential/path-redacted, but may still contain research content or personal information. ${includeExecutionCode ? 'Execution scripts are included only in selected Notebook run histories, with best-effort credential redaction and a 16000 UTF-16 character limit per run; scripts may still contain research content, private paths or credentials. Missing and truncated scripts are marked per run and counted in manifest.json.' : 'Notebook execution scripts are omitted because code inclusion was not requested.'} Full conversations, standalone code files, arbitrary payloads, environment values and raw settings are excluded. Sensitive-content evidence is structurally redacted; original sensitive-content files are included only when explicitly selected and may contain credentials or research content. A missing field means unknown, not success or absence. Sources may reflect different times. Database rows are queried read-only after selection; no snapshot, recovery, migration or checkpoint is performed.\n`,
      undefined,
      true
    )
    record('Collection complete; starting archive creation')
    await writeBestEffort('export.log', () => log.join('\n') + '\n', undefined, true)
    let exportedLogCount = log.length
    const manifestContent = (): string =>
      encode({
        version: 2,
        appVersion: input.appVersion,
        platform: process.platform,
        scope: input.scope ?? 'session',
        projectId: input.projectId,
        sessionId: input.sessionId,
        collectedAt: new Date().toISOString(),
        projectionVersion: 3,
        includeExecutionCode,
        notebookCoverage,
        arch: arch(),
        osRelease: release(),
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? null,
        databaseMetadata,
        outputFailures,
        items: statuses
      })
    await writeBestEffort('manifest.json', manifestContent, undefined, true)
    let recordedFailures = outputFailures.length
    const synchronizeReports = async (): Promise<void> => {
      if (log.length === exportedLogCount && outputFailures.length === recordedFailures) return
      if (files.includes('export.log') && log.length > exportedLogCount) {
        try {
          await appendFile(
            join(content, 'export.log'),
            `${log.slice(exportedLogCount).join('\n')}\n`
          )
          exportedLogCount = log.length
        } catch {
          partial = true
          record('Diagnostic output export.log could not record later archive omissions')
        }
      }
      if (files.includes('manifest.json')) {
        try {
          await writeFile(join(content, 'manifest.json'), manifestContent(), { mode: 0o600 })
          recordedFailures = outputFailures.length
        } catch {
          partial = true
          record('Diagnostic output manifest.json could not record later archive omissions')
        }
      }
    }
    let archiveEntries = await availableEntries()
    await synchronizeReports()
    const archivePath = join(input.directory, 'archive.tar.gz')
    const createArchive = async (entries: string[]): Promise<void> => {
      if (!entries.length) {
        // tar.create rejects an empty list; two zero blocks are a valid empty tar stream.
        await writeFile(archivePath, gzipSync(Buffer.alloc(1024)), { flag: 'wx', mode: 0o600 })
        return
      }
      await tar.create({ cwd: content, file: archivePath, gzip: true, portable: true }, entries)
    }
    try {
      await createArchive(archiveEntries)
    } catch (error) {
      const survivors = await availableEntries()
      if (survivors.length === archiveEntries.length) throw error
      archiveEntries = survivors
      await synchronizeReports()
      await rm(archivePath, { force: true })
      await createArchive(archiveEntries)
    }
    return { kind: 'archive', partial, report: log.join('\n') }
  } catch (error) {
    const message = diagnosticFailure(error)
    record(message)
    return { kind: 'error', report: log.join('\n') }
  }
}
