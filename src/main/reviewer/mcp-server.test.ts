// Tests for the reviewer MCP server's check-to-scope mapping. The key invariant (design.md:114):
// a check's locator.contentHash is back-filled from the referenced scope block, never trusted
// from model input, and out-of-scope locators are rejected.
//
// v2 (issue 12): submit_findings accepts checks[] (status pass|warn|fail) not findings[]+severity.
// summary is no longer accepted (strict schema). Pass checks may omit their locator.

import { describe, it, expect, vi } from 'vitest'

import { mapChecksToScope, submitFindingsInputSchema, ReviewerMcpServer } from './mcp-server'
import type { TurnScope } from '../../shared/reviewer'
import type { ArtifactContent, ExecRecord, OrderedBlock } from './host-sdk'

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

describe('mapChecksToScope', () => {
  it('back-fills contentHash from the referenced scope block, ignoring the model-supplied value', () => {
    const mapped = mapChecksToScope(
      [
        {
          status: 'fail',
          claim: 'wrong count',
          evidence: 'block 0 says 32',
          locator: {
            blockRef: { messageId: 'msg-2', blockIndex: 0 },
            // Hallucinated/stale hash supplied by the model — must be overwritten.
            contentHash: 'model-supplied-garbage'
          }
        }
      ],
      scope
    )

    expect(mapped).toHaveLength(1)
    expect(mapped[0]!.locator!.contentHash).toBe('real-hash-msg-2')
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
            contentHash: 'whatever'
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
          locator: { blockRef: { messageId: 'msg-999', blockIndex: 0 }, contentHash: 'x' }
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
          locator: { blockRef: { messageId: 'act-9', blockIndex: 1 }, contentHash: 'x' }
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
          locator: { blockRef: { blockIndex: 1 }, contentHash: 'x' }
        },
        {
          status: 'fail',
          claim: 'b',
          evidence: 'b',
          locator: { blockRef: { blockIndex: 0 }, contentHash: 'y' }
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

  it('accepts an empty checks array (pure pass)', () => {
    const parsed = submitFindingsInputSchema.safeParse({ checks: [] })
    expect(parsed.success).toBe(true)
  })

  it('rejects unknown status values (inconclusive no longer valid)', () => {
    const parsed = submitFindingsInputSchema.safeParse({
      checks: [{ status: 'inconclusive', claim: 'x', evidence: 'y' }]
    })
    expect(parsed.success).toBe(false)
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
  ): Promise<{ result?: { content?: Array<{ text?: string }>; isError?: boolean } }> => {
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
      result?: { content?: Array<{ text?: string }>; isError?: boolean }
    }
  }

  it('reuses the session transport for the GET SSE stream and still serves tool calls', async () => {
    const server = new ReviewerMcpServer(scope, async () => undefined)
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
      // v2: submit_findings uses checks[] not findings[]
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
          params: { name: 'submit_findings', arguments: { checks: [] } }
        })
      })
      expect(toolResponse.status).toBe(200)
      const toolJson = parseSse(await toolResponse.text())
      expect(toolJson.error).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  it('rejects a request with an unknown mcp-session-id', async () => {
    const server = new ReviewerMcpServer(scope, async () => undefined)
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
    const readTurn = vi.fn<() => OrderedBlock[]>().mockReturnValue([
      {
        blockIndex: 0,
        id: 'message:msg-2',
        kind: 'message',
        sourceId: 'msg-2',
        contentHash: 'real-hash-msg-2',
        role: 'agent',
        content: '42 results'
      }
    ])
    const queryExecutionLog = vi
      .fn<(activityId?: string) => ExecRecord[]>()
      .mockReturnValue([
        { activityId: 'act-9', title: 'analysis', status: 'completed', terminalExitCode: 0 }
      ])
    const readArtifact = vi.fn<(id: string) => Promise<ArtifactContent>>().mockResolvedValue({
      id: 'artifact-csv',
      kind: 'tabular',
      columns: { value: ['42'] },
      rowCount: 1
    })
    const server = new ReviewerMcpServer(scope, async () => undefined, {
      readTurn,
      queryExecutionLog,
      readArtifact
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

      expect(JSON.parse(turn.result?.content?.[0]?.text ?? 'null')).toEqual(
        readTurn.mock.results[0]?.value
      )
      expect(JSON.parse(execution.result?.content?.[0]?.text ?? 'null')).toEqual(
        queryExecutionLog.mock.results[0]?.value
      )
      expect(JSON.parse(artifact.result?.content?.[0]?.text ?? 'null')).toEqual(
        await readArtifact.mock.results[0]?.value
      )
      expect(queryExecutionLog).toHaveBeenCalledWith('act-9')
      expect(readArtifact).toHaveBeenCalledWith('artifact-csv')
    } finally {
      await server.stop()
    }
  })

  it('requires exactly one stable disposition per tracked finding and rejects duplicate submission', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const server = new ReviewerMcpServer(scope, onSubmit, undefined, ['finding-1'])
    const { endpoint, token } = await server.start()

    try {
      const { sessionId, headers } = await initialize(endpoint, token)
      const missing = await callTool(endpoint, sessionId, headers, 'submit_findings', {
        checks: []
      })
      expect(missing.result?.isError).toBe(true)
      expect(missing.result?.content?.[0]?.text).toContain('Missing disposition')

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
              locator: { blockRef: { blockIndex: 0 }, contentHash: 'ignored' }
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
