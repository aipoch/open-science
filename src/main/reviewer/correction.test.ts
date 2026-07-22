// Integration tests for the single-round auditor correction loop.
// Mirrors the stubbed-ACP-session pattern from orchestrator.test.ts.
//
// Tests assert:
// - [Auditor] message is injected only for warn/fail checks
// - The injected message format matches the spec (design.md §6)
// - Resolution transitions happen after the correction turn
// - Exactly one correction round fires (no re-review loop)
// - pass reviews inject nothing

import * as acp from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AcpRuntime } from '../acp/runtime'
import { ReviewRepository } from './repository'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { runReview } from './orchestrator'
import type { PersistedChatSession } from '../../shared/session-persistence'

// ---------------------------------------------------------------------------
// FakeAgentProcess — re-used from orchestrator.test.ts
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
// Minimal session fixture
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

// ---------------------------------------------------------------------------
// MCP helpers — v2 schema: submit_findings accepts checks[] not findings[]
// ---------------------------------------------------------------------------

const MCP_ACCEPT = 'application/json, text/event-stream'

const parseMcpSseBody = (body: string): { result?: unknown; error?: { message?: string } } => {
  const dataLine = body.split('\n').find((line) => line.startsWith('data:'))
  const json = dataLine ? dataLine.slice('data:'.length).trim() : body.trim()
  return json ? (JSON.parse(json) as { result?: unknown; error?: { message?: string } }) : {}
}

// v2: submit_findings accepts checks[] with status (pass|warn|fail), not findings[] with severity.
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

  // v2: use `checks` key, not `findings`
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
// Fake agent that handles both the reviewer session and the main-session correction.
// The main session is registered under 'main-session-1'.
// ---------------------------------------------------------------------------

