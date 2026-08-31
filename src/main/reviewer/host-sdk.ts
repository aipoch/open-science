// Turn-scoped evidence access for the reviewer. Production calls the public read methods through the
// dedicated reviewer MCP server, which validates every activity/artifact id against TurnScope. The
// authenticated HTTP adapter remains for compatibility tests and older callers, but the reviewer no
// longer receives its endpoint/token or executes a Python bootstrap.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { getProjectArtifactDir } from '../artifacts/repository'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type {
  ReviewerFileEvidenceDescriptor,
  ReviewerSourceEvidenceDescriptor,
  ReviewerTurnPlanDescriptor,
  ReviewScopeSnapshotBlock,
  TurnScope,
  ScopeBlock
} from '../../shared/reviewer'
import type { ArtifactVersionProvenance } from '../../shared/artifact-provenance'
import { buildReviewScopeSnapshot as buildPersistedScopeSnapshot } from './scope-snapshot'
import {
  FileObservationMismatchError,
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
import { toErrorMessage } from '../error-message'
import { extractPdfTextPages } from '../uploads/attachment-media'
import {
  readBoundedPptx,
  readBoundedSpreadsheet,
  ArtifactTargetRangeError,
  type ArtifactReadTargets,
  type StructuredArtifactContent
} from './bounded-artifact-content'

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
  turnPlan?: ReviewerTurnPlanDescriptor
  fileEvidence?: ReviewerFileEvidenceDescriptor[]
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
  role: 'work_product' | 'source_document'
  kind: 'tabular'
  // Each key is a column header; the array contains the string values of that column across all rows.
  columns: Record<string, string[]>
  rowCount: number | null
  rowsReturned?: number
  rowCountComplete?: boolean
}

// Raw content is text-only. Opaque binary is never encoded into Reviewer JSON.
export type RawArtifactContent = ArtifactContentWindow & {
  id: string
  role: 'work_product' | 'source_document'
  kind: 'raw'
  content: string
  encoding: 'utf8'
}

type MediaArtifactBase = {
  id: string
  kind: 'media'
  role: 'work_product' | 'source_document'
  filename: string
  mimeType: SupportedReviewerImageMimeType
  checksum: string
  limitations: ReviewLimitation[]
}

export type DeliveredMediaArtifactContent = MediaArtifactBase & {
  delivery: 'delivered'
  sizeBytes: number
  offset: 0
  returnedBytes: number
  truncated: false
  limitations: []
  data: Buffer
}

export type LimitedMediaArtifactContent = MediaArtifactBase & {
  delivery: 'limited'
  sizeBytes: number
  offset: 0
  returnedBytes: 0
  truncated: true
  limitations: ReviewLimitation[]
}

export type MediaArtifactContent = DeliveredMediaArtifactContent | LimitedMediaArtifactContent

export type MediaArtifactMetadata =
  Omit<DeliveredMediaArtifactContent, 'data'> | LimitedMediaArtifactContent

export type UnsupportedArtifactContent = ArtifactContentWindow & {
  id: string
  kind: 'unsupported'
  role: 'work_product' | 'source_document'
  filename: string
  mimeType?: string
  checksum: string
  limitations: ReviewLimitation[]
}

export type ArtifactContent =
  | TabularArtifactContent
  | RawArtifactContent
  | StructuredArtifactContent
  | MediaArtifactContent
  | UnsupportedArtifactContent

export type ReviewLimitation = {
  kind:
    | 'truncated'
    | 'budget-exhausted'
    | 'corrupt-content'
    | 'content-missing'
    | 'checksum-mismatch'
    | 'unsupported-format'
    | 'unsupported-model-capability'
    | 'producer-unavailable'
    | 'input-unavailable'
  subjectId?: string
  detail?: string
}

export type WorkProductTraceResult = {
  id: string
  role: 'work_product'
  file: {
    filename: string
    mimeType?: string
    sizeBytes: number
    checksum: string
    contentStatus: 'available' | 'missing' | 'checksum-mismatch'
  }
  producer:
    | {
        kind: 'notebook'
        runId: string
        language: string
        code: string
        status: string
        outputs: unknown[]
        inputs: ArtifactTraceInput[]
        environment?: unknown
      }
    | {
        kind: 'connector'
        connectorId: string
        toolId: string
        implementationVersion: string
        arguments: unknown
        inputs: ArtifactTraceInput[]
      }
    | { kind: 'unavailable'; reason: string }
  limitations: ReviewLimitation[]
}

export type SourceTraceResult = {
  id: string
  role: 'source_document'
  file: {
    filename: string
    mimeType?: string
    sizeBytes: number
    checksum: string
    contentStatus: 'available' | 'missing' | 'checksum-mismatch'
  }
  source: {
    kind: 'upload-version' | 'artifact-input-version'
    scopeReason: 'read-by-turn' | 'execution-input' | 'artifact-input'
  }
  limitations: ReviewLimitation[]
}

export type ArtifactTraceResult = WorkProductTraceResult | SourceTraceResult

export type ArtifactTraceInput = {
  versionId: string
  checksum: string
}

export type ReviewerArtifactReadResult = ArtifactContent | ArtifactTraceResult

export type ArtifactVersionContentResolver = (request: {
  projectId: string
  sessionId?: string
  fileId?: string
  versionId: string
}) => Promise<{
  path?: string
  filename: string
  contentType?: string
  checksum: string
  size: number
  readRange: (begin: number, end: number) => Promise<Uint8Array>
  verifyUnchanged: () => Promise<void>
  close: () => Promise<void>
}>

type LegacyArtifactVersionContentResolver = (request: {
  projectId: string
  sessionId?: string
  fileId?: string
  versionId: string
}) => Promise<{
  path: string
  filename: string
  contentType?: string
  checksum?: string
}>

