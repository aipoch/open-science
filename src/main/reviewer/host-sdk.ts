// Turn-scoped evidence access for the reviewer. Production calls the public read methods through the
// dedicated reviewer MCP server, which validates every activity/artifact id against TurnScope. The
// authenticated HTTP adapter remains for compatibility tests and older callers, but the reviewer no
// longer receives its endpoint/token or executes a Python bootstrap.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { getProjectArtifactDir } from '../artifacts/repository'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewScopeSnapshotBlock, TurnScope, ScopeBlock } from '../../shared/reviewer'
import { buildReviewScopeSnapshot as buildPersistedScopeSnapshot } from './scope-snapshot'
import {
  readFilePageAndDigest,
  readVerifiedFilePage,
  type FileObservation
} from '../bounded-file-io'
import {
  LOCAL_RESOURCE_BUDGETS,
  ResourceBudgetExceededError,
  assertWithinResourceBudget,
  readBoundedJsonBody
} from '../resource-budget'

// One readable block as returned by host.read_turn().
export type OrderedBlock = {
  blockIndex: number
  id: string
  kind: 'message' | 'activity'
  sourceId: string
  contentHash: string
  // Message fields — present when kind='message'
  role?: string
  content?: string
  artifactIds?: string[]
  // Activity fields — present when kind='activity'
  title?: string
  status?: string
  toolKind?: string
  rawInput?: unknown
  rawOutput?: unknown
  terminalOutput?: string
  terminalExitCode?: number | null
}

// Execution record returned by host.query_execution_log().
export type ExecRecord = {
  activityId: string
  title: string
  status: string
  rawInput?: unknown
  rawOutput?: unknown
  terminalOutput?: string
  terminalExitCode?: number | null
}

// Every Artifact read is one bounded byte window. Fields stay optional in the exported contract so
// older in-process consumers can deserialize pre-pagination results during a rolling app update.
export type ArtifactContentWindow = {
  sizeBytes?: number
  offset?: number
  returnedBytes?: number
  truncated?: boolean
  nextOffset?: number
}

// Column-addressable structure returned for tabular (CSV/TSV) artifacts so the reviewer can
// match by column name instead of aligning rows visually.
export type TabularArtifactContent = ArtifactContentWindow & {
  id: string
  kind: 'tabular'
  // Each key is a column header; the array contains the string values of that column across all rows.
  columns: Record<string, string[]>
  rowCount: number | null
  rowsReturned?: number
  rowCountComplete?: boolean
}

// Raw content for non-tabular artifacts (text UTF-8 or base64-encoded binary).
export type RawArtifactContent = ArtifactContentWindow & {
  id: string
  kind: 'raw'
  content: string
  encoding: 'utf8' | 'base64'
}

// Artifact content as returned by host.read_artifact(id): column-addressable for CSV/TSV, raw otherwise.
export type ArtifactContent = TabularArtifactContent | RawArtifactContent

export type ArtifactVersionContentResolver = (request: {
  projectId: string
  sessionId: string
  fileId: string
  versionId: string
}) => Promise<{
  filename: string
  contentType?: string
  checksum: string
  size: number
  readRange: (begin: number, end: number) => Promise<Uint8Array>
  verifyUnchanged: () => Promise<void>
  close: () => Promise<void>
}>

export type ReviewerResourceBudgetOptions = {
  requestBytes?: number
  readBytes?: number
  sessionBytes?: number
}

export type ReviewerArtifactReadOptions = {
  offset?: number
  maxBytes?: number
}

type ArtifactVerification = {
  path: string
  checksum: string
  sizeBytes: number
  sample: Buffer
  observation: FileObservation
}

type ArtifactVerificationEntry = {
  path: string
  expectedChecksum?: string
  verification: Promise<ArtifactVerification>
}

class ArtifactVersionChecksumMismatchError extends Error {}

// The complete set of RPC methods the host exposes. Single-sourced so the unknown-method error can
// tell a guessing reviewer exactly what IS available (it likes to try e.g. `list_artifacts`).
export const SUPPORTED_HOST_METHODS = ['read_turn', 'query_execution_log', 'read_artifact'] as const

