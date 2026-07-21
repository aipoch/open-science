// Integration tests for the Phase 3 locked re-review fix loop.
//
// Asserts the loop/persistence contract (no LLM judgement):
// - Exactly N [Auditor] injections for N rounds.
// - Resolution transitions: resolved / open / unaddressed.
// - reflagCount increment on over-correction (same claim fails again).
// - Cap termination at 3 rounds (remaining warn/fail set to unaddressed).
// - All-pass on re-review ends the loop cleanly (resolved).
// - Each iteration writes a distinct Review row sharing the original turnMessageId.
// - correction.ts no longer hardcodes unaddressed; resolutions come from re-review.
//
// Pattern: stubbed ACP session per orchestrator.test.ts / correction.test.ts (issue 02/05 pattern).

import * as acp from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AcpRuntime } from '../acp/runtime'
import { ReviewRepository } from './repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { runReview } from './orchestrator'
import type { PersistedChatSession, PersistedChatMessage } from '../../shared/session-persistence'

// ---------------------------------------------------------------------------
// FakeAgentProcess
// ---------------------------------------------------------------------------

class FakeAgentProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }
}

const asAgentProcess = (p: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  p as unknown as ChildProcessWithoutNullStreams

// ---------------------------------------------------------------------------
// MCP helpers (from orchestrator.test.ts)
// ---------------------------------------------------------------------------

const MCP_ACCEPT = 'application/json, text/event-stream'

const parseMcpSseBody = (body: string): { result?: unknown; error?: { message?: string } } => {
  const dataLine = body.split('\n').find((line) => line.startsWith('data:'))
  const json = dataLine ? dataLine.slice('data:'.length).trim() : body.trim()
  return json ? (JSON.parse(json) as { result?: unknown; error?: { message?: string } }) : {}
}

const callSubmitFindings = async (
  mcpBaseUrl: string,
  token: string,
  checks: Array<{
    status: 'pass' | 'warn' | 'fail'
    claim: string
    evidence: string
    sourceFindingId?: string
    locator?: {
      blockRef: { messageId?: string; activityId?: string; blockIndex: number }
      contentHash: string
    }
  }>
): Promise<void> => {
  const initResponse = await fetch(mcpBaseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
      authorization: `Bearer ${token}`
    },
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

  if (!initResponse.ok) throw new Error(`MCP initialize failed: ${initResponse.status}`)

  const initJson = parseMcpSseBody(await initResponse.text())
  const sessionId = initResponse.headers.get('mcp-session-id')
  if (!sessionId || !initJson.result) throw new Error('MCP initialize did not return a session id')

  await fetch(mcpBaseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  })

  const toolResponse = await fetch(mcpBaseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
      authorization: `Bearer ${token}`,
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'submit_findings', arguments: { checks } }
    })
  })

  if (!toolResponse.ok) throw new Error(`submit_findings call failed: ${toolResponse.status}`)
  const toolJson = parseMcpSseBody(await toolResponse.text())
  if (toolJson.error) {
    throw new Error(`submit_findings returned an error: ${toolJson.error.message ?? 'unknown'}`)
  }
}

// ---------------------------------------------------------------------------
// Fake ACP agent — handles both reviewer sessions and main-session prompts.
//
// The agent maintains a round counter. On the first call it submits the initial
// warn/fail findings. On each subsequent correction prompt, it records that call.
// On each re-review session spawned after the correction, the providedReReviewChecks
// array (indexed by round) supplies what the re-reviewer submits.
// ---------------------------------------------------------------------------

type ReReviewChecks = Array<{
  status: 'pass' | 'warn' | 'fail'
  claim: string
  evidence: string
  sourceFindingId?: string
  locator?: {
    blockRef: { messageId?: string; activityId?: string; blockIndex: number }
    contentHash: string
  }
}>

type FixLoopFakeAgentOptions = {
  reviewerSessionIdPrefix?: string // defaults to 'reviewer-session'
  mainSessionId: string
  // Checks submitted by the initial review
  initialChecks: Array<{
    status: 'warn' | 'fail'
    claim: string
    evidence: string
    locator: { blockRef: { blockIndex: number }; contentHash: string }
  }>
  // Per-round checks submitted by re-reviewer (index 0 = round 1, index 1 = round 2, ...)
  // If omitted for a round, the re-reviewer submits no findings (pass).
  reReviewChecksByRound?: ReReviewChecks[]
  // Called when a correction prompt arrives at the main session
  onCorrectionPrompt?: (text: string, round: number) => void
}

