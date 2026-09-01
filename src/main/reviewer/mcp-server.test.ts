// Tests for the reviewer MCP server's check-to-scope mapping. The key invariant (design.md:114):
// a check's locator.contentHash must agree with the referenced frozen scope block, and out-of-scope
// or stale locators are rejected.
//
// v2 (issue 12): submit_findings accepts checks[] (status pass|warn|fail) not findings[]+severity.
// summary is no longer accepted (strict schema). Pass checks may omit their locator.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { request as httpRequest } from 'node:http'
import { describe, it, expect, vi } from 'vitest'

import {
  mapChecksToScope,
  submitFindingsInputSchema,
  validateReviewerEvidenceAccess,
  ReviewerMcpServer,
  serializeReviewerEvidenceCoverage
} from './mcp-server'
import { REVIEWER_BRIDGE_NAMESPACED_TOOLS } from './bridge-tools'
import { createReviewerMcpStdioProxy } from './mcp-stdio-proxy'
import type { ReviewCheck, TurnScope } from '../../shared/reviewer'
import type {
  ArtifactContent,
  ExecRecord,
  MediaArtifactContent,
  OrderedBlock,
  ReviewerHostServer
} from './host-sdk'
import { fetchOverSocket } from '../local-rpc-transport'
import { ResourceBudgetExceededError } from '../resource-budget'

const scope: TurnScope = {
  turnMessageId: 'msg-2',
  blocks: [
    {
      id: 'message:msg-2',
      kind: 'message',
      sourceId: 'msg-2',
      blockIndex: 0,
      contentHash: 'real-hash-msg-2'
    },
    {
      id: 'activity:act-9',
      kind: 'activity',
      sourceId: 'act-9',
      blockIndex: 1,
      contentHash: 'real-hash-act-9'
    }
  ],
  artifactVersionIds: ['artifact-csv']
}

type ReviewerEvidence = Pick<
  ReviewerHostServer,
  'readTurn' | 'queryExecutionLog' | 'readArtifact'
> & { fileRole: ReviewerHostServer['fileRole'] }

const createReviewerEvidence = (): ReviewerEvidence => ({
  fileRole: vi.fn(() => 'work_product' as const),
  readTurn: vi.fn<() => OrderedBlock[]>().mockReturnValue([
    {
      blockIndex: 0,
      id: 'message:msg-2',
      kind: 'message',
      sourceId: 'msg-2',
      contentHash: 'real-hash-msg-2',
      role: 'agent',
      content: '42 results'
    },
    {
      blockIndex: 1,
      id: 'activity:act-9',
      kind: 'activity',
      sourceId: 'act-9',
      contentHash: 'real-hash-act-9',
      title: 'analysis',
      status: 'completed'
    }
  ]),
  queryExecutionLog: vi
    .fn<(activityId?: string) => ExecRecord[]>()
    .mockReturnValue([
      { activityId: 'act-9', title: 'analysis', status: 'completed', terminalExitCode: 0 }
    ]),
  readArtifact: vi.fn<(id: string) => Promise<ArtifactContent>>().mockResolvedValue({
    id: 'artifact-csv',
    role: 'work_product',
    kind: 'tabular',
    columns: { value: ['42'] },
    rowCount: 1
  })
})

const passingCheck = {
  status: 'pass' as const,
  claim: 'The audited turn is supported',
  evidence: 'The frozen turn content was read and verified.'
}

const expectMcpMetadataByteFree = (text: string | undefined, forbiddenBytes: Buffer): unknown => {
  expect(text).toBeTruthy()
  expect(text).not.toContain(forbiddenBytes.toString('base64'))
  expect(text).not.toContain('"type":"Buffer"')
  expect(text).not.toContain('"data"')
  const parsed = JSON.parse(text ?? 'null') as unknown
  expect(parsed).not.toHaveProperty('data')
  return parsed
}

describe('mapChecksToScope', () => {
  it('rejects a locator whose contentHash is stale or hallucinated', () => {
    expect(() =>
      mapChecksToScope(
        [
          {
            status: 'fail',
            claim: 'wrong count',
            evidence: 'block 0 says 32',
            locator: {
              blockRef: { messageId: 'msg-2', blockIndex: 0 },
              contentHash: 'model-supplied-garbage'
            }
          }
        ],
        scope
      )
    ).toThrow(/content hash.*does not match/i)
  })

  it('resolves the block by blockIndex for activity references too', () => {
    const mapped = mapChecksToScope(
      [
        {
          status: 'warn',
          claim: 'suspicious tool call',
          evidence: 'act-9',
          locator: {
            blockRef: { activityId: 'act-9', blockIndex: 1 },
            contentHash: 'real-hash-act-9'
          }
        }
      ],
      scope
    )

    expect(mapped[0]!.locator!.contentHash).toBe('real-hash-act-9')
  })

  it('rejects a locator whose blockIndex is not in scope', () => {
    expect(() =>
      mapChecksToScope(
        [
          {
            status: 'fail',
            claim: 'out of range',
            evidence: 'x',
            locator: { blockRef: { blockIndex: 99 }, contentHash: 'x' }
          }
        ],
        scope
      )
    ).toThrow(/not in the turn scope/i)
  })

  it('back-fills the blockRef id from the scope block, overwriting a wrong model-supplied id', () => {
    const mapped = mapChecksToScope(
      [
        {
          status: 'fail',
          claim: 'mismatched id',
          evidence: 'x',
          // blockIndex 0 is msg-2, but the model claims a different (hallucinated) id.
          locator: {
            blockRef: { messageId: 'msg-999', blockIndex: 0 },
            contentHash: 'real-hash-msg-2'
          }
        }
      ],
      scope
    )

    // The stored id is corrected to the real block at index 0, not the model's msg-999.
    expect(mapped[0]!.locator!.blockRef.messageId).toBe('msg-2')
    expect(mapped[0]!.locator!.blockRef.activityId).toBeUndefined()
    expect(mapped[0]!.locator!.contentHash).toBe('real-hash-msg-2')
  })

  it('back-fills activityId (not messageId) for activity blocks', () => {
    const mapped = mapChecksToScope(
      [
        {
          status: 'warn',
          claim: 'suspicious tool call',
          evidence: 'act-9',
          // Model mislabels an activity block as a message; the id kind is corrected from the block.
          locator: {
            blockRef: { messageId: 'act-9', blockIndex: 1 },
            contentHash: 'real-hash-act-9'
          }
        }
      ],
      scope
    )

    expect(mapped[0]!.locator!.blockRef.activityId).toBe('act-9')
    expect(mapped[0]!.locator!.blockRef.messageId).toBeUndefined()
  })

  it('preserves sortIndex as submission order', () => {
    const mapped = mapChecksToScope(
      [
        {
          status: 'warn',
          claim: 'a',
          evidence: 'a',
          locator: { blockRef: { blockIndex: 1 }, contentHash: 'real-hash-act-9' }
        },
        {
          status: 'fail',
          claim: 'b',
          evidence: 'b',
          locator: { blockRef: { blockIndex: 0 }, contentHash: 'real-hash-msg-2' }
        }
      ],
      scope
    )

    expect(mapped.map((c) => c.sortIndex)).toEqual([0, 1])
    expect(mapped[0]!.locator!.contentHash).toBe('real-hash-act-9')
    expect(mapped[1]!.locator!.contentHash).toBe('real-hash-msg-2')
  })

  it('accepts a pass check without a locator', () => {
    const mapped = mapChecksToScope(
      [
        {
          status: 'pass',
          claim: 'row count verified',
          evidence: 'counted 33 rows from artifact-csv; agent reported 33'
          // no locator — valid for pass checks
        }
      ],
      scope
    )

    expect(mapped).toHaveLength(1)
    expect(mapped[0]!.status).toBe('pass')
    expect(mapped[0]!.locator).toBeUndefined()
  })
})

