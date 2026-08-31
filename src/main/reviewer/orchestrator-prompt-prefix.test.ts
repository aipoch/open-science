// Covers the framework-neutral rubric delivery in runReview: the reviewer prompt that actually
// reaches the agent must carry the rubric regardless of framework.
//
// - opencode has no system-prompt preset, so buildReviewerSession returns a `promptPrefix` and the
//   orchestrator PREPENDS it to the reviewer prompt (`${prefix}\n\n${reviewerPrompt}`).
// - Claude carries the rubric in session _meta and returns no prefix, so the reviewer prompt is sent
//   verbatim with nothing prepended.
//
// Rather than stand up a real ACP agent (see orchestrator.test.ts for that), these tests stub
// acpRuntime.buildReviewerSession directly so the promptPrefix branch can be driven explicitly, and
// assert on the exact text the reviewer session receives via prompt().

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AcpRuntime } from '../acp/runtime'
import { ReviewRepository } from './repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { runReview } from './orchestrator'
import { callSubmitFindingsAfterReadingEvidence as callSubmitFindings } from './reviewer-mcp-test-client'
import type { AcpPromptRequest } from '../../shared/acp'
import type { MessageAttribution, PersistedChatSession } from '../../shared/session-persistence'

// The reviewer prompt built by buildReviewerPrompt always starts with this line (see orchestrator.ts).
// It is the stable marker used to locate the reviewer prompt inside the text sent to the agent.
const REVIEWER_PROMPT_HEAD = 'You are reviewing turn: msg-2'
const RECOVERY_PROMPT_HEAD = 'Your previous turn ended without calling submit_findings.'

const makeSession = (): PersistedChatSession => ({
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
  updatedAt: 2000
})

type PromptBlock = { type: string; text?: string }

// A minimal reviewer session: it records the prompt text and stops immediately so the drive loop
// returns without a real agent. The orchestrator only uses prompt(), nextUpdate(), sessionId and
// dispose() on it (the latter via acpRuntime.disposeReviewerSession).
const makeFakeReviewerSession = (
  promptSink: string[]
): {
  sessionId: string
  prompt: (blocks: PromptBlock[]) => void
  nextUpdate: () => Promise<{ kind: string; stopReason?: string }>
  dispose: () => void
} => ({
  sessionId: 'reviewer-session-1',
  prompt: (blocks) => {
    promptSink.push(blocks.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join(''))
  },
  nextUpdate: async () => ({ kind: 'stop', stopReason: 'end_turn' }),
  dispose: () => {}
})

// A stub runtime that returns the given promptPrefix from buildReviewerSession. Only the methods
// runReview calls on the runtime are implemented.
const makeStubRuntime = (session: unknown, promptPrefix: string | undefined): AcpRuntime =>
  ({
    buildReviewerSession: async () => ({ session, promptPrefix }),
    disposeReviewerSession: () => ({ rejectedToolCalls: 0, reviewerBridgeScoped: undefined })
  }) as unknown as AcpRuntime

// --- Reviewer MCP submit helper (mirrors orchestrator.test.ts) ---
// Used to drive the initial review to a warn outcome so the fix loop (and thus runScopedReview) runs.
// The MCP Streamable HTTP transport answers over SSE, so responses are parsed out of the event stream.
type SubmittedCheck = {
  status: 'pass' | 'warn' | 'fail'
  claim: string
  evidence: string
  sourceFindingId?: string
  locator?: { blockRef: { messageId?: string; blockIndex: number }; contentHash: string }
}

// Pulls the reviewer HTTP MCP server url + bearer token out of the mcpServers config that runReview
// hands to buildReviewerSession, so the stubbed reviewer can post submit_findings to the real server.
const extractReviewerMcp = (mcpServers: unknown[]): { url: string; token: string } => {
  const http = (
    mcpServers as Array<{
      type?: string
      url?: string
      headers?: Array<{ name: string; value: string }>
    }>
  ).find((s) => s.type === 'http')
  if (!http?.url) throw new Error('no http reviewer MCP server in buildReviewerSession request')
  const token =
    http.headers?.find((h) => h.name === 'authorization')?.value?.replace('Bearer ', '') ?? ''
  return { url: http.url, token }
}

let temporaryRoot: string | undefined

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'reviewer-prompt-prefix-test-'))
})

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  }
})

