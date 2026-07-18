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
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { runReview } from './orchestrator'
import type { PersistedChatSession } from '../../shared/session-persistence'

// The reviewer prompt built by buildReviewerPrompt always starts with this line (see orchestrator.ts).
// It is the stable marker used to locate the reviewer prompt inside the text sent to the agent.
const REVIEWER_PROMPT_HEAD = 'You are reviewing turn: msg-2'

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

// A stub runtime that returns the given promptPrefix from buildReviewerSession. Only the two methods
// runReview calls on the runtime are implemented.
const makeStubRuntime = (session: unknown, promptPrefix: string | undefined): AcpRuntime =>
  ({
    buildReviewerSession: async () => ({ session, promptPrefix }),
    disposeReviewerSession: () => {}
  }) as unknown as AcpRuntime

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
    await ensureProjectSchema(client)
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

    // Exactly one prompt was sent to the reviewer session.
    expect(promptSink).toHaveLength(1)
    const sent = promptSink[0]!

    // The sent prompt begins with the prefix followed by a blank line, then the reviewer prompt.
    expect(sent.startsWith(`${openCodePrefix}\n\n`)).toBe(true)
    // The reviewer prompt still rides along, positioned after the prefix.
    expect(sent).toContain(REVIEWER_PROMPT_HEAD)
    expect(sent.indexOf(openCodePrefix)).toBe(0)
    expect(sent.indexOf(openCodePrefix)).toBeLessThan(sent.indexOf(REVIEWER_PROMPT_HEAD))
    // Concretely: prefix + separator + the reviewer prompt (which starts with its known head line).
    expect(sent.startsWith(`${openCodePrefix}\n\n${REVIEWER_PROMPT_HEAD}`)).toBe(true)

    await client.$disconnect()
  })

  it('sends the reviewer prompt with no prefix when the framework returns none (Claude via _meta)', async () => {
    const promptSink: string[] = []
    // Claude carries the rubric in session _meta, so buildReviewerSession returns no promptPrefix.
    const runtime = makeStubRuntime(makeFakeReviewerSession(promptSink), undefined)

    const client = createProjectDbClient(temporaryRoot!)
    await ensureProjectSchema(client)
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

    expect(promptSink).toHaveLength(1)
    const sent = promptSink[0]!

    // No prefix: the text sent is exactly the reviewer prompt, starting with its head line.
    expect(sent.startsWith(REVIEWER_PROMPT_HEAD)).toBe(true)
    // And nothing from the opencode-style prefix leaked in.
    expect(sent).not.toContain('OPENCODE-RUBRIC-PREFIX')

    await client.$disconnect()
  })
})