describe('submitFindingsInputSchema — v3 unified checks[] (no reasoning)', () => {
  it('leaves the bridge item count to the per-run MCP schema', () => {
    const submitFindingsTool = REVIEWER_BRIDGE_NAMESPACED_TOOLS.find(
      (tool) => tool.name === 'submit_findings'
    )
    const checksSchema = (
      submitFindingsTool?.parameters as {
        properties?: { checks?: { minItems?: number; maxItems?: number } }
      }
    ).properties?.checks

    expect(checksSchema?.minItems).toBeUndefined()
    expect(checksSchema?.maxItems).toBeUndefined()
  })

  it('does not tell initial bridge reviewers to manufacture a pass check', () => {
    const submitFindingsTool = REVIEWER_BRIDGE_NAMESPACED_TOOLS.find(
      (tool) => tool.name === 'submit_findings'
    )

    expect(submitFindingsTool?.description).not.toMatch(
      /at least one|empty checks array is invalid/i
    )
    expect(submitFindingsTool?.description).toMatch(/initial.*no checkable claims.*empty checks/i)
  })

  it('accepts checks[] with status pass|warn|fail (no reasoning field)', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [
        {
          status: 'pass',
          claim: 'row count matches',
          evidence: 'counted 33 rows from artifact; agent reported 33'
        },
        {
          status: 'warn',
          claim: 'unit label inconsistency',
          evidence: 'block 0 uses mg/L, block 2 uses mmol/L',
          locator: { blockRef: { blockIndex: 0 }, contentHash: 'abc' }
        },
        {
          status: 'fail',
          claim: 'count contradicts tool output',
          evidence: 'agent said 42 but tool output shows 0',
          locator: { blockRef: { blockIndex: 1 }, contentHash: 'def' }
        }
      ]
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.checks).toHaveLength(3)
      expect(parsed.data.checks[0]!.status).toBe('pass')
      expect(parsed.data.checks[1]!.status).toBe('warn')
      expect(parsed.data.checks[2]!.status).toBe('fail')
      // v3: no reasoning field
      expect('reasoning' in parsed.data).toBe(false)
    }
  })

  it('rejects a reasoning field (v3: reasoning no longer accepted)', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [],
      reasoning: 'This should now be rejected'
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts an empty checks array for an initial Review', () => {
    const parsed = submitFindingsInputSchema.safeParse({ checks: [] })
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown status values (inconclusive no longer valid)', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [{ status: 'inconclusive', claim: 'x', evidence: 'y' }]
    })
    expect(parsed.success).toBe(false)
  })

  it('requires status, claim, and evidence on every check', () => {
    for (const check of [
      { claim: 'missing status', evidence: 'evidence' },
      { status: 'pass', evidence: 'missing claim' },
      { status: 'pass', claim: 'missing evidence' }
    ]) {
      expect(submitFindingsInputSchema.safeParse({ checks: [check] }).success).toBe(false)
    }
  })

  it('requires a locator for warn and fail checks', () => {
    for (const status of ['warn', 'fail'] as const) {
      const parsed = submitFindingsInputSchema.safeParse({
        checks: [{ status, claim: 'unsupported claim', evidence: 'contradiction found' }]
      })
      expect(parsed.success).toBe(false)
    }
  })

  it('rejects a summary field (v2 no longer accepts summary)', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [],
      summary: 'No issues found.'
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects the old findings[] field (strict schema)', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      findings: [
        {
          severity: 'fail',
          claim: 'x',
          evidence: 'y',
          locator: { blockRef: { blockIndex: 0 }, contentHash: 'h' }
        }
      ],
      checks: []
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts pass check without a locator', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [
        {
          status: 'pass',
          claim: 'verified row count',
          evidence: 'counted 33 rows'
          // no locator — valid for pass
        }
      ]
    })

    expect(parsed.success).toBe(true)
  })

  it('locator validates a warn check', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [
        {
          status: 'warn',
          claim: 'unit label mismatch',
          evidence: 'blocks differ',
          locator: {
            blockRef: { messageId: 'msg-2', blockIndex: 1 },
            contentHash: 'deadbeef'
          }
        }
      ]
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const check = parsed.data.checks[0]!
      expect(check.status).toBe('warn')
      expect(check.locator?.blockRef.blockIndex).toBe(1)
      expect(check.locator?.contentHash).toBe('deadbeef')
    }
  })
})

describe('validateReviewerEvidenceAccess', () => {
  it('rejects checks submitted without reading the frozen turn', () => {
    const checks = submitFindingsInputSchema.parse({
      checks: [{ status: 'pass', claim: 'turn is correct', evidence: 'looks correct' }]
    }).checks

    expect(() =>
      validateReviewerEvidenceAccess(checks, scope, {
        turnRead: false,
        allExecutionLogsRead: false,
        executionLogActivityIds: new Set(),
        artifactVersionIds: new Set()
      })
    ).toThrow(/must read the frozen turn/i)
  })

  it('does not let an Artifact or execution-log read replace the frozen turn read', () => {
    const checks = submitFindingsInputSchema.parse({
      checks: [{ status: 'pass', claim: 'turn is correct', evidence: 'artifact looks correct' }]
    }).checks

    for (const access of [
      {
        turnRead: false,
        allExecutionLogsRead: true,
        executionLogActivityIds: new Set<string>(),
        artifactVersionIds: new Set<string>()
      },
      {
        turnRead: false,
        allExecutionLogsRead: false,
        executionLogActivityIds: new Set<string>(),
        artifactVersionIds: new Set(['artifact-csv'])
      }
    ]) {
      expect(() => validateReviewerEvidenceAccess(checks, scope, access)).toThrow(
        /must read the frozen turn/i
      )
    }
  })

  it('requires the referenced activity execution log to have been read', () => {
    const checks = submitFindingsInputSchema.parse({
      checks: [
        {
          status: 'warn',
          claim: 'activity output is incomplete',
          evidence: 'the command stopped early',
          locator: {
            blockRef: { blockIndex: 1 },
            contentHash: 'real-hash-act-9'
          }
        }
      ]
    }).checks

    expect(() =>
      validateReviewerEvidenceAccess(checks, scope, {
        turnRead: true,
        allExecutionLogsRead: false,
        executionLogActivityIds: new Set(),
        artifactVersionIds: new Set()
      })
    ).toThrow(/execution log.*was not read/i)
  })

  it('requires the exact Artifact Version to have been read before it can be bound', () => {
    const checks = submitFindingsInputSchema.parse({
      checks: [
        {
          status: 'pass',
          claim: 'artifact row count matches',
          evidence: 'counted one row',
          artifactVersionId: 'artifact-csv'
        }
      ]
    }).checks

    expect(() =>
      validateReviewerEvidenceAccess(checks, scope, {
        turnRead: true,
        allExecutionLogsRead: false,
        executionLogActivityIds: new Set(),
        artifactVersionIds: new Set()
      })
    ).toThrow(/artifact.*was not read/i)
    expect(() =>
      validateReviewerEvidenceAccess(checks, scope, {
        turnRead: true,
        allExecutionLogsRead: false,
        executionLogActivityIds: new Set(),
        artifactVersionIds: new Set(['artifact-csv'])
      })
    ).not.toThrow()
  })
})

