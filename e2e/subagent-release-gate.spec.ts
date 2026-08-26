import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import {
  createProject,
  openProjectSession,
  openRecentSession,
  sendPrompt
} from './certification/helpers'
import { test } from './fixtures/electron-app'

const ROOT_PROMPT = 'Coordinate the release-gate delegates.'
const CHILD_COUNT = 24
const TERMINAL_PROMPT = 'Run the production delegation terminal journey.'
const BOUNDED_COLLECT_PROMPT = 'Run the production bounded collect journey.'
const BOUNDED_RECOLLECT_PROMPT = 'Collect the running Subagent in Turn B.'
const PERMISSION_PROMPT = 'Run the production delegated permission journey.'
const USER_QUESTION_PROMPT = 'Run the production delegated user question journey.'
const STOP_PROMPT = 'Run the production delegation Stop journey.'
const BRANCH_A_PROMPT = 'Start the inactive-branch Stop certification journey.'
const BRANCH_B_PROMPT = 'Start the active-branch partial Stop certification journey.'
const UNAVAILABLE_PROMPT = 'Verify unsupported delegation admission.'
const INHERITED_SPECIALIST_PROMPT = 'Run the production inherited Specialist delegation journey.'
const STRUCTURED_OUTPUT_PROMPT = 'Run the production structured output journey.'
const RELIABLE_MESSAGING_PROMPT = 'Run the production reliable messaging journey.'
const RELIABLE_BRANCH_PARK_PROMPT = 'Start the reliable messaging branch park journey.'
const RELIABLE_FAILURE_PROMPT = 'Start the reliable messaging post-fence failure journey.'
const RELIABLE_FAILURE_OBSERVE_PROMPT = 'Observe the reliable messaging post-fence failure.'
const RELIABLE_FAIRNESS_PROMPT = 'Start the reliable messaging fairness journey.'
const RELIABLE_FAIRNESS_USER_PROMPT = 'Run the concurrent real user prompt.'
const STRUCTURED_OUTPUT_CHILD = 'Create certified structured evidence.'
const TERMINAL_CHILD = 'Certified delegated terminal'
const INHERITED_SPECIALIST_CHILD = 'Inherited specialist terminal'
const PERMISSION_CHILD = 'Request the delegated fixture permission.'
const USER_QUESTION_CHILD = 'Delegated scope researcher'
const USER_QUESTION_CHILD_TWO = 'Delegated citation reviewer'
const STOP_CHILD = 'Delegated fixture A'
const STOP_CHILD_TWO = 'Delegated fixture B'
const BRANCH_A_CHILD = 'Inactive branch child A'
const BRANCH_B_CHILD = 'Active branch child B1'
const BRANCH_B_CHILD_TWO = 'Active branch child B2'

const expectDurableChildStatus = async (
  page: Page,
  name: string,
  status: 'running' | 'completed' | 'cancelled' | 'error'
): Promise<void> => {
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ childName }) => {
          const loaded = await window.api.sessions.loadAll()
          for (const session of loaded.sessions) {
            const frame = session.conversationGraph?.frames.find(
              (candidate) => candidate.delegateName === childName
            )
            const record = session.runtimeContext?.delegatedWork?.records.find(
              (candidate) => candidate.agentFrameId === frame?.id
            )
            const current = record?.attempts.at(-1)
            if (current) return current.status
          }
          return undefined
        },
        { childName: name }
      )
    )
    .toBe(status)
}

const expectRenderedChildStatus = async (
  page: Page,
  name: string,
  status: 'running' | 'completed' | 'cancelled' | 'error'
): Promise<void> => {
  const bar = page.getByTestId('subagents-bar')
  const trigger = bar.locator(':scope > button')
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click()
  await expect(
    bar
      .getByRole('button', {
        name: `${name}, ${status}`
      })
      .first()
  ).toBeVisible()
  await trigger.click()
}