type FixLoopAgentState = {
  // List of session IDs created (all kinds)
  sessions: Array<{ sessionId: string; mcpServers: unknown[]; cwd: string }>
  // Prompts received per session
  promptsReceived: Map<string, string[]>
  // Corrected-session message counter (for generating stable IDs in fake sessions)
  correctionCount: number
}

// Shared mutable session data — simulates the session JSON being updated when
// the main agent receives prompts. The test populates this after each correction.
type SharedSessionData = {
  getSession: () => PersistedChatSession
}

const startFixLoopFakeAgent = (
  process: FakeAgentProcess,
  options: FixLoopFakeAgentOptions,
  sessionData: SharedSessionData
): FixLoopAgentState => {
  const state: FixLoopAgentState = {
    sessions: [],
    promptsReceived: new Map(),
    correctionCount: 0
  }

  // Track how many reviewer sessions have been started (to index re-review rounds).
  let reviewerSessionCount = 0

  acp
    .agent({ name: 'fix-loop-test-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      const mcpServers = (ctx.params.mcpServers ?? []) as Array<{ type?: string }>
      const isReviewer = mcpServers.some((s) => s.type === 'http')

      let sessionId: string
      if (isReviewer) {
        reviewerSessionCount++
        sessionId = `${options.reviewerSessionIdPrefix ?? 'reviewer-session'}-${reviewerSessionCount}`
      } else {
        sessionId = options.mainSessionId
      }

      state.sessions.push({
        sessionId,
        mcpServers: ctx.params.mcpServers ?? [],
        cwd: ctx.params.cwd
      })

      return { sessionId }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt
        .map((block: ContentBlock) => (block.type === 'text' ? block.text : ''))
        .join('')

      const existing = state.promptsReceived.get(ctx.params.sessionId) ?? []
      existing.push(text)
      state.promptsReceived.set(ctx.params.sessionId, existing)

      // Reviewer sessions have IDs starting with the configured prefix.
      const prefix = options.reviewerSessionIdPrefix ?? 'reviewer-session'
      const isReviewerSession = ctx.params.sessionId.startsWith(prefix)

      if (isReviewerSession) {
        // This is a reviewer session prompt — submit findings based on which review round it is.
        const roundIndex = reviewerSessionCount - 1 // 0-based index of re-review rounds
        const sessionRecord = state.sessions[state.sessions.length - 1]
        const mcpServers = sessionRecord?.mcpServers ?? []
        const reviewerMcp = (
          mcpServers as Array<{
            type?: string
            url?: string
            headers?: Array<{ name: string; value: string }>
          }>
        ).find((s) => s.type === 'http')

        if (reviewerMcp?.url) {
          const token =
            reviewerMcp.headers
              ?.find((h) => h.name === 'authorization')
              ?.value?.replace('Bearer ', '') ?? ''

          if (roundIndex === 0) {
            // Initial review: submit the initial checks
            await callSubmitFindings(reviewerMcp.url, token, options.initialChecks)
          } else {
            // Re-review round (roundIndex >= 1): use re-review checks for this round
            const reReviewRoundIndex = roundIndex - 1
            const trackedFindingIds = [...text.matchAll(/"sourceFindingId":"([^"]+)"/g)].map(
              (match) => match[1]!
            )
            const reReviewChecks = (options.reReviewChecksByRound?.[reReviewRoundIndex] ?? []).map(
              (check, index) => ({
                ...check,
                sourceFindingId: check.sourceFindingId ?? trackedFindingIds[index]
              })
            )
            await callSubmitFindings(reviewerMcp.url, token, reReviewChecks)
          }
        }
      } else {
        // This is a main-session correction prompt
        state.correctionCount++
        options.onCorrectionPrompt?.(text, state.correctionCount)

        // Simulate the session JSON being updated with a new agent correction message.
        // The fix loop needs to reload the session to see new messages after the correction.
        // In the real app, the session JSON is updated by the ACP runtime's handleSessionUpdate.
        // In tests, we update the shared session data here.
        const correctionMsgId = `correction-msg-${state.correctionCount}`
        const auditorMsgId = `auditor-msg-${state.correctionCount}`
        const currentMsgs = sessionData.getSession().messages
        // Add: [Auditor] user message + agent correction response
        const updatedSession: PersistedChatSession = {
          ...sessionData.getSession(),
          messages: [
            ...currentMsgs,
            {
              id: auditorMsgId,
              role: 'user',
              content: text,
              status: 'complete',
              eventIds: [],
              createdAt: Date.now(),
              updatedAt: Date.now()
            } satisfies PersistedChatMessage,
            {
              id: correctionMsgId,
              role: 'agent',
              content: 'I have corrected the issue.',
              status: 'complete',
              eventIds: [],
              createdAt: Date.now() + 1,
              updatedAt: Date.now() + 1
            } satisfies PersistedChatMessage
          ]
        }
        // Mutate through the shared object so the getSession callback sees updates
        Object.assign(sessionData, { _session: updatedSession })
      }

      // Emit a reply chunk and stop.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}-${Date.now()}`,
          content: { type: 'text', text: 'OK.' }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onRequest(acp.methods.agent.session.close, () => ({}))
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return state
}

// ---------------------------------------------------------------------------
// Session fixture helpers
// ---------------------------------------------------------------------------

const makeSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
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
      updatedAt: 1000
    },
    {
      id: 'msg-2',
      role: 'agent',
      content: 'I ran the analysis and found 42 results.',
      status: 'complete',
      eventIds: [],
      createdAt: 2000,
      updatedAt: 2000
    }
  ],
  createdAt: 900,
  updatedAt: 2000,
  ...overrides
})