type ResolvedArtifactVersionContent = Awaited<
  ReturnType<ArtifactVersionContentResolver | LegacyArtifactVersionContentResolver>
>

const isManagedArtifactVersionContent = (
  value: ResolvedArtifactVersionContent | undefined
): value is Awaited<ReturnType<ArtifactVersionContentResolver>> =>
  Boolean(
    value &&
    typeof value.checksum === 'string' &&
    typeof (value as { size?: unknown }).size === 'number' &&
    typeof (value as { readRange?: unknown }).readRange === 'function' &&
    typeof (value as { verifyUnchanged?: unknown }).verifyUnchanged === 'function' &&
    typeof (value as { close?: unknown }).close === 'function'
  )

export type ArtifactVersionTraceResolver = (request: {
  projectId: string
  versionId: string
}) => Promise<ArtifactVersionProvenance>

export type ArtifactVersionEvidenceResolvers = {
  content?: ArtifactVersionContentResolver
  trace?: ArtifactVersionTraceResolver
  pagedContent?: ReviewerPagedContentResolver
}

export type ReviewerPagedContentResolver = (request: {
  artifactVersionId: string
  path: string
  filename: string
  format: 'pdf' | 'docx' | 'pptx'
  pages: number[]
  includePreview: boolean
  maxBytes: number
  verifiedObservation: FileObservation
  verifiedChecksum: string
  signal?: AbortSignal
}) => Promise<{
  pageCount: number
  pages: Array<{ pageNumber: number; text: string }>
  media?: Array<{ pageNumber: number; data: string; mimeType: string }>
  limitations?: ReviewLimitation[]
  pageCountComplete?: boolean
}>

export type ReviewerResourceBudgetOptions = {
  requestBytes?: number
  readBytes?: number
  sessionBytes?: number
}

export type ReviewerArtifactReadOptions = {
  view?: 'trace' | 'content'
  offset?: number
  maxBytes?: number
  pages?: number[]
  sheet?: string
  rowStart?: number
  rowEnd?: number
  columns?: string[]
  includePreview?: boolean
}

export type SupportedReviewerImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// Explicit allowlist used at every JSON boundary. Never serialize MediaArtifactContent by spread:
// delivered results intentionally carry enumerable bytes so cloning cannot silently drop them.
export const toMediaArtifactMetadata = (
  artifact: MediaArtifactContent | MediaArtifactMetadata
): MediaArtifactMetadata => {
  const common = {
    id: artifact.id,
    kind: 'media' as const,
    role: artifact.role,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    checksum: artifact.checksum,
    sizeBytes: artifact.sizeBytes,
    offset: 0 as const
  }
  return artifact.delivery === 'delivered'
    ? {
        ...common,
        delivery: 'delivered',
        returnedBytes: artifact.returnedBytes,
        truncated: false,
        limitations: []
      }
    : {
        ...common,
        delivery: 'limited',
        returnedBytes: 0,
        truncated: true,
        limitations: artifact.limitations
      }
}

