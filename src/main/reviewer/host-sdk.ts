// Host SDK for the reviewer REPL sandbox. Provides scope-narrowed read functions that the reviewer
// calls from Python code to access the audited turn's data. All access is validated against the
// TurnScope produced by resolveTurnScope; out-of-scope ids are rejected.
//
// The "host" module is injected into the reviewer Python sandbox via an HTTP RPC endpoint (mirroring
// how the notebook MCP server's host.mcp() works). The reviewer REPL's Python bridge boots a _Host
// object; calls to host.read_turn() / host.query_execution_log() / host.read_artifact() POST to this
// server and get back JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { getProjectArtifactDir } from '../artifacts/repository'
import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import type { TurnScope, ScopeBlock } from '../../shared/reviewer'

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

// Column-addressable structure returned for tabular (CSV/TSV) artifacts so the reviewer can
// match by column name instead of aligning rows visually.
export type TabularArtifactContent = {
  id: string
  kind: 'tabular'
  // Each key is a column header; the array contains the string values of that column across all rows.
  columns: Record<string, string[]>
  rowCount: number
}

// Raw content for non-tabular artifacts (text UTF-8 or base64-encoded binary).
export type RawArtifactContent = {
  id: string
  kind: 'raw'
  content: string
  encoding: 'utf8' | 'base64'
}

// Artifact content as returned by host.read_artifact(id): column-addressable for CSV/TSV, raw otherwise.
export type ArtifactContent = TabularArtifactContent | RawArtifactContent

// The complete set of RPC methods the host exposes. Single-sourced so the unknown-method error can
// tell a guessing reviewer exactly what IS available (it likes to try e.g. `list_artifacts`).
export const SUPPORTED_HOST_METHODS = ['read_turn', 'query_execution_log', 'read_artifact'] as const

// The HTTP RPC server that backs the host.* Python functions in the reviewer sandbox.
// It verifies every requested id against the TurnScope so the reviewer can only see this turn.
export class ReviewerHostServer {
  private server: Server
  readonly token: string
  private _endpoint: string | undefined

