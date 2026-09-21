import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import * as tar from 'tar'
import type {
  SessionDiagnosticItem,
  SessionDiagnosticWorkerInput,
  SessionDiagnosticWorkerResult
} from '../../shared/session-diagnostics'
import { arch, release } from 'node:os'
import { projectDiagnosticSession, projectDiagnosticLog } from './projection'
import { readDiagnosticDatabase } from './database'

const FILE_LIMIT = 8 * 1024 * 1024
const TOTAL_LIMIT = 32 * 1024 * 1024
const safeSegment = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value)
class DiagnosticCollectionError extends Error {}
const diagnosticFailure = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' &&
    /^(?:ENOENT|EACCES|EPERM|EIO|ENOSPC|SQLITE_BUSY|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_ERROR)$/.test(
      code
    )
    ? `Diagnostic source failed (${code})`
    : 'Diagnostic source unavailable or collection failed'
}
type Source = SessionDiagnosticItem & { path?: string; root: string; output: string }

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
  const sources: Source[] = [
    {
      id: 'session',
      name: 'session.json',
      kind: 'session',
      available: false,
      root: input.configRoot,
      path: join(project, `${input.sessionId}.json`),
      output: 'session.json'
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
            reason: item.reason ? item.reason : undefined
          }))
        }
      }
    if (!input.directory)
      throw new DiagnosticCollectionError('Diagnostic output directory is missing')
    const content = join(input.directory, 'content')
    await mkdir(content, { mode: 0o700 })
    const files: string[] = []
    let total = 0
    const write = async (name: string, value: string, required = false): Promise<void> => {
      const bytes = Buffer.byteLength(value)
      if (bytes > FILE_LIMIT || total + bytes > TOTAL_LIMIT - (required ? 0 : 1024 * 1024))
        throw new DiagnosticCollectionError('Diagnostic output size limit exceeded')
      await mkdir(dirname(join(content, name)), { recursive: true, mode: 0o700 })
      await writeFile(join(content, name), value, { flag: 'wx', mode: 0o600 })
      total += bytes
      files.push(name)
    }
    const selected = new Set(
      (input.selectedItems ?? []).filter((id) => sources.some((source) => source.id === id))
    )
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
    }[] = sources
      .filter((source) => !selected.has(source.id))
      .map((source) => ({
        id: source.id,
        selected: false,
        status: source.available ? 'skipped' : 'missing',
        reason: source.reason ? source.reason : undefined,
        collectedAt: new Date().toISOString()
      }))
    for (const id of selected) {
      const source = sources.find((candidate) => candidate.id === id)
      const state = {
        id,
        selected: true,
        status: 'exported',
        reason: undefined as string | undefined,
        arrayCounts: undefined as unknown,
        collectedAt: new Date().toISOString()
      }
      statuses.push(state)
      try {
        if (!source?.available || !source.path)
          throw new DiagnosticCollectionError(source?.reason ?? 'Source is no longer discoverable')
        if (source.kind === 'database') {
          await checkPath(source.root, source.path)
          for (const result of readDiagnosticDatabase(
            source.path,
            input.projectId,
            input.sessionId
          )) {
            if (result.error) {
              partial = true
              state.status = 'partial'
              record(`Database table query failed (${result.table}): ${result.error}`)
              continue
            }
            await write(`db/${result.table}.json`, encode(result.rows))
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
          const stat = await lstat(source.path)
          const metadata = { sizeBytes: stat.size, mtimeMs: stat.mtimeMs }
          if (stat.size > FILE_LIMIT) {
            await write(
              `${source.output}.metadata.json`,
              encode({ ...metadata, omissionReason: 'source-size-limit' })
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
            if (source.kind === 'session' || source.kind === 'invalid-session') {
              let parsed: unknown
              try {
                parsed = JSON.parse(observation.text)
              } catch {
                /* Invalid input contributes metadata only. */
              }
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const projection = projectDiagnosticSession(parsed)
                state.arrayCounts = projection.arrayCounts
                if (projection.truncated) {
                  partial = true
                  state.status = 'truncated'
                  record('Session arrays truncated; source, retained and omitted counts recorded')
                }
                await write(source.output, encode({ ...projection, sourceMetadata: metadata }))
              } else {
                await write(
                  `${source.output}.metadata.json`,
                  encode({ ...metadata, omissionReason: 'invalid-json' })
                )
                partial = true
                state.status = 'partial'
                record('invalid-json: file metadata retained and content omitted')
              }
            } else {
              let omittedLines = 0
              const projected: string[] = []
              for (const line of observation.text.split('\n')) {
                if (!line.trim()) continue
                try {
                  const entry = projectDiagnosticLog(JSON.parse(line))
                  if (Object.keys(entry).length) projected.push(JSON.stringify(entry))
                  else omittedLines++
                } catch {
                  omittedLines++
                }
              }
              await write(source.output, projected.join('\n') + (projected.length ? '\n' : ''))
              await write(
                `${source.output}.metadata.json`,
                encode({
                  ...metadata,
                  retainedRecords: projected.length,
                  omittedLines,
                  omissionPolicy:
                    'Only structured diagnostic fields retained; messages, stacks and arbitrary payloads omitted.'
                })
              )
              if (omittedLines) {
                partial = true
                state.status = 'partial'
                record('Unstructured log records omitted')
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
    await write(
      'manifest.json',
      encode({
        version: 1,
        appVersion: input.appVersion,
        platform: process.platform,
        projectId: input.projectId,
        sessionId: input.sessionId,
        collectedAt: new Date().toISOString(),
        projectionVersion: 2,
        arch: arch(),
        osRelease: release(),
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? null,
        databaseMetadata,
        items: statuses
      }),
      true
    )
    await write(
      'README.txt',
      'Local diagnostic observations, not a restore package. No upload or LLM is involved. Only fixed diagnostic fields are exported. Conversation text, titles, tool inputs and outputs, log messages, stacks, paths, credentials and unknown fields are omitted, not text-redacted. IDs, states, timestamps and numeric usage remain. Invalid or oversized session files contribute metadata only. Unstructured log lines are omitted. Sources may reflect different times. Database rows are queried read-only after selection; no snapshot, recovery, migration or checkpoint is performed.\n',
      true
    )
    record('Collection complete; starting archive creation')
    await write('export.log', log.join('\n') + '\n', true)
    await tar.create(
      { cwd: content, file: join(input.directory, 'archive.tar.gz'), gzip: true, portable: true },
      files
    )
    return { kind: 'archive', partial, report: log.join('\n') }
  } catch (error) {
    const message = diagnosticFailure(error)
    record(message)
    return { kind: 'error', error: message, report: log.join('\n') }
  }
}