const seedDelegatedWork = async (page: Page, projectId: string): Promise<void> => {
  await page.evaluate(
    async ({ childCount, projectId, rootPrompt }) => {
      const bridge = globalThis as unknown as {
        api: {
          sessions: {
            saveManifest: (request: {
              lastProjectId: string
              lastSessionId: string
            }) => Promise<void>
            saveSession: (session: Record<string, unknown>) => Promise<void>
          }
        }
      }
      const now = Date.now()
      const sessionId = 'subagent-release-gate-session'
      const rootFrameId = 'release-root'
      const rootBranchId = 'release-root-branch'
      const rootMessageId = 'release-root-message'
      const rootMessage = {
        id: rootMessageId,
        role: 'user',
        content: rootPrompt,
        status: 'complete',
        eventIds: [],
        agentFrameId: rootFrameId,
        introducedOnBranchId: rootBranchId,
        revisionRootMessageId: rootMessageId,
        createdAt: now,
        updatedAt: now
      }
      const graph = {
        schemaVersion: 1,
        rootFrameId,
        activeFrameId: rootFrameId,
        frames: [
          {
            id: rootFrameId,
            originBindingState: 'root',
            kind: 'root',
            status: 'completed',
            activeBranchId: rootBranchId,
            createdAt: now
          }
        ] as Array<Record<string, unknown>>,
        branches: [
          {
            id: rootBranchId,
            agentFrameId: rootFrameId,
            headMessageId: rootMessageId,
            createdAt: now,
            updatedAt: now
          }
        ] as Array<Record<string, unknown>>,
        messages: [rootMessage] as Array<Record<string, unknown>>,
        activities: [],
        activityGroups: [],
        runtimeSegments: [] as Array<Record<string, unknown>>
      }
      const statuses = ['running', 'completed', 'cancelled', 'error'] as const
      const records = Array.from({ length: childCount }, (_, index) => {
        const suffix = String(index + 1).padStart(2, '0')
        const frameId = `release-child-${suffix}`
        const branchId = `release-branch-${suffix}`
        const messageId = `release-message-${suffix}`
        const runtimeSegmentId = `release-runtime-${suffix}`
        const attemptId = `release-attempt-${suffix}`
        const status = statuses[index % statuses.length]
        const createdAt = now + index
        graph.frames.push({
          id: frameId,
          parentFrameId: rootFrameId,
          originMessageId: rootMessageId,
          originBindingState: 'validated',
          kind: 'delegate',
          delegateName: `Release Child ${suffix}`,
          ...(index === 1 ? { agentName: 'Literature Specialist' } : {}),
          status,
          activeBranchId: branchId,
          createdAt
        })
        graph.branches.push({
          id: branchId,
          agentFrameId: frameId,
          headMessageId: messageId,
          createdAt,
          updatedAt: createdAt
        })
        graph.messages.push({
          id: messageId,
          role: 'agent',
          content: `Durable transcript for Release Child ${suffix}`,
          status: 'complete',
          eventIds: [],
          agentFrameId: frameId,
          introducedOnBranchId: branchId,
          revisionRootMessageId: messageId,
          runtimeSegmentId,
          createdAt,
          updatedAt: createdAt
        })
        graph.runtimeSegments.push({
          id: runtimeSegmentId,
          agentFrameId: frameId,
          frameworkId: 'opencode',
          startedAt: createdAt,
          ...(status === 'running' ? {} : { completedAt: createdAt + 1 })
        })
        return {
          agentFrameId: frameId,
          attempts: [
            {
              id: attemptId,
              status,
              resolvedAgent:
                index === 1
                  ? {
                      kind: 'specialist',
                      profileId: 'literature',
                      revision: 1,
                      displayName: 'Literature Specialist'
                    }
                  : { kind: 'main' },
              runtimeSegmentIds: [runtimeSegmentId],
              startedAt: createdAt,
              ...(status === 'cancelled'
                ? { cancellationReason: 'Stopped by the Main Agent' }
                : {}),
              ...(status === 'error'
                ? { error: { code: 'fixture_failure', message: 'Deterministic child failure' } }
                : {})
            }
          ]
        }
      })
      const session = {
        id: sessionId,
        projectId,
        title: rootPrompt,
        cwd: '/tmp/subagent-release-gate',
        status: 'idle',
        agentFrameworkId: 'opencode',
        messages: [rootMessage],
        conversationGraph: graph,
        runtimeContext: {
          version: 1,
          revision: childCount,
          delegatedWork: { records }
        },
        createdAt: now,
        updatedAt: now + childCount
      }
      await bridge.api.sessions.saveSession(session)
      await bridge.api.sessions.saveManifest({
        lastProjectId: projectId,
        lastSessionId: sessionId
      })
    },
    { childCount: CHILD_COUNT, projectId, rootPrompt: ROOT_PROMPT }
  )
}

test('projects real production-composed delegation, permission, and Stop lifecycle', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Production delegation release gate')

  await sendPrompt(
    page,
    TERMINAL_PROMPT,
    'Production delegation reached a terminal result.',
    120_000
  )
  await expectDurableChildStatus(page, TERMINAL_CHILD, 'completed')

  await sendPrompt(
    page,
    BOUNDED_COLLECT_PROMPT,
    'Production bounded delegate returned while a Subagent kept running.',
    120_000
  )
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop subagents' })).toBeVisible()
  await sendPrompt(
    page,
    BOUNDED_RECOLLECT_PROMPT,
    'Production bounded collect journey completed.',
    120_000
  )
  await expectRenderedChildStatus(page, TERMINAL_CHILD, 'completed')

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill(PERMISSION_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  const permissionCard = page
    .getByTestId('permission-composer-scroll')
    .getByTestId('permission-card')
  await expect(permissionCard).toContainText('Read delegated evidence', {
    timeout: 120_000
  })
  await expectDurableChildStatus(page, PERMISSION_CHILD, 'running')
  await expect(permissionCard).toHaveAccessibleName(
    `${PERMISSION_CHILD} permission request: Allow tool access?`
  )
  await permissionCard.getByRole('button', { name: /^Allow/ }).click()
  await expect(page.getByText('Production delegated permission journey completed.')).toBeVisible({
    timeout: 120_000
  })
  await expectDurableChildStatus(page, PERMISSION_CHILD, 'completed')
  await expectRenderedChildStatus(page, PERMISSION_CHILD, 'completed')

  await composer.fill(STOP_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Production delegation is running.')).toBeVisible({
    timeout: 120_000
  })
  await expectDurableChildStatus(page, STOP_CHILD, 'running')
  await expectDurableChildStatus(page, STOP_CHILD_TWO, 'running')
  await expectRenderedChildStatus(page, STOP_CHILD, 'running')
  await expectRenderedChildStatus(page, STOP_CHILD_TWO, 'running')
  await page.getByRole('button', { name: 'Cancel run' }).click()
  await expectDurableChildStatus(page, STOP_CHILD, 'cancelled')
  await expectRenderedChildStatus(page, STOP_CHILD, 'cancelled')
  await expectDurableChildStatus(page, STOP_CHILD_TWO, 'cancelled')
  await expectRenderedChildStatus(page, STOP_CHILD_TWO, 'cancelled')
})

