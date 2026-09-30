import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { appendFile, lstat, mkdir, open, opendir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as tar from 'tar'
import type {
  SessionDiagnosticItem,
  SessionDiagnosticWorkerInput,
  SessionDiagnosticWorkerResult
} from '../../shared/session-diagnostics'
import { arch, homedir, release } from 'node:os'
import { projectDiagnosticSession, projectDiagnosticLog } from './projection'
import { readDiagnosticDatabase } from './database'
import { projectDiagnosticNotebook, type DiagnosticNotebookCodeCoverage } from './notebook'
import { projectDiagnosticEnvironment } from './environment'

const FILE_LIMIT = 8 * 1024 * 1024
const TOTAL_LIMIT = 32 * 1024 * 1024
const safeSegment = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value)
class DiagnosticCollectionError extends Error {}
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

async function discover(input: SessionDiagnosticWorkerInput): Promise<Source[]> {
  const project = join(input.configRoot, 'sessions', input.projectId)
  const notebookRoot = join(input.dataRoot, 'notebooks', input.projectId, input.sessionId)
  const sources: Source[] = [
    {
      id: 'session',
      name: 'session.json',
      kind: 'session',
      available: false,
      root: input.configRoot,
      path: join(project, `${input.sessionId}.json`),
      output: 'session.json'
    },
    {
      id: 'environment',
      name: 'environment.json',
      kind: 'environment',
      available: true,
      root: input.configRoot,
      path: join(input.configRoot, 'settings.json'),
      output: 'environment.json'
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
  return Promise.all(sources.map(inspectSource))
}

async function readSource(
  source: Source
): Promise<{ text: string; note?: string; partial?: boolean }> {
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
    const text = buffer.subarray(0, offset).toString('utf8')
    if (source.kind === 'log') {
      const current = await lstat(source.path!).catch(() => undefined)
      const rotated = !current || current.ino !== before.ino || current.dev !== before.dev
      const truncated = offset < before.size || after.size < before.size
      if (rotated || truncated)
        return {
          text,
          partial: true,
          note: 'Log rotated or truncated during collection; retained available bytes from the initially opened file'
        }
      return {
        text,
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
    if (!safeSegment(input.projectId) || !safeSegment(input.sessionId))
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
          source.kind === 'log' || source.kind === 'environment'
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
          source?.kind === 'log' || source?.kind === 'environment'
            ? ('global' as const)
            : source?.kind === 'sensitive-file'
              ? ('unknown' as const)
              : ('target-session' as const),
        sourceMetadata: undefined as unknown
      }
      statuses.push(state)
      try {
        if (!source?.available || (source.kind !== 'sensitive-evidence' && !source.path))
          throw new DiagnosticCollectionError(source?.reason ?? 'Source is no longer discoverable')
        if (source.kind === 'sensitive-evidence') {
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
        } else if (source.kind === 'database') {
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
          if (stat.size > FILE_LIMIT) {
            await writeBestEffort(
              `${source.output}.metadata.json`,
              () => encode({ ...metadata, omissionReason: 'source-size-limit' }),
              state
            )
            partial = true
            state.status = 'truncated'
            record('Source exceeds read budget; file metadata retained')
          } else {
            const observation = await readSource(source)
            if (observation.note) record(observation.note)
            if (observation.partial) {
              partial = true
              state.status = 'partial'
            }
            if (
              source.kind === 'session' ||
              source.kind === 'invalid-session' ||
              source.kind === 'notebook'
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
                    const projection = projectDiagnosticNotebook(
                      parsed,
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
                    if (Object.values(truncation).some((count) => count > 0)) {
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
                  } catch {
                    await writeBestEffort(
                      `${source.output}.metadata.json`,
                      () => encode({ ...metadata, omissionReason: 'invalid-scope-or-shape' }),
                      state
                    )
                    partial = true
                    state.status = 'partial'
                    record('Notebook document scope or shape invalid; content omitted')
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
                  omittedLines++
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
                retainedRecords: projected.length,
                omittedLines,
                missingEventTextRecords
              }
              if (omittedLines || missingEventTextRecords) {
                partial = true
                state.status = 'partial'
                if (omittedLines) record('Unstructured log records omitted')
                if (missingEventTextRecords)
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
              (status.id === 'database' && name.startsWith('db/'))
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
        `Local diagnostic observations, not a restore package. No upload or LLM is involved. Start with manifest.json for selected, missing, failed and truncated sources, then inspect session.json, notebook run histories, db/*.json and logs/main*.log. environment.json contains stored settings observed at export time and App/OS/runtime versions; it does not prove effective settings at failure time. Session, Notebook and DB records are scoped to the selected session. Logs are application-global and may include other sessions; they must not be attributed to this session without matching identities. Event messages, exception stacks/causes and Notebook stderr/traceback are bounded and credential/path-redacted, but may still contain research content or personal information. ${includeExecutionCode ? 'Execution scripts are included only in selected Notebook run histories, with best-effort credential redaction and a 16000 UTF-16 character limit per run; scripts may still contain research content, private paths or credentials. Missing and truncated scripts are marked per run and counted in manifest.json.' : 'Notebook execution scripts are omitted because code inclusion was not requested.'} Full conversations, standalone code files, arbitrary payloads, environment values and raw settings are excluded. Sensitive-content evidence is structurally redacted; original sensitive-content files are included only when explicitly selected and may contain credentials or research content. A missing field means unknown, not success or absence. Sources may reflect different times. Database rows are queried read-only after selection; no snapshot, recovery, migration or checkpoint is performed.\n`,
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