describe('runReview — framework-neutral rubric delivery (promptPrefix)', () => {
  it('prepends the promptPrefix to the reviewer prompt when the framework returns one (opencode)', async () => {
    const openCodePrefix = 'OPENCODE-RUBRIC-PREFIX: apply this rubric before reviewing.'
    const promptSink: string[] = []
    const runtime = makeStubRuntime(makeFakeReviewerSession(promptSink), openCodePrefix)

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => makeSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    expect(promptSink).toHaveLength(2)
    const sent = promptSink[0]!

    // The sent prompt begins with the prefix followed by a blank line, then the reviewer prompt.
    expect(sent.startsWith(`${openCodePrefix}\n\n`)).toBe(true)
    // The reviewer prompt still rides along, positioned after the prefix.
    expect(sent).toContain(REVIEWER_PROMPT_HEAD)
    expect(sent.indexOf(openCodePrefix)).toBe(0)
    expect(sent.indexOf(openCodePrefix)).toBeLessThan(sent.indexOf(REVIEWER_PROMPT_HEAD))
    // Concretely: prefix + separator + the reviewer prompt (which starts with its known head line).
    expect(sent.startsWith(`${openCodePrefix}\n\n${REVIEWER_PROMPT_HEAD}`)).toBe(true)
    expect(promptSink[1]).toContain(RECOVERY_PROMPT_HEAD)

    await client.$disconnect()
  })

  it('sends the reviewer prompt with no prefix when the framework returns none (Claude via _meta)', async () => {
    const promptSink: string[] = []
    // Claude carries the rubric in session _meta, so buildReviewerSession returns no promptPrefix.
    const runtime = makeStubRuntime(makeFakeReviewerSession(promptSink), undefined)

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      getSession: () => makeSession(),
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!
    })

    expect(promptSink).toHaveLength(2)
    const sent = promptSink[0]!

    // No prefix: the text sent is exactly the reviewer prompt, starting with its head line.
    expect(sent.startsWith(REVIEWER_PROMPT_HEAD)).toBe(true)
    // And nothing from the opencode-style prefix leaked in.
    expect(sent).not.toContain('OPENCODE-RUBRIC-PREFIX')
    expect(promptSink[1]).toContain(RECOVERY_PROMPT_HEAD)

    await client.$disconnect()
  })

  it('fails closed when a completed bridged reviewer request was never session-scoped', async () => {
    const runtime = {
      buildReviewerSession: async (request: { mcpServers: unknown[] }) => {
        const mcp = extractReviewerMcp(request.mcpServers)
        let submitDone: Promise<void> | null = null
        return {
          session: {
            sessionId: 'reviewer-session-1',
            prompt: () => {
              submitDone = callSubmitFindings(mcp.url, mcp.token, [
                { status: 'pass', claim: 'Scoped claim', evidence: 'Scoped evidence' }
              ])
            },
            nextUpdate: async () => {
              if (submitDone) await submitDone
              return { kind: 'stop', stopReason: 'end_turn' }
            },
            dispose: () => {}
          }
        }
      },
      disposeReviewerSession: () => ({
        rejectedToolCalls: 0,
        reviewerBridgeScoped: false
      })
    } as unknown as AcpRuntime
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
    expect(review.errorMessage).toContain('reviewer-only tool scope')
    expect(review.checks).toEqual([])
    await client.$disconnect()
  })

  it('returns an error review and stops the MCP server when reviewer disposal fails', async () => {
    let reviewerEndpoint = ''
    const runtime = {
      buildReviewerSession: async (request: { mcpServers: unknown[] }) => {
        const mcp = extractReviewerMcp(request.mcpServers)
        reviewerEndpoint = mcp.url
        let submitDone: Promise<void> | null = null
        return {
          session: {
            sessionId: 'reviewer-session-1',
            prompt: () => {
              submitDone = callSubmitFindings(mcp.url, mcp.token, [
                { status: 'pass', claim: 'Cleanup claim', evidence: 'Cleanup evidence' }
              ])
            },
            nextUpdate: async () => {
              if (submitDone) await submitDone
              return { kind: 'stop', stopReason: 'end_turn' }
            },
            dispose: () => {}
          }
        }
      },
      disposeReviewerSession: () => {
        throw new Error('reviewer dispose failed')
      }
    } as unknown as AcpRuntime
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
    expect(review.errorMessage).toContain('reviewer dispose failed')
    await expect(fetch(reviewerEndpoint)).rejects.toThrow()
    await client.$disconnect()
  })

  it('keeps the reviewer failure primary when disposal also fails', async () => {
    let reviewerEndpoint = ''
    const runtime = {
      buildReviewerSession: async (request: { mcpServers: unknown[] }) => {
        reviewerEndpoint = extractReviewerMcp(request.mcpServers).url
        return {
          session: {
            sessionId: 'reviewer-session-1',
            prompt: () => {
              throw new Error('reviewer prompt failed')
            },
            nextUpdate: async () => ({ kind: 'stop', stopReason: 'end_turn' }),
            dispose: () => {}
          }
        }
      },
      disposeReviewerSession: () => {
        throw new Error('reviewer dispose failed')
      }
    } as unknown as AcpRuntime
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
    expect(review.errorMessage).toContain('reviewer prompt failed')
    expect(review.errorMessage).not.toContain('reviewer dispose failed')
    await expect(fetch(reviewerEndpoint)).rejects.toThrow()
    await client.$disconnect()
  })
})

