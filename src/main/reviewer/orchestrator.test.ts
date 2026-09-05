// Integration test for the reviewer orchestrator.
// Mirrors the patterns from src/main/acp/runtime.test.ts and src/main/notebook/host-mcp.integration.test.ts.
// The test stubs the ACP session so no real LLM is invoked; it asserts the orchestrator's wiring:
// - buildSession config (cwd, mcpServers, _meta)
// - submit_findings validates + persists
// - lifecycle transitions (running → complete / error)
// - reviewer session is disposed after submit_findings
// - recomputation-based findings carry verification output in their evidence field
// - scope isolation: out-of-scope artifact reads are rejected; no writes to main execution records

import * as acp from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AcpRuntime } from '../acp/runtime.test-utils'
import { ReviewRepository } from './repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { runReview } from './orchestrator'
import { ReviewerHostServer } from './host-sdk'
import { callSubmitFindingsAfterReadingEvidence as callSubmitFindings } from './reviewer-mcp-test-client'
import type { FrozenReviewerTurnBlock, ReviewerCheckFixture } from './reviewer-mcp-test-client'
import type { PersistedChatSession } from '../../shared/session-persistence'

// Re-use the same FakeAgentProcess pattern from runtime.test.ts.
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

const asAgentProcess = (process: FakeAgentProcess): ChildProcessWithoutNullStreams =>
  process as unknown as ChildProcessWithoutNullStreams

// Minimal session used for turn-scope resolution.
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

const makeSessionWithRequiredPlanOutput = (): PersistedChatSession => {
  const base = makeSession({
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: 'Produce the approved report.',
        status: 'complete',
        eventIds: [],
        createdAt: 1000,
        updatedAt: 1000
      },
      {
        id: 'msg-2',
        role: 'agent',
        content: 'Done.',
        status: 'complete',
        eventIds: [],
        createdAt: 2000,
        updatedAt: 2000
      }
    ]
  })
  const document = {
    schema_version: 1 as const,
    task_summary: 'Produce a report',
    phases: [
      {
        name: 'Delivery',
        delegations: [
          { name: 'Writer', steps: [{ title: 'Write', description: 'Write the report.' }] }
        ]
      }
    ],
    desired_outputs: ['report.csv'],
    feasibility: { confidence: 'high' as const, rationale: 'Inputs are available.' }
  }
  const projection = {
    artifactId: 'plan-artifact',
    artifactVersionId: 'plan-version',
    artifactChecksum: 'plan-checksum',
    originatingPromptMessageId: 'msg-1',
    revision: 1,
    approval: 'approved' as const,
    lifecycle: 'in_progress' as const,
    document,
    stepStatuses: { Write: { status: 'in_progress' as const, updatedAt: 1500 } },
    stepStates: { Write: { status: 'in_progress' as const } },
    counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 1 }
  }
  return {
    ...base,
    planHistoryProjections: [projection],
    runtimeContext: {
      version: 1,
      revision: 1,
      plan: {
        artifactId: projection.artifactId,
        artifactVersionId: projection.artifactVersionId,
        artifactChecksum: projection.artifactChecksum,
        originatingPromptMessageId: projection.originatingPromptMessageId,
        approval: projection.approval,
        stepStatuses: projection.stepStatuses
      }
    }
  }
}