test('routes a delegated user question through one durable card and same-Frame continuation', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Delegated user question release gate')

  await sendPrompt(
    page,
    USER_QUESTION_PROMPT,
    'Production delegated user question is pending.',
    120_000
  )
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ childName, projectId }) => {
            const loaded = await window.api.sessions.loadAll()
            const session = loaded.sessions.find((candidate) => candidate.projectId === projectId)
            const frame = session?.conversationGraph?.frames.find(
              (candidate) => candidate.delegateName === childName
            )
            return {
              status: session?.runtimeContext?.delegatedWork?.questionRequests?.find(
                (candidate) => candidate.sourceFrameId === frame?.id
              )?.status,
              pendingCount: session?.runtimeContext?.delegatedWork?.questionRequests?.filter(
                (candidate) => candidate.status === 'pending'
              ).length,
              childText: session?.conversationGraph?.messages
                .filter((message) => message.agentFrameId === frame?.id)
                .map((message) => message.content)
                .join('\n')
            }
          },
          { childName: USER_QUESTION_CHILD, projectId }
        ),
      { timeout: 30_000 }
    )
    .toMatchObject({ status: 'pending', pendingCount: 2 })
  const card = page.getByTestId('delegated-question-card')
  await expect(card).toContainText(`Asked by ${USER_QUESTION_CHILD}`, { timeout: 120_000 })
  await expect(card).toContainText('Which evidence scope should the researcher use?')

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill('Main draft remains independently editable.')
  await card
    .getByRole('textbox', { name: 'Type your own answer' })
    .fill('Temporary delegated draft')
  await card.getByRole('button', { name: 'Focused' }).click()
  await card.getByRole('button', { name: 'Next' }).click()
  await expect(card).toContainText('Which result format should the researcher return?')
  await card.getByRole('button', { name: 'Narrative' }).click()
  await expect(card.getByRole('button', { name: 'Finish' })).toBeVisible()
  await expect(card.getByText('Review answers')).toHaveCount(0)
  await expect(card.getByRole('button', { name: /Confirm & send/ })).toHaveCount(0)
  await card.getByRole('button', { name: 'Back' }).click()
  await expect(card).toContainText('Which evidence scope should the researcher use?')
  await expect(card.getByRole('button', { name: 'Focused' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await card.getByRole('button', { name: 'Next' }).click()
  await expect(card.getByRole('button', { name: 'Narrative' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await card.getByRole('button', { name: 'Finish' }).click()

  await expect(card).toContainText(`Asked by ${USER_QUESTION_CHILD_TWO}`, { timeout: 120_000 })
  await expect(card).toContainText('Which citation style should the reviewer use?')
  await expect(card.getByText('Review answers')).toHaveCount(0)
  await expect(card.getByRole('button', { name: /Confirm & send/ })).toHaveCount(0)
  await card.getByRole('button', { name: 'Footnotes' }).click()
  await card.getByRole('button', { name: 'Finish' }).click()
  await expect(card).toHaveCount(0, { timeout: 120_000 })
  await expect(composer).toHaveText('Main draft remains independently editable.')
  await expectDurableChildStatus(page, USER_QUESTION_CHILD, 'completed')
  await expectDurableChildStatus(page, USER_QUESTION_CHILD_TWO, 'completed')
  await page.getByRole('button', { name: /2 subagents/ }).click()
  await page.getByRole('button', { name: USER_QUESTION_CHILD }).click()
  await expect(page.getByRole('region', { name: 'Subagents' })).toContainText(
    'Delegated answer continuation completed.',
    { timeout: 120_000 }
  )

  const evidence = await page.evaluate(
    async ({ childName, childNameTwo, projectId }) => {
      const loaded = await window.api.sessions.loadAll()
      const session = loaded.sessions.find((candidate) => candidate.projectId === projectId)!
      const graph = session.conversationGraph!
      const frame = graph.frames.find((candidate) => candidate.delegateName === childName)!
      const frameTwo = graph.frames.find((candidate) => candidate.delegateName === childNameTwo)!
      const owner = session.runtimeContext?.delegatedWork
      const question = owner?.questionRequests?.find(
        (candidate) => candidate.sourceFrameId === frame.id
      )
      const questionTwo = owner?.questionRequests?.find(
        (candidate) => candidate.sourceFrameId === frameTwo.id
      )
      return {
        question,
        questionTwo,
        attemptCount: owner?.records.find((record) => record.agentFrameId === frame.id)?.attempts
          .length,
        attemptCountTwo: owner?.records.find((record) => record.agentFrameId === frameTwo.id)
          ?.attempts.length,
        rootText: graph.messages
          .filter((message) => message.agentFrameId === graph.rootFrameId)
          .map((message) => message.content)
          .join('\n'),
        childText: graph.messages
          .filter((message) => message.agentFrameId === frame.id)
          .map((message) => message.content)
          .join('\n'),
        childTextTwo: graph.messages
          .filter((message) => message.agentFrameId === frameTwo.id)
          .map((message) => message.content)
          .join('\n')
      }
    },
    { childName: USER_QUESTION_CHILD, childNameTwo: USER_QUESTION_CHILD_TWO, projectId }
  )
  expect(evidence.question).toMatchObject({
    status: 'confirmed',
    answers: [
      { questionIndex: 0, value: 'Focused' },
      { questionIndex: 1, value: 'Narrative' }
    ]
  })
  expect(evidence.questionTwo).toMatchObject({
    status: 'confirmed',
    answers: [{ questionIndex: 0, value: 'Footnotes' }]
  })
  expect(evidence.attemptCount).toBe(2)
  expect(evidence.attemptCountTwo).toBe(2)
  expect(evidence.rootText).not.toContain('Answer: Focused')
  expect(evidence.rootText).not.toContain('Answer: Narrative')
  expect(evidence.childText).toContain('Answer: Focused')
  expect(evidence.childText).toContain('Answer: Narrative')
  expect(evidence.childTextTwo).toContain('Answer: Footnotes')
  const mainProviderContext = (await app.readFakeAgentPrompts())
    .filter(({ role }) => role === 'main')
    .map(({ prompt }) => prompt)
    .join('\n')
  expect(mainProviderContext).not.toContain('Which evidence scope should the researcher use?')
  expect(mainProviderContext).not.toContain('Which result format should the researcher return?')
  expect(mainProviderContext).not.toContain('Which citation style should the reviewer use?')
  expect(mainProviderContext).not.toContain('Main draft remains independently editable.')
  expect(mainProviderContext).not.toContain('Temporary delegated draft')
  expect(mainProviderContext).not.toContain('Focused')
  expect(mainProviderContext).not.toContain('Narrative')
  expect(mainProviderContext).not.toContain('Footnotes')
})

test('rejects an unsupported Specialist configuration before child admission', async ({ app }) => {
  test.setTimeout(120_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Unsupported delegation release gate')
  await sendPrompt(
    page,
    UNAVAILABLE_PROMPT,
    'Subagents are unavailable for this session configuration.',
    120_000
  )
  const unavailableNotice = page
    .getByRole('status')
    .filter({ hasText: 'Subagents unavailable for this configuration' })
  await expect(unavailableNotice).toBeVisible()
  await expect(unavailableNotice.getByRole('button', { name: 'Open Settings' })).toBeVisible()
  const admittedChildren = await page.evaluate(async () => {
    const loaded = await window.api.sessions.loadAll()
    const session = loaded.sessions[0]
    return {
      records: session?.runtimeContext?.delegatedWork?.records.length ?? 0,
      frames:
        session?.conversationGraph?.frames.filter((frame) => frame.kind === 'delegate').length ?? 0
    }
  })
  expect(admittedChildren).toEqual({ records: 0, frames: 0 })
})

test('persists production-composed structured output submitted by the child capability', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Structured output release gate')

  await sendPrompt(
    page,
    STRUCTURED_OUTPUT_PROMPT,
    'Production structured output journey completed.',
    120_000
  )
  await expectDurableChildStatus(page, STRUCTURED_OUTPUT_CHILD, 'completed')
  const beforeRestart = await page.evaluate(async (childName) => {
    const loaded = await window.api.sessions.loadAll()
    const session = loaded.sessions[0]
    const frame = session?.conversationGraph?.frames.find(
      (candidate) => candidate.delegateName === childName
    )
    const prompt = session?.conversationGraph?.messages.find(
      (message) =>
        message.agentFrameId === frame?.id && message.structuredOutputEvidence !== undefined
    )
    const terminal = session?.conversationGraph?.messages.find(
      (message) => message.agentFrameId === frame?.id && message.role === 'agent'
    )
    return {
      accepted: prompt?.structuredOutputEvidence?.accepted?.value,
      artifactIds: terminal?.artifactIds ?? [],
      text: terminal?.content
    }
  }, STRUCTURED_OUTPUT_CHILD)
  expect(beforeRestart).toMatchObject({
    accepted: { count: 3 },
    text: 'Structured child completed.'
  })
  expect(beforeRestart.artifactIds).toHaveLength(1)

  page = await app.restart()
  const afterRestart = await page.evaluate(async (childName) => {
    const loaded = await window.api.sessions.loadAll()
    const session = loaded.sessions[0]
    const frame = session?.conversationGraph?.frames.find(
      (candidate) => candidate.delegateName === childName
    )
    const prompt = session?.conversationGraph?.messages.find(
      (message) =>
        message.agentFrameId === frame?.id && message.structuredOutputEvidence !== undefined
    )
    return prompt?.structuredOutputEvidence?.accepted?.value
  }, STRUCTURED_OUTPUT_CHILD)
  expect(afterRestart).toEqual({ count: 3 })
})

test('routes reliable Main and child messages through production Host RPC and the root scheduler', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Reliable messaging release gate')

  await sendPrompt(
    page,
    RELIABLE_MESSAGING_PROMPT,
    'Production reliable downward message was accepted.',
    120_000
  )
  await expect(
    page.getByText('Main replied to the reliable child question from the root continuation.')
  ).toBeVisible({
    timeout: 120_000
  })
  const inlineQuestion = page.getByRole('article', {
    name: /asked a question\./
  })
  await expect(inlineQuestion).toContainText('Child reliable question reached Main')
  const evidence = await page.evaluate(async (projectId) => {
    const loaded = await window.api.sessions.loadAll()
    const session = loaded.sessions.find((candidate) => candidate.projectId === projectId)
    return {
      commands: session?.runtimeContext?.delegatedWork?.messageCommands,
      rendered: session?.conversationGraph?.messages.some((message) =>
        message.content.includes(
          'Main replied to the reliable child question from the root continuation.'
        )
      )
    }
  }, projectId)
  expect(evidence.rendered).toBe(true)
  expect(evidence.commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        direction: 'to_child',
        receipt: expect.objectContaining({ status: 'accepted' })
      }),
      expect.objectContaining({
        direction: 'to_parent',
        receipt: expect.objectContaining({ status: 'accepted' })
      }),
      expect.objectContaining({
        requestId: 'e2e-main-reply-to-child',
        direction: 'to_child',
        receipt: expect.objectContaining({ status: 'accepted' })
      })
    ])
  )
})

