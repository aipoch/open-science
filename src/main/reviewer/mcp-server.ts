// In-process MCP server that exposes scope-bounded evidence reads and `submit_findings` to the
// reviewer ACP session. It is the reviewer's only approved capability. Streamable HTTP remains the
// protocol; Windows carries it over a named pipe through the stdio proxy instead of loopback TCP.
// The server is created per review run and shut down after the reviewer session disposes.
//
// v2 (issue 12): submit_findings now accepts a single `checks[]` array with status pass|warn|fail.
// The old `findings[]` + `summary` + `checks[]` split is gone. `summary` is rejected.
// A pass check without a locator is accepted; a warn/fail check requires a locator.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

import type { McpServer } from '@agentclientprotocol/sdk'

import {
  REVIEWER_MCP_SERVER_NAME,
  REVIEWER_MCP_TOOLS,
  type NewCheck,
  type TurnScope
} from '../../shared/reviewer'
import { assertBlockInScope, type ReviewerHostServer } from './host-sdk'
import { createLogger } from '../logger'
import { listenForLocalRpc, localRpcServerLogFields } from '../local-rpc-transport'
import {
  LOCAL_RESOURCE_BUDGETS,
  ResourceBudgetExceededError,
  readBoundedJsonBody
} from '../resource-budget'
import { createReviewerMcpStdioProxyConfig } from './mcp-stdio-proxy'
import {
  MAX_REVIEW_CHECKS,
  MAX_REVIEW_CLAIM_CHARACTERS,
  MAX_REVIEW_EVIDENCE_CHARACTERS,
  MAX_REVIEW_SUBMISSION_BYTES,
  reviewSubmissionByteLength
} from './submission-limits'

const log = createLogger('reviewer:mcp')

type ReviewerEvidenceAccess = Pick<
  ReviewerHostServer,
  'readTurn' | 'queryExecutionLog' | 'readArtifact'
>

// Zod schema for the optional locator on a check submitted by the reviewer.
const checkLocatorSchema = z.object({
  blockRef: z
    .object({
      messageId: z.string().optional(),
      activityId: z.string().optional(),
      blockIndex: z.number().int().min(0)
    })
    .describe('Identifies the block within the turn this check points at'),
  contentHash: z.string().describe('The contentHash of the block this check points at')
})

const checkFields = {
  claim: z
    .string()
    .min(1)
    .max(MAX_REVIEW_CLAIM_CHARACTERS)
    .describe('The specific claim or thing being checked'),
  evidence: z
    .string()
    .min(1)
    .max(MAX_REVIEW_EVIDENCE_CHARACTERS)
    .describe(
      'Supporting evidence from the turn (cite block ids / exec-log entries / artifact content you read). ' +
        'For pass checks: describe what you verified and why it passed. ' +
        'For warn/fail: describe the contradiction found.'
    ),
  sourceFindingId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable id of an original finding being re-evaluated. Required for every tracked finding ' +
        'during a fix-loop re-review; never invent or rewrite this id.'
    ),
  artifactVersionId: z
    .string()
    .optional()
    .describe('If this check relates to an artifact, its version id')
}

// The status controls the locator contract at the schema seam: pass may summarize a verified area,
// while warn/fail must identify the exact frozen block whose claim is being challenged.
const checkSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('pass').describe('Verified and supported by the audited evidence.'),
    ...checkFields,
    locator: checkLocatorSchema
      .optional()
      .describe('Optional block-level locator for a passing verification.')
  }),
  z.object({
    status: z.enum(['warn', 'fail']).describe('A warning or failure that requires exact location.'),
    ...checkFields,
    locator: checkLocatorSchema.describe(
      'Required block-level locator for the claim being warned or failed.'
    )
  })
])

// The top-level submit_findings input schema.
// v2: a single `checks[]` replaces the old findings[]+summary+checks[] split.
// v3: reasoning removed — the reviewer log is captured from the action stream, not self-authored.
// summary is explicitly excluded — the panel no longer shows it.
type SubmitFindingsObjectSchema = z.ZodObject<{
  checks: z.ZodArray<typeof checkSchema>
}>

export type SubmitFindingsInput = z.infer<SubmitFindingsObjectSchema>