export const toLimitedMediaArtifactMetadata = (
  artifact: MediaArtifactContent | MediaArtifactMetadata,
  limitations: ReviewLimitation[]
): LimitedMediaArtifactContent => ({
  id: artifact.id,
  kind: 'media',
  role: artifact.role,
  filename: artifact.filename,
  mimeType: artifact.mimeType,
  checksum: artifact.checksum,
  delivery: 'limited',
  sizeBytes: artifact.sizeBytes,
  offset: 0,
  returnedBytes: 0,
  truncated: true,
  limitations
})

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
  private readonly sourceDocumentEvidenceByVersionId: ReadonlyMap<
    string,
    ReviewerSourceEvidenceDescriptor
  >
  readonly token: string
  private _endpoint: string | undefined

  constructor(
    private readonly session: PersistedChatSession,
    private readonly scope: TurnScope,
    private readonly artifactStorageRoot: string,
    private readonly resolveArtifactVersion?:
      ArtifactVersionContentResolver | LegacyArtifactVersionContentResolver,
    frozenScopeSnapshot?: ReviewScopeSnapshotBlock[],
    resourceBudget: ReviewerResourceBudgetOptions = {},
    private readonly resolveArtifactVersionTrace?: ArtifactVersionTraceResolver,
    private readonly resolvePagedContent?: ReviewerPagedContentResolver,
    sourceDocumentEvidence: readonly ReviewerFileEvidenceDescriptor[] = []
  ) {
    this.frozenScopeSnapshot = frozenScopeSnapshot ?? buildPersistedScopeSnapshot(session, scope)
    this.token = randomUUID()
    const sourceDescriptors = sourceDocumentEvidence.filter(
      (descriptor): descriptor is ReviewerSourceEvidenceDescriptor =>
        descriptor.role === 'source_document'
    )
    if (sourceDescriptors.length !== sourceDocumentEvidence.length) {
      throw new Error('Source Document authority cannot contain Work Product descriptors.')
    }
    if (sourceDescriptors.some((descriptor) => !descriptor.traceAvailable)) {
      throw new Error('Every Source Document descriptor must have trusted trace provenance.')
    }
    const duplicateSourceIds = sourceDescriptors
      .map((descriptor) => descriptor.versionId)
      .filter((versionId, index, ids) => ids.indexOf(versionId) !== index)
    if (duplicateSourceIds.length > 0) {
      throw new Error(`Duplicate Source Document Version descriptor: ${duplicateSourceIds[0]}.`)
    }
    this.sourceDocumentEvidenceByVersionId = new Map(
      sourceDescriptors.map((descriptor) => [descriptor.versionId, descriptor])
    )
    const scopedSourceIds = new Set(scope.sourceDocumentVersionIds ?? [])
    const descriptorSourceIds = new Set(this.sourceDocumentEvidenceByVersionId.keys())
    if (
      scopedSourceIds.size !== (scope.sourceDocumentVersionIds ?? []).length ||
      scopedSourceIds.size !== descriptorSourceIds.size ||
      [...scopedSourceIds].some((versionId) => !descriptorSourceIds.has(versionId))
    ) {
      throw new Error('Frozen Source Document scope does not match its trusted descriptor map.')
    }
    if (scope.artifactVersionIds.some((versionId) => descriptorSourceIds.has(versionId))) {
      throw new Error('A file Version cannot be both a Work Product and a Source Document.')
    }
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
        res.end(JSON.stringify({ error: toErrorMessage(error) }))
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
        result =
          params.view === 'trace'
            ? await this.readArtifact(params.id as string, {
                view: 'trace',
                offset: params.offset as number | undefined,
                maxBytes: params.maxBytes as number | undefined,
                pages: params.pages as number[] | undefined,
                sheet: params.sheet as string | undefined,
                rowStart: params.rowStart as number | undefined,
                rowEnd: params.rowEnd as number | undefined,
                columns: params.columns as string[] | undefined,
                includePreview: params.includePreview as boolean | undefined
              })
            : await this.readArtifact(params.id as string, {
                view: 'content',
                offset: params.offset as number | undefined,
                maxBytes: params.maxBytes as number | undefined,
                pages: params.pages as number[] | undefined,
                sheet: params.sheet as string | undefined,
                rowStart: params.rowStart as number | undefined,
                rowEnd: params.rowEnd as number | undefined,
                columns: params.columns as string[] | undefined,
                includePreview: params.includePreview as boolean | undefined
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
    const jsonResult =
      typeof result === 'object' && result !== null && 'kind' in result && result.kind === 'media'
        ? toMediaArtifactMetadata(result as MediaArtifactContent)
        : result
    res.end(JSON.stringify({ result: jsonResult }))
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

  // Returns immutable Version content for a Work Product or Source Document in this turn's frozen
  // evidence scope. Historical scopes omit sourceDocumentVersionIds and retain artifact-only access.
  // Tabular artifacts (CSV/TSV) are returned as { kind:'tabular'; columns; rowCount } so the
  // reviewer can address by column name without visual row alignment. Non-tabular artifacts
  // return { kind:'raw'; content; encoding }.
  async readArtifact(
    id: string,
    options: ReviewerArtifactReadOptions = {},
    signal?: AbortSignal
  ): Promise<ReviewerArtifactReadResult> {
    const allowedVersionIds = [
      ...this.scope.artifactVersionIds,
      ...this.sourceDocumentEvidenceByVersionId.keys()
    ]
    if (!allowedVersionIds.includes(id)) {
      throw new Error(
        `File Version id ${JSON.stringify(id)} is not in this turn's scope. ` +
          `Allowed ids: ${allowedVersionIds.join(', ')}`
      )
    }

    if (options.view === 'trace') return this.readArtifactTrace(id, options)
    const role = this.fileRole(id)

    // Look up artifact metadata from the session so we can determine the format.
    const artifactMeta = (this.session.artifacts ?? []).find((a) => a.id === id)

    // Read the artifact from managed storage. A read failure (missing/unreadable file) MUST surface
    // as an error, not degrade to empty content — otherwise the reviewer cannot distinguish "could
    // not read" from "the file is genuinely empty", which produces false "empty artifact" findings.
    if (options.offset !== undefined && hasStructuredTargets(options)) {
      throw new Error(
        'Reviewer Artifact offset cannot be combined with structured content targets.'
      )
    }

    const resolvedVersion = this.resolveArtifactVersion
      ? await this.resolveArtifactVersion({
          projectId: this.session.projectId,
          versionId: id,
          ...(artifactMeta?.artifactId
            ? { sessionId: this.session.id, fileId: artifactMeta.artifactId }
            : {})
        })
      : undefined
    const managedLease = isManagedArtifactVersionContent(resolvedVersion)
      ? resolvedVersion
      : undefined
    const artifactPath =
      resolvedVersion?.path ??
      (resolvedVersion
        ? undefined
        : resolveArtifactPath(this.artifactStorageRoot, this.session.projectId, id))

    try {
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
      let verification: ArtifactVerification
      try {
        if (!artifactPath) {
          const sample = Buffer.from(
            await managedLease!.readRange(0, Math.min(managedLease!.size, 512))
          )
          await managedLease!.verifyUnchanged()
          verification = {
            path: '',
            checksum: managedLease!.checksum,
            sizeBytes: managedLease!.size,
            sample,
            observation: {
              device: 0,
              inode: 0,
              sizeBytes: managedLease!.size,
              modifiedAtMs: 0,
              changedAtMs: 0
            }
          }
        } else {
          verification = await this.verifyArtifact(
            id,
            artifactPath,
            resolvedVersion?.checksum,
            signal
          )
        }
      } catch (error) {
        if (signal?.aborted) throw error
        if (error instanceof ArtifactVersionChecksumMismatchError) throw error
        throw new Error(
          `Failed to read artifact ${JSON.stringify(id)} at ${artifactPath}: ` +
            `${toErrorMessage(error)}`
        )
      }

      if (offset > verification.sizeBytes) {
        throw new Error(
          `Reviewer Artifact offset ${offset} exceeds file size ${verification.sizeBytes}.`
        )
      }

      const filename = resolvedVersion?.filename ?? artifactMeta?.path ?? artifactMeta?.name ?? id
      const structuredFormat = detectStructuredFormat(
        resolvedVersion?.contentType ?? artifactMeta?.mimeType,
        filename
      )
      if (structuredFormat) {
        if (!artifactPath) {
          throw new Error(
            `Managed Artifact ${JSON.stringify(id)} does not expose a verified structured-content path.`
          )
        }
        const targets: ArtifactReadTargets = {
          pages: options.pages,
          sheet: options.sheet,
          rowStart: options.rowStart,
          rowEnd: options.rowEnd,
          columns: options.columns
        }
        let structured: StructuredArtifactContent
        if (structuredFormat === 'xlsx') {
          structured = await readBoundedSpreadsheet(id, artifactPath, targets, signal)
        } else if (structuredFormat === 'docx') {
          structured = await this.readPreviewPagedContent(
            id,
            artifactPath,
            filename ?? id,
            'docx',
            options.pages ?? [1],
            options.includePreview === true,
            returnedLimit,
            verification,
            signal
          )
        } else if (structuredFormat === 'pptx') {
          structured = await readBoundedPptx(id, artifactPath, targets, signal)
          if (options.includePreview && structured.kind === 'paged') {
            structured = await this.mergePreviewContent(
              structured,
              artifactPath,
              filename ?? id,
              returnedLimit,
              verification,
              signal
            )
          }
        } else {
          try {
            const pdf = await extractPdfTextPages(
              artifactPath,
              options.pages,
              returnedLimit,
              signal
            )
            structured = {
              id,
              role: 'work_product',
              kind: 'paged',
              format: 'pdf',
              targets: { pages: pdf.pages.map((page) => page.pageNumber) },
              pageCount: pdf.pageCount,
              pages: pdf.pages,
              partial: pdf.pages.length < pdf.pageCount,
              limitations: pdf.truncated
                ? [
                    {
                      kind: 'truncated',
                      subjectId: id,
                      detail: 'Requested PDF page text was truncated.'
                    }
                  ]
                : []
            }
            const needsPreview =
              options.includePreview === true || pdf.pages.some((page) => page.text.length === 0)
            if (needsPreview) {
              structured = await this.mergePreviewContent(
                structured,
                artifactPath,
                filename ?? id,
                returnedLimit,
                verification,
                signal
              )
            }
          } catch (error) {
            if (signal?.aborted) throw error
            if (
              error instanceof ArtifactTargetRangeError ||
              (error instanceof Error && error.message.startsWith('Requested PDF page must'))
            ) {
              throw error
            }
            structured = {
              id,
              role: 'work_product',
              kind: 'paged',
              format: 'pdf',
              targets: { ...(options.pages ? { pages: [...new Set(options.pages)] } : {}) },
              pageCount: 0,
              pages: [],
              partial: true,
              limitations: [
                {
                  kind: 'corrupt-content',
                  subjectId: id,
                  detail: `PDF could not be parsed: ${toErrorMessage(error)}`
                }
              ]
            }
          }
        }
        return this.commitStructuredResponse({ ...structured, role }, returnedLimit)
      }
      if (hasStructuredTargets(options)) {
        return this.commitStructuredResponse(
          {
            id,
            role,
            kind: 'unsupported',
            targets: {
              ...(options.pages ? { pages: [...new Set(options.pages)] } : {}),
              ...(options.sheet ? { sheet: options.sheet } : {}),
              ...(options.rowStart !== undefined ? { rowStart: options.rowStart } : {}),
              ...(options.rowEnd !== undefined ? { rowEnd: options.rowEnd } : {}),
              ...(options.columns ? { columns: [...new Set(options.columns)] } : {})
            },
            partial: true,
            limitations: [
              {
                kind: 'unsupported-format',
                subjectId: id,
                detail: `Targeted structured content is not supported for ${filename ?? id}.`
              }
            ]
          },
          returnedLimit
        )
      }
      let read: {
        page: Buffer
        offset: number
        returnedBytes: number
        truncated: boolean
        sizeBytes: number
        sample: Buffer
      }
      if (managedLease) {
        try {
          if (signal?.aborted) throw signal.reason
          const end = Math.min(managedLease.size, offset + returnedLimit)
          const page = Buffer.from(await managedLease.readRange(offset, end))
          await managedLease.verifyUnchanged()
          read = {
            page,
            offset,
            returnedBytes: page.byteLength,
            truncated: end < managedLease.size,
            sizeBytes: managedLease.size,
            sample: verification.sample
          }
        } catch (error) {
          throw new Error(
            `Failed to read managed Artifact ${JSON.stringify(id)}: ${toErrorMessage(error)}`
          )
        }
      } else {
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
              `${toErrorMessage(error)}`
          )
        }
      }
      let result: ArtifactContent
      const contentType = resolvedVersion?.contentType ?? artifactMeta?.mimeType
      const imageMimeType = detectSupportedImageMimeType(read.sample)

      if (imageMimeType) {
        if (offset !== 0) {
          throw new Error('Reviewer image content reads do not accept an offset.')
        }
        const sourceComplete = read.returnedBytes === read.sizeBytes
        const baseMetadataBytes = Buffer.byteLength(
          JSON.stringify({
            id,
            kind: 'media',
            role: 'work_product',
            delivery: 'delivered',
            filename,
            mimeType: imageMimeType,
            checksum: verification.checksum,
            sizeBytes: read.sizeBytes,
            offset: 0,
            returnedBytes: read.returnedBytes,
            truncated: false,
            limitations: []
          }),
          'utf8'
        )
        const encodedMediaBytes = 4 * Math.ceil(read.page.length / 3)
        const complete =
          sourceComplete && baseMetadataBytes + encodedMediaBytes <= remainingSessionBytes
        const limitations: ReviewLimitation[] = complete
          ? []
          : [
              {
                kind: 'budget-exhausted',
                subjectId: id,
                detail: `Image content requires ${read.sizeBytes} source bytes and exceeds the bounded media transport budget.`
              }
            ]
        const metadata: MediaArtifactBase = {
          id,
          role,
          kind: 'media',
          filename,
          mimeType: imageMimeType,
          checksum: verification.checksum,
          limitations
        }
        if (complete) {
          result = {
            ...metadata,
            delivery: 'delivered',
            sizeBytes: read.sizeBytes,
            offset: 0,
            returnedBytes: read.returnedBytes,
            truncated: false,
            limitations: [],
            data: read.page
          }
        } else {
          result = {
            ...metadata,
            delivery: 'limited',
            sizeBytes: read.sizeBytes,
            offset: 0,
            returnedBytes: 0,
            truncated: true,
            limitations
          }
        }
      } else if (
        isDeclaredTextContentType(contentType) ||
        isTabularArtifact(contentType, filename) ||
        (!contentType && isLikelyText(read.sample))
      ) {
        const safePage = decodeUtf8Page(read.page, offset)
        if (
          read.returnedBytes > 0 &&
          (safePage.offset !== offset || safePage.returnedBytes === 0)
        ) {
          result = unsupportedArtifactContent({
            id,
            role,
            filename,
            contentType,
            checksum: verification.checksum,
            sizeBytes: read.sizeBytes
          })
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
          if (
            isTabularArtifact(contentType, filename) &&
            window.offset === 0 &&
            !window.truncated
          ) {
            const parsed = parseTabular(text, detectDelimiter(contentType, filename))
            result = {
              id,
              role,
              kind: 'tabular',
              columns: parsed.columns,
              rowCount: parsed.rowCount,
              rowsReturned: parsed.rowCount,
              rowCountComplete: true,
              ...window
            }
          } else {
            result = { id, role, kind: 'raw', content: text, encoding: 'utf8', ...window }
          }
        }
      } else {
        result = unsupportedArtifactContent({
          id,
          role,
          filename,
          contentType,
          checksum: verification.checksum,
          sizeBytes: read.sizeBytes
        })
      }

      const responseBytes =
        Buffer.byteLength(
          JSON.stringify(result.kind === 'media' ? toMediaArtifactMetadata(result) : result),
          'utf8'
        ) +
        (result.kind === 'media' && result.delivery === 'delivered'
          ? 4 * Math.ceil(result.data.length / 3)
          : 0)
      assertWithinResourceBudget(
        'reviewer-session',
        this.reviewerBytesReturned + responseBytes,
        this.resourceBudget.sessionBytes
      )
      this.reviewerBytesReturned += responseBytes
      return result
    } finally {
      await managedLease?.close()
    }
  }

  private async readArtifactTrace(
    id: string,
    options: ReviewerArtifactReadOptions
  ): Promise<ArtifactTraceResult> {
    if (options.offset !== undefined) {
      throw new Error('Reviewer Artifact offset is only valid for content reads.')
    }
    const requestedBytes = options.maxBytes ?? this.resourceBudget.readBytes
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
    const sourceEvidence = this.sourceDocumentEvidenceByVersionId.get(id)
    if (this.fileRole(id) === 'source_document') {
      if (!sourceEvidence) {
        throw new Error(`Trusted Source Document provenance is unavailable for Version ${id}.`)
      }
      const limitations: ReviewLimitation[] =
        sourceEvidence.contentStatus === 'available'
          ? []
          : [
              {
                kind:
                  sourceEvidence.contentStatus === 'checksum-mismatch'
                    ? 'checksum-mismatch'
                    : 'content-missing',
                subjectId: id
              }
            ]
      const trace: SourceTraceResult = {
        id,
        role: 'source_document',
        file: {
          filename: sourceEvidence.filename,
          ...(sourceEvidence.mimeType ? { mimeType: sourceEvidence.mimeType } : {}),
          sizeBytes: sourceEvidence.sizeBytes,
          checksum: sourceEvidence.checksum,
          contentStatus: sourceEvidence.contentStatus
        },
        source: {
          kind:
            sourceEvidence.scopeReason === 'artifact-input'
              ? 'artifact-input-version'
              : 'upload-version',
          scopeReason: sourceEvidence.scopeReason
        },
        limitations
      }
      return this.commitTraceResponse(trace)
    }
    if (!this.resolveArtifactVersionTrace) {
      const meta = (this.session.artifacts ?? []).find((artifact) => artifact.id === id)
      const unavailable: WorkProductTraceResult = {
        id,
        role: 'work_product',
        file: {
          filename: meta?.name ?? meta?.path ?? id,
          ...(meta?.mimeType ? { mimeType: meta.mimeType } : {}),
          sizeBytes: meta?.size ?? 0,
          checksum: meta?.sha256 ?? '',
          contentStatus: 'available'
        },
        producer: { kind: 'unavailable', reason: 'producer-unavailable' },
        limitations: [{ kind: 'producer-unavailable', subjectId: id }]
      }
      return this.commitTraceResponse(this.boundTrace(unavailable, returnedLimit))
    }

    const provenance = await this.resolveArtifactVersionTrace({
      projectId: this.session.projectId,
      versionId: id
    })
    const evidence = provenance.evidence
    const limitations: ReviewLimitation[] = []
    if (provenance.contentStatus.state === 'unavailable') {
      limitations.push({
        kind:
          provenance.contentStatus.reason === 'missing' ? 'content-missing' : 'checksum-mismatch',
        subjectId: id
      })
    }
    if (provenance.execution?.truncation) {
      limitations.push({
        kind: 'truncated',
        subjectId: id,
        detail: `Captured execution omitted ${provenance.execution.truncation.omittedLeadingRunCount} run(s), ${provenance.execution.truncation.omittedOutputCount} output(s), and ${provenance.execution.truncation.omittedInputCount} input(s).`
      })
    }
    for (const input of provenance.execution?.inputFiles ?? []) {
      if (input.availability.state === 'unavailable') {
        limitations.push({
          kind: 'input-unavailable',
          subjectId: input.inputFileVersionId,
          detail: input.availability.reason
        })
      }
    }

    let producer: WorkProductTraceResult['producer']
    if (evidence.producer.state === 'unavailable') {
      producer = { kind: 'unavailable', reason: evidence.producer.reason }
      limitations.push({
        kind: 'producer-unavailable',
        subjectId: id,
        detail: evidence.producer.reason
      })
    } else if ('kind' in evidence.producer) {
      producer = {
        kind: 'connector',
        connectorId: evidence.producer.connector_id,
        toolId: evidence.producer.tool_id,
        implementationVersion: evidence.producer.implementation_version,
        arguments: evidence.connector_execution?.normalized_arguments ?? {},
        inputs: evidence.inputs.map((input) => ({
          versionId: input.input_file_version_id,
          checksum: input.checksum
        }))
      }
    } else {
      const notebookProducer = evidence.producer as Extract<
        typeof evidence.producer,
        { notebook_session_id: string }
      >
      const run = provenance.execution?.runs.find(
        (candidate) => candidate.runId === notebookProducer.producer_run_id
      )
      if (!run) {
        producer = { kind: 'unavailable', reason: 'captured-producer-run-unavailable' }
        limitations.push({
          kind: 'producer-unavailable',
          subjectId: notebookProducer.producer_run_id,
          detail: 'The captured producer Run is unavailable.'
        })
      } else {
        producer = {
          kind: 'notebook',
          runId: run.runId,
          language: run.kernelKind,
          // This is the immutable captured Run script. reproduction_code / Code Reconstruction is
          // intentionally never consulted by the Reviewer trace projection.
          code: run.script,
          status: run.status,
          outputs: run.outputs,
          inputs: run.inputFileVersionKeys.flatMap((input) => {
            const captured = evidence.inputs.find(
              (candidate) =>
                candidate.source_kind === input.sourceKind &&
                candidate.input_file_version_id === input.inputFileVersionId
            )
            if (captured) {
              return [{ versionId: input.inputFileVersionId, checksum: captured.checksum }]
            }
            limitations.push({
              kind: 'input-unavailable',
              subjectId: input.inputFileVersionId,
              detail: 'Captured input checksum metadata is unavailable.'
            })
            return []
          }),
          ...(evidence.environment ? { environment: evidence.environment } : {})
        }
      }
    }

    const trace: ArtifactTraceResult = {
      id,
      role: 'work_product',
      file: {
        filename: evidence.filename,
        ...(evidence.content_type ? { mimeType: evidence.content_type } : {}),
        sizeBytes: evidence.size_bytes,
        checksum: evidence.checksum,
        contentStatus:
          provenance.contentStatus.state === 'available'
            ? 'available'
            : provenance.contentStatus.reason
      },
      producer,
      limitations
    }
    return this.commitTraceResponse(this.boundTrace(trace, returnedLimit))
  }

  private boundTrace(trace: WorkProductTraceResult, limit: number): WorkProductTraceResult {
    if (Buffer.byteLength(JSON.stringify(trace), 'utf8') <= limit) return trace
    const bounded = structuredClone(trace)
    bounded.limitations.push({
      kind: 'truncated',
      subjectId: trace.id,
      detail: 'Trace fields were truncated to the Reviewer read budget.'
    })
    if (bounded.producer.kind === 'notebook') {
      delete bounded.producer.environment
      bounded.producer.outputs = []
      let low = 0
      let high = bounded.producer.code.length
      while (low < high) {
        const midpoint = Math.ceil((low + high) / 2)
        bounded.producer.code =
          trace.producer.kind === 'notebook' ? trace.producer.code.slice(0, midpoint) : ''
        if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= limit) low = midpoint
        else high = midpoint - 1
      }
      bounded.producer.code =
        trace.producer.kind === 'notebook' ? trace.producer.code.slice(0, low) : ''
    } else if (bounded.producer.kind === 'connector') {
      bounded.producer.arguments = { omitted: true }
    }
    const responseBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
    assertWithinResourceBudget('reviewer-session', responseBytes, limit)
    return bounded
  }

  private commitTraceResponse<T extends ArtifactTraceResult>(trace: T): T {
    const responseBytes = Buffer.byteLength(JSON.stringify(trace), 'utf8')
    assertWithinResourceBudget(
      'reviewer-session',
      this.reviewerBytesReturned + responseBytes,
      this.resourceBudget.sessionBytes
    )
    this.reviewerBytesReturned += responseBytes
    return trace
  }

  fileRole(id: string): 'work_product' | 'source_document' {
    if (this.sourceDocumentEvidenceByVersionId.has(id)) return 'source_document'
    if (this.scope.artifactVersionIds.includes(id)) return 'work_product'
    throw new Error(`File Version ${JSON.stringify(id)} is not in this turn's scope.`)
  }

  private commitStructuredResponse(
    content: StructuredArtifactContent,
    limit: number
  ): StructuredArtifactContent {
    const bounded = structuredClone(content)
    let responseBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
    if (responseBytes > limit) {
      bounded.limitations.push({
        kind: 'budget-exhausted',
        subjectId: bounded.id,
        detail: 'Requested structured content exceeded the Reviewer read budget.'
      })
      bounded.partial = true
      while (responseBytes > limit && bounded.kind === 'spreadsheet') {
        const sheet = [...bounded.sheets].reverse().find((candidate) => candidate.rows.length > 0)
        if (!sheet) break
        sheet.rows.pop()
        responseBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
      }
      while (responseBytes > limit && bounded.kind === 'paged' && bounded.media?.length) {
        bounded.media.pop()
        responseBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
      }
      while (responseBytes > limit && bounded.kind === 'paged') {
        const page = bounded.pages.at(-1)
        if (!page) break
        if (page.text.length > 0) page.text = page.text.slice(0, Math.floor(page.text.length / 2))
        else bounded.pages.pop()
        responseBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
      }
      if (bounded.kind === 'spreadsheet') {
        const returnedRows = bounded.sheets.flatMap((sheet) =>
          sheet.rows.map((row) => row.rowNumber)
        )
        if (returnedRows.length > 0) {
          bounded.targets.rowStart = Math.min(...returnedRows)
          bounded.targets.rowEnd = Math.max(...returnedRows)
        } else {
          delete bounded.targets.rowStart
          delete bounded.targets.rowEnd
        }
      } else if (bounded.kind === 'paged') {
        bounded.targets.pages = [
          ...new Set([
            ...bounded.pages.map((page) => page.pageNumber),
            ...(bounded.media ?? []).map((media) => media.pageNumber)
          ])
        ]
      }
    }
    responseBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8')
    assertWithinResourceBudget('reviewer-session', responseBytes, limit)
    assertWithinResourceBudget(
      'reviewer-session',
      this.reviewerBytesReturned + responseBytes,
      this.resourceBudget.sessionBytes
    )
    this.reviewerBytesReturned += responseBytes
    return bounded
  }

  private async readPreviewPagedContent(
    id: string,
    path: string,
    filename: string,
    format: 'pdf' | 'docx' | 'pptx',
    pages: number[],
    includePreview: boolean,
    maxBytes: number,
    verification: ArtifactVerification,
    signal?: AbortSignal
  ): Promise<Extract<StructuredArtifactContent, { kind: 'paged' }>> {
    if (!this.resolvePagedContent) {
      return {
        id,
        role: 'work_product',
        kind: 'paged',
        format,
        targets: { pages: [] },
        pageCount: 0,
        pages: [],
        partial: true,
        limitations: [
          {
            kind: 'unsupported-model-capability',
            subjectId: id,
            detail: `Rendered ${format.toUpperCase()} page preview is unavailable.`
          }
        ]
      }
    }
    let resolved: Awaited<ReturnType<ReviewerPagedContentResolver>>
    try {
      resolved = await this.resolvePagedContent({
        artifactVersionId: id,
        path,
        filename,
        format,
        pages,
        includePreview,
        maxBytes,
        verifiedObservation: verification.observation,
        verifiedChecksum: verification.checksum,
        signal
      })
    } catch (error) {
      if (signal?.aborted) throw error
      return {
        id,
        role: 'work_product',
        kind: 'paged',
        format,
        targets: { pages: [] },
        pageCount: 0,
        pages: [],
        partial: true,
        limitations: [
          {
            kind:
              error instanceof ResourceBudgetExceededError
                ? 'budget-exhausted'
                : error instanceof FileObservationMismatchError
                  ? 'checksum-mismatch'
                  : 'corrupt-content',
            subjectId: id,
            detail: `${format.toUpperCase()} preview failed: ${toErrorMessage(error)}`
          }
        ]
      }
    }
    const requestedPages = new Set(pages)
    const resolvedPages = resolved.pages.filter((page) => requestedPages.has(page.pageNumber))
    const resolvedMedia = resolved.media?.filter((media) => requestedPages.has(media.pageNumber))
    const actualPages = [
      ...new Set([
        ...resolvedPages.map((page) => page.pageNumber),
        ...(resolvedMedia ?? []).map((media) => media.pageNumber)
      ])
    ]
    const missingPages = pages.filter((page) => !actualPages.includes(page))
    return {
      id,
      role: 'work_product',
      kind: 'paged',
      format,
      targets: { pages: actualPages },
      pageCount: resolved.pageCount,
      ...(resolved.pageCountComplete !== undefined
        ? { pageCountComplete: resolved.pageCountComplete }
        : {}),
      pages: resolvedPages,
      ...(resolvedMedia ? { media: resolvedMedia } : {}),
      partial: resolved.pageCountComplete === false || actualPages.length < resolved.pageCount,
      limitations: [
        ...(resolved.limitations?.map((limitation) => ({ ...limitation })) ?? []),
        ...(resolved.pageCountComplete === false
          ? [
              {
                kind: 'truncated' as const,
                subjectId: id,
                detail: `Rendered page coverage stops after page ${resolved.pageCount}; the document contains additional pages.`
              }
            ]
          : []),
        ...(missingPages.length > 0
          ? [
              {
                kind: 'truncated' as const,
                subjectId: id,
                detail: `Rendered preview did not return requested page(s): ${missingPages.join(', ')}.`
              }
            ]
          : [])
      ]
    }
  }

  private async mergePreviewContent(
    content: Extract<StructuredArtifactContent, { kind: 'paged' }>,
    path: string,
    filename: string,
    maxBytes: number,
    verification: ArtifactVerification,
    signal?: AbortSignal
  ): Promise<Extract<StructuredArtifactContent, { kind: 'paged' }>> {
    const pages = content.targets.pages ?? content.pages.map((page) => page.pageNumber)
    if (!this.resolvePagedContent) {
      return {
        ...content,
        limitations: [
          ...content.limitations,
          {
            kind: 'unsupported-model-capability',
            subjectId: content.id,
            detail: `Rendered ${content.format.toUpperCase()} page preview is unavailable.`
          }
        ]
      }
    }
    let preview: Awaited<ReturnType<ReviewerPagedContentResolver>>
    try {
      preview = await this.resolvePagedContent({
        artifactVersionId: content.id,
        path,
        filename,
        format: content.format,
        pages,
        includePreview: true,
        maxBytes: Math.max(
          1,
          maxBytes - Buffer.byteLength(JSON.stringify(content), 'utf8') - 1_024
        ),
        verifiedObservation: verification.observation,
        verifiedChecksum: verification.checksum,
        signal
      })
    } catch (error) {
      if (signal?.aborted) throw error
      return {
        ...content,
        limitations: [
          ...content.limitations,
          {
            kind:
              error instanceof ResourceBudgetExceededError
                ? 'budget-exhausted'
                : error instanceof FileObservationMismatchError
                  ? 'checksum-mismatch'
                  : 'corrupt-content',
            subjectId: content.id,
            detail: `${content.format.toUpperCase()} preview failed: ${toErrorMessage(error)}`
          }
        ]
      }
    }
    const requestedPages = new Set(pages)
    const textByPage = new Map(content.pages.map((page) => [page.pageNumber, page.text]))
    for (const page of preview.pages.filter((candidate) =>
      requestedPages.has(candidate.pageNumber)
    )) {
      if (!textByPage.get(page.pageNumber)) textByPage.set(page.pageNumber, page.text)
    }
    const previewMedia = preview.media?.filter((media) => requestedPages.has(media.pageNumber))
    const actualPages = [
      ...new Set([...textByPage.keys(), ...(previewMedia ?? []).map((m) => m.pageNumber)])
    ]
    return {
      ...content,
      pageCount: preview.pageCount || content.pageCount,
      ...(preview.pageCountComplete !== undefined
        ? { pageCountComplete: preview.pageCountComplete }
        : {}),
      targets: { pages: actualPages },
      pages: actualPages.map((pageNumber) => ({
        pageNumber,
        text: textByPage.get(pageNumber) ?? ''
      })),
      ...(previewMedia ? { media: previewMedia } : {}),
      partial: content.partial || preview.pageCountComplete === false,
      limitations: [
        ...content.limitations,
        ...(preview.limitations?.map((limitation) => ({ ...limitation })) ?? []),
        ...(preview.pageCountComplete === false
          ? [
              {
                kind: 'truncated' as const,
                subjectId: content.id,
                detail: `Rendered page coverage stops after page ${preview.pageCount}; the document contains additional pages.`
              }
            ]
          : [])
      ]
    }
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

type StructuredFormat = 'xlsx' | 'pdf' | 'docx' | 'pptx'

const STRUCTURED_MIME_TYPES = new Map<string, StructuredFormat>([
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx']
])

const detectStructuredFormat = (mimeType?: string, path?: string): StructuredFormat | undefined => {
  const normalizedMime = mimeType?.toLowerCase().split(';')[0]?.trim()
  const byMime = normalizedMime ? STRUCTURED_MIME_TYPES.get(normalizedMime) : undefined
  if (byMime) return byMime
  const extension = path ? extname(path).toLowerCase().slice(1) : ''
  return ['xlsx', 'pdf', 'docx', 'pptx'].includes(extension)
    ? (extension as StructuredFormat)
    : undefined
}

const hasStructuredTargets = (options: ReviewerArtifactReadOptions): boolean =>
  options.pages !== undefined ||
  options.sheet !== undefined ||
  options.rowStart !== undefined ||
  options.rowEnd !== undefined ||
  options.columns !== undefined ||
  options.includePreview !== undefined

const TEXT_APPLICATION_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'image/svg+xml'
])