test('parks an upward message on branch switch and resumes it after restart and restoration', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Reliable branch park release gate')

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill(RELIABLE_BRANCH_PARK_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Branch park upward message queued.')).toBeVisible({
    timeout: 120_000
  })
  let sessionId: string | undefined
  await expect
    .poll(async () => {
      const identity = await page.evaluate(async (projectId) => {
        const loaded = await window.api.sessions.loadAll()
        const session = loaded.sessions.find((candidate) => candidate.projectId === projectId)
        const command = session?.runtimeContext?.delegatedWork?.messageCommands?.find(
          ({ requestId }) => requestId === 'e2e-child-park'
        )
        return { sessionId: session?.id, status: command?.receipt.status }
      }, projectId)
      sessionId = identity.sessionId
      return identity.status
    })
    .toBe('queued')
  expect(sessionId).toEqual(expect.any(String))

  const inactiveBranchReload = page.waitForEvent('domcontentloaded')
  await page.evaluate(
    async ({ projectId, sessionId }) => {
      const loaded = await window.api.sessions.loadAll()
      const session = loaded.sessions.find(
        (candidate) => candidate.projectId === projectId && candidate.id === sessionId
      )!
      const graph = session.conversationGraph!
      const root = graph.frames.find(({ id }) => id === graph.rootFrameId)!
      const parentBranch = graph.branches.find(({ id }) => id === root.activeBranchId)!
      const forkTarget = graph.messages
        .filter(
          (message) =>
            message.agentFrameId === root.id &&
            message.introducedOnBranchId === parentBranch.id &&
            message.role === 'user'
        )
        .sort((left, right) => right.createdAt - left.createdAt)[0]!
      const now = Date.now()
      graph.branches.push({
        id: 'e2e-park-other-branch',
        agentFrameId: root.id,
        parentBranchId: parentBranch.id,
        forkMessageId: forkTarget.parentMessageId,
        supersededMessageId: forkTarget.id,
        headMessageId: forkTarget.parentMessageId,
        createdAt: now,
        updatedAt: now
      })
      root.activeBranchId = 'e2e-park-other-branch'
      graph.activeFrameId = root.id
      await window.api.sessions.saveSession({
        ...session,
        conversationGraph: graph,
        messages: [],
        activities: [],
        activityGroups: [],
        updatedAt: now
      })
      window.setTimeout(() => window.location.reload(), 0)
    },
    { projectId, sessionId: sessionId! }
  )
  await inactiveBranchReload
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ projectId, sessionId }) => {
          const loaded = await window.api.sessions.loadAll()
          const session = loaded.sessions.find(
            (candidate) => candidate.projectId === projectId && candidate.id === sessionId
          )
          const command = session?.runtimeContext?.delegatedWork?.messageCommands?.find(
            ({ requestId }) => requestId === 'e2e-child-park'
          )
          return { sessionStatus: session?.status, receiptStatus: command?.receipt.status }
        },
        { projectId, sessionId: sessionId! }
      )
    )
    .toEqual({ sessionStatus: 'idle', receiptStatus: 'queued' })
  page = await app.restart()
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ projectId, sessionId }) => {
          const loaded = await window.api.sessions.loadAll()
          return loaded.sessions
            .find((candidate) => candidate.projectId === projectId && candidate.id === sessionId)
            ?.runtimeContext?.delegatedWork?.messageCommands?.find(
              ({ requestId }) => requestId === 'e2e-child-park'
            )?.receipt.status
        },
        { projectId, sessionId: sessionId! }
      )
    )
    .toBe('queued')

  const restoredBranchReload = page.waitForEvent('domcontentloaded')
  await page.evaluate(
    async ({ projectId, sessionId }) => {
      const loaded = await window.api.sessions.loadAll()
      const session = loaded.sessions.find(
        (candidate) => candidate.projectId === projectId && candidate.id === sessionId
      )!
      const graph = session.conversationGraph!
      const root = graph.frames.find(({ id }) => id === graph.rootFrameId)!
      const command = session.runtimeContext?.delegatedWork?.messageCommands?.find(
        ({ requestId }) => requestId === 'e2e-child-park'
      )
      if (!command) throw new Error('Parked message command is unavailable.')
      root.activeBranchId = command.rootBranchId
      graph.activeFrameId = root.id
      const restoredBranch = graph.branches.find(({ id }) => id === command.rootBranchId)!
      const messagesById = new Map(graph.messages.map((message) => [message.id, message]))
      const restoredMessages: typeof graph.messages = []
      let cursor = restoredBranch.headMessageId
      while (cursor) {
        const message = messagesById.get(cursor)
        if (!message) break
        restoredMessages.unshift(message)
        cursor = message.parentMessageId
      }
      const restoredMessageIds = new Set<string>(restoredMessages.map(({ id }) => id))
      await window.api.sessions.saveSession({
        ...session,
        conversationGraph: graph,
        messages: restoredMessages,
        activities: graph.activities.filter((activity) =>
          restoredMessageIds.has(activity.promptMessageId)
        ),
        activityGroups: graph.activityGroups.filter((group) =>
          restoredMessageIds.has(group.promptMessageId)
        ),
        updatedAt: Date.now()
      })
      window.setTimeout(() => window.location.reload(), 0)
    },
    { projectId, sessionId: sessionId! }
  )
  await restoredBranchReload
  await openRecentSession(page, RELIABLE_BRANCH_PARK_PROMPT)
  await expect(
    page.getByText('Main rendered the parked child question after branch restoration.')
  ).toBeVisible({ timeout: 120_000 })
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ projectId, sessionId }) => {
          const loaded = await window.api.sessions.loadAll()
          return loaded.sessions
            .find((candidate) => candidate.projectId === projectId && candidate.id === sessionId)
            ?.runtimeContext?.delegatedWork?.messageCommands?.find(
              ({ requestId }) => requestId === 'e2e-child-park'
            )?.receipt.status
        },
        { projectId, sessionId: sessionId! }
      )
    )
    .toBe('accepted')
})

