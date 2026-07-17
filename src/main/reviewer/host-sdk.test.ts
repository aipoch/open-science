// Unit tests for ReviewerHostServer: covers host.read_artifact column-parsing for tabular artifacts
// (CSV/TSV), raw reads, the real managed-storage path layout, missing-file error propagation, and the
// out-of-scope rejection path.
//
// Tests start an actual ReviewerHostServer on a random port and POST to it, mirroring what the
// Python host bridge does. This exercises the full HTTP RPC layer.

import { writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ReviewerHostServer, buildReviewerHostPythonBootstrap } from './host-sdk'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { TurnScope } from '../../shared/reviewer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT = 'project-1'
// Managed artifacts are addressed by a colon-composite version id: <sessionId>:<messageId>:<filename>.
const V1 = 'session-1:msg-1:results.csv'

const makeSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: PROJECT,
  title: 'Test session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Run the analysis',
      status: 'complete',
      eventIds: [],
      createdAt: 1000,
      updatedAt: 1000,
      artifactIds: [V1]
    }
  ],
  artifacts: [
    {
      id: V1,
      kind: 'managed-file',
      path: 'results.csv',
      mimeType: 'text/csv'
    }
  ],
  createdAt: 900,
  updatedAt: 2000,
  ...overrides
})

const makeScope = (artifactVersionIds: string[] = [V1]): TurnScope => ({
  turnMessageId: 'msg-1',
  blocks: [
    {
      id: 'message:msg-1',
      kind: 'message',
      sourceId: 'msg-1',
      blockIndex: 0,
      contentHash: 'abc123'
    }
  ],
  artifactVersionIds
})

// Writes an artifact into the REAL managed layout the app uses:
// <root>/artifacts/<projectName>/<sessionId>/<messageId>/<filename>, keyed by the colon-composite
// version id <sessionId>:<messageId>:<filename>.
const writeArtifact = async (root: string, versionId: string, content: string): Promise<void> => {
  const firstColon = versionId.indexOf(':')
  const secondColon = versionId.indexOf(':', firstColon + 1)
  const sessionId = versionId.slice(0, firstColon)
  const messageId = versionId.slice(firstColon + 1, secondColon)
  const filename = versionId.slice(secondColon + 1)
  const dir = join(root, 'artifacts', PROJECT, sessionId, messageId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), content)
}

// Posts a JSON-RPC style request to the host server and returns the parsed body.
const post = async (
  endpoint: string,
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ result?: unknown; error?: string }> => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ method, params })
  })
  return response.json() as Promise<{ result?: unknown; error?: string }>
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string
let server: ReviewerHostServer
let endpoint: string
let token: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'host-sdk-test-'))
})

afterEach(async () => {
  await server?.stop().catch(() => undefined)
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// read_artifact: tabular (CSV)
// ---------------------------------------------------------------------------

describe('host.read_artifact — tabular CSV', () => {
  it('returns kind=tabular with column-addressable structure for a simple CSV', async () => {
    await writeArtifact(tmpDir, V1, 'name,value,unit\nalpha,1,mg\nbeta,2,mg\ngamma,3,mg\n')

    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: V1 })

    expect(body.result).toMatchObject({
      id: V1,
      kind: 'tabular',
      rowCount: 3,
      columns: {
        name: ['alpha', 'beta', 'gamma'],
        value: ['1', '2', '3'],
        unit: ['mg', 'mg', 'mg']
      }
    })
  })

  it('returns kind=tabular for a CSV with more than 5 columns', async () => {
    const versionId = 'session-1:msg-1:wide.csv'
    const header = 'a,b,c,d,e,f,g'
    const row1 = '1,2,3,4,5,6,7'
    const row2 = '8,9,10,11,12,13,14'
    await writeArtifact(tmpDir, versionId, `${header}\n${row1}\n${row2}\n`)

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'wide.csv', mimeType: 'text/csv' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as {
      kind: string
      rowCount: number
      columns: Record<string, string[]>
    }
    expect(result.kind).toBe('tabular')
    expect(result.rowCount).toBe(2)
    expect(Object.keys(result.columns)).toHaveLength(7)
    expect(result.columns['a']).toEqual(['1', '8'])
    expect(result.columns['g']).toEqual(['7', '14'])
  })

  it('returns kind=tabular for a TSV artifact', async () => {
    const versionId = 'session-1:msg-1:data.tsv'
    await writeArtifact(tmpDir, versionId, 'col1\tcol2\tcol3\nfoo\t10\tbar\nbaz\t20\tqux\n')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          {
            id: versionId,
            kind: 'managed-file',
            path: 'data.tsv',
            mimeType: 'text/tab-separated-values'
          }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as {
      kind: string
      rowCount: number
      columns: Record<string, string[]>
    }
    expect(result.kind).toBe('tabular')
    expect(result.rowCount).toBe(2)
    expect(result.columns['col1']).toEqual(['foo', 'baz'])
    expect(result.columns['col2']).toEqual(['10', '20'])
  })
})