const isDeclaredTextContentType = (mimeType?: string): boolean => {
  const normalized = mimeType?.toLowerCase().split(';')[0]?.trim()
  return (
    normalized?.startsWith('text/') === true || TEXT_APPLICATION_MIME_TYPES.has(normalized ?? '')
  )
}

const startsWithBytes = (value: Buffer, prefix: readonly number[]): boolean =>
  value.length >= prefix.length && prefix.every((byte, index) => value[index] === byte)

// Trust file signatures, not user-controlled extensions or MIME declarations. These are the only
// raster formats the Reviewer transport admits as active MCP image content.
const detectSupportedImageMimeType = (
  sample: Buffer
): SupportedReviewerImageMimeType | undefined => {
  if (startsWithBytes(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWithBytes(sample, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  const gifHeader = sample.subarray(0, 6).toString('ascii')
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return 'image/gif'
  if (
    sample.length >= 12 &&
    sample.subarray(0, 4).toString('ascii') === 'RIFF' &&
    sample.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

const unsupportedArtifactContent = (input: {
  id: string
  role: 'work_product' | 'source_document'
  filename: string
  contentType?: string
  checksum: string
  sizeBytes: number
}): UnsupportedArtifactContent => ({
  id: input.id,
  kind: 'unsupported',
  role: input.role,
  filename: input.filename,
  ...(input.contentType ? { mimeType: input.contentType } : {}),
  checksum: input.checksum,
  sizeBytes: input.sizeBytes,
  offset: 0,
  returnedBytes: 0,
  truncated: false,
  limitations: [{ kind: 'unsupported-format', subjectId: input.id }]
})

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

    def read_artifact(self, artifact_id, view=None, pages=None, offset=None, max_bytes=None,
                      sheet=None, row_start=None, row_end=None, columns=None, include_preview=None):
        """Return artifact content for an artifact belonging to this turn.

        For tabular artifacts (CSV, TSV) returns:
          {'kind': 'tabular', 'id': ..., 'columns': {'col': [values]}, 'rowCount': N}
        where each column is addressable by name — no visual row-alignment needed.

        XLSX accepts exact sheet, row_start/row_end, and column-letter targets. PDF/DOCX/PPTX
        accept exact 1-based pages (slides for PPTX). A partial targeted response is sufficient
        when those targets fully cover the claim.

        Text returns bounded UTF-8. Supported images are available only through the MCP image
        content transport. Other binary formats return bounded metadata and a typed limitation;
        binary bytes are never embedded in this JSON compatibility response.
        """
        params = {"id": artifact_id}
        optional = {
            "view": view, "pages": pages, "offset": offset, "maxBytes": max_bytes,
            "sheet": sheet, "rowStart": row_start, "rowEnd": row_end, "columns": columns,
            "includePreview": include_preview
        }
        params.update({key: value for key, value in optional.items() if value is not None})
        return self._call("read_artifact", params)

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