// Creates a shared session data object whose getSession() returns the latest session state.
const makeSharedSession = (
  initial: PersistedChatSession
): SharedSessionData & { _session: PersistedChatSession } => {
  const shared = {
    _session: initial,
    getSession(): PersistedChatSession {
      return shared._session
    }
  }
  return shared
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let temporaryRoot: string | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'reviewer-fix-loop-test-'))
})

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('fix loop: all-pass on re-review ends the loop (resolved)', () => {
  it('resolves all checks when re-review passes; exactly 1 [Auditor] injection for 1 round', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())

    const correctionPrompts: string[] = []

    const agentState = startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'fail',
            claim: 'Agent claimed 42 results',
            evidence: 'Tool output shows 0 results',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc123' }
          }
        ],
        // Re-review round 1: all pass
        reReviewChecksByRound: [
          [
            {
              status: 'pass',
              claim: 'Agent claimed 42 results',
              evidence: 'Correction confirmed: results now correct'
            }
          ]
        ],
        onCorrectionPrompt: (text) => {
          correctionPrompts.push(text)
        }
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => shared.getSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1'
    })

    // Exactly 1 [Auditor] injection for 1 round.
    expect(correctionPrompts).toHaveLength(1)
    expect(correctionPrompts[0]).toMatch(/\[Auditor\]/)

    // Exactly 2 reviewer sessions: initial + 1 re-review.
    const reviewerSessions = agentState.sessions.filter((s) =>
      s.sessionId.startsWith('reviewer-session')
    )
    expect(reviewerSessions).toHaveLength(2)

    // The original review's warn/fail check must now be resolved.
    const reviews = await repository.getReviewsForSession('session-1')
    // 2 Review rows: initial + re-review
    expect(reviews.length).toBeGreaterThanOrEqual(2)

    // The initial review (original turnMessageId = msg-2) should have resolution = resolved.
    const initialReview = reviews.find((r) =>
      r.checks.some((c) => c.claim === 'Agent claimed 42 results' && c.resolution === 'resolved')
    )
    expect(initialReview).toBeDefined()

    await client.$disconnect()
  })

  it('waits for a complete correction message before starting re-review', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())
    let correctionPolls = 0

    startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'fail',
            claim: 'Agent claimed 42 results',
            evidence: 'Tool output shows 0 results',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc123' }
          }
        ],
        reReviewChecksByRound: [
          [
            {
              status: 'pass',
              claim: 'Agent claimed 42 results',
              evidence: 'Correction confirmed: results now correct'
            }
          ]
        ]
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => {
        const session = shared.getSession()
        const correction = session.messages.find((message) => message.id === 'correction-msg-1')
        if (!correction) return session

        correctionPolls++
        if (correctionPolls > 1) return session

        return {
          ...session,
          messages: session.messages.map((message) =>
            message.id === correction.id
              ? { ...message, status: 'error', content: 'Partial correction was interrupted.' }
              : message
          )
        }
      },
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1'
    })

    expect(correctionPolls).toBeGreaterThanOrEqual(2)
    const reviews = await repository.getReviewsForSession('session-1')
    expect(
      reviews.some((review) =>
        review.checks.some(
          (check) => check.claim === 'Agent claimed 42 results' && check.resolution === 'resolved'
        )
      )
    ).toBe(true)

    await client.$disconnect()
  })
})