const createSubmitFindingsObjectSchema = (
  trackedCheckAllowance: number | null = 0
): SubmitFindingsObjectSchema => {
  const checksSchema = z
    .array(checkSchema)
    .min(1, 'Submit at least one explicit pass, warn, or fail check.')
  const boundedChecksSchema =
    trackedCheckAllowance === null
      ? checksSchema
      : checksSchema.max(
          MAX_REVIEW_CHECKS + trackedCheckAllowance,
          `At most ${MAX_REVIEW_CHECKS} new findings are allowed beyond tracked dispositions`
        )

  return z
    .object({
      checks: boundedChecksSchema.describe(
        'All checks you ran, each with status pass|warn|fail, claim, and evidence. ' +
          'A locator is required for warn/fail and optional for pass. ' +
          'A completed review requires at least one explicit check; an empty array is never a pass.'
      )
    })
    .strict() // Reject unknown fields including the old `summary`, old `findings`, and old `reasoning`
}

const createSubmitFindingsInputSchema = (
  trackedCheckAllowance = 0
): z.ZodType<SubmitFindingsInput> =>
  createSubmitFindingsObjectSchema(trackedCheckAllowance).superRefine((input, context) => {
    const bytes = reviewSubmissionByteLength(input.checks)
    if (bytes > MAX_REVIEW_SUBMISSION_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message:
          `Reviewer result exceeds the ${MAX_REVIEW_SUBMISSION_BYTES}-byte limit ` +
          `(got ${bytes} bytes)`
      })
    }
  })

export const submitFindingsInputSchema = createSubmitFindingsInputSchema()
export const submitFindingsBridgeInputSchema = createSubmitFindingsObjectSchema(null)

export type ReviewerEvidenceAccessLedger = {
  turnRead: boolean
  allExecutionLogsRead: boolean
  executionLogActivityIds: ReadonlySet<string>
  artifactVersionIds: ReadonlySet<string>
}

export const validateReviewerEvidenceAccess = (
  checks: SubmitFindingsInput['checks'],
  scope: TurnScope,
  access: ReviewerEvidenceAccessLedger
): void => {
  if (!access.turnRead) {
    throw new Error('Reviewer must read the frozen turn before submitting checks.')
  }

  for (const check of checks) {
    if (check.locator) {
      const block = assertBlockInScope(
        scope.blocks.find((entry) => entry.blockIndex === check.locator?.blockRef.blockIndex),
        String(check.locator.blockRef.blockIndex)
      )
      if (
        block.kind === 'activity' &&
        !access.allExecutionLogsRead &&
        !access.executionLogActivityIds.has(block.sourceId)
      ) {
        throw new Error(
          `Execution log for activity ${block.sourceId} was not read before submitting its check.`
        )
      }
    }
    if (check.artifactVersionId && !access.artifactVersionIds.has(check.artifactVersionId)) {
      throw new Error(
        `Artifact Version ${check.artifactVersionId} was not read before submitting its check.`
      )
    }
  }
}

// The reviewer-supplied report (v3: no reasoning — captured from action stream instead).
export type SubmitFindingsReport = Record<string, never>

type ReviewerMcpServerOptions = {
  command?: string
  entryPath?: string
  transport?: 'tcp' | 'pipe'
  requestBytes?: number
}

// Maps model-submitted checks onto the turn scope, enforcing the single-sourcing contract
// (design.md:114): for checks that carry a locator, the model supplies only blockIndex as the
// pointer; the block is resolved from scope.blocks, out-of-scope indices are rejected, its identity
// is reconstructed from the frozen scope, and the supplied contentHash must match that frozen block.
// Pass checks without a locator are accepted as-is.
export const mapChecksToScope = (
  checks: SubmitFindingsInput['checks'],
  scope: TurnScope
): NewCheck[] =>
  checks.map((c, i) => {
    if (!c.locator) {
      // Pass check without a locator — accept as-is.
      return {
        status: c.status,
        claim: c.claim,
        evidence: c.evidence,
        sourceFindingId: c.sourceFindingId,
        locator: undefined,
        artifactVersionId: c.artifactVersionId,
        sortIndex: i
      }
    }

    const { blockIndex } = c.locator.blockRef
    const block = assertBlockInScope(
      scope.blocks.find((b) => b.blockIndex === blockIndex),
      String(blockIndex)
    )
    if (c.locator.contentHash !== block.contentHash) {
      throw new Error(
        `Locator content hash does not match frozen block ${blockIndex}: ${c.locator.contentHash}`
      )
    }

    // Reconstruct the blockRef id from the block itself so a hallucinated/stale id can't be stored.
    const blockRef =
      block.kind === 'message'
        ? { messageId: block.sourceId, blockIndex }
        : { activityId: block.sourceId, blockIndex }

    return {
      status: c.status,
      claim: c.claim,
      evidence: c.evidence,
      sourceFindingId: c.sourceFindingId,
      locator: { blockRef, contentHash: block.contentHash },
      artifactVersionId: c.artifactVersionId,
      sortIndex: i
    }
  })