test('recovers a post-fence receipt persistence failure as uncertain after restart', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Reliable failure window release gate')

  await sendPrompt(
    page,
    RELIABLE_FAILURE_PROMPT,
    'Reliable post-fence source turn completed.',
    120_000
  )
  await expect(page.getByText('Persistence sabotage released.')).toBeVisible({ timeout: 120_000 })
  let sessionId: string | undefined
  await expect
    .poll(async () => {
      const durable = await page.evaluate(async (projectId) => {
        const loaded = await window.api.sessions.loadAll()
        const session = loaded.sessions.find((candidate) => candidate.projectId === projectId)
        const command = session?.runtimeContext?.delegatedWork?.messageCommands?.find(
          ({ requestId }) => requestId === 'e2e-child-post-fence'
        )
        return {
          sessionId: session?.id,
          sessionStatus: session?.status,
          dispatchStartedAt:
            command?.receipt.status === 'queued' ? command.receipt.dispatchStartedAt : undefined
        }
      }, projectId)
      sessionId = durable.sessionId
      return {
        sessionStatus: durable.sessionStatus,
        dispatchStarted: typeof durable.dispatchStartedAt === 'number'
      }
    })
    .toEqual({ sessionStatus: 'idle', dispatchStarted: true })
  expect(sessionId).toEqual(expect.any(String))
  page = await app.restart()
  await openProjectSession(page, 'Reliable failure window release gate', RELIABLE_FAILURE_PROMPT)
  const messageId = await page.evaluate(
    async ({ projectId, sessionId }) => {
      const loaded = await window.api.sessions.loadAll()
      return loaded.sessions
        .find((candidate) => candidate.projectId === projectId && candidate.id === sessionId)
        ?.runtimeContext?.delegatedWork?.messageCommands?.find(
          ({ requestId }) => requestId === 'e2e-child-post-fence'
        )?.messageId
    },
    { projectId, sessionId: sessionId! }
  )
  expect(messageId).toEqual(expect.any(String))
  await sendPrompt(
    page,
    `${RELIABLE_FAILURE_OBSERVE_PROMPT} Message ID ${messageId}`,
    'Reliable post-fence uncertainty recovered.',
    120_000
  )
  const receipt = await page.evaluate(
    async ({ projectId, sessionId }) => {
      const loaded = await window.api.sessions.loadAll()
      return loaded.sessions
        .find((candidate) => candidate.projectId === projectId && candidate.id === sessionId)
        ?.runtimeContext?.delegatedWork?.messageCommands?.find(
          ({ requestId }) => requestId === 'e2e-child-post-fence'
        )?.receipt
    },
    { projectId, sessionId: sessionId! }
  )
  expect(receipt).toMatchObject({ status: 'uncertain', resolution: 'pending' })
})