// Builds a fake ACP agent that immediately responds to any session/prompt with a simulated
// reviewer turn. The reviewer "calls submit_findings" by posting to the HTTP MCP endpoint
// identified from the mcpServers config.
const startFakeReviewerAgent = (
  process: FakeAgentProcess,
  reviewerSessionId: string,
  options: {
    // When set, the agent simulates the reviewer calling submit_findings via the MCP server URL.
    simulateFindingsViaHttp?: boolean
    // When set, the agent requests a non-reviewer tool the strict gate rejects, then ends its turn
    // without submit_findings — exercising the gate-rejection incomplete-review path.
    emitRejectedToolCall?: boolean
    // v3: checks[] only — reasoning removed from submit_findings
    checksToSubmit?: ReviewerCheckFixture
  } = {}
): {
  newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }>
  prompts: Array<{ sessionId: string; text: string }>
  closedSessions: string[]
} => {
  const newSessions: Array<{ cwd: string; mcpServers: unknown[]; _meta?: unknown }> = []
  const prompts: Array<{ sessionId: string; text: string }> = []
  const closedSessions: string[] = []

  acp
    .agent({ name: 'test-reviewer-agent' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { close: {} }
      },
      authMethods: []
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      newSessions.push({
        cwd: ctx.params.cwd,
        mcpServers: ctx.params.mcpServers ?? [],
        ...(ctx.params._meta === undefined ? {} : { _meta: ctx.params._meta })
      })

      return { sessionId: reviewerSessionId }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const text = ctx.params.prompt
        .map((block: ContentBlock) => (block.type === 'text' ? block.text : ''))
        .join('')

      prompts.push({ sessionId: ctx.params.sessionId, text })

      // If requested, ask for a tool outside the reviewer allowlist; the runtime gate rejects it and
      // increments the session's rejected-tool-call counter.
      if (options.emitRejectedToolCall && prompts.length === 1) {
        await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: 'reviewer-blocked-bash',
            title: 'Bash',
            kind: 'execute',
            status: 'pending'
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
          ]
        })
      }

      // If requested, simulate the reviewer calling submit_findings via the HTTP MCP server.
      if (
        options.simulateFindingsViaHttp &&
        newSessions.length > 0 &&
        (!options.emitRejectedToolCall || prompts.length > 1)
      ) {
        const mcpServers = newSessions[newSessions.length - 1]?.mcpServers ?? []
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
              ?.find((h: { name: string; value: string }) => h.name === 'authorization')
              ?.value?.replace('Bearer ', '') ?? ''
          await callSubmitFindings(
            reviewerMcp.url,
            token,
            options.checksToSubmit ?? [
              {
                status: 'pass',
                claim: 'The audited turn is supported',
                evidence: 'The frozen turn was read and no contradiction was found.'
              }
            ]
          )
        }
      }

      // Stream a minimal reply chunk.
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: `reply-${ctx.params.sessionId}`,
          content: { type: 'text', text: 'Review complete.' }
        }
      })

      return { stopReason: 'end_turn' }
    })
    .onRequest(acp.methods.agent.session.close, (ctx) => {
      closedSessions.push(ctx.params.sessionId)
      return {}
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
      )
    )

  return { newSessions, prompts, closedSessions }
}