/**
 * @deprecated Use mapChecksToScope
 */
export const mapFindingsToScope = mapChecksToScope

// Called by the MCP server when the reviewer calls submit_findings.
export type SubmitFindingsHandler = (
  checks: NewCheck[],
  scope: TurnScope,
  report: SubmitFindingsReport
) => Promise<void>

// The per-run reviewer MCP server: exposes submit_findings and starts/stops with the review.
export class ReviewerMcpServer {
  private readonly httpServer: ReturnType<typeof createServer>
  private readonly token: string
  private _endpoint: string | undefined
  private _socketPath: string | undefined
  private readonly transports = new Map<string, StreamableHTTPServerTransport>()
  private readonly trackedFindingIds: ReadonlySet<string>
  private readonly evidenceAccess = {
    turnRead: false,
    allExecutionLogsRead: false,
    executionLogActivityIds: new Set<string>(),
    artifactVersionIds: new Set<string>()
  }
  private findingsSubmissionAttempted = false
  private findingsSubmissionState: 'idle' | 'submitting' | 'submitted' = 'idle'

  constructor(
    private readonly scope: TurnScope,
    private readonly onSubmitFindings: SubmitFindingsHandler,
    private readonly evidence?: ReviewerEvidenceAccess,
    trackedFindingIds: readonly string[] = [],
    private readonly options: ReviewerMcpServerOptions = {}
  ) {
    this.trackedFindingIds = new Set(trackedFindingIds)
    this.token = randomUUID()
    this.httpServer = createServer((req, res) => {
      void this.handleHttpRequest(req, res).catch((error) => {
        log.error('reviewer MCP request failed', { error })
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        } else {
          res.destroy(error instanceof Error ? error : undefined)
        }
      })
    })
  }

  // Starts the MCP server on loopback TCP or a Windows named pipe.
  async start(): Promise<{ endpoint: string; token: string }> {
    const connection = await listenForLocalRpc(this.httpServer, {
      name: 'reviewer-mcp',
      transport:
        this.options.transport ??
        (this.options.command && this.options.entryPath ? undefined : 'tcp')
    })
    this._endpoint = `${connection.endpoint}/mcp`
    this._socketPath = connection.socketPath

    log.info('reviewer MCP server started', localRpcServerLogFields(this.httpServer))

    return { endpoint: this._endpoint, token: this.token }
  }

  // Stops the HTTP server; called after the reviewer session is disposed.
  async stop(): Promise<void> {
    const connection = localRpcServerLogFields(this.httpServer)
    log.info('reviewer MCP server stopping', connection)
    for (const transport of this.transports.values()) {
      await transport.close().catch(() => undefined)
    }
    this.transports.clear()

    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()))

    log.info('reviewer MCP server stopped', {
      ...connection,
      listening: this.httpServer.listening
    })
  }

  get submissionAttempted(): boolean {
    return this.findingsSubmissionAttempted
  }

  // Returns the native HTTP config, or the Windows stdio proxy config for a named pipe.
  toAcpMcpServerConfig(): McpServer {
    if (!this._endpoint) throw new Error('ReviewerMcpServer not started')

    if (this._socketPath) {
      if (!this.options.command || !this.options.entryPath) {
        throw new Error('Reviewer MCP stdio proxy launch is not configured.')
      }
      return createReviewerMcpStdioProxyConfig({
        command: this.options.command,
        entryPath: this.options.entryPath,
        socketPath: this._socketPath,
        token: this.token
      })
    }

    return {
      type: 'http' as const,
      name: REVIEWER_MCP_SERVER_NAME,
      url: this._endpoint,
      headers: [{ name: 'authorization', value: `Bearer ${this.token}` }]
    }
  }

  private buildMcpServer(): ModelContextProtocolServer {
    const server = new ModelContextProtocolServer({
      name: REVIEWER_MCP_SERVER_NAME,
      version: '1.0.0'
    })

    const trackedCheckAllowance = this.trackedFindingIds.size
    const submitFindingsObjectSchema = createSubmitFindingsObjectSchema(trackedCheckAllowance)
    const submitFindingsInputSchema = createSubmitFindingsInputSchema(trackedCheckAllowance)

    const evidence = this.evidence
    if (evidence) {
      server.registerTool(
        REVIEWER_MCP_TOOLS.readTurn,
        {
          title: 'Read audited turn',
          description:
            'Return the ordered message and tool-activity blocks in the audited turn. The server ' +
            'enforces the turn scope; no other conversation data is available.',
          inputSchema: {}
        },
        async () => {
          const turn = evidence.readTurn()
          this.evidenceAccess.turnRead = true
          return { content: [{ type: 'text', text: JSON.stringify(turn) }] }
        }
      )

      server.registerTool(
        REVIEWER_MCP_TOOLS.queryExecutionLog,
        {
          title: 'Read audited execution log',
          description:
            'Return tool input, output, terminal output, and exit codes for activities in the ' +
            'audited turn. An out-of-scope activity id is rejected.',
          inputSchema: {
            activityId: z.string().optional().describe('Optional in-scope activity id')
          }
        },
        async ({ activityId }) => {
          try {
            const executionLog = evidence.queryExecutionLog(activityId)
            if (activityId) this.evidenceAccess.executionLogActivityIds.add(activityId)
            else this.evidenceAccess.allExecutionLogsRead = true
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(executionLog)
                }
              ]
            }
          } catch (error) {
            return this.toolError(error)
          }
        }
      )

      server.registerTool(
        REVIEWER_MCP_TOOLS.readArtifact,
        {
          title: 'Read audited artifact',
          description:
            'Read one artifact attached to the audited turn. Complete CSV/TSV data is returned by ' +
            'column; paged CSV/TSV is returned as raw UTF-8 byte windows so record and quoting ' +
            'semantics are not corrupted. When truncated is true, continue from nextOffset while ' +
            'the review budget remains and report that the evidence was partial. An out-of-scope ' +
            'artifact id is rejected.',
          inputSchema: {
            id: z.string().min(1).describe('In-scope artifact version id'),
            offset: z.number().int().min(0).optional().describe('Byte offset for a bounded page'),
            maxBytes: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Requested source bytes; the host clamps this to its page limit')
          }
        },
        async ({ id, offset, maxBytes }, extra) => {
          try {
            const artifact = await evidence.readArtifact(id, { offset, maxBytes }, extra.signal)
            this.evidenceAccess.artifactVersionIds.add(id)
            return {
              content: [{ type: 'text', text: JSON.stringify(artifact) }]
            }
          } catch (error) {
            return this.toolError(error)
          }
        }
      )
    }

    server.registerTool(
      REVIEWER_MCP_TOOLS.submitFindings,
      {
        title: 'Submit review checks',
        description:
          'Submit your structured review checks. Call this exactly once, then stop. ' +
          'Submit at least one explicit check; an empty checks array is invalid. ' +
          'Each check has status (pass/warn/fail), claim, and evidence; locator is required for ' +
          'warn/fail and optional for pass. ' +
          'Do NOT include a reasoning or summary field — they are no longer accepted.',
        inputSchema: submitFindingsObjectSchema.shape
      },
      async (input) => {
        this.findingsSubmissionAttempted = true
        // Keep the idle check and the transition to `submitting` free of awaits. JavaScript's
        // run-to-completion semantics then make this a single-writer gate for concurrent tool calls.
        if (this.findingsSubmissionState !== 'idle') {
          return {
            content: [
              { type: 'text', text: 'Validation error: submit_findings was already called.' }
            ],
            isError: true
          }
        }

        let parsed: SubmitFindingsInput

        try {
          parsed = submitFindingsInputSchema.parse(input)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('submit_findings validation failed', { error: message })
          return {
            content: [{ type: 'text', text: `Validation error: ${message}` }],
            isError: true
          }
        }

        log.info('submit_findings received', { count: parsed.checks.length })

        // sourceFindingId is a correction-loop protocol field. Some reviewers still invent one on
        // an initial review; discard it there so a valid assessment is not lost to a non-semantic
        // tracking mistake. Re-reviews remain strict because their tracked ids are authoritative.
        const trackedChecks =
          this.trackedFindingIds.size === 0
            ? parsed.checks.map((check) => {
                const sanitized = { ...check }
                delete sanitized.sourceFindingId
                return sanitized
              })
            : parsed.checks
        const trackingError = this.validateTrackedDispositions(trackedChecks)
        if (trackingError) {
          log.warn('submit_findings tracking validation failed', { error: trackingError })
          return {
            content: [{ type: 'text', text: `Validation error: ${trackingError}` }],
            isError: true
          }
        }

        try {
          validateReviewerEvidenceAccess(trackedChecks, this.scope, this.evidenceAccess)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('submit_findings evidence access validation failed', { error: message })
          return {
            content: [{ type: 'text', text: `Validation error: ${message}` }],
            isError: true
          }
        }

        // Reconstruct each locator identity from its scope block, verify the supplied frozen hash,
        // and reject out-of-scope locators. A bad locator is a validation error.
        let newChecks: NewCheck[]
        try {
          newChecks = mapChecksToScope(trackedChecks, this.scope)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('submit_findings locator out of scope', { error: message })
          return {
            content: [{ type: 'text', text: `Validation error: ${message}` }],
            isError: true
          }
        }

        this.findingsSubmissionState = 'submitting'
        try {
          await this.onSubmitFindings(newChecks, this.scope, {})
          this.findingsSubmissionState = 'submitted'
        } catch (error) {
          this.findingsSubmissionState = 'idle'
          throw error
        }

        return {
          content: [
            {
              type: 'text',
              text: `checks submitted: ${newChecks.length} check(s) recorded`
            }
          ]
        }
      }
    )

    return server
  }

  // A fix-loop re-review must disposition every original finding by stable database id exactly once.
  // New issues may be submitted without sourceFindingId, but wording can never resolve or re-flag an
  // existing finding. Initial reviews reject source ids because there is nothing to track yet.
  private validateTrackedDispositions(checks: SubmitFindingsInput['checks']): string | undefined {
    const supplied = new Set<string>()

    for (const check of checks) {
      const id = check.sourceFindingId
      if (!id) continue
      if (!this.trackedFindingIds.has(id)) return `Unknown sourceFindingId ${JSON.stringify(id)}.`
      if (supplied.has(id))
        return `Duplicate disposition for sourceFindingId ${JSON.stringify(id)}.`
      supplied.add(id)
    }

    const missing = [...this.trackedFindingIds].filter((id) => !supplied.has(id))
    if (missing.length > 0) {
      return `Missing disposition for tracked finding id(s): ${missing.join(', ')}.`
    }

    return undefined
  }

  private toolError(error: unknown): {
    content: Array<{ type: 'text'; text: string }>
    isError: true
  } {
    const message = error instanceof Error ? error.message : String(error)
    return { content: [{ type: 'text', text: message }], isError: true }
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Verify bearer token.
    const authHeader = req.headers['authorization'] ?? ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (bearer !== this.token) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    let parsedBody: unknown
    if (req.method === 'POST') {
      try {
        parsedBody = await readBoundedJsonBody(
          req,
          this.options.requestBytes ?? LOCAL_RESOURCE_BUDGETS.requestBytes,
          { emptyValue: undefined }
        )
      } catch (error) {
        const exceeded = error instanceof ResourceBudgetExceededError
        if (exceeded) {
          res.shouldKeepAlive = false
          res.setHeader('connection', 'close')
          res.once('finish', () => req.destroy())
        }
        res.writeHead(exceeded ? 413 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        return
      }
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    let transport: StreamableHTTPServerTransport

    const existingTransport = sessionId ? this.transports.get(sessionId) : undefined
    if (existingTransport) {
      // Established session: every follow-up request (POST messages, GET SSE stream, DELETE) carries
      // the mcp-session-id, so reuse its transport. Crucially the GET that opens the SSE stream lands
      // here — connecting a second transport to the shared McpServer would throw "Already connected".
      transport = existingTransport
    } else if (!sessionId && req.method === 'POST') {
      // The initialize request is the only one without a session id: create the transport, register it
      // as soon as the session id is assigned, and connect the McpServer to it exactly once.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.transports.set(id, transport)
        }
      })
      transport.onclose = () => {
        if (transport.sessionId) this.transports.delete(transport.sessionId)
      }
      await this.buildMcpServer().connect(transport)
    } else {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad Request: missing or unknown mcp-session-id' }))
      return
    }

    await transport.handleRequest(req, res, parsedBody)
  }
}