test('fairly schedules two upward lanes with a concurrent real user prompt', async ({ app }) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Reliable fairness release gate')

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill(RELIABLE_FAIRNESS_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Two upward lanes are queued.')).toBeVisible({ timeout: 120_000 })
  await page.evaluate(
    ({ projectId, text }) => {
      const run = async (): Promise<void> => {
        const loaded = await window.api.sessions.loadAll()
        const session = loaded.sessions.find((candidate) => candidate.projectId === projectId)!
        await window.api.acp.sendPrompt({ sessionId: session.id, text })
      }
      ;(
        globalThis as typeof globalThis & { fairnessUserPrompt?: Promise<void> }
      ).fairnessUserPrompt = run()
    },
    { projectId, text: RELIABLE_FAIRNESS_USER_PROMPT }
  )

  await expect(page.getByText('Main rendered reliable fairness child A.')).toBeVisible({
    timeout: 120_000
  })
  await expect(page.getByText('Main rendered reliable fairness child B.')).toBeVisible({
    timeout: 120_000
  })
  await expect(page.getByText('Concurrent real user prompt completed.')).toBeVisible({
    timeout: 120_000
  })
  const evidence = await page.evaluate(async (projectId) => {
    await (globalThis as typeof globalThis & { fairnessUserPrompt?: Promise<void> })
      .fairnessUserPrompt
    const loaded = await window.api.sessions.loadAll()
    const commands =
      loaded.sessions.find((candidate) => candidate.projectId === projectId)?.runtimeContext
        ?.delegatedWork?.messageCommands ?? []
    return commands
      .filter(({ requestId }) => requestId.startsWith('e2e-fairness-'))
      .map(({ requestId, receipt }) => ({ requestId, status: receipt.status }))
      .sort((left, right) => left.requestId.localeCompare(right.requestId))
  }, projectId)
  expect(evidence).toEqual([
    { requestId: 'e2e-fairness-a', status: 'accepted' },
    { requestId: 'e2e-fairness-b', status: 'accepted' }
  ])
})

