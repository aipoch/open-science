// In-process HTTP MCP server that exposes `submit_findings` to the reviewer ACP session.
// Uses the MCP Streamable HTTP transport so the agent connects via URL (McpServerHttp).
// The server is created per review run and shut down after the reviewer session disposes.
//
// v2 (issue 12): submit_findings now accepts a single `checks[]` array with status pass|warn|fail.
// The old `findings[]` + `summary` + `checks[]` split is gone. `summary` is rejected.
// A pass check without a locator is accepted; a warn/fail check should have a locator.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { McpServer as ModelContextProtocolServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

import type { McpServer } from '@agentclientprotocol/sdk'

import type { NewCheck, TurnScope } from '../../shared/reviewer'
import { assertBlockInScope } from './host-sdk'
import { createLogger } from '../logger'

const REVIEWER_MCP_SERVER_NAME = 'open-science-reviewer'

const log = createLogger('reviewer:mcp')

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

// Zod schema for one unified check submitted by the reviewer.
// status: pass = verified and ok; warn = minor issue; fail = serious issue.
// locator is optional — pass checks may omit it; warn/fail checks should include it.
const checkSchema = z.object({
  status: z
    .enum(['pass', 'warn', 'fail'])
    .describe(
      'pass = verified and ok; warn = minor issue that does not invalidate the result; ' +
        'fail = serious issue that requires correction. No inconclusive — use warn when uncertain.'
    ),
  claim: z.string().min(1).describe('The specific claim or thing being checked'),
  evidence: z
    .string()
    .min(1)
    .describe(
      'Supporting evidence from the turn (cite block ids / exec-log entries / artifact content you read). ' +
        'For pass checks: describe what you verified and why it passed. ' +
        'For warn/fail: describe the contradiction found.'
    ),
  locator: checkLocatorSchema
    .optional()
    .describe(
      'Block-level locator for the claim being checked. Required for warn/fail; optional for pass.'
    ),
  artifactVersionId: z
    .string()
    .optional()
    .describe('If this check relates to an artifact, its version id')
})

// The top-level submit_findings input schema.
// v2: a single `checks[]` replaces the old findings[]+summary+checks[] split.
// v3: reasoning removed — the reviewer log is captured from the action stream, not self-authored.
// summary is explicitly excluded — the panel no longer shows it.
export const submitFindingsInputSchema = z
  .object({
    checks: z
      .array(checkSchema)
      .describe(
        'All checks you ran, each with status pass|warn|fail, claim, evidence, and optional locator. ' +
          'Pass an empty array if you ran no checks (treat as pass).'
      )
  })
  .strict() // Reject unknown fields including the old `summary`, old `findings`, and old `reasoning`

export type SubmitFindingsInput = z.infer<typeof submitFindingsInputSchema>

// The reviewer-supplied report (v3: no reasoning — captured from action stream instead).
export type SubmitFindingsReport = Record<string, never>

// Maps model-submitted checks onto the turn scope, enforcing the single-sourcing contract
// (design.md:114): for checks that carry a locator, the model supplies only blockIndex as the
// pointer; the block is resolved from scope.blocks, out-of-scope indices are rejected, and the
// locator's blockRef id (messageId / activityId) AND contentHash are both back-filled from the scope
// block — never trusted from model input. Pass checks without a locator are accepted as-is.
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

    // Reconstruct the blockRef id from the block itself so a hallucinated/stale id can't be stored.
    const blockRef =
      block.kind === 'message'
        ? { messageId: block.sourceId, blockIndex }
        : { activityId: block.sourceId, blockIndex }

    return {
      status: c.status,
      claim: c.claim,
      evidence: c.evidence,
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
  private readonly mcpServer: ModelContextProtocolServer
  private readonly httpServer: ReturnType<typeof createServer>
  private readonly token: string
  private _endpoint: string | undefined
  private readonly transports = new Map<string, StreamableHTTPServerTransport>()

  constructor(
    private readonly scope: TurnScope,
    private readonly onSubmitFindings: SubmitFindingsHandler
  ) {
    this.token = randomUUID()
    this.mcpServer = this.buildMcpServer()
    this.httpServer = createServer((req, res) => {
      void this.handleHttpRequest(req, res)
    })
  }

  // Starts the HTTP MCP server on a random port and returns its URL + auth token.
  async start(): Promise<{ endpoint: string; token: string }> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.listen(0, '127.0.0.1', () => resolve())
      this.httpServer.once('error', reject)
    })

    const addr = this.httpServer.address() as { port: number }
    this._endpoint = `http://127.0.0.1:${addr.port}/mcp`

    log.info('reviewer MCP server started', { endpoint: this._endpoint })

    return { endpoint: this._endpoint, token: this.token }
  }

  // Stops the HTTP server; called after the reviewer session is disposed.
  async stop(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close().catch(() => undefined)
    }
    this.transports.clear()

    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()))

    log.info('reviewer MCP server stopped')
  }

  // Returns the ACP McpServer config (HTTP type) to pass to buildSession.
  toAcpMcpServerConfig(): McpServer {
    if (!this._endpoint) throw new Error('ReviewerMcpServer not started')

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

    server.registerTool(
      'submit_findings',
      {
        title: 'Submit review checks',
        description:
          'Submit your structured review checks. Call this exactly once, then stop. ' +
          'Pass an empty checks array if you ran no checks. ' +
          'Each check has status (pass/warn/fail), claim, evidence, and optional locator. ' +
          'Do NOT include a reasoning or summary field — they are no longer accepted.',
        inputSchema: submitFindingsInputSchema.shape
      },
      async (input) => {
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

        // Back-fill each locator's contentHash from its scope block and reject out-of-scope
        // locators (design.md:114 single-sourcing contract). A bad locator is a validation error.
        let newChecks: NewCheck[]
        try {
          newChecks = mapChecksToScope(parsed.checks, this.scope)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('submit_findings locator out of scope', { error: message })
          return {
            content: [{ type: 'text', text: `Validation error: ${message}` }],
            isError: true
          }
        }

        await this.onSubmitFindings(newChecks, this.scope, {})

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

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Verify bearer token.
    const authHeader = req.headers['authorization'] ?? ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (bearer !== this.token) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined

    let transport: StreamableHTTPServerTransport

    if (sessionId && this.transports.has(sessionId)) {
      // Established session: every follow-up request (POST messages, GET SSE stream, DELETE) carries
      // the mcp-session-id, so reuse its transport. Crucially the GET that opens the SSE stream lands
      // here — connecting a second transport to the shared McpServer would throw "Already connected".
      transport = this.transports.get(sessionId)!
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
      await this.mcpServer.connect(transport)
    } else {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad Request: missing or unknown mcp-session-id' }))
      return
    }

    await transport.handleRequest(req, res)
  }
}