describe('fix loop: cancellation', () => {
  it('stops before the first correction round when cancelled as the loop starts', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())
    const correctionPrompts: string[] = []
    const abortController = new AbortController()
    const onFixLoopStart = vi.fn(() => abortController.abort())
    const onFixLoopEnd = vi.fn()

    const agentState = startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'fail',
            claim: 'Agent claimed 42 results',
            evidence: 'Tool output shows 0 results',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc123' }
          }
        ],
        onCorrectionPrompt: (text) => correctionPrompts.push(text)
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => shared.getSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1',
      onCorrectionPrompt: (text) => correctionPrompts.push(text),
      onFixLoopStart,
      onFixLoopEnd,
      fixLoopAbortSignal: abortController.signal
    })

    expect(onFixLoopStart).toHaveBeenCalledTimes(1)
    expect(onFixLoopEnd).toHaveBeenCalledTimes(1)
    expect(correctionPrompts).toEqual([])
    expect(
      agentState.sessions.filter((session) => session.sessionId.startsWith('reviewer-session'))
    ).toHaveLength(1)
    expect(review.checks[0]?.resolution).toBe('open')

    await client.$disconnect()
  })
})

describe('fix loop: newly discovered issues remain in the automatic remediation loop', () => {
  it('carries a new re-review finding into the next round and resolves it by its own id', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())
    const correctionPrompts: string[] = []

    const agentState = startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'fail',
            claim: 'Original incorrect result',
            evidence: 'The first output is contradictory',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'original' }
          }
        ],
        reReviewChecksByRound: [
          [
            {
              status: 'pass',
              claim: 'Original result is fixed',
              evidence: 'The correction now matches the record'
            },
            {
              status: 'fail',
              claim: 'Correction introduced a new unit error',
              evidence: 'The corrected value is labeled with the wrong unit',
              locator: { blockRef: { blockIndex: 1 }, contentHash: 'new-issue' }
            }
          ],
          [
            {
              status: 'pass',
              claim: 'The newly introduced unit error is fixed',
              evidence: 'The value and unit now agree'
            }
          ]
        ],
        onCorrectionPrompt: (text) => correctionPrompts.push(text)
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => shared.getSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1'
    })

    expect(correctionPrompts).toHaveLength(2)
    expect(
      agentState.sessions.filter((session) => session.sessionId.startsWith('reviewer-session'))
    ).toHaveLength(3)
    const checks = (await repository.getReviewsForSession('session-1')).flatMap(
      (review) => review.checks
    )
    expect(checks.find((check) => check.claim === 'Original incorrect result')?.resolution).toBe(
      'resolved'
    )
    expect(
      checks.find((check) => check.claim === 'Correction introduced a new unit error')?.resolution
    ).toBe('resolved')

    await client.$disconnect()
  })
})

describe('fix loop: cap at 3 rounds → unaddressed', () => {
  it('stops after 3 rounds; remaining warn/fail set to unaddressed; exactly 3 injections', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())

    const correctionPrompts: string[] = []

    const agentState = startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'fail',
            claim: 'Persistent issue',
            evidence: 'Not fixed',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
          }
        ],
        // All 3 re-review rounds still have warn/fail (never passes)
        reReviewChecksByRound: [
          [
            {
              status: 'fail',
              claim: 'Persistent issue',
              evidence: 'Still not fixed in round 1',
              locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
            }
          ],
          [
            {
              status: 'fail',
              claim: 'Persistent issue',
              evidence: 'Still not fixed in round 2',
              locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
            }
          ],
          [
            {
              status: 'fail',
              claim: 'Persistent issue',
              evidence: 'Still not fixed in round 3',
              locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
            }
          ]
        ],
        onCorrectionPrompt: (text) => {
          correctionPrompts.push(text)
        }
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => shared.getSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1'
    })

    // Exactly 3 [Auditor] injections.
    expect(correctionPrompts).toHaveLength(3)

    // 4 reviewer sessions: initial + 3 re-reviews.
    const reviewerSessions = agentState.sessions.filter((s) =>
      s.sessionId.startsWith('reviewer-session')
    )
    expect(reviewerSessions).toHaveLength(4)

    // The initial review's check must be unaddressed (cap reached).
    const reviews = await repository.getReviewsForSession('session-1')
    const hasUnaddressed = reviews.some((r) =>
      r.checks.some((c) => c.claim === 'Persistent issue' && c.resolution === 'unaddressed')
    )
    expect(hasUnaddressed).toBe(true)

    await client.$disconnect()
  })
})