// The real MCP HTTP client (used by the reviewer ACP session) opens a GET SSE stream after
// initialize. A prior bug re-created a transport and re-connected the shared McpServer for every
// GET, throwing "Already connected to a transport" as an unhandledRejection and breaking the tool
// channel. This exercises the full initialize → GET → tool-call flow against a live server.
describe('ReviewerMcpServer HTTP transport', () => {
  const MCP_ACCEPT = 'application/json, text/event-stream'

  const parseSse = (body: string): { result?: unknown; error?: { message?: string } } => {
    const dataLine = body.split('\n').find((line) => line.startsWith('data:'))
    const json = dataLine ? dataLine.slice('data:'.length).trim() : body.trim()
    return json ? JSON.parse(json) : {}
  }

  const initialize = async (
    endpoint: string,
    token: string
  ): Promise<{ sessionId: string; headers: Record<string, string> }> => {
    const headers = {
      authorization: `Bearer ${token}`,
      accept: MCP_ACCEPT,
      'content-type': 'application/json'
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' }
        }
      })
    })
    const sessionId = response.headers.get('mcp-session-id')
    expect(response.status).toBe(200)
    expect(sessionId).toBeTruthy()
    await response.text()
    await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    })
    return { sessionId: sessionId!, headers }
  }

  const callTool = async (
    endpoint: string,
    sessionId: string,
    headers: Record<string, string>,
    name: string,
    args: Record<string, unknown>,
    id = 2
  ): Promise<{
    result?: {
      content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
      isError?: boolean
    }
  }> => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
    expect(response.status).toBe(200)
    return parseSse(await response.text()) as {
      result?: {
        content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
        isError?: boolean
      }
    }
  }

  it('bounds declared and chunked HTTP bodies while accepting the exact request limit', async () => {
    const evidence = createReviewerEvidence()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'budget-test', version: '1.0' }
      }
    })
    const server = new ReviewerMcpServer(scope, onSubmit, evidence, 'initial', [], {
      requestBytes: Buffer.byteLength(initializeBody)
    })
    const { endpoint, token } = await server.start()
    const headers = {
      authorization: `Bearer ${token}`,
      accept: MCP_ACCEPT,
      'content-type': 'application/json'
    }

    try {
      const declared = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: `${initializeBody} `
      })
      expect(declared.status).toBe(413)
      expect(declared.headers.get('connection')).toBe('close')

      const chunked = await new Promise<{
        status: number | undefined
        connection: string | undefined
      }>((resolve, reject) => {
        const request = httpRequest(endpoint, { method: 'POST', headers }, (response) => {
          response.resume()
          response.once('end', () =>
            resolve({ status: response.statusCode, connection: response.headers.connection })
          )
        })
        request.once('error', reject)
        request.write(initializeBody)
        request.end(' ')
      })
      expect(chunked).toEqual({ status: 413, connection: 'close' })
      expect(evidence.readTurn).not.toHaveBeenCalled()
      expect(onSubmit).not.toHaveBeenCalled()

      const exact = await fetch(endpoint, { method: 'POST', headers, body: initializeBody })
      expect(exact.status).toBe(200)
      expect(exact.headers.get('mcp-session-id')).toBeTruthy()
      await exact.text()
    } finally {
      await server.stop()
    }
  })

  it('reuses the session transport for the GET SSE stream and still serves tool calls', async () => {
    const server = new ReviewerMcpServer(
      scope,
      async () => undefined,
      createReviewerEvidence(),
      'initial'
    )
    const { endpoint, token } = await server.start()

    const authHeaders = { authorization: `Bearer ${token}`, accept: MCP_ACCEPT }

    try {
      // 1. initialize → obtain the session id.
      const initResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0' }
          }
        })
      })
      expect(initResponse.status).toBe(200)
      const sessionId = initResponse.headers.get('mcp-session-id')
      expect(sessionId).toBeTruthy()
      await initResponse.text()

      await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': sessionId!,
          ...authHeaders
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      })

      // 2. GET opens the SSE stream carrying the session id — must reuse the transport, not 4xx/5xx.
      const controller = new AbortController()
      const sseResponse = await fetch(endpoint, {
        method: 'GET',
        headers: { 'mcp-session-id': sessionId!, ...authHeaders },
        signal: controller.signal
      })
      expect(sseResponse.status).toBe(200)
      controller.abort()
      await sseResponse.body?.cancel().catch(() => undefined)

      // 3. A tool call after the GET still works — the channel was not broken by the SSE open.
      const toolResponse = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-session-id': sessionId!,
          ...authHeaders
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'read_turn', arguments: {} }
        })
      })
      expect(toolResponse.status).toBe(200)
      const toolJson = parseSse(await toolResponse.text())
      expect(toolJson.error).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('does not emit an unhandled rejection when two initialize requests race', async () => {
    const server = new ReviewerMcpServer(
      scope,
      async () => undefined,
      createReviewerEvidence(),
      'initial',
      [],
      { command: 'unused', entryPath: 'unused', transport: 'pipe' }
    )
    const { endpoint, token } = await server.start()
    const proxyConfig = server.toAcpMcpServerConfig()
    if (!('env' in proxyConfig)) throw new Error('Expected Reviewer MCP stdio proxy config')
    const socketPath = proxyConfig.env?.find(
      (entry) => entry.name === 'OPEN_SCIENCE_REVIEWER_MCP_SOCKET_PATH'
    )?.value
    if (!socketPath) throw new Error('Expected Reviewer MCP named-pipe path')
    const socketFetch = fetchOverSocket(socketPath)
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)

    const headers = {
      authorization: `Bearer ${token}`,
      accept: MCP_ACCEPT,
      'content-type': 'application/json'
    }
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'racing-client', version: '1.0' }
      }
    })

    try {
      const responses = await Promise.allSettled([
        socketFetch(endpoint, {
          method: 'POST',
          headers,
          body: initializeBody,
          signal: AbortSignal.timeout(2_000)
        }),
        socketFetch(endpoint, {
          method: 'POST',
          headers,
          body: initializeBody,
          signal: AbortSignal.timeout(2_000)
        })
      ])
      await new Promise((resolve) => setImmediate(resolve))

      expect(responses.every((result) => result.status === 'fulfilled')).toBe(true)
      const fulfilledResponses = responses
        .filter(
          (result): result is PromiseFulfilledResult<Response> => result.status === 'fulfilled'
        )
        .map((result) => result.value)
      expect(fulfilledResponses.map((response) => response.status)).toEqual([200, 200])
      expect(
        new Set(fulfilledResponses.map((response) => response.headers.get('mcp-session-id'))).size
      ).toBe(2)
      expect(unhandledRejections).toEqual([])

      await Promise.all(
        fulfilledResponses.map((response) => response.body?.cancel().catch(() => undefined))
      )
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      await server.stop()
    }
  })

  it('rejects a request with an unknown mcp-session-id', async () => {
    const server = new ReviewerMcpServer(scope, async () => undefined, undefined, 'initial')
    const { endpoint, token } = await server.start()

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: MCP_ACCEPT,
          authorization: `Bearer ${token}`,
          'mcp-session-id': 'does-not-exist'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
      })
      expect(response.status).toBe(400)
      await response.text()
    } finally {
      await server.stop()
    }
  })

  it('exposes evidence only through the scope-bounded reviewer MCP tools', async () => {
    const evidence = createReviewerEvidence()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, evidence, 'initial', [], {
      supportsImageInput: true
    })
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const turn = await callTool(endpoint, sessionId, headers, 'read_turn', {})
      const execution = await callTool(
        endpoint,
        sessionId,
        headers,
        'query_execution_log',
        { activityId: 'act-9' },
        3
      )
      const artifact = await callTool(
        endpoint,
        sessionId,
        headers,
        'read_artifact',
        { id: 'artifact-csv' },
        4
      )
      const submitted = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        {
          checks: [
            {
              ...passingCheck,
              artifactVersionId: 'artifact-csv'
            }
          ]
        },
        5
      )

      expect(JSON.parse(turn.result?.content?.[0]?.text ?? 'null')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceId: 'msg-2' }),
          expect.objectContaining({ sourceId: 'act-9' })
        ])
      )
      expect(JSON.parse(execution.result?.content?.[0]?.text ?? 'null')).toEqual([
        expect.objectContaining({ activityId: 'act-9', status: 'completed' })
      ])
      expect(JSON.parse(artifact.result?.content?.[0]?.text ?? 'null')).toEqual(
        expect.objectContaining({ id: 'artifact-csv', kind: 'tabular', rowCount: 1 })
      )
      expect(evidence.queryExecutionLog).toHaveBeenCalledWith('act-9')
      expect(evidence.readArtifact).toHaveBeenCalledWith(
        'artifact-csv',
        { offset: undefined, maxBytes: undefined },
        expect.any(AbortSignal)
      )
      expect(submitted.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledOnce()
    } finally {
      await server.stop()
    }
  })

  it('withholds rendered page previews from a text-only Reviewer and records Coverage only', async () => {
    const previewBytes = Buffer.from('rendered-pdf-page')
    const previewBase64 = previewBytes.toString('base64')
    const evidence = createReviewerEvidence()
    vi.mocked(evidence.readArtifact).mockResolvedValue({
      id: 'artifact-csv',
      role: 'work_product',
      kind: 'paged',
      format: 'pdf',
      targets: { pages: [3] },
      pageCount: 8,
      pages: [{ pageNumber: 3, text: 'Target claim is 42 mg.' }],
      media: [{ pageNumber: 3, data: previewBase64, mimeType: 'image/png' }],
      partial: true,
      limitations: []
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, evidence, 'initial', [], {
      supportsImageInput: false
    })
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const response = await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        view: 'content',
        pages: [3],
        includePreview: true
      })

      expect(response.result?.content).toHaveLength(1)
      const text = response.result?.content?.[0]?.text ?? ''
      expect(text).not.toContain(previewBase64)
      expect(text).not.toContain('"data"')
      expect(JSON.parse(text)).toMatchObject({
        kind: 'paged',
        pages: [{ pageNumber: 3, text: 'Target claim is 42 mg.' }],
        media: [{ pageNumber: 3, mimeType: 'image/png' }],
        limitations: [
          expect.objectContaining({
            kind: 'unsupported-model-capability',
            subjectId: 'artifact-csv'
          })
        ]
      })
      expect(evidence.readArtifact).toHaveBeenCalledWith(
        'artifact-csv',
        expect.objectContaining({ pages: [3], includePreview: true }),
        expect.any(AbortSignal)
      )
      expect(server.evidenceCoverage.artifactReads?.get('artifact-csv')).toMatchObject({
        contentRead: true,
        mediaRead: false,
        partial: true,
        limitations: [expect.objectContaining({ kind: 'unsupported-model-capability' })]
      })

      await callTool(endpoint, sessionId, headers, 'read_turn', {}, 3)
      const submission = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        { checks: [] },
        4
      )
      expect(submission.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledWith([], scope, {})
    } finally {
      await server.stop()
    }
  })

  it.each([
    {
      name: 'preview unavailable',
      limitation: { kind: 'unsupported-model-capability' as const, subjectId: 'artifact-csv' }
    },
    {
      name: 'preview budget exhausted',
      limitation: { kind: 'budget-exhausted' as const, subjectId: 'artifact-csv' }
    }
  ])('keeps $name responses byte-free and Coverage-only', async ({ limitation }) => {
    const forbiddenBytes = Buffer.from('preview-must-not-leak').toString('base64')
    const evidence = createReviewerEvidence()
    vi.mocked(evidence.readArtifact).mockResolvedValue({
      id: 'artifact-csv',
      role: 'work_product',
      kind: 'paged',
      format: 'docx',
      targets: { pages: [1] },
      pageCount: 1,
      pages: [{ pageNumber: 1, text: '' }],
      partial: true,
      limitations: [limitation]
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, evidence, 'initial', [], {
      supportsImageInput: true
    })
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const response = await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        pages: [1],
        includePreview: true
      })
      const serialized = JSON.stringify(response)
      expect(serialized).not.toContain(forbiddenBytes)
      expect(response.result?.content).toHaveLength(1)
      expect(server.evidenceCoverage.artifactReads?.get('artifact-csv')).toMatchObject({
        mediaRead: false,
        partial: true,
        limitations: [expect.objectContaining({ kind: limitation.kind })]
      })
      await callTool(endpoint, sessionId, headers, 'read_turn', {}, 3)
      await callTool(endpoint, sessionId, headers, 'submit_findings', { checks: [] }, 4)
      expect(onSubmit).toHaveBeenCalledWith([], scope, {})
    } finally {
      await server.stop()
    }
  })

  it('retains trace/content Coverage, partial state, role, and typed limitations', async () => {
    const evidence = createReviewerEvidence()
    vi.mocked(evidence.readArtifact)
      .mockResolvedValueOnce({
        id: 'artifact-csv',
        role: 'work_product',
        file: {
          filename: 'plot.png',
          mimeType: 'image/png',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          contentStatus: 'available'
        },
        producer: { kind: 'unavailable', reason: 'producer-not-supplied' },
        limitations: [
          { kind: 'producer-unavailable', subjectId: 'artifact-csv' },
          { kind: 'truncated', subjectId: 'artifact-csv', detail: 'outputs omitted' }
        ]
      })
      .mockResolvedValueOnce({
        id: 'artifact-csv',
        role: 'work_product',
        kind: 'paged',
        format: 'pptx',
        targets: { pages: [2] },
        pageCount: 10,
        pages: [{ pageNumber: 2, text: 'targeted claim' }],
        media: [
          {
            pageNumber: 2,
            data: Buffer.from('slide-preview').toString('base64'),
            mimeType: 'image/png'
          }
        ],
        partial: true,
        limitations: []
      })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, evidence, 'initial', [], {
      supportsImageInput: true
    })
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        view: 'trace'
      })
      const contentRead = await callTool(
        endpoint,
        sessionId,
        headers,
        'read_artifact',
        { id: 'artifact-csv', view: 'content' },
        3
      )

      expect(contentRead.result?.content).toEqual([
        expect.objectContaining({
          type: 'text',
          text: expect.not.stringContaining(Buffer.from('slide-preview').toString('base64'))
        }),
        {
          type: 'image',
          data: Buffer.from('slide-preview').toString('base64'),
          mimeType: 'image/png'
        }
      ])

      expect(server.evidenceCoverage.artifactReads?.get('artifact-csv')).toEqual({
        role: 'work_product',
        traceRead: true,
        contentRead: true,
        mediaRead: true,
        partial: true,
        requestedTargets: [],
        actualTargets: [{ pages: [2] }],
        limitations: [
          { kind: 'producer-unavailable', subjectId: 'artifact-csv' },
          { kind: 'truncated', subjectId: 'artifact-csv', detail: 'outputs omitted' }
        ]
      })
      expect(
        serializeReviewerEvidenceCoverage(server.evidenceCoverage).artifactReads[0]
      ).toMatchObject({
        versionId: 'artifact-csv',
        role: 'work_product',
        traceRead: true,
        contentRead: true,
        mediaRead: true,
        requestedTargets: [],
        actualTargets: [{ pages: [2] }]
      })
    } finally {
      await server.stop()
    }
  })

  it('records Source Document reads only in Coverage without requiring a source finding field', async () => {
    const evidence = createReviewerEvidence()
    evidence.fileRole = vi.fn(() => 'source_document' as const)
    vi.mocked(evidence.readArtifact).mockResolvedValueOnce({
      id: 'source-v1',
      role: 'source_document',
      kind: 'paged',
      format: 'pdf',
      targets: { pages: [4] },
      pageCount: 8,
      pages: [{ pageNumber: 4, text: 'The reported dose is 5 mg.' }],
      partial: true,
      limitations: []
    })
    const sourceScope = { ...scope, sourceDocumentVersionIds: ['source-v1'] }
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(sourceScope, onSubmit, evidence, 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'source-v1',
        view: 'content',
        pages: [4]
      })
      const rejectedSourceBinding = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        {
          checks: [
            {
              status: 'pass',
              claim: 'The source attribution is verified',
              evidence: 'Source Version source-v1 page 4 states the reported dose is 5 mg.',
              artifactVersionId: 'source-v1'
            }
          ]
        },
        3
      )
      expect(rejectedSourceBinding.result?.isError).toBe(true)
      expect(rejectedSourceBinding.result?.content?.[0]?.text).toContain(
        'must be cited in evidence'
      )
      expect(onSubmit).not.toHaveBeenCalled()
      const submitted = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: [
          {
            status: 'pass',
            claim: 'The source attribution is verified',
            evidence: 'Source Version source-v1 page 4 states the reported dose is 5 mg.'
          }
        ]
      })

      expect(submitted.result?.isError).not.toBe(true)
      expect(server.evidenceCoverage.artifactReads?.get('source-v1')).toMatchObject({
        role: 'source_document',
        contentRead: true,
        requestedTargets: [{ pages: [4] }],
        actualTargets: [{ pages: [4] }]
      })
      expect(onSubmit.mock.calls[0]?.[0]?.[0]?.artifactVersionId).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('distinguishes retrieved contradiction, target truncation, and unavailable Source Coverage', async () => {
    const evidence = createReviewerEvidence()
    evidence.fileRole = vi.fn(() => 'source_document' as const)
    vi.mocked(evidence.readArtifact)
      .mockResolvedValueOnce({
        id: 'source-contradiction',
        role: 'source_document',
        kind: 'paged',
        format: 'pdf',
        targets: { pages: [2] },
        pageCount: 5,
        pages: [{ pageNumber: 2, text: 'The source reports 3 mg, not 5 mg.' }],
        partial: true,
        limitations: []
      })
      .mockResolvedValueOnce({
        id: 'source-truncated',
        role: 'source_document',
        kind: 'paged',
        format: 'pdf',
        targets: { pages: [] },
        pageCount: 8,
        pages: [],
        partial: true,
        limitations: [
          {
            kind: 'truncated',
            subjectId: 'source-truncated',
            detail: 'Requested page 6 was truncated.'
          }
        ]
      })
      .mockRejectedValueOnce(new Error('Source content missing from immutable storage'))
    const sourceScope = {
      ...scope,
      sourceDocumentVersionIds: ['source-contradiction', 'source-truncated', 'source-unavailable']
    }
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(sourceScope, onSubmit, evidence, 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'source-contradiction',
        pages: [2]
      })
      await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'source-truncated',
        pages: [6]
      })
      const unavailable = await callTool(
        endpoint,
        sessionId,
        headers,
        'read_artifact',
        { id: 'source-unavailable', pages: [1] },
        4
      )
      expect(unavailable.result?.isError).toBe(true)

      const submitted = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: [
          {
            status: 'fail',
            claim: 'The attributed dose contradicts the source',
            evidence: 'Source Version source-contradiction page 2 says 3 mg, not 5 mg.',
            locator: {
              blockRef: { blockIndex: 0 },
              contentHash: 'real-hash-msg-2'
            }
          },
          {
            status: 'warn',
            claim: 'The load-bearing attribution remains unverifiable',
            evidence: 'Source Version source-truncated target page 6 was genuinely truncated.',
            locator: {
              blockRef: { blockIndex: 0 },
              contentHash: 'real-hash-msg-2'
            }
          }
        ]
      })

      expect(submitted.result?.isError).not.toBe(true)
      expect(onSubmit.mock.calls[0]?.[0]).toHaveLength(2)
      expect(server.evidenceCoverage.artifactReads?.get('source-unavailable')).toMatchObject({
        role: 'source_document',
        contentRead: true,
        partial: true,
        requestedTargets: [{ pages: [1] }],
        actualTargets: [],
        limitations: [
          expect.objectContaining({ kind: 'content-missing', subjectId: 'source-unavailable' })
        ]
      })
      expect(
        onSubmit.mock.calls[0]?.[0]?.some((check: ReviewCheck) =>
          check.evidence.includes('source-unavailable')
        )
      ).toBe(false)
    } finally {
      await server.stop()
    }
  })

  it('retains normalized requested spreadsheet targets when invalid or budgeted host reads fail', async () => {
    const evidence = createReviewerEvidence()
    evidence.fileRole = vi.fn(() => 'source_document' as const)
    vi.mocked(evidence.readArtifact)
      .mockRejectedValueOnce(new Error('Requested sheet Missing was not found'))
      .mockRejectedValueOnce(
        new ResourceBudgetExceededError('reviewer-session', 3_000_000, 2_000_000)
      )
    const server = new ReviewerMcpServer(
      { ...scope, sourceDocumentVersionIds: ['source-sheet'] },
      vi.fn(),
      evidence,
      'initial'
    )
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'source-sheet',
        sheet: 'Missing',
        rowStart: 8,
        rowEnd: 10,
        columns: ['b', 'A', 'b']
      })
      await callTool(
        endpoint,
        sessionId,
        headers,
        'read_artifact',
        {
          id: 'source-sheet',
          sheet: 'Results',
          rowStart: 100,
          rowEnd: 120,
          columns: ['D', 'E']
        },
        3
      )

      expect(server.evidenceCoverage.artifactReads?.get('source-sheet')).toMatchObject({
        requestedTargets: [
          { sheet: 'Missing', rowStart: 8, rowEnd: 10, columns: ['B', 'A'] },
          { sheet: 'Results', rowStart: 100, rowEnd: 120, columns: ['D', 'E'] }
        ],
        actualTargets: [],
        partial: true,
        limitations: [
          expect.objectContaining({ kind: 'content-missing' }),
          expect.objectContaining({ kind: 'budget-exhausted' })
        ]
      })
    } finally {
      await server.stop()
    }
  })

  it('rejects oversized spreadsheet targets and non-letter columns at the MCP schema boundary', async () => {
    const evidence = createReviewerEvidence()
    const server = new ReviewerMcpServer(scope, vi.fn(), evidence, 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const hugeSpan = await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        sheet: 'Results',
        rowStart: 1,
        rowEnd: 1_001
      })
      const a1Column = await callTool(
        endpoint,
        sessionId,
        headers,
        'read_artifact',
        { id: 'artifact-csv', sheet: 'Results', columns: ['A1'] },
        3
      )

      expect(hugeSpan.result?.isError).toBe(true)
      expect(a1Column.result?.isError).toBe(true)
      expect(evidence.readArtifact).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('returns image data only as an MCP image block and records media Coverage distinctly', async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const evidence = createReviewerEvidence()
    const deliveredMedia = {
      id: 'artifact-csv',
      kind: 'media',
      delivery: 'delivered',
      role: 'work_product',
      filename: 'plot.png',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: imageBytes.length,
      offset: 0,
      returnedBytes: imageBytes.length,
      truncated: false,
      limitations: [],
      data: imageBytes
    } satisfies MediaArtifactContent
    ;(deliveredMedia as MediaArtifactContent & Record<string, unknown>).bytes = imageBytes
    vi.mocked(evidence.readArtifact).mockResolvedValue(deliveredMedia)
    const server = new ReviewerMcpServer(
      scope,
      vi.fn().mockResolvedValue(undefined),
      evidence,
      'initial',
      [],
      { supportsImageInput: true }
    )
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const response = await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        view: 'content'
      })
      const [metadata, image] = response.result?.content ?? []
      expect(expectMcpMetadataByteFree(metadata?.text, imageBytes)).toMatchObject({
        kind: 'media',
        delivery: 'delivered',
        filename: 'plot.png',
        mimeType: 'image/png'
      })
      expect(metadata?.text).not.toContain('"bytes"')
      expect(image).toEqual({
        type: 'image',
        data: imageBytes.toString('base64'),
        mimeType: 'image/png'
      })
      expect(server.evidenceCoverage.artifactReads?.get('artifact-csv')).toMatchObject({
        contentRead: true,
        mediaRead: true,
        partial: false,
        limitations: []
      })
    } finally {
      await server.stop()
    }
  })

  it('returns a typed limitation without image data for a text-only Reviewer', async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const evidence = createReviewerEvidence()
    const deliveredMedia = {
      id: 'artifact-csv',
      kind: 'media',
      delivery: 'delivered',
      role: 'work_product',
      filename: 'plot.png',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: imageBytes.length,
      offset: 0,
      returnedBytes: imageBytes.length,
      truncated: false,
      limitations: [],
      data: imageBytes
    } satisfies MediaArtifactContent
    ;(deliveredMedia as MediaArtifactContent & Record<string, unknown>).bytes = imageBytes
    vi.mocked(evidence.readArtifact).mockResolvedValue(deliveredMedia)
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, evidence, 'initial', [], {
      supportsImageInput: false
    })
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const response = await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        view: 'content'
      })
      expect(response.result?.content).toHaveLength(1)
      const metadata = expectMcpMetadataByteFree(
        response.result?.content?.[0]?.text,
        imageBytes
      ) as {
        limitations?: Array<{ kind?: string }>
        delivery?: string
      }
      expect(metadata.delivery).toBe('limited')
      expect(response.result?.content?.[0]?.text).not.toContain('"bytes"')
      expect(metadata.limitations).toContainEqual(
        expect.objectContaining({ kind: 'unsupported-model-capability' })
      )
      expect(server.evidenceCoverage.artifactReads?.get('artifact-csv')).toMatchObject({
        contentRead: true,
        mediaRead: false,
        partial: true,
        limitations: expect.arrayContaining([
          expect.objectContaining({ kind: 'unsupported-model-capability' })
        ])
      })
      await callTool(endpoint, sessionId, headers, 'read_turn', {}, 3)
      const submission = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        { checks: [] },
        4
      )
      expect(submission.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledWith([], scope, {})
    } finally {
      await server.stop()
    }
  })

  it('keeps budget-limited media metadata byte-free and emits no image block', async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const evidence = createReviewerEvidence()
    const limitedMedia = {
      id: 'artifact-csv',
      kind: 'media',
      delivery: 'limited',
      role: 'work_product',
      filename: 'large.png',
      mimeType: 'image/png',
      checksum: 'a'.repeat(64),
      sizeBytes: 4096,
      offset: 0,
      returnedBytes: 0,
      truncated: true,
      limitations: [{ kind: 'budget-exhausted' as const, subjectId: 'artifact-csv' }]
    } satisfies MediaArtifactContent
    ;(limitedMedia as MediaArtifactContent & Record<string, unknown>).data = imageBytes
    ;(limitedMedia as MediaArtifactContent & Record<string, unknown>).bytes = imageBytes
    vi.mocked(evidence.readArtifact).mockResolvedValue(limitedMedia)
    const server = new ReviewerMcpServer(
      scope,
      vi.fn().mockResolvedValue(undefined),
      evidence,
      'initial',
      [],
      { supportsImageInput: true }
    )
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const response = await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        view: 'content'
      })
      expect(response.result?.content).toHaveLength(1)
      expect(
        expectMcpMetadataByteFree(response.result?.content?.[0]?.text, imageBytes)
      ).toMatchObject({ delivery: 'limited', limitations: [{ kind: 'budget-exhausted' }] })
      expect(response.result?.content?.[0]?.text).not.toContain('"bytes"')
      expect(server.evidenceCoverage.artifactReads?.get('artifact-csv')).toMatchObject({
        mediaRead: false,
        partial: true
      })
    } finally {
      await server.stop()
    }
  })

  it('keeps unsupported opaque-binary metadata free of raw and encoded bytes', async () => {
    const opaqueBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef])
    const evidence = createReviewerEvidence()
    const unsupported = {
      id: 'artifact-csv',
      kind: 'unsupported',
      role: 'work_product',
      filename: 'archive.zip',
      mimeType: 'application/zip',
      checksum: 'b'.repeat(64),
      sizeBytes: opaqueBytes.length,
      offset: 0,
      returnedBytes: 0,
      truncated: false,
      limitations: [{ kind: 'unsupported-format' as const, subjectId: 'artifact-csv' }]
    } satisfies ArtifactContent
    vi.mocked(evidence.readArtifact).mockResolvedValue(unsupported)
    const server = new ReviewerMcpServer(
      scope,
      vi.fn().mockResolvedValue(undefined),
      evidence,
      'initial'
    )
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const response = await callTool(endpoint, sessionId, headers, 'read_artifact', {
        id: 'artifact-csv',
        view: 'content'
      })
      expect(response.result?.content).toHaveLength(1)
      const text = response.result?.content?.[0]?.text
      expect(text).not.toContain(opaqueBytes.toString('base64'))
      expect(text).not.toContain('"type":"Buffer"')
      expect(text).not.toContain('"data"')
      expect(JSON.parse(text ?? 'null')).toMatchObject({
        kind: 'unsupported',
        limitations: [{ kind: 'unsupported-format' }]
      })
    } finally {
      await server.stop()
    }
  })

  it('accepts an explicit empty initial submission only after the frozen turn was read', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, createReviewerEvidence(), 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const beforeRead = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: []
      })
      expect(beforeRead.result?.isError).toBe(true)
      expect(beforeRead.result?.content?.[0]?.text).toContain('must read the frozen turn')

      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      const accepted = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: []
      })
      expect(accepted.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledOnce()
      expect(onSubmit).toHaveBeenCalledWith([], scope, {})
    } finally {
      await server.stop()
    }
  })

  it('allows a malformed submission to be corrected before one accepted submission', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, createReviewerEvidence(), 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})

      const malformed = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: [{ status: 'pass', claim: 'The count matches' }]
      })
      expect(malformed.result?.isError).toBe(true)
      expect(malformed.result?.content?.[0]?.text).toMatch(/validation error/i)
      expect(onSubmit).not.toHaveBeenCalled()

      const accepted = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        { checks: [passingCheck] },
        3
      )
      expect(accepted.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledOnce()

      const secondAcceptedAttempt = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        { checks: [passingCheck] },
        4
      )
      expect(secondAcceptedAttempt.result?.isError).toBe(true)
      expect(secondAcceptedAttempt.result?.content?.[0]?.text).toContain('already accepted')
      expect(onSubmit).toHaveBeenCalledOnce()
    } finally {
      await server.stop()
    }
  })

  it('rejects an empty tracked re-review submission even without tracked ids', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, createReviewerEvidence(), 'tracked')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      const rejected = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: []
      })
      expect(rejected.result?.isError).toBe(true)
      expect(onSubmit).not.toHaveBeenCalled()
    } finally {
      await server.stop()
    }
  })

  it('requires exactly one stable disposition per tracked finding and rejects duplicate submission', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, createReviewerEvidence(), 'tracked', [
      'finding-1'
    ])
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      const missing = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: [passingCheck]
      })
      expect(missing.result?.isError).toBe(true)
      expect(missing.result?.content?.[0]?.text).toContain('Missing disposition')
      expect(server.submissionAttempted).toBe(true)

      const duplicatedDisposition = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        {
          checks: [
            {
              sourceFindingId: 'finding-1',
              status: 'pass',
              claim: 'First disposition',
              evidence: 'First verification'
            },
            {
              sourceFindingId: 'finding-1',
              status: 'pass',
              claim: 'Second disposition',
              evidence: 'Second verification'
            }
          ]
        },
        3
      )
      expect(duplicatedDisposition.result?.isError).toBe(true)
      expect(duplicatedDisposition.result?.content?.[0]?.text).toContain('Duplicate disposition')

      const unknown = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        {
          checks: [
            {
              sourceFindingId: 'invented-finding',
              status: 'pass',
              claim: 'Invented identity',
              evidence: 'Not a tracked finding'
            }
          ]
        },
        4
      )
      expect(unknown.result?.isError).toBe(true)
      expect(unknown.result?.content?.[0]?.text).toContain('Unknown sourceFindingId')

      const valid = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        {
          checks: [
            {
              sourceFindingId: 'finding-1',
              status: 'fail',
              claim: 'Paraphrased description of the same unresolved defect',
              evidence: 'The corrected output is still contradictory',
              locator: { blockRef: { blockIndex: 0 }, contentHash: 'real-hash-msg-2' }
            }
          ]
        },
        5
      )
      expect(valid.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(onSubmit.mock.calls[0]?.[0]?.[0]).toMatchObject({
        sourceFindingId: 'finding-1',
        claim: 'Paraphrased description of the same unresolved defect'
      })

      const duplicate = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        {
          checks: [
            {
              sourceFindingId: 'finding-1',
              status: 'pass',
              claim: 'Resolved',
              evidence: 'Verified'
            }
          ]
        },
        6
      )
      expect(duplicate.result?.isError).toBe(true)
      expect(duplicate.result?.content?.[0]?.text).toContain('already called')
      expect(onSubmit).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('allows historical tracked dispositions beyond the five-new-check limit', async () => {
    const trackedFindingIds = Array.from({ length: 6 }, (_, index) => `finding-${index + 1}`)
    const trackedChecks = trackedFindingIds.map((sourceFindingId, index) => ({
      sourceFindingId,
      status: 'pass' as const,
      claim: `Tracked finding ${index + 1} is resolved`,
      evidence: `Verified tracked finding ${index + 1}`
    }))
    const runSubmission = async (
      checks: Array<Record<string, unknown>>
    ): Promise<{
      result: Awaited<ReturnType<typeof callTool>>
      onSubmit: ReturnType<typeof vi.fn>
    }> => {
      const onSubmit = vi.fn().mockResolvedValue(undefined)
      const server = new ReviewerMcpServer(
        scope,
        onSubmit,
        createReviewerEvidence(),
        'tracked',
        trackedFindingIds
      )
      const { endpoint, token } = await server.start()

      try {
        const { sessionId, headers } = await initialize(endpoint, token)
        await callTool(endpoint, sessionId, headers, 'read_turn', {})
        const result = await callTool(endpoint, sessionId, headers, 'submit_findings', { checks })
        return { result, onSubmit }
      } finally {
        await server.stop()
      }
    }

    const accepted = await runSubmission(trackedChecks)
    expect(accepted.result.result?.isError).not.toBe(true)
    expect(accepted.onSubmit).toHaveBeenCalledOnce()
    expect(accepted.onSubmit.mock.calls[0]?.[0]).toHaveLength(6)

    const tooManyNewChecks = Array.from({ length: 6 }, (_, index) => ({
      ...passingCheck,
      claim: `New finding ${index + 1}`,
      evidence: `New evidence ${index + 1}`
    }))
    const rejected = await runSubmission([...trackedChecks, ...tooManyNewChecks])
    expect(rejected.result.result?.isError).toBe(true)
    expect(rejected.onSubmit).not.toHaveBeenCalled()
  })

  it('drops a model-invented sourceFindingId during an initial review', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, createReviewerEvidence(), 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      const result = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: [
          {
            sourceFindingId: 'review-r-sine-plot-execution',
            status: 'pass',
            claim: 'The plotted curve matches the executed code',
            evidence: 'The execution block evaluates sin(x) over one period.'
          }
        ]
      })

      expect(result.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledOnce()
      expect(onSubmit.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({
          sourceFindingId: undefined,
          claim: 'The plotted curve matches the executed code'
        })
      ])
    } finally {
      await server.stop()
    }
  })

  it('accepts exactly one of two concurrent submit_findings calls', async () => {
    let submissionsStarted = 0
    let releaseSubmission: (() => void) | undefined
    const submissionGate = new Promise<void>((resolve) => {
      releaseSubmission = resolve
    })
    const releaseTimer = setTimeout(() => releaseSubmission?.(), 100)
    const onSubmit = vi.fn(async () => {
      submissionsStarted++
      if (submissionsStarted === 2) releaseSubmission?.()
      await submissionGate
    })
    const server = new ReviewerMcpServer(scope, onSubmit, createReviewerEvidence(), 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      const calls = await Promise.all([
        callTool(endpoint, sessionId, headers, 'submit_findings', { checks: [passingCheck] }, 2),
        callTool(endpoint, sessionId, headers, 'submit_findings', { checks: [passingCheck] }, 3)
      ])

      expect(calls.map((call) => call.result?.isError === true).sort()).toEqual([false, true])
      expect(calls.find((call) => call.result?.isError)?.result?.content?.[0]?.text).toContain(
        'already called'
      )
      expect(onSubmit).toHaveBeenCalledTimes(1)
    } finally {
      clearTimeout(releaseTimer)
      releaseSubmission?.()
      await server.stop()
    }
  })

  it('allows submit_findings to retry after the submission handler fails', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('persistence failed'))
      .mockResolvedValueOnce(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, createReviewerEvidence(), 'initial')
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      await callTool(endpoint, sessionId, headers, 'read_turn', {})
      const failed = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        { checks: [passingCheck] },
        2
      )
      expect(failed.result?.isError).toBe(true)

      const retry = await callTool(
        endpoint,
        sessionId,
        headers,
        'submit_findings',
        { checks: [passingCheck] },
        3
      )
      expect(retry.result?.isError).not.toBe(true)
      expect(onSubmit).toHaveBeenCalledTimes(2)
    } finally {
      await server.stop()
    }
  })

  it('rejects submit_findings with a summary field (schema-level validation)', async () => {
    // The MCP SDK may strip unknown fields before passing to the handler, but the schema
    // itself rejects summary. Verify at the schema level (the HTTP transport test for this
    // would be inconclusive since the SDK may strip the field in transit).
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [],
      summary: 'This should be rejected'
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.message).toMatch(/unrecognized_keys|Unrecognized key/i)
    }
  })
})

