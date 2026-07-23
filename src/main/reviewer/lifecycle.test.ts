// Integration test for the reviewer app-lifecycle wiring (issue 08).
//
// This test mirrors orchestrator.test.ts and correction.test.ts but focuses on:
// 1. finishRun-style trigger → runReview → persist end-to-end
// 2. mainSessionId + model flowing from ReviewRunRequest through ipc.ts into runReview
// 3. Loop guard: [Auditor] correction fires exactly once; its stop does NOT spawn a second runReview
// 4. Session delete cascades deleteReviewsForSession; project delete cascades deleteReviewsForProject
//
// v2 (issue 12): updated to use unified checks[] model (status pass|warn|fail).

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
// FakeAgentProcess — same pattern as orchestrator.test.ts
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
// MCP HTTP helpers — v2 schema: submit_findings accepts checks[] not findings[]
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
  // v2: checks[] with status (pass|warn|fail)
  checks: Array<{
    status: 'pass' | 'warn' | 'fail'
    claim: string
    evidence: string
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
// Fake agent that handles both reviewer session and main-session correction
// ---------------------------------------------------------------------------

type FakeAgentState = {
  newSessions: Array<{ sessionId: string; cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  promptsReceived: Map<string, string[]>
  closedSessions: string[]
  // Records the outcome of any permission request the reviewer session raised (regression coverage for
  // background reviewer permission handling, including the exact allow/reject option selected).
  reviewerPermissionOutcomes: string[]
  reviewerPermissionOptionIds: Array<string | undefined>
}

const startFakeAgent = (
  process: FakeAgentProcess,
  options: {
    reviewerSessionId: string
    mainSessionId: string
    simulateFindingsViaHttp?: boolean
    // When set, the reviewer session raises a permission request before submitting findings, so the
    // test can assert the runtime auto-approves it instead of throwing "Unknown ACP session".
    requestPermissionFromReviewer?: boolean
    // v2: checks[] with status (pass|warn|fail)
    checksToSubmit?: Array<{
      status: 'pass' | 'warn' | 'fail'
      claim: string
      evidence: string
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
    closedSessions: [],
    reviewerPermissionOutcomes: [],
    reviewerPermissionOptionIds: []
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

      // A reviewer session runs unattended: exercise the runtime's auto-approval path by raising a
      // permission request from it and recording the outcome. Before the fix this threw "Unknown ACP
      // session" because reviewer sessions are intentionally not tracked in the runtime's session map.
      if (
        ctx.params.sessionId === options.reviewerSessionId &&
        options.requestPermissionFromReviewer
      ) {
        const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: 'reviewer-exec-1',
            title: 'python read_turn.py',
            kind: 'execute'
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
          ]
        })
        state.reviewerPermissionOutcomes.push(permission.outcome.outcome)
        state.reviewerPermissionOptionIds.push(
          permission.outcome.outcome === 'selected' ? permission.outcome.optionId : undefined
        )
      }

      // If this is the reviewer session, simulate submit_findings via HTTP.
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

      // Stream a minimal reply chunk then stop.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: { type: 'text', text: 'Acknowledged.' }
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
// Test suite
// ---------------------------------------------------------------------------

let temporaryRoot: string | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'reviewer-lifecycle-test-'))
})

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('reviewer app lifecycle integration', () => {
  describe('end-to-end: finishRun trigger → runReview → persist', () => {
    it('creates a review row and checks when submit_findings is called (pass review)', async () => {
      const process = new FakeAgentProcess()
      startFakeAgent(process, {
        reviewerSessionId: 'reviewer-session-1',
        mainSessionId: 'main-session-1',
        // An explicit empty submission is a valid pass.
        simulateFindingsViaHttp: true
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

      const reviewUpdates: import('../../shared/reviewer').ReviewWithChecks[] = []

      const review = await runReview({
        sessionId: 'session-1',
        turnMessageId: 'msg-2',
        projectId: 'project-1',
        model: 'claude-opus-4-5',
        getSession: () => session,
        reviewRepository: repository,
        acpRuntime: runtime,
        artifactStorageRoot: temporaryRoot!,
        onReviewUpdate: (r) => reviewUpdates.push(r)
      })

      // End-to-end: lifecycle becomes complete, outcome is pass.
      expect(review.lifecycle).toBe('complete')
      expect(review.outcome).toBe('pass')
      expect(review.model).toBe('claude-opus-4-5')
      // v2: checks (not findings)
      expect(review.checks).toHaveLength(0)

      // Persisted: reload from DB confirms the review row was written.
      const stored = await repository.getReviewsForSession('session-1')
      expect(stored).toHaveLength(1)
      expect(stored[0]?.lifecycle).toBe('complete')
      expect(stored[0]?.model).toBe('claude-opus-4-5')

      // onReviewUpdate was called (at least 'running' + 'complete').
      expect(reviewUpdates.length).toBeGreaterThanOrEqual(2)
      expect(reviewUpdates.at(-1)?.lifecycle).toBe('complete')

      await client.$disconnect()
    })

    it('rejects an out-of-scope reviewer execution request without breaking the review', async () => {
      const process = new FakeAgentProcess()
      const state = startFakeAgent(process, {
        reviewerSessionId: 'reviewer-session-1',
        mainSessionId: 'main-session-1',
        // The reviewer raises the legacy Python execution request that must now be denied.
        requestPermissionFromReviewer: true,
        simulateFindingsViaHttp: true
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
        artifactStorageRoot: temporaryRoot!
      })

      // The request is handled unattended, but the selected option is the explicit rejection.
      expect(state.reviewerPermissionOutcomes).toEqual(['selected'])
      expect(state.reviewerPermissionOptionIds).toEqual(['reject-once'])
      expect(review.lifecycle).toBe('complete')
      expect(review.outcome).toBe('pass')

      await client.$disconnect()
    })

    it('creates check rows when submit_findings reports warn/fail', async () => {
      const process = new FakeAgentProcess()
      const checksToSubmit = [
        {
          status: 'fail' as const,
          claim: 'Agent claimed 42 results but tool output shows 0',
          evidence: 'Terminal output: "Found 0 rows"',
          locator: { blockRef: { messageId: 'msg-2', blockIndex: 1 }, contentHash: 'abc123' }
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
        model: 'claude-opus-4-5',
        getSession: () => session,
        reviewRepository: repository,
        acpRuntime: runtime,
        artifactStorageRoot: temporaryRoot!
      })

      expect(review.lifecycle).toBe('complete')
      expect(review.outcome).toBe('flagged')
      // v2: checks not findings
      expect(review.checks).toHaveLength(1)
      expect(review.checks[0]?.status).toBe('fail')
      expect(review.checks[0]?.claim).toContain('42 results')

      // Checks are persisted.
      const stored = await repository.getReviewsForSession('session-1')
      expect(stored[0]?.checks).toHaveLength(1)

      await client.$disconnect()
    })
  })

  describe('mainSessionId + model flow through IPC into runReview', () => {
    it('threads mainSessionId and model from runReview options into review row and correction', async () => {
      const process = new FakeAgentProcess()
      const checksToSubmit = [
        {
          status: 'warn' as const,
          claim: 'Minor inconsistency in label',
          evidence: 'Block [0] uses mg/L, block [1] uses mmol/L',
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
        mainSessionId: 'main-session-1',
        model: 'claude-opus-4-5',
        getSession: () => session,
        reviewRepository: repository,
        acpRuntime: runtime,
        artifactStorageRoot: temporaryRoot!,
        sessionRefreshTimeoutMs: 0,
        onCorrectionPrompt: (text) => correctionPrompts.push(text)
      })

      // model is recorded on the review row.
      expect(review.model).toBe('claude-opus-4-5')

      // mainSessionId enabled the correction: exactly one [Auditor] message was sent.
      expect(correctionPrompts).toHaveLength(1)
      expect(correctionPrompts[0]).toMatch(/^\[Auditor\]/)

      // Without mainSessionId no correction would fire (pass test in other suite covers this).
      await client.$disconnect()
    })

    it('skips correction injection when mainSessionId is omitted', async () => {
      const process = new FakeAgentProcess()
      const checksToSubmit = [
        {
          status: 'fail' as const,
          claim: 'Fabricated result',
          evidence: 'No supporting activity',
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
        // mainSessionId intentionally omitted
        getSession: () => session,
        reviewRepository: repository,
        acpRuntime: runtime,
        artifactStorageRoot: temporaryRoot!,
        onCorrectionPrompt: (text) => correctionPrompts.push(text)
      })

      expect(review.outcome).toBe('flagged')
      // No correction without mainSessionId.
      expect(correctionPrompts).toHaveLength(0)

      await client.$disconnect()
    })
  })

  describe('loop guard: correction fires exactly once, guarded turn does not spawn a second runReview', () => {
    it('the correction turn stop does not re-trigger runReview (onRunReviewCalled count = 0)', async () => {
      const process = new FakeAgentProcess()
      const checksToSubmit = [
        {
          status: 'warn' as const,
          claim: 'Units inconsistency',
          evidence: 'Block [0] and block [2] differ',
          locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' }
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
        mainSessionId: 'main-session-1',
        getSession: () => session,
        reviewRepository: repository,
        acpRuntime: runtime,
        artifactStorageRoot: temporaryRoot!,
        sessionRefreshTimeoutMs: 0,
        onCorrectionPrompt: (text) => correctionPrompts.push(text),
        onRunReviewCalled: () => {
          runReviewCallCount++
        }
      })

      // Phase 3: fix loop runs internally — the external onRunReviewCalled is NOT invoked.
      // The fix loop is driven by runFixLoop (internal), not by external runReview re-calls.
      expect(runReviewCallCount).toBe(0)

      // The fake persistence snapshot never gains a correction message. The loop must fail closed
      // instead of re-reviewing the original stale turn and falsely resolving the issue.
      const reviewerSessions = agentState.newSessions.filter(
        (s) => s.sessionId === 'reviewer-session-1'
      )
      expect(reviewerSessions).toHaveLength(1)
      const stored = await repository.getReviewsForSession('session-1')
      expect(stored[0]?.checks[0]?.resolution).toBe('unaddressed')

      await client.$disconnect()
    })
  })

  describe('delete cascade', () => {
    it('deleteReviewsForSession removes all reviews for a session, leaving no orphan findings', async () => {
      const process = new FakeAgentProcess()
      startFakeAgent(process, {
        reviewerSessionId: 'reviewer-session-1',
        mainSessionId: 'main-session-1',
        simulateFindingsViaHttp: true,
        checksToSubmit: [
          {
            status: 'fail' as const,
            claim: 'Bad claim',
            evidence: 'Evidence',
            locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' }
          }
        ]
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

      await runReview({
        sessionId: 'session-1',
        turnMessageId: 'msg-2',
        projectId: 'project-1',
        getSession: () => session,
        reviewRepository: repository,
        acpRuntime: runtime,
        artifactStorageRoot: temporaryRoot!
      })

      // Confirm review and checks exist before delete.
      const before = await repository.getReviewsForSession('session-1')
      expect(before).toHaveLength(1)
      expect(before[0]?.checks).toHaveLength(1)

      // Delete cascade.
      await repository.deleteReviewsForSession('session-1')

      // No reviews remain.
      const after = await repository.getReviewsForSession('session-1')
      expect(after).toHaveLength(0)

      // No orphan check rows remain.
      const orphanCount = await repository.countFindings()
      expect(orphanCount).toBe(0)

      await client.$disconnect()
    })

    it('deleteReviewsForProject removes all reviews across all sessions in a project', async () => {
      const client = createProjectDbClient(temporaryRoot!)
      await ensureProjectSchema(client)
      const repository = new ReviewRepository(() => Promise.resolve(client))

      // Create reviews for two sessions in the same project, plus one in a different project.
      const scope = { turnMessageId: 'msg-x', blocks: [], artifactVersionIds: [] }

      await repository.createReview({
        projectId: 'project-A',
        sessionId: 'session-A1',
        turnMessageId: 'msg-x',
        scope,
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test-model'
      })

      await repository.createReview({
        projectId: 'project-A',
        sessionId: 'session-A2',
        turnMessageId: 'msg-x',
        scope,
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test-model'
      })

      await repository.createReview({
        projectId: 'project-B',
        sessionId: 'session-B1',
        turnMessageId: 'msg-x',
        scope,
        lifecycle: 'complete',
        outcome: 'pass',
        model: 'test-model'
      })

      // Add checks to one of project-A's reviews to check orphan cleanup.
      const reviewA1 = (await repository.getReviewsForSession('session-A1'))[0]
      if (reviewA1) {
        await repository.addChecks(reviewA1.id, [
          {
            status: 'warn',
            claim: 'Minor issue',
            evidence: 'Evidence',
            locator: { blockRef: { blockIndex: 0 }, contentHash: 'h1' }
          }
        ])
      }

      // Delete project-A reviews.
      await repository.deleteReviewsForProject('project-A')

      // project-A reviews are gone.
      const a1After = await repository.getReviewsForSession('session-A1')
      const a2After = await repository.getReviewsForSession('session-A2')
      expect(a1After).toHaveLength(0)
      expect(a2After).toHaveLength(0)

      // project-B review is intact.
      const b1After = await repository.getReviewsForSession('session-B1')
      expect(b1After).toHaveLength(1)

      // No orphan checks.
      const orphanCount = await repository.countFindings()
      expect(orphanCount).toBe(0)

      await client.$disconnect()
    })
  })
})