describe('fix loop: stable finding identity survives reviewer paraphrases', () => {
  it('increments reflagCount instead of resolving when the same issue is reworded', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())

    startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'fail',
            claim: 'Value should be 42',
            evidence: 'Tool shows 0',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
          }
        ],
        // Round 1: the reviewer describes the same tracked issue with different wording.
        reReviewChecksByRound: [
          [
            {
              status: 'fail',
              claim: 'The corrected value is still not the expected forty-two',
              evidence: 'Now shows 100 — over-corrected',
              locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc2' }
            }
          ],
          // Round 2: passes
          [
            {
              status: 'pass',
              claim: 'The value now matches the expected result',
              evidence: 'Now correct'
            }
          ]
        ]
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => shared.getSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1'
    })

    // The original claim's reflagCount should be 1 (re-flagged once).
    const reviews = await repository.getReviewsForSession('session-1')
    const allChecks = reviews.flatMap((r) => r.checks)
    const claimChecks = allChecks.filter((c) => c.claim === 'Value should be 42')
    const hasReflagged = claimChecks.some((c) => c.reflagCount >= 1)
    expect(hasReflagged).toBe(true)

    await client.$disconnect()
  })
})

describe('fix loop: claim left unchanged stays open', () => {
  it('keeps claim open (unaddressed at cap) when agent does not address it across all rounds', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())

    const sameWarnCheck = {
      status: 'warn' as const,
      claim: 'Ignored warning',
      evidence: 'No change detected',
      locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
    }

    startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'warn',
            claim: 'Ignored warning',
            evidence: 'Agent may not have addressed this',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
          }
        ],
        // All 3 re-review rounds re-flag the same claim (agent never changes it).
        reReviewChecksByRound: [[sameWarnCheck], [sameWarnCheck], [sameWarnCheck]]
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => shared.getSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1'
    })

    // When the agent never addresses the claim, the loop hits the cap and marks it unaddressed.
    // The claim should NOT be resolved.
    const reviews = await repository.getReviewsForSession('session-1')
    const allChecks = reviews.flatMap((r) => r.checks)
    const claimChecks = allChecks.filter((c) => c.claim === 'Ignored warning')

    // Must not be resolved (agent left it unchanged → eventually unaddressed at cap).
    const hasResolved = claimChecks.some((c) => c.resolution === 'resolved')
    expect(hasResolved).toBe(false)

    // Must be unaddressed (cap reached).
    const hasUnaddressed = claimChecks.some((c) => c.resolution === 'unaddressed')
    expect(hasUnaddressed).toBe(true)

    await client.$disconnect()
  })
})

describe('fix loop: distinct Review rows per iteration', () => {
  it('writes a distinct Review row per iteration all sharing the original turnMessageId', async () => {
    const process = new FakeAgentProcess()
    const shared = makeSharedSession(makeSession())

    startFixLoopFakeAgent(
      process,
      {
        mainSessionId: 'main-session-1',
        initialChecks: [
          {
            status: 'fail',
            claim: 'Test claim',
            evidence: 'Evidence',
            locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc' }
          }
        ],
        // 2 re-review rounds: first still fails, second passes
        reReviewChecksByRound: [
          [
            {
              status: 'fail',
              claim: 'Test claim',
              evidence: 'Still failing',
              locator: { blockRef: { blockIndex: 1 }, contentHash: 'abc2' }
            }
          ],
          [
            {
              status: 'pass',
              claim: 'Test claim',
              evidence: 'Fixed in round 2'
            }
          ]
        ]
      },
      shared
    )

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => shared.getSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1'
    })

    const reviews = await repository.getReviewsForSession('session-1')

    // 3 Review rows: initial + 2 re-reviews
    expect(reviews.length).toBeGreaterThanOrEqual(3)

    // All share the same original turnMessageId.
    const allShareOriginalTurnId = reviews.every((r) => r.turnMessageId === 'msg-2')
    expect(allShareOriginalTurnId).toBe(true)

    // Each row has a distinct id.
    const ids = reviews.map((r) => r.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)

    await client.$disconnect()
  })
})