// ---------------------------------------------------------------------------
// read_artifact: non-tabular (kind=raw)
// ---------------------------------------------------------------------------

describe('host.read_artifact — non-tabular', () => {
  it('returns kind=raw with content for a plain text artifact', async () => {
    const versionId = 'session-1:msg-1:report.txt'
    await writeArtifact(tmpDir, versionId, 'Hello from the artifact!')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          { id: versionId, kind: 'managed-file', path: 'report.txt', mimeType: 'text/plain' }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    expect(body.result).toMatchObject({
      id: versionId,
      kind: 'raw',
      content: 'Hello from the artifact!'
    })
  })

  it('returns kind=raw for an artifact with no mimeType (content-sniff fallback)', async () => {
    const versionId = 'session-1:msg-1:unknown.bin'
    await writeArtifact(tmpDir, versionId, 'some text content')

    // Session has no mimeType for this artifact — should fall back to raw.
    server = new ReviewerHostServer(
      makeSession({
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'unknown.bin' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as { kind: string }
    expect(result.kind).toBe('raw')
  })
})

// ---------------------------------------------------------------------------
// read_artifact: real content vs. read failure (regression: no silent-swallow)
// ---------------------------------------------------------------------------

describe('host.read_artifact — read failures are not empty content', () => {
  it('surfaces an error (not empty content) when the artifact file is missing on disk', async () => {
    // The version id is in scope, but no file was written to managed storage.
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: V1 })

    // A read failure must be an error, NOT a { kind:'raw', content:'' } success — otherwise the
    // reviewer cannot tell "could not read" from "genuinely empty".
    expect(body.result).toBeUndefined()
    expect(body.error).toBeTruthy()
    expect(body.error).toMatch(/results\.csv|read/i)
  })

  it('returns empty content WITHOUT error for a genuinely empty (0-byte) readable artifact', async () => {
    const versionId = 'session-1:msg-1:empty.txt'
    await writeArtifact(tmpDir, versionId, '')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [
          { id: versionId, kind: 'managed-file', path: 'empty.txt', mimeType: 'text/plain' }
        ]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    expect(body.error).toBeUndefined()
    expect(body.result).toMatchObject({ id: versionId, kind: 'raw', content: '' })
  })
})

// ---------------------------------------------------------------------------
// read_artifact: scope isolation — out-of-scope id rejected
// ---------------------------------------------------------------------------

describe('host.read_artifact — scope isolation', () => {
  it('rejects artifact ids not in the turn scope', async () => {
    server = new ReviewerHostServer(
      makeSession(),
      makeScope([V1]), // only V1 in scope
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    // A different version id is NOT in scope.
    const body = await post(endpoint, token, 'read_artifact', {
      id: 'session-1:msg-1:secret.csv'
    })

    expect(body.error).toMatch(/secret\.csv/)
    expect(body.error).toMatch(/not in this turn/)
  })

  it('rejects requests with an invalid bearer token', async () => {
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer bad-token'
      },
      body: JSON.stringify({ method: 'read_artifact', params: { id: V1 } })
    })

    expect(response.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// read_artifact: CSV sniffing by content when no mimeType
// ---------------------------------------------------------------------------

describe('host.read_artifact — CSV content sniffing', () => {
  it('detects CSV by comma-delimited content even without a mimeType', async () => {
    const versionId = 'session-1:msg-1:data.csv'
    // A clean CSV file but stored without a mimeType in the session artifacts.
    await writeArtifact(tmpDir, versionId, 'x,y,z\n1,2,3\n4,5,6\n')

    server = new ReviewerHostServer(
      makeSession({
        // Artifact stored without mimeType but with .csv extension in path — use extension to sniff.
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'data.csv' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as { kind: string; rowCount: number }
    expect(result.kind).toBe('tabular')
    expect(result.rowCount).toBe(2)
  })

  it('detects TSV by .tsv extension when no mimeType', async () => {
    const versionId = 'session-1:msg-1:results.tsv'
    await writeArtifact(tmpDir, versionId, 'a\tb\tc\n1\t2\t3\n')

    server = new ReviewerHostServer(
      makeSession({
        artifacts: [{ id: versionId, kind: 'managed-file', path: 'results.tsv' }]
      }),
      makeScope([versionId]),
      tmpDir
    )
    ;({ endpoint, token } = await server.start())

    const body = await post(endpoint, token, 'read_artifact', { id: versionId })

    const result = body.result as { kind: string }
    expect(result.kind).toBe('tabular')
  })
})

// ---------------------------------------------------------------------------
// read_turn / query_execution_log: surface tool I/O from toolContent
// ---------------------------------------------------------------------------

// A scope whose single block is the tool activity `act-1`.
const activityScope = (): TurnScope => ({
  turnMessageId: 'msg-1',
  blocks: [
    { id: 'activity:act-1', kind: 'activity', sourceId: 'act-1', blockIndex: 0, contentHash: 'h1' }
  ],
  artifactVersionIds: []
})

describe('host tool I/O — surfaced from toolContent', () => {
  it('surfaces tool payload text from toolContent when rawInput/rawOutput are absent', async () => {
    // Mirrors a real MCP notebook_execute activity: no rawInput/rawOutput, payload lives in toolContent.
    const session = makeSession({
      messages: [],
      activities: [
        {
          id: 'act-1',
          kind: 'tool',
          title: 'mcp__open-science-notebook__notebook_execute',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          toolContent: [
            { type: 'content', content: { type: 'text', text: '{"script":"print(6*7)"}' } }
          ]
        }
      ]
    })

    server = new ReviewerHostServer(session, activityScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    // query_execution_log exposes the payload.
    const log = await post(endpoint, token, 'query_execution_log', { activityId: 'act-1' })
    const records = log.result as Array<Record<string, unknown>>
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records[0])).toContain('print(6*7)')

    // read_turn exposes the same payload on the activity block.
    const turn = await post(endpoint, token, 'read_turn')
    const blocks = turn.result as Array<Record<string, unknown>>
    expect(JSON.stringify(blocks[0])).toContain('print(6*7)')
  })

  it('preserves existing rawInput/rawOutput/terminalOutput (no regression)', async () => {
    const session = makeSession({
      messages: [],
      activities: [
        {
          id: 'act-1',
          kind: 'tool',
          title: 'Bash',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          rawInput: { command: 'ls' },
          rawOutput: { stdout: 'file.txt' },
          terminalOutput: 'file.txt'
        }
      ]
    })

    server = new ReviewerHostServer(session, activityScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const log = await post(endpoint, token, 'query_execution_log', { activityId: 'act-1' })
    const records = log.result as Array<{
      rawInput?: unknown
      rawOutput?: unknown
      terminalOutput?: string
    }>
    expect(records[0].rawInput).toEqual({ command: 'ls' })
    expect(records[0].rawOutput).toEqual({ stdout: 'file.txt' })
    expect(records[0].terminalOutput).toBe('file.txt')
  })

  it('tolerates empty / malformed toolContent blocks without throwing', async () => {
    const session = makeSession({
      messages: [],
      activities: [
        {
          id: 'act-1',
          kind: 'tool',
          title: 'mcp__open-science-notebook__notebook_execute',
          status: 'completed',
          sortIndex: 0,
          eventIds: [],
          createdAt: 1,
          updatedAt: 2,
          toolContent: [
            {},
            { type: 'content' },
            { type: 'content', content: { type: 'text', text: 'kept-text' } }
          ]
        }
      ]
    })

    server = new ReviewerHostServer(session, activityScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    const log = await post(endpoint, token, 'query_execution_log', { activityId: 'act-1' })
    expect(log.error).toBeUndefined()
    const records = log.result as Array<Record<string, unknown>>
    expect(JSON.stringify(records[0])).toContain('kept-text')
  })
})

// ---------------------------------------------------------------------------
// host RPC — method surface discoverability
// ---------------------------------------------------------------------------

describe('host RPC — method surface', () => {
  it('answers an unknown method with an error naming the supported methods', async () => {
    server = new ReviewerHostServer(makeSession(), makeScope(), tmpDir)
    ;({ endpoint, token } = await server.start())

    // The reviewer model tends to guess methods like `list_artifacts`; the error must tell it what
    // IS available so it stops guessing.
    const body = await post(endpoint, token, 'list_artifacts')

    expect(body.result).toBeUndefined()
    expect(body.error).toMatch(/list_artifacts/)
    expect(body.error).toMatch(/read_turn/)
    expect(body.error).toMatch(/query_execution_log/)
    expect(body.error).toMatch(/read_artifact/)
  })
})

describe('buildReviewerHostPythonBootstrap — single source of the host client', () => {
  it('defines all three supported host methods and binds the endpoint/token', () => {
    const code = buildReviewerHostPythonBootstrap('http://127.0.0.1:9', 'tok-123')

    expect(code).toContain('def read_turn')
    expect(code).toContain('def query_execution_log')
    expect(code).toContain('def read_artifact')
    expect(code).toContain('http://127.0.0.1:9')
    expect(code).toContain('tok-123')
  })
})