test('stops only the active branch and exposes a retryable partial failure', async ({ app }) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Branch Stop release gate')

  await sendPrompt(page, BRANCH_A_PROMPT, 'Inactive branch child A is running.', 120_000)
  await expectDurableChildStatus(page, BRANCH_A_CHILD, 'running')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })

  const conversation = page.getByRole('region', { name: 'Conversation' })
  await app.armDelegatedHandoffCleanupSabotage(BRANCH_B_CHILD_TWO)
  await conversation.getByText(BRANCH_A_PROMPT, { exact: true }).hover()
  await conversation.getByRole('button', { name: 'Edit message' }).click()
  await conversation.getByRole('textbox', { name: 'Edit message' }).fill(BRANCH_B_PROMPT)
  await conversation.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Active branch children B1 and B2 are running.')).toBeVisible({
    timeout: 120_000
  })
  await expectDurableChildStatus(page, BRANCH_B_CHILD, 'running')
  await expectDurableChildStatus(page, BRANCH_B_CHILD_TWO, 'running')
  await expectDurableChildStatus(page, BRANCH_A_CHILD, 'running')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible({ timeout: 30_000 })

  const subagents = page.getByTestId('subagents-bar')
  await subagents.locator(':scope > button').click()
  await expect(subagents.getByRole('button', { name: `${BRANCH_B_CHILD}, running` })).toBeVisible()
  await expect(
    subagents.getByRole('button', { name: `${BRANCH_B_CHILD_TWO}, running` })
  ).toBeVisible()
  await expect(subagents.getByRole('button', { name: new RegExp(BRANCH_A_CHILD) })).toHaveCount(0)
  await subagents.locator(':scope > button').click()

  await app.sabotageDelegatedHandoffCleanup(BRANCH_B_CHILD_TWO)
  await page.getByRole('button', { name: 'Stop subagents' }).click()
  await expectDurableChildStatus(page, BRANCH_B_CHILD, 'cancelled')
  await expectDurableChildStatus(page, BRANCH_B_CHILD_TWO, 'running')
  await expect(page.getByRole('alert')).toContainText(
    'One or more Subagent Attempts could not be stopped.'
  )
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Send gate restored after Stop.')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Stop subagents' })).toBeEnabled()

  await app.restoreDelegatedHandoffCleanup(BRANCH_B_CHILD_TWO)
  await page.getByRole('button', { name: 'Stop subagents' }).click()
  await expectDurableChildStatus(page, BRANCH_B_CHILD_TWO, 'cancelled')

  await conversation.getByRole('button', { name: 'Previous message revision' }).click()
  await expect(conversation.getByText(BRANCH_A_PROMPT, { exact: true })).toBeVisible()
  await expectDurableChildStatus(page, BRANCH_A_CHILD, 'running')
  await expectRenderedChildStatus(page, BRANCH_A_CHILD, 'running')
  await page.getByRole('button', { name: 'Stop subagents' }).click()
  await expectDurableChildStatus(page, BRANCH_A_CHILD, 'cancelled')
})