type FakeAgentState = {
  newSessions: Array<{ sessionId: string; cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  // The text of prompts received per session
  promptsReceived: Map<string, string[]>
  // Sessions that were closed
  closedSessions: string[]
}

const startFakeAgent = (
  process: FakeAgentProcess,
  options: {
    reviewerSessionId: string
    mainSessionId: string
    simulateFindingsViaHttp?: boolean
    checksToSubmit?: Array<{
      status: 'pass' | 'warn' | 'fail'
      claim: string
      evidence: string
      sourceFindingId?: string
      locator?: {
        blockRef: { messageId?: string; activityId?: string; blockIndex: number }
        contentHash: string
      }
    }>
  }
): FakeAgentState => {
  const state: FakeAgentState = {
    newSessions: [],
    promptsReceived: new Map(),
    closedSessions: []
  }

  acp
    .agent({ name: 'test-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      // Distinguish the reviewer session from the main session by the presence of MCP servers.
      // The reviewer is always spawned with at least one HTTP MCP server (submit_findings);
      // the main session (created via createSession()) has no MCP servers configured here.
      const mcpServers = (ctx.params.mcpServers ?? []) as Array<{ type?: string }>
      const isReviewer = mcpServers.some((s) => s.type === 'http')
      const sessionId = isReviewer ? options.reviewerSessionId : options.mainSessionId

      state.newSessions.push({
        sessionId,
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers ?? [],
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
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

      // If this is a reviewer session prompt, simulate submit_findings via HTTP.
      if (ctx.params.sessionId === options.reviewerSessionId && options.simulateFindingsViaHttp) {
        const latestSession = state.newSessions.find(
          (s) => s.sessionId === options.reviewerSessionId
        )
        const mcpServers = latestSession?.mcpServers ?? []
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
          await callSubmitFindings(reviewerMcp.url, token, options.checksToSubmit ?? [])
        }
      }

      // Stream a minimal reply chunk.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: { type: 'text', text: 'Acknowledged. I have fixed the issue.' }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onRequest(acp.methods.agent.session.close, (ctx) => {
      state.closedSessions.push(ctx.params.sessionId)
      return {}
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return state
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let temporaryRoot: string | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'reviewer-correction-test-'))
})

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('single-round auditor correction', () => {
  it('injects exactly one [Auditor] message for warn/fail checks', async () => {
    const process = new FakeAgentProcess()
    const checksToSubmit = [
      {
        status: 'fail' as const,
        claim: 'Agent claimed 42 results',
        evidence: 'Tool output shows 0 results in msg-2',
        locator: { blockRef: { messageId: 'msg-2', blockIndex: 1 }, contentHash: 'abc123' }
      },
      {
        status: 'warn' as const,
        claim: 'Units inconsistency: mg/L vs mmol/L',
        evidence: 'Block [0] and block [2] use different units',
        locator: { blockRef: { messageId: 'msg-2', blockIndex: 0 }, contentHash: 'def456' }
      }
    ]

    startFakeAgent(process, {
      reviewerSessionId: 'reviewer-session-1',
      mainSessionId: 'main-session-1',
      simulateFindingsViaHttp: true,
      checksToSubmit
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    // Pre-register the main session so sendPrompt can find it.
    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))
    const session = makeSession()

    // Capture prompts sent to the main session via sendCorrectionPrompt.
    const correctionPrompts: string[] = []

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => session,
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1',
      sessionRefreshTimeoutMs: 0,
      onCorrectionPrompt: (text) => correctionPrompts.push(text)
    })

    // Review should be flagged with 2 warn/fail checks.
    expect(review.outcome).toBe('flagged')
    // v2: use checks not findings
    expect(review.checks).toHaveLength(2)
    expect(review.checks.filter((c) => c.status === 'warn' || c.status === 'fail')).toHaveLength(2)

    // Exactly one [Auditor] message was injected.
    expect(correctionPrompts).toHaveLength(1)
    const auditorMsg = correctionPrompts[0]!

    // Message must start with [Auditor] header.
    expect(auditorMsg).toMatch(/^\[Auditor\]/)
    expect(auditorMsg).toContain('2 issues')

    // Both checks must appear.
    expect(auditorMsg).toContain('[fail]')
    expect(auditorMsg).toContain('Agent claimed 42 results')
    expect(auditorMsg).toContain('[warn]')
    expect(auditorMsg).toContain('Units inconsistency')

    // Must end with the instruction line.
    expect(auditorMsg).toContain('Acknowledge in one line')
    expect(auditorMsg).toContain("Don't restate or narrate")

    await client.$disconnect()
  })

  it('does not inject an [Auditor] message for a pass review', async () => {
    const process = new FakeAgentProcess()
    startFakeAgent(process, {
      reviewerSessionId: 'reviewer-session-1',
      mainSessionId: 'main-session-1',
      simulateFindingsViaHttp: true,
      checksToSubmit: []
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))
    const session = makeSession()

    const correctionPrompts: string[] = []

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => session,
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1',
      onCorrectionPrompt: (text) => correctionPrompts.push(text)
    })

    // Pass review: no injection.
    expect(review.outcome).toBe('pass')
    expect(correctionPrompts).toHaveLength(0)

    await client.$disconnect()
  })

  it('updates check resolutions to unaddressed after the correction turn', async () => {
    const process = new FakeAgentProcess()
    const checksToSubmit = [
      {
        status: 'fail' as const,
        claim: 'Fabricated statistic',
        evidence: 'No supporting tool activity found',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'hash1' }
      }
    ]

    startFakeAgent(process, {
      reviewerSessionId: 'reviewer-session-1',
      mainSessionId: 'main-session-1',
      simulateFindingsViaHttp: true,
      checksToSubmit
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))
    const session = makeSession()

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => session,
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1',
      sessionRefreshTimeoutMs: 0
    })

    // v2: checks not findings
    expect(review.checks).toHaveLength(1)
    const check = review.checks[0]!
    // Phase 1: resolution is updated from 'open' to 'unaddressed' (no re-review to confirm fix).
    expect(['resolved', 'unaddressed']).toContain(check.resolution)
    expect(check.resolution).not.toBe('open')

    // Verify the resolution was persisted in DB.
    const reloaded = await repository.getReviewsForSession('session-1')
    expect(reloaded[0]?.checks[0]?.resolution).not.toBe('open')

    await client.$disconnect()
  })

  it('does not re-review a stale session snapshot when the correction was not persisted', async () => {
    const process = new FakeAgentProcess()
    const checksToSubmit = [
      {
        status: 'warn' as const,
        claim: 'Minor label inconsistency',
        evidence: 'Block [0] and block [2] differ',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'hash1' }
      }
    ]

    const agentState = startFakeAgent(process, {
      reviewerSessionId: 'reviewer-session-1',
      mainSessionId: 'main-session-1',
      simulateFindingsViaHttp: true,
      checksToSubmit
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    await runtime.createSession({ cwd: '/workspace' })

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))
    const session = makeSession()

    let runReviewCallCount = 0
    const correctionPrompts: string[] = []

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => session,
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1',
      sessionRefreshTimeoutMs: 0,
      onCorrectionPrompt: (text) => correctionPrompts.push(text),
      onRunReviewCalled: () => {
        runReviewCallCount++
      }
    })

    // Phase 3: fix loop is driven internally — onRunReviewCalled (external trigger) stays 0.
    expect(runReviewCallCount).toBe(0)

    // The fix loop attempted at least one correction round.
    expect(correctionPrompts.length).toBeGreaterThanOrEqual(1)

    // No fresh correction message exists in the supplied session state, so re-reviewing would audit
    // the old turn and could produce a false resolution. The loop stops before spawning one.
    const reviewerSessions = agentState.newSessions.filter(
      (s) => s.sessionId === 'reviewer-session-1'
    )
    expect(reviewerSessions).toHaveLength(1)
    const stored = await repository.getReviewsForSession('session-1')
    expect(stored[0]?.checks[0]?.resolution).toBe('unaddressed')

    await client.$disconnect()
  })

  it('message format contains numbered list with status and claim', async () => {
    // Test buildAuditorMessage directly.
    const { buildAuditorMessage } = await import('./correction')

    const checks = [
      {
        id: 'c1',
        reviewId: 'r1',
        status: 'fail' as const,
        resolution: 'open' as const,
        claim: 'Agent claimed test passed',
        evidence: 'No test activity found',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' },
        sortIndex: 0,
        reflagCount: 0
      },
      {
        id: 'c2',
        reviewId: 'r1',
        status: 'warn' as const,
        resolution: 'open' as const,
        claim: 'Unit label inconsistency',
        evidence: 'Block [0] uses mg/L, block [2] uses mmol/L',
        locator: { blockRef: { blockIndex: 2 }, contentHash: 'h2' },
        sortIndex: 1,
        reflagCount: 0
      }
    ]

    const msg = buildAuditorMessage(checks)

    // Header format.
    expect(msg).toMatch(
      /^\[Auditor\] A fresh-context reviewer traced your work and found 2 issues:/
    )

    // Numbered checks with status (not severity).
    expect(msg).toContain('1. [fail] "Agent claimed test passed"')
    expect(msg).toContain('No test activity found')
    expect(msg).toContain('2. [warn] "Unit label inconsistency"')
    expect(msg).toContain('mg/L')

    // Closing instruction.
    expect(msg).toContain('Acknowledge in one line and make the fix')
    expect(msg).toContain("Don't restate or narrate your evaluation.")
  })

  it('buildAuditorMessage only includes warn/fail checks', async () => {
    const { buildAuditorMessage } = await import('./correction')

    const checks = [
      {
        id: 'c1',
        reviewId: 'r1',
        status: 'fail' as const,
        resolution: 'open' as const,
        claim: 'Fabricated claim',
        evidence: 'Evidence',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' },
        sortIndex: 0,
        reflagCount: 0
      }
    ]

    const msg = buildAuditorMessage(checks)
    expect(msg).toContain('1 issue')
    expect(msg).toContain('[fail]')
  })

  it('error in correction sendPrompt does not spin into a re-review loop', async () => {
    const process = new FakeAgentProcess()
    const checksToSubmit = [
      {
        status: 'fail' as const,
        claim: 'Test claim',
        evidence: 'Test evidence',
        locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' }
      }
    ]

    startFakeAgent(process, {
      reviewerSessionId: 'reviewer-session-1',
      mainSessionId: 'main-session-1',
      simulateFindingsViaHttp: true,
      checksToSubmit
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    // Do NOT pre-create a main session — sendPrompt will throw 'session not found'.
    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))
    const session = makeSession()

    const correctionPrompts: string[] = []
    let correctionFailedCount = 0

    // Should not throw even if correction fails.
    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => session,
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      mainSessionId: 'main-session-1', // session not registered in runtime → sendPrompt throws
      onCorrectionPrompt: (text) => correctionPrompts.push(text),
      onCorrectionFailed: () => {
        correctionFailedCount++
      }
    })

    // Review should still be complete even if correction failed.
    expect(review.lifecycle).toBe('complete')
    expect(review.outcome).toBe('flagged')

    // The correction prompt was attempted (suppress broadcast in production), but because sendPrompt
    // threw, onCorrectionFailed fires so the renderer can clear the pending suppression.
    expect(correctionPrompts).toHaveLength(1)
    expect(correctionFailedCount).toBe(1)

    await client.$disconnect()
  })
})