// The second promptPrefix concat site lives inside the module-local runScopedReview, reachable only
// through the Phase 3 fix loop: an initial review that flags warn/fail → [Auditor] correction turn →
// scoped re-review of the correction turn. We drive that real path here (stubbing the runtime so the
// prefix branch can be exercised) and assert the scoped re-review's prompt carries the prefix.
describe('runScopedReview — framework-neutral rubric delivery (fix-loop re-review)', () => {
  it('completes a tracked scoped re-review while preserving the framework promptPrefix (opencode)', async () => {
    const scopedPrefix = 'OPENCODE-RUBRIC-PREFIX: apply this rubric to the scoped re-review.'
    const scopedPromptSink: string[] = []

    // The main session evolves as the simulated correction turn appends new messages.
    let currentSession = makeSession()

    const warnCheck: SubmittedCheck = {
      status: 'warn',
      claim: 'Result count is unverified',
      evidence: 'Agent asserted 42 results but no artifact backs it.',
      locator: { blockRef: { messageId: 'msg-2', blockIndex: 0 }, contentHash: 'h-msg-2' }
    }

    // buildReviewerSession is called twice: once for the initial review (submit a warn finding so the
    // fix loop runs, no prefix), once for the scoped re-review (return a prefix + capture the prompt).
    let buildCall = 0
    const reviewerRuntime = {
      buildReviewerSession: async (request: { mcpServers: unknown[] }) => {
        buildCall += 1
        if (buildCall === 1) {
          const mcp = extractReviewerMcp(request.mcpServers)
          let submitDone: Promise<void> | null = null
          const initialSession = {
            sessionId: 'reviewer-initial',
            prompt: () => {
              // Fire submit_findings; nextUpdate awaits it so the warn check is recorded before stop.
              submitDone = callSubmitFindings(mcp.url, mcp.token, [warnCheck])
            },
            nextUpdate: async () => {
              if (submitDone) await submitDone
              return { kind: 'stop', stopReason: 'end_turn' }
            },
            dispose: () => {}
          }
          return { session: initialSession, promptPrefix: undefined }
        }
        const mcp = extractReviewerMcp(request.mcpServers)
        let submitDone: Promise<void> | null = null
        const scopedSession = {
          sessionId: 'reviewer-scoped',
          prompt: (blocks: PromptBlock[]) => {
            const prompt = blocks
              .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
              .join('')
            scopedPromptSink.push(prompt)
            const sourceFindingId = prompt.match(/"sourceFindingId":"([^"]+)"/u)?.[1]
            if (!sourceFindingId)
              throw new Error('tracked re-review prompt omitted sourceFindingId')
            submitDone = callSubmitFindings(mcp.url, mcp.token, [
              {
                status: 'pass',
                claim: 'The correction now verifies the result count.',
                evidence: 'The correction Turn explicitly records the verification.',
                sourceFindingId
              }
            ])
          },
          nextUpdate: async () => {
            if (submitDone) await submitDone
            return { kind: 'stop', stopReason: 'end_turn' }
          },
          dispose: () => {}
        }
        return { session: scopedSession, promptPrefix: scopedPrefix }
      },
      disposeReviewerSession: () => ({ rejectedToolCalls: 0, reviewerBridgeScoped: undefined })
    } as unknown as AcpRuntime
    const runtime = {
      // The [Auditor] correction turn: append the auditor user turn + the agent's correction turn so
      // the fix loop resolves a new correctionTurnMessageId (msg-4-correction) for the scoped review.
      sendApplicationPrompt: async (request: AcpPromptRequest, attribution: MessageAttribution) => {
        currentSession = {
          ...currentSession,
          messages: [
            ...currentSession.messages,
            {
              id: 'msg-3-auditor',
              role: 'user',
              content: '[Auditor] please fix.',
              attribution,
              status: 'complete',
              eventIds: [],
              createdAt: 3000,
              updatedAt: 3000
            },
            {
              id: 'msg-4-correction',
              role: 'agent',
              content: 'Acknowledged; verified the count.',
              status: 'complete',
              responseToMessageId: request.provenanceContext?.promptMessageId,
              eventIds: [],
              createdAt: 4000,
              updatedAt: 4000
            }
          ],
          updatedAt: 4000
        }
      }
    } as unknown as AcpRuntime

    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      mainSessionId: 'session-1', // required to trigger the fix loop
      getSession: () => currentSession,
      reviewRepository: repository,
      acpRuntime: runtime,
      reviewerAcpRuntime: reviewerRuntime,
      artifactStorageRoot: temporaryRoot!,
      fixLoopMaxRounds: 1
    })

    // The initial review + exactly one scoped re-review each built a reviewer session.
    expect(buildCall).toBe(2)
    // The scoped re-review prompt carries the prefix ahead of the reviewer prompt for the correction
    // turn (msg-4-correction), submits a tracked pass, and therefore needs no recovery prompt.
    expect(scopedPromptSink).toHaveLength(1)
    const scopedHead = 'You are reviewing turn: msg-4-correction'
    const sent = scopedPromptSink[0]!
    expect(sent.startsWith(`${scopedPrefix}\n\n`)).toBe(true)
    expect(sent).toContain(scopedHead)
    expect(sent.startsWith(`${scopedPrefix}\n\n${scopedHead}`)).toBe(true)

    const reviews = await repository.getReviewsForSession('session-1')
    expect(reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lifecycle: 'complete',
          outcome: 'pass',
          submittedChecks: [
            expect.objectContaining({
              kind: 'tracked',
              assessment: expect.objectContaining({ status: 'pass' }),
              dispositionOutcome: 'resolved',
              sourceFindingId: expect.any(String)
            })
          ]
        })
      ])
    )
    const sourceReview = reviews.find((review) =>
      review.checks.some((check) => check.claim === warnCheck.claim)
    )
    expect(sourceReview?.checks[0]).toMatchObject({ resolution: 'resolved' })

    await client.$disconnect()
  })

  it.each([
    {
      caseName: 'records disposal failure as the scoped error',
      scopedPromptError: undefined,
      expectedError: 'scoped reviewer dispose failed'
    },
    {
      caseName: 'keeps an existing scoped reviewer failure primary',
      scopedPromptError: 'scoped reviewer prompt failed',
      expectedError: 'scoped reviewer prompt failed'
    }
  ])('$caseName and stops the MCP server', async ({ scopedPromptError, expectedError }) => {
    let currentSession = makeSession()
    let buildCall = 0
    let disposeCall = 0
    let scopedEndpoint = ''
    const runtime = {
      buildReviewerSession: async (request: { mcpServers: unknown[] }) => {
        buildCall += 1
        const mcp = extractReviewerMcp(request.mcpServers)
        let submitDone: Promise<void> | null = null
        return {
          session: {
            sessionId: `reviewer-${buildCall}`,
            prompt: () => {
              if (buildCall === 1) {
                submitDone = callSubmitFindings(mcp.url, mcp.token, [
                  {
                    status: 'warn',
                    claim: 'Result count is unverified',
                    evidence: 'No artifact supports the result count.',
                    locator: {
                      blockRef: { messageId: 'msg-2', blockIndex: 0 },
                      contentHash: 'h-msg-2'
                    }
                  }
                ])
              } else {
                scopedEndpoint = mcp.url
                if (scopedPromptError) throw new Error(scopedPromptError)
              }
            },
            nextUpdate: async () => {
              if (submitDone) await submitDone
              return { kind: 'stop', stopReason: 'end_turn' }
            },
            dispose: () => {}
          }
        }
      },
      disposeReviewerSession: () => {
        disposeCall += 1
        if (disposeCall === 2) throw new Error('scoped reviewer dispose failed')
        return { rejectedToolCalls: 0, reviewerBridgeScoped: undefined }
      },
      sendApplicationPrompt: async (request: AcpPromptRequest, attribution: MessageAttribution) => {
        currentSession = {
          ...currentSession,
          messages: [
            ...currentSession.messages,
            {
              id: 'msg-3-auditor',
              role: 'user',
              content: '[Auditor] verify the result count.',
              attribution,
              status: 'complete',
              eventIds: [],
              createdAt: 3000,
              updatedAt: 3000
            },
            {
              id: 'msg-4-correction',
              role: 'agent',
              content: 'Verified the result count.',
              status: 'complete',
              responseToMessageId: request.provenanceContext?.promptMessageId,
              eventIds: [],
              createdAt: 4000,
              updatedAt: 4000
            }
          ],
          updatedAt: 4000
        }
      }
    } as unknown as AcpRuntime
    const client = createProjectDbClient(temporaryRoot!)
    await migrateApplicationDatabase(client)
    const repository = new ReviewRepository(() => Promise.resolve(client))

    await runReview({
      sessionId: 'session-1',
      turnMessageId: 'msg-2',
      projectId: 'project-1',
      mainSessionId: 'session-1',
      getSession: () => currentSession,
      reviewRepository: repository,
      acpRuntime: runtime,
      artifactStorageRoot: temporaryRoot!,
      fixLoopMaxRounds: 1
    })

    const reviews = await repository.getReviewsForSession('session-1')
    expect(reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lifecycle: 'error',
          errorMessage: expectedError
        })
      ])
    )
    await expect(fetch(scopedEndpoint)).rejects.toThrow()
    await client.$disconnect()
  })
})