describe('ReviewerMcpServer named-pipe proxy', () => {
  it('lists and calls the existing scoped tools through stdio without loopback TCP', async () => {
    const evidence = createReviewerEvidence()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, evidence, 'initial', [], {
      command: 'C:\\Open Science.exe',
      entryPath: 'C:\\app\\main.js',
      transport: 'pipe'
    })
    await server.start()

    const config = server.toAcpMcpServerConfig()
    if ('type' in config) throw new Error('Expected Reviewer stdio proxy config.')
    const environment = Object.fromEntries(
      (config.env ?? []).map((entry) => [entry.name, entry.value])
    )
    expect(config.args).toEqual(['C:\\app\\main.js', '--open-science-reviewer-mcp-proxy'])

    const proxy = await createReviewerMcpStdioProxy({
      socketPath: environment.OPEN_SCIENCE_REVIEWER_MCP_SOCKET_PATH!,
      token: environment.OPEN_SCIENCE_REVIEWER_MCP_TOKEN!
    })
    const client = new Client({ name: 'reviewer-proxy-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    try {
      await Promise.all([proxy.connect(serverTransport), client.connect(clientTransport)])
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'read_turn',
        'query_execution_log',
        'read_artifact',
        'submit_findings'
      ])

      const turn = await client.callTool({ name: 'read_turn', arguments: {} })
      expect(turn.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('42 results') })
      ])
      await client.callTool({
        name: 'submit_findings',
        arguments: { checks: [passingCheck] }
      })
      expect(onSubmit).toHaveBeenCalledOnce()
    } finally {
      await client.close()
      await proxy.close()
      await server.stop()
    }
  })
})