test('inherits a real root Specialist when profile is omitted and preserves its label after restart', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Inherited Specialist release gate')
  const specialist = await page.evaluate(async () =>
    window.api.specialist.create({
      name: 'RELEASE_SPECIALIST',
      displayName: 'Release Specialist',
      description: 'Production-composed S4 identity fixture.',
      systemPrompt: 'Preserve the release Specialist identity.'
    })
  )

  await page.getByRole('button', { name: /Agent controls:/ }).click()
  await page.getByTestId('specialist-submenu-trigger').press('ArrowRight')
  await page.getByTestId(`specialist-option-${specialist.id}`).click()
  await sendPrompt(
    page,
    INHERITED_SPECIALIST_PROMPT,
    'Production inherited Specialist delegation completed.',
    120_000
  )
  await expectDurableChildStatus(page, INHERITED_SPECIALIST_CHILD, 'completed')
  const inheritedChildTrigger = page.getByRole('button', { name: INHERITED_SPECIALIST_CHILD })
  await inheritedChildTrigger.click()
  const inheritedPreview = page.getByRole('region', { name: 'Subagents' })
  await expect(inheritedPreview).toContainText('Release Specialist')
  await inheritedPreview.getByRole('button', { name: 'Close Subagents preview' }).click()
  await expect(inheritedChildTrigger).toBeFocused()

  page = await app.restart()
  await openRecentSession(page, INHERITED_SPECIALIST_PROMPT)
  await page.getByRole('button', { name: INHERITED_SPECIALIST_CHILD }).click()
  await expect(page.getByRole('region', { name: 'Subagents' })).toContainText('Release Specialist')
})

test('ships one durable, scalable, keyboard-operable persisted Subagent surface', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Subagent release gate')
  await seedDelegatedWork(page, projectId)

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: ROOT_PROMPT })
    .click()

  const summary = page.getByTestId('subagents-bar')
  await expect(summary).toHaveCount(1)
  await summary.locator(':scope > button').click()
  const childRows = summary.locator('[aria-label="Subagents"] > button')
  await expect(childRows).toHaveCount(CHILD_COUNT)
  await expect(childRows.first()).toHaveAccessibleName('Release Child 01, running')
  await expect(childRows.nth(1)).toHaveAccessibleName('Release Child 02, completed')
  await expect(childRows.nth(2)).toHaveAccessibleName('Release Child 03, cancelled')
  await expect(childRows.nth(3)).toHaveAccessibleName('Release Child 04, error')
  await expect(summary.locator(':scope > button')).toHaveAccessibleName('24 subagents, 6 running')

  await childRows.nth(19).focus()
  await page.keyboard.press('Enter')
  const preview = page.getByRole('region', { name: 'Subagents' })
  await expect(preview).toHaveCount(1)
  const selector = preview.getByRole('combobox', { name: 'Subagent Frame' })
  await expect(selector).toContainText('Release Child 20')
  await expect(preview.getByText('Durable transcript for Release Child 20')).toBeVisible()
  await selector.click()
  await page.getByRole('option', { name: 'Release Child 02' }).click()
  await expect(preview.getByText('Literature Specialist')).toBeVisible()
  await expect(preview.getByText('Durable transcript for Release Child 02')).toBeVisible()

  await preview.getByRole('button', { name: 'Close Subagents preview' }).click()
  await expect(summary.locator(':scope > button')).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  const mobilePreview = page.getByRole('region', { name: 'Subagents' })
  const reopenedOnResize = await mobilePreview
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (!reopenedOnResize) {
    const mobileSummary = page.getByTestId('subagents-bar')
    await mobileSummary.locator(':scope > button').click()
    await mobileSummary.getByRole('button', { name: 'Release Child 20, error' }).click()
  }
  await expect(mobilePreview).toHaveCount(1)
  await page.getByRole('combobox', { name: 'Subagent Frame' }).click()
  await page.getByRole('option', { name: 'Release Child 05' }).click()
  await expect(page.getByRole('combobox', { name: 'Subagent Frame' })).toContainText(
    'Release Child 05'
  )
  await expect(page.getByText('Durable transcript for Release Child 05')).toBeVisible()

  await expect
    .poll(() =>
      page.evaluate(async (projectId) => {
        const bridge = globalThis as unknown as {
          api: {
            preview: {
              load: (request: { projectId: string }) => Promise<{
                subagents?: { selectedAgentFrameId?: string }
              } | null>
            }
          }
        }
        return (await bridge.api.preview.load({ projectId }))?.subagents?.selectedAgentFrameId
      }, projectId)
    )
    .toBe('release-child-05')

  page = await app.restart()
  await page
    .getByRole('region', { name: 'Recent sessions' })
    .getByRole('button', { name: ROOT_PROMPT })
    .click()
  const restartedSummary = page.getByTestId('subagents-bar')
  await restartedSummary.locator(':scope > button').click()
  await expect(restartedSummary.locator('[aria-label="Subagents"] > button')).toHaveCount(
    CHILD_COUNT
  )
  await restartedSummary.locator(':scope > button').click()
  await expect(page.getByRole('combobox', { name: 'Subagent Frame' })).toContainText(
    'Release Child 05'
  )
})