// Scope-enforcing evidence reader with a legacy authenticated HTTP adapter.
export class ReviewerHostServer {
  private server: Server
  private readonly frozenScopeSnapshot: ReviewScopeSnapshotBlock[]
  private readonly resourceBudget: Required<ReviewerResourceBudgetOptions>
  private readonly artifactVerifications = new Map<string, ArtifactVerificationEntry>()
  private reviewerBytesReturned = 0
  readonly token: string
  private _endpoint: string | undefined

  constructor(
    private readonly session: PersistedChatSession,
    private readonly scope: TurnScope,
    private readonly artifactStorageRoot: string,
    private readonly resolveArtifactVersion?: ArtifactVersionContentResolver,
    frozenScopeSnapshot?: ReviewScopeSnapshotBlock[],
    resourceBudget: ReviewerResourceBudgetOptions = {}
  ) {
    this.frozenScopeSnapshot = frozenScopeSnapshot ?? buildPersistedScopeSnapshot(session, scope)
    this.token = randomUUID()
    this.resourceBudget = {
      requestBytes: resourceBudget.requestBytes ?? LOCAL_RESOURCE_BUDGETS.requestBytes,
      readBytes: resourceBudget.readBytes ?? LOCAL_RESOURCE_BUDGETS.reviewerReadBytes,
      sessionBytes: resourceBudget.sessionBytes ?? LOCAL_RESOURCE_BUDGETS.reviewerSessionBytes
    }
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        if (error instanceof ResourceBudgetExceededError) {
          res.shouldKeepAlive = false
          res.setHeader('connection', 'close')
          res.once('finish', () => req.destroy())
        }
        res.writeHead(error instanceof ResourceBudgetExceededError ? 413 : 500, {
          'content-type': 'application/json'
        })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      })
    })
  }

  // Starts the server on a random port and resolves the endpoint URL.
  async start(): Promise<{ endpoint: string; token: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => resolve())
      this.server.once('error', reject)
    })

    const addr = this.server.address() as { port: number }
    this._endpoint = `http://127.0.0.1:${addr.port}`

    return { endpoint: this._endpoint, token: this.token }
  }

  // Shuts down the server; called after the reviewer session disposes.
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.artifactVerifications.clear()
  }

  get endpoint(): string {
    if (!this._endpoint) throw new Error('ReviewerHostServer not started')
    return this._endpoint
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Verify bearer token.
    const authHeader = req.headers['authorization'] ?? ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (bearer !== this.token) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    // Read body.
    let parsed: { method?: string; params?: Record<string, unknown> }

    try {
      parsed = await readBoundedJsonBody<typeof parsed>(req, this.resourceBudget.requestBytes)
    } catch (error) {
      if (error instanceof ResourceBudgetExceededError) throw error
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
      return
    }

    const method = parsed.method
    const params = parsed.params ?? {}

    let result: unknown

    switch (method) {
      case 'read_turn':
        result = this.readTurn()
        break
      case 'query_execution_log':
        result = this.queryExecutionLog(params.activityId as string | undefined)
        break
      case 'read_artifact':
        result = await this.readArtifact(params.id as string, {
          offset: params.offset as number | undefined,
          maxBytes: params.maxBytes as number | undefined
        })
        break
      default:
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error:
              `Unknown method: ${method ?? 'undefined'}. ` +
              `Supported methods: ${SUPPORTED_HOST_METHODS.join(', ')}.`
          })
        )
        return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result }))
  }

  // Returns the ordered blocks for this turn with their content and metadata.
  readTurn(): OrderedBlock[] {
    return this.frozenScopeSnapshot.map(
      ({ payload, ...block }) => ({ ...block, ...payload }) as OrderedBlock
    )
  }

  // Returns execution records for this turn's activities, optionally filtered to one activity.
  queryExecutionLog(activityId?: string): ExecRecord[] {
    const activityIds = new Set(
      this.scope.blocks.filter((block) => block.kind === 'activity').map((block) => block.sourceId)
    )
    const activities = this.readTurn().filter((block) => block.kind === 'activity')
    const target =
      activityId !== undefined
        ? activities.filter((activity) => activity.sourceId === activityId)
        : activities

    // Out-of-scope id: reject rather than silently returning empty.
    if (activityId !== undefined && target.length === 0) {
      throw new Error(
        `Activity id ${JSON.stringify(activityId)} is not in this turn's scope. ` +
          `Allowed ids: ${[...activityIds].join(', ')}`
      )
    }

    return target.map((activity) => ({
      activityId: activity.sourceId,
      title: activity.title ?? '',
      status: activity.status ?? '',
      rawInput: activity.rawInput,
      rawOutput: activity.rawOutput,
      terminalOutput: activity.terminalOutput,
      terminalExitCode: activity.terminalExitCode
    }))
  }

  // Returns artifact content for an artifact id belonging to this turn.
  // Tabular artifacts (CSV/TSV) are returned as { kind:'tabular'; columns; rowCount } so the
  // reviewer can address by column name without visual row alignment. Non-tabular artifacts
  // return { kind:'raw'; content; encoding }.
  async readArtifact(
    id: string,
    options: ReviewerArtifactReadOptions = {},
    signal?: AbortSignal
  ): Promise<ArtifactContent> {
    if (!this.scope.artifactVersionIds.includes(id)) {
      throw new Error(
        `Artifact id ${JSON.stringify(id)} is not in this turn's scope. ` +
          `Allowed ids: ${this.scope.artifactVersionIds.join(', ')}`
      )
    }

    // Look up artifact metadata from the session so we can determine the format.
    const artifactMeta = (this.session.artifacts ?? []).find((a) => a.id === id)

    // Read the artifact from managed storage. A read failure (missing/unreadable file) MUST surface
    // as an error, not degrade to empty content — otherwise the reviewer cannot distinguish "could
    // not read" from "the file is genuinely empty", which produces false "empty artifact" findings.
    const offset = options.offset ?? 0
    const requestedBytes = options.maxBytes ?? this.resourceBudget.readBytes
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Reviewer Artifact offset must be a non-negative integer.')
    }
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
      throw new Error('Reviewer Artifact maxBytes must be a positive integer.')
    }
    const remainingSessionBytes = this.resourceBudget.sessionBytes - this.reviewerBytesReturned
    if (remainingSessionBytes <= 0) {
      throw new ResourceBudgetExceededError(
        'reviewer-session',
        this.reviewerBytesReturned + 1,
        this.resourceBudget.sessionBytes
      )
    }
    const returnedLimit = Math.min(
      requestedBytes,
      this.resourceBudget.readBytes,
      remainingSessionBytes
    )
    const resolvedVersion = this.resolveArtifactVersion
      ? artifactMeta?.artifactId
        ? await this.resolveArtifactVersion({
            projectId: this.session.projectId,
            sessionId: this.session.id,
            fileId: artifactMeta.artifactId,
            versionId: id
          })
        : (() => {
            throw new Error(`Artifact ${JSON.stringify(id)} has no logical file identity.`)
          })()
      : undefined
    const artifactPath = resolvedVersion
      ? undefined
      : resolveArtifactPath(this.artifactStorageRoot, this.session.projectId, id)
    let read: { page: Buffer; returnedBytes: number; sizeBytes: number; sample: Buffer }
    if (resolvedVersion) {
      try {
        if (signal?.aborted) throw signal.reason
        if (offset > resolvedVersion.size) {
          throw new Error(
            `Reviewer Artifact offset ${offset} exceeds file size ${resolvedVersion.size}.`
          )
        }
        const end = Math.min(resolvedVersion.size, offset + returnedLimit)
        const [page, sample] = await Promise.all([
          resolvedVersion.readRange(offset, end),
          resolvedVersion.readRange(0, Math.min(resolvedVersion.size, 512))
        ])
        await resolvedVersion.verifyUnchanged()
        read = {
          page: Buffer.from(page),
          returnedBytes: page.byteLength,
          sizeBytes: resolvedVersion.size,
          sample: Buffer.from(sample)
        }
      } catch (error) {
        throw new Error(
          `Failed to read managed Artifact ${JSON.stringify(id)}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        await resolvedVersion.close()
      }
    } else {
      let verification: ArtifactVerification
      try {
        verification = await this.verifyArtifact(id, artifactPath!, undefined, signal)
      } catch (error) {
        if (error instanceof ArtifactVersionChecksumMismatchError) throw error
        throw new Error(
          `Failed to read artifact ${JSON.stringify(id)} at ${artifactPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        )
      }

      if (offset > verification.sizeBytes) {
        throw new Error(
          `Reviewer Artifact offset ${offset} exceeds file size ${verification.sizeBytes}.`
        )
      }
      try {
        const page = await readVerifiedFilePage(
          artifactPath!,
          offset,
          returnedLimit,
          verification.observation,
          signal
        )
        read = {
          ...page,
          sizeBytes: verification.sizeBytes,
          sample: verification.sample
        }
      } catch (error) {
        this.artifactVerifications.delete(id)
        throw new Error(
          `Failed to read artifact ${JSON.stringify(id)} at ${artifactPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    if (offset > read.sizeBytes) {
      throw new Error(`Reviewer Artifact offset ${offset} exceeds file size ${read.sizeBytes}.`)
    }
    const isText = isLikelyText(read.sample)
    let result: ArtifactContent
    const base64Window = (): RawArtifactContent => {
      const truncated = offset + read.returnedBytes < read.sizeBytes
      return {
        id,
        kind: 'raw',
        content: read.page.toString('base64'),
        encoding: 'base64',
        sizeBytes: read.sizeBytes,
        offset,
        returnedBytes: read.returnedBytes,
        truncated,
        ...(truncated ? { nextOffset: offset + read.returnedBytes } : {})
      }
    }

    if (isText) {
      const safePage = decodeUtf8Page(read.page, offset)
      if (read.returnedBytes > 0 && (safePage.offset !== offset || safePage.returnedBytes === 0)) {
        result = base64Window()
      } else {
        const text = safePage.content
        const truncated = safePage.offset + safePage.returnedBytes < read.sizeBytes
        const window = {
          sizeBytes: read.sizeBytes,
          offset: safePage.offset,
          returnedBytes: safePage.returnedBytes,
          truncated,
          ...(truncated ? { nextOffset: safePage.offset + safePage.returnedBytes } : {})
        }

        // A byte page can split a quoted record, escaped quote, or header. Return incomplete tabular
        // files as raw UTF-8 windows so following nextOffset reconstructs exact source bytes; only a
        // complete table is safe to project into column-addressable data.
        const contentType = resolvedVersion?.contentType ?? artifactMeta?.mimeType
        const filename = resolvedVersion?.filename ?? artifactMeta?.path
        if (isTabularArtifact(contentType, filename) && window.offset === 0 && !window.truncated) {
          const parsed = parseTabular(text, detectDelimiter(contentType, filename))
          result = {
            id,
            kind: 'tabular',
            columns: parsed.columns,
            rowCount: parsed.rowCount,
            rowsReturned: parsed.rowCount,
            rowCountComplete: true,
            ...window
          }
        } else {
          result = { id, kind: 'raw', content: text, encoding: 'utf8', ...window }
        }
      }
    } else {
      result = base64Window()
    }

    const responseBytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    assertWithinResourceBudget(
      'reviewer-session',
      this.reviewerBytesReturned + responseBytes,
      this.resourceBudget.sessionBytes
    )
    this.reviewerBytesReturned += responseBytes
    return result
  }

  private async verifyArtifact(
    id: string,
    path: string,
    expectedChecksum: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<ArtifactVerification> {
    const cached = this.artifactVerifications.get(id)
    if (cached?.path === path && cached.expectedChecksum === expectedChecksum) {
      return cached.verification
    }

    const verification = readFilePageAndDigest(path, 0, 0, signal).then((read) => {
      if (expectedChecksum && read.checksum !== expectedChecksum) {
        throw new ArtifactVersionChecksumMismatchError(
          `Artifact Version checksum mismatch while reading ${JSON.stringify(id)}.`
        )
      }
      return {
        path,
        checksum: read.checksum,
        sizeBytes: read.sizeBytes,
        sample: read.sample,
        observation: read.observation
      }
    })
    const entry = { path, expectedChecksum, verification }
    this.artifactVerifications.set(id, entry)
    try {
      return await verification
    } catch (error) {
      if (this.artifactVerifications.get(id) === entry) this.artifactVerifications.delete(id)
      throw error
    }
  }
}

const decodeUtf8Page = (
  page: Buffer,
  requestedOffset: number
): { content: string; offset: number; returnedBytes: number } => {
  let start = 0
  while (start < page.length && (page[start]! & 0xc0) === 0x80) start += 1
  let end = page.length
  const decoder = new TextDecoder('utf-8', { fatal: true })
  while (end >= start) {
    try {
      const bytes = page.subarray(start, end)
      return {
        content: decoder.decode(bytes),
        offset: requestedOffset + start,
        returnedBytes: bytes.byteLength
      }
    } catch {
      end -= 1
    }
  }
  return { content: '', offset: requestedOffset + page.length, returnedBytes: 0 }
}

// Heuristic to distinguish text from binary artifact content.
const isLikelyText = (bytes: Buffer): boolean => {
  const sample = bytes.slice(0, 512)

  for (const byte of sample) {
    if (byte === 0) return false
  }

  return true
}

// Resolves an artifact file path from managed storage, reusing the layout owned by ArtifactRepository:
// <storageRoot>/artifacts/<projectId>/<sessionId>/<messageId>/<filename>. The version id is the
// colon-composite <sessionId>:<messageId>:<filename> assigned when the artifact is attached to a turn.
export const resolveArtifactPath = (
  storageRoot: string,
  projectId: string,
  versionId: string
): string => {
  const firstColon = versionId.indexOf(':')
  const secondColon = versionId.indexOf(':', firstColon + 1)

  if (firstColon === -1 || secondColon === -1) {
    throw new Error(`Malformed artifact version id ${JSON.stringify(versionId)}`)
  }

  const sessionId = versionId.slice(0, firstColon)
  const messageId = versionId.slice(firstColon + 1, secondColon)
  const filename = versionId.slice(secondColon + 1)

  return join(getProjectArtifactDir(storageRoot, projectId), sessionId, messageId, filename)
}

// MIME types and file extensions that indicate a tabular (delimiter-separated) format.
const TABULAR_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/tab-separated-values',
  'application/tab-separated-values'
])
const TABULAR_EXTENSIONS = new Set(['.csv', '.tsv'])

// Returns true when the artifact should be parsed as a tabular structure.
const isTabularArtifact = (mimeType?: string, path?: string): boolean => {
  if (mimeType && TABULAR_MIME_TYPES.has(mimeType.toLowerCase().split(';')[0]?.trim() ?? '')) {
    return true
  }

  if (path) {
    const ext = extname(path).toLowerCase()
    if (TABULAR_EXTENSIONS.has(ext)) return true
  }

  return false
}

// Detects the field delimiter for a tabular artifact from its MIME type or path extension.
// Falls back to comma (CSV) when the format is ambiguous.
const detectDelimiter = (mimeType?: string, path?: string): ',' | '\t' => {
  if (mimeType) {
    const normalized = mimeType.toLowerCase()
    if (normalized.includes('tab-separated')) return '\t'
  }

  if (path) {
    const ext = extname(path).toLowerCase()
    if (ext === '.tsv') return '\t'
  }

  return ','
}

// Splits delimiter-separated text into rows of fields following RFC 4180: fields may be wrapped in
// double quotes, a quoted field may contain the delimiter, embedded newlines, and escaped quotes
// (""). CRLF and LF line endings are both accepted. Fully-empty rows (blank lines) are dropped.
const parseDelimitedRows = (text: string, delimiter: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let rowHasContent = false

  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    // Drop blank lines: a row that is a single empty field with no quoted content.
    if (rowHasContent || row.length > 1) rows.push(row)
    row = []
    rowHasContent = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      rowHasContent = true
    } else if (ch === delimiter) {
      rowHasContent = true
      endField()
    } else if (ch === '\r') {
      // Swallow CR; the following LF (if any) terminates the row.
    } else if (ch === '\n') {
      endRow()
    } else {
      field += ch
      rowHasContent = true
    }
  }

  // Flush any trailing field/row not terminated by a newline.
  if (inQuotes || rowHasContent || row.length > 0) endRow()

  return rows
}

// Parses delimiter-separated text into a column-addressable structure. The first row is treated as
// the header. Blank lines are ignored; RFC 4180 quoting is honored (see parseDelimitedRows).
// Duplicate headers are disambiguated by suffixing (`id`, `id_2`, …) so no column is silently lost.
// Returns columns as Record<header, values[]> plus the row count (excluding the header row).
export const parseTabular = (
  text: string,
  delimiter: ',' | '\t'
): { columns: Record<string, string[]>; rowCount: number } => {
  const rows = parseDelimitedRows(text, delimiter)

  if (rows.length === 0) {
    return { columns: {}, rowCount: 0 }
  }

  // Disambiguate duplicate headers so each source column survives.
  const seen = new Map<string, number>()
  const headers = rows[0]!.map((raw) => {
    const count = (seen.get(raw) ?? 0) + 1
    seen.set(raw, count)
    return count === 1 ? raw : `${raw}_${count}`
  })

  const columns: Record<string, string[]> = {}
  for (const header of headers) {
    columns[header] = []
  }

  const dataRows = rows.slice(1)

  for (const dataRow of dataRows) {
    for (let col = 0; col < headers.length; col++) {
      const header = headers[col]!
      columns[header]!.push(dataRow[col] ?? '')
    }
  }

  return { columns, rowCount: dataRows.length }
}

// The Python bootstrap code injected into the reviewer sandbox. It defines a `host` module
// that forwards read_turn / query_execution_log / read_artifact calls to the ReviewerHostServer.
export const buildReviewerHostPythonBootstrap = (endpoint: string, token: string): string => `
import json
import urllib.request
import urllib.error

class _ReviewerHost:
    """Scope-narrowed read access to the audited turn. Call these from the reviewer REPL."""

    def __init__(self, endpoint, token):
        self._endpoint = endpoint
        self._token = token

    def _call(self, method, params=None):
        payload = json.dumps({"method": method, "params": params or {}}).encode("utf-8")
        req = urllib.request.Request(
            self._endpoint, data=payload, method="POST",
            headers={
                "content-type": "application/json",
                "authorization": "Bearer " + self._token
            }
        )
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                parsed = json.loads(e.read().decode("utf-8"))
            except Exception:
                parsed = {}
            raise RuntimeError(parsed.get("error") or ("host HTTP " + str(e.code)))
        if body.get("error"):
            raise RuntimeError("host error: " + str(body["error"]))
        return body["result"]

    def read_turn(self):
        """Return the ordered block list for the audited turn."""
        return self._call("read_turn")

    def query_execution_log(self, activity_id=None):
        """Return execution records for this turn's activities (optionally filter to one)."""
        params = {}
        if activity_id is not None:
            params["activityId"] = activity_id
        return self._call("query_execution_log", params)

    def read_artifact(self, artifact_id):
        """Return artifact content for an artifact belonging to this turn.

        For tabular artifacts (CSV, TSV) returns:
          {'kind': 'tabular', 'id': ..., 'columns': {'col': [values]}, 'rowCount': N}
        where each column is addressable by name — no visual row-alignment needed.

        For all other artifacts returns:
          {'kind': 'raw', 'id': ..., 'content': '...', 'encoding': 'utf8'|'base64'}
        """
        return self._call("read_artifact", {"id": artifact_id})

# Inject into sandbox globals under the name host.
host = _ReviewerHost(${JSON.stringify(endpoint)}, ${JSON.stringify(token)})
`

// Verifies that a given block id is within the scope. Used by submit_findings to validate locators.
export const assertBlockInScope = (block: ScopeBlock | undefined, id: string): ScopeBlock => {
  if (!block) {
    throw new Error(`Block ${JSON.stringify(id)} is not in the turn scope.`)
  }
  return block
}