let temporaryRoot: string | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'reviewer-orchestrator-test-'))
})

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('reviewer orchestrator', () => {
  it('creates a reviewer session with the correct buildSession config', async () => {
    const process = new FakeAgentProcess()
    const { newSessions } = startFakeReviewerAgent(process, 'reviewer-session-1', {
      simulateFindingsViaHttp: true
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
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

    // Reviewer execution is isolated from the audited workspace in an empty temporary directory.
    expect(newSessions).toHaveLength(1)
    expect(newSessions[0]?.cwd).toContain('open-science-reviewer-')
    expect(newSessions[0]?.cwd).not.toBe('/workspace')

    // The reviewer MCP server (HTTP type) was included.
    const mcpServers = (newSessions[0]?.mcpServers ?? []) as Array<{ type?: string; name?: string }>
    expect(mcpServers.some((s) => s.type === 'http' && s.name === 'open-science-reviewer')).toBe(
      true
    )

    // _meta includes a systemPrompt with append (rubric).
    const meta = newSessions[0]?._meta as Record<string, unknown> | undefined
    expect(meta?.disableBuiltInTools).toBe(true)
    expect(
      (meta?.claudeCode as { options?: { tools?: unknown[] } } | undefined)?.options?.tools ?? null
    ).toEqual([])
    const systemPrompt = meta?.systemPrompt as Record<string, unknown> | undefined
    expect(systemPrompt?.type).toBe('preset')
    expect(systemPrompt?.preset).toBe('claude_code')
    expect(typeof systemPrompt?.append).toBe('string')
    expect((systemPrompt?.append as string).length).toBeGreaterThan(0)

    // Review was persisted.
    expect(review.sessionId).toBe('session-1')
    expect(review.turnMessageId).toBe('msg-2')
    await expect(access(newSessions[0]!.cwd)).rejects.toMatchObject({ code: 'ENOENT' })

    await client.$disconnect()
  })

  it('fails closed when the reviewer stops without submitting findings', async () => {
    const process = new FakeAgentProcess()
    const { prompts } = startFakeReviewerAgent(process, 'reviewer-session-1')

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
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

    expect(review.lifecycle).toBe('error')
    expect(review.outcome).toBeNull()
    expect(review.errorMessage).toContain('without calling submit_findings')
    expect(review.checks).toHaveLength(0)
    expect(prompts).toHaveLength(2)

    await client.$disconnect()
  })

  it('notes permission-gate rejections as context on an incomplete review', async () => {
    const process = new FakeAgentProcess()
    startFakeReviewerAgent(process, 'reviewer-session-1', { emitRejectedToolCall: true })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => makeSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    expect(review.lifecycle).toBe('error')
    // The message reports the rejection count as context without claiming it blocked submit_findings.
    expect(review.errorMessage).toContain('rejected by the permission gate')
    expect(review.errorMessage).toContain('stopped without calling submit_findings')
    expect(review.checks).toHaveLength(0)

    await client.$disconnect()
  })

  it('recovers a reviewer after the permission gate rejects its first tool call', async () => {
    const process = new FakeAgentProcess()
    const { prompts } = startFakeReviewerAgent(process, 'reviewer-session-1', {
      emitRejectedToolCall: true,
      simulateFindingsViaHttp: true
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => makeSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    expect(review.lifecycle).toBe('complete')
    expect(review.outcome).toBe('pass')
    expect(review.checks).toHaveLength(1)
    expect(prompts).toHaveLength(2)

    await client.$disconnect()
  })

  it('persists checks and sets outcome=flagged when submit_findings is called with warn/fail checks', async () => {
    const process = new FakeAgentProcess()
    const checksToSubmit = [
      {
        status: 'fail' as const,
        claim: 'Agent claimed 42 results',
        evidence: 'Tool output shows 0 results in msg-2',
        locator: {
          blockRef: { messageId: 'msg-2', blockIndex: 1 },
          contentHash: 'abc123'
        }
      }
    ]

    startFakeReviewerAgent(process, 'reviewer-session-1', {
      simulateFindingsViaHttp: true,
      checksToSubmit
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
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

    expect(review.lifecycle).toBe('complete')
    expect(review.outcome).toBe('flagged')
    expect(review.checks).toHaveLength(1)
    expect(review.checks[0]?.status).toBe('fail')
    expect(review.checks[0]?.claim).toBe('Agent claimed 42 results')

    // Verify checks are persisted in DB.
    const reloaded = await repository.getReviewsForSession('session-1')
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]?.checks).toHaveLength(1)
    expect(reloaded[0]?.checks[0]?.claim).toBe('Agent claimed 42 results')

    await client.$disconnect()
  })

  it('reads the effective Plan and persists a fail for its missing required deliverable', async () => {
    const process = new FakeAgentProcess()
    let reviewedPlanBlock: FrozenReviewerTurnBlock | undefined
    startFakeReviewerAgent(process, 'reviewer-session-1', {
      simulateFindingsViaHttp: true,
      checksToSubmit: (blocks) => {
        reviewedPlanBlock = blocks.find((block) => block.turnPlan)
        const agentBlock = blocks.find((block) => block.role === 'agent')
        const plan = reviewedPlanBlock?.turnPlan?.content as
          { desired_outputs?: string[] } | undefined
        if (!agentBlock || !plan?.desired_outputs?.includes('report.csv')) return []
        if ((agentBlock.artifactIds ?? []).length > 0) return []
        return [
          {
            status: 'fail',
            claim: 'The effective current-Turn Plan requires report.csv, but it is missing.',
            evidence: 'read_turn exposed desired_outputs=["report.csv"] and no produced artifact.',
            locator: {
              blockRef: { blockIndex: agentBlock.blockIndex },
              contentHash: agentBlock.contentHash
            }
          }
        ]
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => makeSessionWithRequiredPlanOutput(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    expect(reviewedPlanBlock?.turnPlan).toMatchObject({
      status: 'active',
      binding: 'current-turn'
    })
    expect(review).toMatchObject({ lifecycle: 'complete', outcome: 'flagged' })
    expect(review.checks).toEqual([
      expect.objectContaining({ status: 'fail', claim: expect.stringContaining('report.csv') })
    ])
    const [stored] = await repository.getReviewsForSession('session-1')
    expect(stored?.checks[0]).toMatchObject({ status: 'fail' })
    await client.$disconnect()
  })

  it.each([
    {
      caseName: 'warns for a concrete reference explicitly newly retrieved in this Turn',
      agentContent: 'I newly retrieved DOI 10.1000/current-turn for this answer.',
      expectedOutcome: 'flagged' as const,
      expectedChecks: 1
    },
    {
      caseName: 'abstains for an identifier carried from earlier work without current retrieval',
      agentContent: 'Use DOI 10.1000/earlier-turn from our earlier work.',
      expectedOutcome: 'pass' as const,
      expectedChecks: 0
    }
  ])('$caseName', async ({ agentContent, expectedOutcome, expectedChecks }) => {
    const process = new FakeAgentProcess()
    startFakeReviewerAgent(process, 'reviewer-session-1', {
      simulateFindingsViaHttp: true,
      checksToSubmit: (blocks) => {
        const agentBlock = blocks.find((block) => block.role === 'agent')
        if (!agentBlock?.content?.match(/DOI\s+10\./iu)) return []
        if (!agentBlock.content.match(/newly retrieved|established in this Turn/iu)) return []
        return [
          {
            status: 'warn',
            claim: 'A concrete external reference was presented as newly retrieved in this Turn.',
            evidence: 'The DOI traces nowhere in the current-Turn evidence.',
            locator: {
              blockRef: { blockIndex: agentBlock.blockIndex },
              contentHash: agentBlock.contentHash
            }
          }
        ]
      }
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () =>
        makeSession({
          messages: [
            makeSession().messages[0]!,
            { ...makeSession().messages[1]!, content: agentContent }
          ]
        }),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    expect(review).toMatchObject({ lifecycle: 'complete', outcome: expectedOutcome })
    expect(review.checks).toHaveLength(expectedChecks)
    if (expectedChecks > 0) expect(review.checks[0]?.status).toBe('warn')
    await client.$disconnect()
  })

  it('reads a greeting-only turn and explicitly completes with no Review Checks', async () => {
    const process = new FakeAgentProcess()
    startFakeReviewerAgent(process, 'reviewer-session-1', {
      simulateFindingsViaHttp: true,
      checksToSubmit: []
    })
    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () =>
        makeSession({
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'hi',
              status: 'complete',
              eventIds: [],
              createdAt: 1000,
              updatedAt: 1000
            },
            {
              id: 'msg-2',
              role: 'agent',
              content: 'Hi! How can I help?',
              status: 'complete',
              eventIds: [],
              createdAt: 2000,
              updatedAt: 2000
            }
          ]
        }),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    expect(review).toMatchObject({ lifecycle: 'complete', outcome: 'pass', checks: [] })
    expect(review.scope.blocks.map((block) => block.sourceId)).toEqual(['msg-1', 'msg-2'])
    expect(review.reviewerLog).not.toEqual([])
    const [reloaded] = await repository.getReviewsForSession('session-1')
    expect(reloaded).toMatchObject({ lifecycle: 'complete', outcome: 'pass', checks: [] })
    expect(reloaded?.reviewerLog).toEqual(review.reviewerLog)

    await client.$disconnect()
  })

  it('persists checks and reviewer log (v3: reasoning removed, log captured from stream)', async () => {
    const process = new FakeAgentProcess()

    startFakeReviewerAgent(process, 'reviewer-session-1', {
      simulateFindingsViaHttp: true,
      checksToSubmit: [
        {
          status: 'pass',
          claim: 'row count matches',
          evidence: 'Loaded artifact and counted 33 rows; agent reported 33'
        },
        {
          status: 'warn',
          claim: 'external DOI citation unverifiable',
          evidence: 'Citation is external and not cached in session',
          locator: { blockRef: { blockIndex: 0 }, contentHash: 'abc' }
        }
      ]
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
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

    expect(review.lifecycle).toBe('complete')
    // v2/v3: outcome=flagged because one check has status 'warn'
    expect(review.outcome).toBe('flagged')
    // v2/v3: checks includes both pass and warn checks
    expect(review.checks).toHaveLength(2)
    expect(review.checks[0]!.status).toBe('pass')
    expect(review.checks[1]!.status).toBe('warn')
    // v3: reasoning is gone; reviewerLog captures the stream (the fake agent emits an agent_message_chunk)
    expect('reasoning' in review).toBe(false)
    expect(Array.isArray(review.reviewerLog)).toBe(true)

    // Survives a reload from the DB (backs the Session reviewer page across restart).
    const reloaded = await repository.getReviewsForSession('session-1')
    expect(reloaded[0]?.checks).toHaveLength(2)
    expect(Array.isArray(reloaded[0]?.reviewerLog)).toBe(true)

    await client.$disconnect()
  })

  it('sets lifecycle=error when the session cannot be found', async () => {
    const process = new FakeAgentProcess()
    startFakeReviewerAgent(process, 'reviewer-session-1')

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const updateEvents: string[] = []
    let mutationCount = 0

    const review = await runReview({
      sessionId: 'missing-session',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => undefined, // session not found
      reviewRepository: repository,
      runSessionMutation: async (mutation) => {
        mutationCount += 1
        return mutation()
      },
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      onReviewUpdate: (r) => updateEvents.push(r.lifecycle)
    })

    expect(review.lifecycle).toBe('error')
    expect(review.errorMessage).toContain('missing-session')
    expect(mutationCount).toBe(1)
    // ACP session was never spawned.

    await client.$disconnect()
  })

  it('calls onReviewUpdate on lifecycle transitions', async () => {
    const process = new FakeAgentProcess()
    startFakeReviewerAgent(process, 'reviewer-session-1', { simulateFindingsViaHttp: true })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const lifecycles: string[] = []

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => makeSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      onReviewUpdate: (r) => lifecycles.push(r.lifecycle)
    })

    // First update: 'running' (created), last update: 'complete'.
    expect(lifecycles[0]).toBe('running')
    expect(lifecycles[lifecycles.length - 1]).toBe('complete')

    await client.$disconnect()
  })

  it('submit_findings rejects unknown status values', async () => {
    // We can test the schema validation directly without a full agent run.
    const { submitFindingsInputSchema } = await import('./mcp-server')

    const result = submitFindingsInputSchema.safeParse({
      checks: [
        {
          status: 'critical', // invalid — only pass|warn|fail
          claim: 'test claim',
          evidence: 'test evidence'
        }
      ]
    })

    expect(result.success).toBe(false)
  })

  it('submit_findings accepts valid checks (pass, warn, fail)', async () => {
    const { submitFindingsInputSchema } = await import('./mcp-server')

    const result = submitFindingsInputSchema.safeParse({
      checks: [
        {
          status: 'pass',
          claim: 'row count verified',
          evidence: 'counted 33 rows; agent reported 33'
        },
        {
          status: 'warn',
          claim: 'Minor label inconsistency',
          evidence: 'Block [2] shows "mg/L" but block [4] uses "mmol/L"',
          locator: {
            blockRef: { messageId: 'msg-2', blockIndex: 1 },
            contentHash: 'deadbeef'
          }
        }
      ]
    })

    expect(result.success).toBe(true)
  })

  it('submit_findings rejects summary field (v2: no summary)', async () => {
    const { submitFindingsInputSchema } = await import('./mcp-server')

    const result = submitFindingsInputSchema.safeParse({
      checks: [],
      summary: 'This should be rejected'
    })

    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Recomputation-based finding: verification output cited in evidence
// ---------------------------------------------------------------------------
//
// These tests verify that a finding produced from a reviewer's own recomputation
// (using host.read_artifact to load a tabular artifact and recount rows) correctly
// cites both the agent's reported value and the reviewer's verification output in
// its evidence field. They also verify that scope isolation holds: out-of-scope
// artifact reads are rejected by the host SDK.

describe('reviewer recomputation + scope isolation', () => {
  it('finding produced from recomputation cites both agent value and reviewer verification output in evidence', async () => {
    // This test exercises the path where the reviewer reads a tabular artifact via
    // host.read_artifact (which returns kind=tabular), recomputes a statistic, and submits
    // a finding whose evidence cites both the agent's claim and the recomputed value.
    //
    // We directly exercise ReviewerHostServer + submit_findings schema validation without
    // spinning up an ACP session, mirroring how the unit tests above isolate the MCP layer.

    const tmpDir = await mkdtemp(join(tmpdir(), 'reviewer-recomp-test-'))

    try {
      // Place a CSV artifact (the "ground truth" table) in managed storage using the real layout:
      // <root>/artifacts/<projectId>/<sessionId>/<messageId>/<filename>, keyed by the composite id
      // <sessionId>:<messageId>:<filename>.
      const artifactVersionId = 'session-1:msg-2:samples.csv'
      const artifactDir = join(tmpDir, 'artifacts', 'project-1', 'session-1', 'msg-2')
      await mkdir(artifactDir, { recursive: true })
      // The table has 33 rows (agent claimed 32 — the off-by-one the reviewer should catch).
      const rows = Array.from({ length: 33 }, (_, i) => `sample-${i + 1},0.${i + 1}`)
      const csvContent = `sample_id,value\n${rows.join('\n')}\n`
      await writeFile(join(artifactDir, 'samples.csv'), csvContent)

      const scope = {
        turnMessageId: 'msg-2',
        blocks: [
          {
            id: 'message:msg-2',
            kind: 'message' as const,
            sourceId: 'msg-2',
            blockIndex: 0,
            contentHash: 'hash-msg-2'
          }
        ],
        artifactVersionIds: [artifactVersionId]
      }

      const session = makeSession({
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Count the samples',
            status: 'complete',
            eventIds: [],
            createdAt: 1000,
            updatedAt: 1000
          },
          {
            id: 'msg-2',
            role: 'agent',
            content: 'I found 32 samples in the dataset.',
            status: 'complete',
            eventIds: [],
            createdAt: 2000,
            updatedAt: 2000,
            artifactIds: [artifactVersionId]
          }
        ],
        artifacts: [
          {
            id: artifactVersionId,
            kind: 'managed-file' as const,
            path: 'samples.csv',
            mimeType: 'text/csv'
          }
        ]
      })

      // Start the host SDK server.
      const hostServer = new ReviewerHostServer(session, scope, tmpDir)
      const { endpoint, token } = await hostServer.start()

      // Simulate the reviewer reading the artifact via host.read_artifact.
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ method: 'read_artifact', params: { id: artifactVersionId } })
      })
      const body = (await response.json()) as {
        result?: { kind: string; rowCount: number; columns: Record<string, string[]> }
      }

      // The reviewer's recomputed row count from the tabular artifact.
      const reviewerRowCount = body.result!.rowCount

      // Agent claimed 32, reviewer computed 33 — build the evidence string that cites both.
      const agentClaimedValue = 32
      const evidenceText =
        `Agent claimed ${agentClaimedValue} samples (msg[0]: "I found ${agentClaimedValue} samples"). ` +
        `Reviewer recomputed rowCount from ${artifactVersionId} (kind=tabular): ${reviewerRowCount} rows.`

      // The finding should cite both the agent's value and the reviewer's verification output.
      const { submitFindingsInputSchema } = await import('./mcp-server')
      // v2: use checks[] with status, not findings[] with severity
      const check = {
        status: 'fail' as const,
        claim: `Agent claimed ${agentClaimedValue} samples but the artifact has ${reviewerRowCount}`,
        evidence: evidenceText,
        locator: {
          blockRef: { messageId: 'msg-2', blockIndex: 0 },
          contentHash: 'hash-msg-2'
        },
        artifactVersionId: artifactVersionId
      }

      const parsed = submitFindingsInputSchema.safeParse({ checks: [check] })
      expect(parsed.success).toBe(true)

      // Evidence cites the agent's value.
      expect(check.evidence).toContain('Agent claimed 32')
      // Evidence cites the reviewer's computed value.
      expect(check.evidence).toContain('33 rows')
      // Row count from the tabular artifact matches reality.
      expect(reviewerRowCount).toBe(33)

      await hostServer.stop()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('host.read_artifact rejects out-of-scope artifact ids (scope isolation)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'reviewer-isolation-test-'))

    try {
      const scope = {
        turnMessageId: 'msg-1',
        blocks: [
          {
            id: 'message:msg-1',
            kind: 'message' as const,
            sourceId: 'msg-1',
            blockIndex: 0,
            contentHash: 'hash-msg-1'
          }
        ],
        artifactVersionIds: ['artifact-in-scope'] // only this id is allowed
      }

      const hostServer = new ReviewerHostServer(makeSession(), scope, tmpDir)
      const { endpoint, token } = await hostServer.start()

      // Request an artifact that is NOT in this turn's scope.
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          method: 'read_artifact',
          params: { id: 'artifact-from-different-turn' }
        })
      })

      // The server returns 500 with an error message (thrown from readArtifact).
      const body = (await response.json()) as { error?: string }
      expect(body.error).toMatch(/artifact-from-different-turn/)
      expect(body.error).toMatch(/not in this turn/)

      await hostServer.stop()
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })

  it('reviewer does not write to main execution records or artifacts during runReview', async () => {
    // This test verifies sandbox isolation by confirming that runReview completes without
    // creating any notebook run records (the main execution record store). The reviewer uses
    // its own host SDK server — it has no access to the main notebook runtime.
    //
    // We check this by asserting the review completes (lifecycle=complete) and no notebook
    // run files were written to the temporary root (which stands in for the main storage).
    const process = new FakeAgentProcess()
    const checksToSubmit = [
      {
        status: 'fail' as const,
        claim: 'Agent claimed 42 results but recomputed count = 33',
        evidence:
          'Agent stated 42 in msg-2. Reviewer ran host.read_artifact("csv-1") → kind=tabular, rowCount=33.',
        locator: {
          blockRef: { messageId: 'msg-2', blockIndex: 1 },
          contentHash: 'abc123'
        }
      }
    ]

    startFakeReviewerAgent(process, 'reviewer-session-1', {
      simulateFindingsViaHttp: true,
      checksToSubmit
    })

    const runtime = new AcpRuntime({
      appVersion: '0.1.0',
      defaultCwd: '/workspace',
      spawnAgent: () => asAgentProcess(process)
    })

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    const review = await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => makeSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    // Review completed successfully.
    expect(review.lifecycle).toBe('complete')
    expect(review.outcome).toBe('flagged')

    // v2: use checks not findings
    const check = review.checks[0]!
    expect(check.evidence).toContain('Agent stated 42')
    expect(check.evidence).toContain('rowCount=33')
    expect(check.artifactVersionId).toBeUndefined()

    // No notebook run files should have been created in the storage root by the reviewer.
    // The main notebook runtime was never touched by the reviewer session.
    const { readdir } = await import('node:fs/promises')
    const notebookRunsPath = join(temporaryRoot!, 'notebooks')
    const notebookExists = await readdir(notebookRunsPath).catch(() => null)
    expect(notebookExists).toBeNull()

    await client.$disconnect()
  })
})