  constructor(
    private readonly session: PersistedChatSession,
    private readonly scope: TurnScope,
    private readonly artifactStorageRoot: string
  ) {
    this.token = randomUUID()
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        res.writeHead(500, { 'content-type': 'application/json' })
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
    const body = await readBody(req)
    let parsed: { method?: string; params?: Record<string, unknown> }

    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
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
        result = await this.readArtifact(params.id as string)
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
  private readTurn(): OrderedBlock[] {
    const messageMap = new Map(this.session.messages.map((m) => [m.id, m]))
    const activityMap = new Map((this.session.activities ?? []).map((a) => [a.id, a]))

    return this.scope.blocks.map((block): OrderedBlock => {
      if (block.kind === 'message') {
        const msg = messageMap.get(block.sourceId)

        return {
          blockIndex: block.blockIndex,
          id: block.id,
          kind: 'message',
          sourceId: block.sourceId,
          contentHash: block.contentHash,
          role: msg?.role,
          content: msg?.content,
          artifactIds: msg?.artifactIds
        }
      } else {
        const activity = activityMap.get(block.sourceId)

        return {
          blockIndex: block.blockIndex,
          id: block.id,
          kind: 'activity',
          sourceId: block.sourceId,
          contentHash: block.contentHash,
          title: activity?.title,
          status: activity?.status,
          toolKind: activity?.toolKind,
          ...(activity ? activityIoFields(activity) : {})
        }
      }
    })
  }

  // Returns execution records for this turn's activities, optionally filtered to one activity.
  private queryExecutionLog(activityId?: string): ExecRecord[] {
    const activityIds = new Set(
      this.scope.blocks.filter((b) => b.kind === 'activity').map((b) => b.sourceId)
    )
    const activities: PersistedToolActivity[] = (this.session.activities ?? []).filter((a) =>
      activityIds.has(a.id)
    )

    const target =
      activityId !== undefined ? activities.filter((a) => a.id === activityId) : activities

    // Out-of-scope id: reject rather than silently returning empty.
    if (activityId !== undefined && target.length === 0) {
      throw new Error(
        `Activity id ${JSON.stringify(activityId)} is not in this turn's scope. ` +
          `Allowed ids: ${[...activityIds].join(', ')}`
      )
    }

    return target.map((a) => ({
      activityId: a.id,
      title: a.title,
      status: a.status,
      ...activityIoFields(a)
    }))
  }

  // Returns artifact content for an artifact id belonging to this turn.
  // Tabular artifacts (CSV/TSV) are returned as { kind:'tabular'; columns; rowCount } so the
  // reviewer can address by column name without visual row alignment. Non-tabular artifacts
  // return { kind:'raw'; content; encoding }.
  private async readArtifact(id: string): Promise<ArtifactContent> {
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
    const artifactPath = resolveArtifactPath(this.artifactStorageRoot, this.session.projectId, id)

    let bytes: Buffer
    try {
      bytes = await readFile(artifactPath)
    } catch (error) {
      throw new Error(
        `Failed to read artifact ${JSON.stringify(id)} at ${artifactPath}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      )
    }

    const isText = isLikelyText(bytes)

    if (isText) {
      const text = bytes.toString('utf8')

      // Determine if this artifact is a tabular format (CSV/TSV) by mimeType or path extension.
      if (isTabularArtifact(artifactMeta?.mimeType, artifactMeta?.path)) {
        const parsed = parseTabular(
          text,
          detectDelimiter(artifactMeta?.mimeType, artifactMeta?.path)
        )
        return { id, kind: 'tabular', columns: parsed.columns, rowCount: parsed.rowCount }
      }

      return { id, kind: 'raw', content: text, encoding: 'utf8' }
    }

    return { id, kind: 'raw', content: bytes.toString('base64'), encoding: 'base64' }
  }
}

// Reads the full HTTP request body as a string.
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

// The I/O fields exposed to the reviewer for one tool activity. Non-MCP tools (e.g. Bash) populate
// rawInput/rawOutput/terminalOutput directly; MCP tools (notebook_execute, write_artifact_file) leave
// those empty and record their payload in toolContent instead. To keep the reviewer from being blind
// to what a tool actually did, we surface the toolContent text under rawOutput when rawOutput is
// absent — otherwise the reviewer cannot verify a claim against the tool's real output.
const activityIoFields = (
  activity: PersistedToolActivity
): Pick<ExecRecord, 'rawInput' | 'rawOutput' | 'terminalOutput' | 'terminalExitCode'> => {
  const toolContentText =
    activity.rawOutput === undefined ? extractToolContentText(activity.toolContent) : undefined

  return {
    rawInput: activity.rawInput,
    rawOutput: activity.rawOutput ?? toolContentText,
    terminalOutput: activity.terminalOutput,
    terminalExitCode: activity.terminalExitCode
  }
}

// Pulls the readable text out of an ACP-style toolContent array. Each block is loosely typed; we
// tolerate blocks without text (returning undefined when nothing readable is present). Handles both
// `{ content: { text } }` and flat `{ text }` shapes.
const extractToolContentText = (toolContent: unknown[] | undefined): string | undefined => {
  if (!Array.isArray(toolContent)) return undefined

  const texts: string[] = []
  for (const block of toolContent) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>

    const nested =
      typeof record.content === 'object' && record.content !== null
        ? (record.content as Record<string, unknown>).text
        : undefined

    if (typeof nested === 'string') texts.push(nested)
    else if (typeof record.text === 'string') texts.push(record.text)
  }

  return texts.length > 0 ? texts.join('\n') : undefined
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
// <storageRoot>/artifacts/<projectName>/<sessionId>/<messageId>/<filename>. The version id is the
// colon-composite <sessionId>:<messageId>:<filename> assigned when the artifact is attached to a turn.
export const resolveArtifactPath = (
  storageRoot: string,
  projectName: string,
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

  return join(getProjectArtifactDir(storageRoot, projectName), sessionId, messageId, filename)
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
