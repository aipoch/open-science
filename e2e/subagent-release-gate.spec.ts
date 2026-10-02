import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { Page } from 'playwright'
import { applySessionConversationCommands } from '../src/shared/session-conversation-command'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { AcpModelCallUsage, AcpTurnTokenUsage } from '../src/shared/acp'

import {
  createProject,
  openProjectSession,
  openRecentSession,
  sendPrompt
} from './certification/helpers'
import { test } from './fixtures/electron-app'
import { retrySessionRevisionConflict } from './fixtures/session-revision-retry'

const ROOT_PROMPT = 'Coordinate the release-gate delegates.'
const CHILD_COUNT = 24
const TERMINAL_PROMPT = 'Run the production delegation terminal journey.'
const SETTLEMENT_PROMPT = 'Run the production idle Main settlement journey.'
const SETTLEMENT_CHILD = 'Idle Main settlement child'
const SETTLEMENT_INITIAL_ANSWER = 'Main ended its turn while the file-gated child remained running.'
const SETTLEMENT_FINAL_ANSWER =
  'Main collected the completed file-gated child evidence after its idle turn.'
const PROGRESS_PROMPT = 'Wait for three file-gated Subagents and report progress.'
const ARTIFACT_VERSION_INPUT_PROMPT =
  'Run the production Artifact Version input delegation journey.'
const BOUNDED_COLLECT_PROMPT = 'Run the production bounded collect journey.'
const BOUNDED_RECOLLECT_PROMPT = 'Collect the running Subagent in Turn B.'
const SCROLL_INTENT_PROMPT = 'Run the production Subagent scroll intent journey.'
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
const ARTIFACT_VERSION_INPUT_CHILD = 'Artifact Version input child'
const INHERITED_SPECIALIST_CHILD = 'Inherited specialist terminal'
const PERMISSION_CHILD = 'Request the delegated fixture permission.'
const USER_QUESTION_CHILD = 'Delegated scope researcher'
const USER_QUESTION_CHILD_TWO = 'Delegated citation reviewer'
const STOP_CHILD = 'Delegated fixture A'
const STOP_CHILD_TWO = 'Delegated fixture B'
const BRANCH_A_CHILD = 'Inactive branch child A'
const BRANCH_B_CHILD = 'Active branch child B1'
const BRANCH_B_CHILD_TWO = 'Active branch child B2'
const IRIS_MARKDOWN_REPORT = [
  '## Iris EDA 完成',
  '',
  '数据来源：`sklearn.datasets.load_iris`',
  '',
  '### 1) 数据规模与元信息（实测）',
  '- 形状：**150 行 × 4 个数值特征**',
  '',
  '### 2) 分组统计',
  '| species | sepal length | petal length |',
  '| --- | --- | --- |',
  '| setosa | 5.006 ± 0.352 | 1.462 ± 0.174 |',
  '| versicolor | 5.936 ± 0.516 | 4.260 ± 0.470 |',
  '',
  '### 3) 相关系数矩阵',
  '```',
  '              sepal length  petal length',
  'sepal length         1.000         0.872',
  '```'
].join('\n')

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

const seedDelegatedWork = async (
  page: Page,
  projectId: string,
  longFirstChild = false,
  markdownFirstChild = false
): Promise<void> => {
  await page.evaluate(
    async ({
      childCount,
      projectId,
      rootPrompt,
      longFirstChild,
      markdownFirstChild,
      markdownReport
    }) => {
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
        const messageCount = longFirstChild && index === 0 ? 32 : 1
        graph.branches.push({
          id: branchId,
          agentFrameId: frameId,
          headMessageId: messageCount === 1 ? messageId : `${messageId}-${messageCount - 1}`,
          createdAt,
          updatedAt: createdAt
        })
        for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
          graph.messages.push({
            id: messageIndex === 0 ? messageId : `${messageId}-${messageIndex}`,
            role: 'agent',
            content:
              longFirstChild && index === 0
                ? `Durable transcript for Release Child ${suffix}, part ${messageIndex + 1}. ${'Review the evidence. '.repeat(30)}`
                : markdownFirstChild && index === 0
                  ? markdownReport
                  : `Durable transcript for Release Child ${suffix}`,
            status: markdownFirstChild && index === 0 ? 'streaming' : 'complete',
            eventIds: [],
            agentFrameId: frameId,
            introducedOnBranchId: branchId,
            ...(messageIndex > 0
              ? {
                  parentMessageId:
                    messageIndex === 1 ? messageId : `${messageId}-${messageIndex - 1}`
                }
              : {}),
            runtimeSegmentId,
            createdAt: createdAt + messageIndex,
            updatedAt: createdAt + messageIndex
          })
        }
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
    {
      childCount: CHILD_COUNT,
      projectId,
      rootPrompt: ROOT_PROMPT,
      longFirstChild,
      markdownFirstChild,
      markdownReport: IRIS_MARKDOWN_REPORT
    }
  )
}

test('renders a running Subagent Markdown report after switching preview tabs', async ({ app }) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Subagent Markdown report')
  await seedDelegatedWork(page, projectId, false, true)
  page = await app.restart()
  await openRecentSession(page, ROOT_PROMPT)

  const bar = page.getByTestId('subagents-bar')
  await bar.locator(':scope > button').click()
  await bar.getByRole('button', { name: 'Release Child 01, running' }).click()
  const transcript = page.locator('[data-slot="subagent-transcript"]')
  const report = transcript.locator('[data-message-id="release-message-01"]')
  await expect(report.locator('h2')).toHaveText('Iris EDA 完成')
  await expect(report.locator('[data-streamdown="strong"]')).toContainText('150 行')
  await expect(report.locator('table tbody tr')).toHaveCount(2)
  await expect(report.locator('pre')).toContainText('sepal length')
  await expect(report.locator('[data-agent-markdown-fallback]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('tab', { name: 'Subagents' }).click()
  await expect(report.locator('h2')).toHaveText('Iris EDA 完成')
  await expect(report.locator('table tbody tr')).toHaveCount(2)
  await expect(report.locator('[data-agent-markdown-fallback]')).toHaveCount(0)
})

test('keeps a Subagent reading position across preview tabs', async ({ app }) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await app.setMainWindowSize(1280, 900)
  const projectId = await createProject(page, 'Subagent reading position')
  await seedDelegatedWork(page, projectId, true)
  page = await app.restart()
  await openRecentSession(page, ROOT_PROMPT)

  const bar = page.getByTestId('subagents-bar')
  await bar.locator(':scope > button').click()
  await bar.getByRole('button', { name: 'Release Child 01, running' }).click()
  const preview = page.getByRole('region', { name: 'Subagents' })
  const viewport = preview.locator('[data-slot="message-scroller-viewport"]')
  await expect(preview).toContainText('part 32')
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(900)
  await viewport.hover()
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
  await page.mouse.wheel(0, -500)
  await expect
    .poll(() =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop
      )
    )
    .toBeGreaterThan(100)
  const readingPosition = await viewport.evaluate((element) => element.scrollTop)

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('tab', { name: 'Subagents' }).click()
  expect(await preview.textContent()).toContain('part 32')
  expect(await viewport.locator('[data-message-id]').count()).toBeGreaterThan(0)
  await expect(preview).toBeVisible()
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(readingPosition - 8)
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeLessThan(readingPosition + 8)

  const bottomGap = (): Promise<number> =>
    viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
  await preview.getByRole('button', { name: 'Scroll to end' }).click()
  await expect.poll(bottomGap).toBeLessThan(3)
  await app.setMainWindowSize(1280, 760)
  await expect.poll(bottomGap).toBeLessThan(3)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page.getByRole('tab', { name: 'Subagents' }).click()
  await expect.poll(bottomGap).toBeLessThan(3)
})

test('follows live Subagent output only after the reader returns to the end', async ({ app }) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.setMainWindowSize(1280, 900)
  await createProject(page, 'Live Subagent scroll intent')
  const directory = await app.createTestDirectory('subagent-scroll-intent')
  const releaseFiles = [
    join(directory, 'start'),
    join(directory, 'first'),
    join(directory, 'second')
  ]

  try {
    await sendPrompt(
      page,
      `${SCROLL_INTENT_PROMPT}\nRelease files: ${JSON.stringify(releaseFiles)}`,
      'Production Subagent scroll intent journey started.',
      120_000
    )
    await expectDurableChildStatus(page, 'Scroll intent child', 'running')
    const bar = page.getByTestId('subagents-bar')
    await bar.locator(':scope > button').click()
    await bar.getByRole('button', { name: 'Scroll intent child, running' }).click()
    const preview = page.getByRole('region', { name: 'Subagents' })
    const viewport = preview.locator('[data-slot="message-scroller-viewport"]')
    await expect(viewport).toBeVisible()
    await writeFile(releaseFiles[0], '')
    await expect(preview).toContainText('Initial delegated evidence.', { timeout: 60_000 })
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page.getByRole('tab', { name: 'Subagents' }).click()
    await expect(preview).toContainText('Initial delegated evidence.')
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(900)
    await viewport.hover()
    await page.mouse.wheel(0, 2000)
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
    await page.mouse.wheel(0, -500)
    const bottomGap = (): Promise<number> =>
      viewport.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop
      )
    await expect.poll(bottomGap).toBeGreaterThan(100)
    const readingPosition = await viewport.evaluate((element) => element.scrollTop)

    await writeFile(releaseFiles[1], '')
    await expect(preview).toContainText('Reading-position update arrived.', { timeout: 60_000 })
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(readingPosition - 8)
    expect(await viewport.evaluate((element) => element.scrollTop)).toBeLessThan(
      readingPosition + 8
    )

    await preview.getByRole('button', { name: 'Scroll to end' }).click()
    await expect.poll(bottomGap).toBeLessThan(3)
    await writeFile(releaseFiles[2], '')
    await expect(preview).toContainText('Follow-end update arrived.', { timeout: 60_000 })
    await expect.poll(bottomGap).toBeLessThan(3)
  } finally {
    await Promise.all(releaseFiles.map((file) => writeFile(file, '')))
  }
})

test('preserves the complete live transcript on every visible frame across preview tabs', async ({
  app
}) => {
  test.setTimeout(240_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await app.setMainWindowSize(1280, 900)
  await createProject(page, 'Live Subagent history continuity')
  const directory = await app.createTestDirectory('subagent-history-continuity')
  const releaseFiles = ['start', 'first', 'second', 'finish'].map((name) => join(directory, name))
  try {
    await sendPrompt(
      page,
      `${SCROLL_INTENT_PROMPT}\nRelease files: ${JSON.stringify(releaseFiles)}`,
      'Production Subagent scroll intent journey started.',
      120_000
    )
    await expectDurableChildStatus(page, 'Scroll intent child', 'running')
    const bar = page.getByTestId('subagents-bar')
    await bar.locator(':scope > button').click()
    await bar.getByRole('button', { name: 'Scroll intent child, running' }).click()
    const preview = page.getByRole('region', { name: 'Subagents', includeHidden: true })
    const transcript = preview.locator('[data-slot="subagent-transcript"]')
    await writeFile(releaseFiles[0], '')
    await expect(transcript).toContainText('Initial delegated evidence.', { timeout: 60_000 })

    // Keep the provider running throughout the assertions: terminal staging must not repair
    // a missing transcript before this test notices it. Sample painted frames, not just an
    // eventually successful locator assertion after re-entering the tab.
    await transcript.evaluate((element) => {
      const panelId = element.closest('[role="tabpanel"]')?.id
      if (!panelId) throw new Error('Subagent preview has no tab panel')
      const audit = { frames: 0, losses: [] as string[], expected: [60, 0, 0], stop: false }
      ;(window as unknown as { subagentHistoryAudit: typeof audit }).subagentHistoryAudit = audit
      const sample = (): void => {
        if (audit.stop) return
        const panel = document.getElementById(panelId)
        if (panel && !panel.closest('[hidden]')) {
          audit.frames += 1
          const current = panel.querySelector('[data-slot="subagent-transcript"]')
          const counts = [
            'Initial delegated evidence.',
            'Reading-position update arrived.',
            'Follow-end update arrived.'
          ].map((text) => (current?.textContent?.split(text).length ?? 1) - 1)
          if (counts.some((count, index) => count < audit.expected[index])) {
            audit.losses.push(`Expected ${audit.expected}; received ${counts}`)
          }
        }
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    const counts = async (): Promise<number[]> =>
      transcript.evaluate((element) =>
        [
          'Initial delegated evidence.',
          'Reading-position update arrived.',
          'Follow-end update arrived.'
        ].map((text) => (element.textContent?.split(text).length ?? 1) - 1)
      )
    expect(await counts()).toEqual([60, 0, 0])
    for (const [gate, expected] of [
      [1, [60, 20, 0]],
      [2, [60, 20, 20]]
    ] as const) {
      await page.getByRole('button', { name: 'Files', exact: true }).click()
      if (gate === 1) {
        await sendPrompt(page, 'Verify interaction follow-up.', 'Interaction follow-up completed.')
        expect(await counts()).toEqual([60, 0, 0])
      }
      await writeFile(releaseFiles[gate], '')
      await expect.poll(counts, { timeout: 60_000 }).toEqual(expected)
      await page.evaluate((expected) => {
        ;(
          window as unknown as { subagentHistoryAudit: { expected: readonly number[] } }
        ).subagentHistoryAudit.expected = expected
      }, expected)
      await page.getByRole('tab', { name: 'Subagents' }).click()
      expect(await counts()).toEqual(expected)
      await expectDurableChildStatus(page, 'Scroll intent child', 'running')
    }
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.getByRole('button', { name: 'Files', exact: true }).click()
      await page.getByRole('tab', { name: 'Subagents' }).click()
      expect(await counts()).toEqual([60, 20, 20])
    }
    const audit = await page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
      const audit = (
        window as unknown as {
          subagentHistoryAudit: { frames: number; losses: string[]; stop: boolean }
        }
      ).subagentHistoryAudit
      audit.stop = true
      return audit
    })
    expect(audit.frames).toBeGreaterThan(0)
    expect(audit.losses).toEqual([])
    await writeFile(releaseFiles[3], '')
    await expectDurableChildStatus(page, 'Scroll intent child', 'completed')
    expect(await counts()).toEqual([60, 20, 20])
  } finally {
    await Promise.all(releaseFiles.map((file) => writeFile(file, '')))
  }
})

test('restores messages and tools emitted before opening and while the Subagents tab is closed', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Subagent transcript lifecycle')
  const directory = await app.createTestDirectory('subagent-transcript-lifecycle')
  const releaseFiles = ['start', 'first', 'second', 'finish', 'include-history'].map((name) =>
    join(directory, name)
  )
  try {
    await page.evaluate(() => {
      const received: string[] = []
      ;(window as unknown as { childHistoryEvents: string[] }).childHistoryEvents = received
      window.api.acp.onAgentRuntimeUpdate((update) => {
        if (update.event.text) received.push(update.event.text)
      })
    })
    await sendPrompt(
      page,
      `${SCROLL_INTENT_PROMPT}\nRelease files: ${JSON.stringify(releaseFiles)}`,
      'Production Subagent scroll intent journey started.',
      120_000
    )
    await expectDurableChildStatus(page, 'Scroll intent child', 'running')
    await writeFile(releaseFiles[0], '')
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { childHistoryEvents: string[] }).childHistoryEvents.some((text) =>
            text.includes('Initial delegated evidence.')
          )
        )
      )
      .toBe(true)
    const openChild = async (): Promise<void> => {
      const bar = page.getByTestId('subagents-bar')
      const trigger = bar.locator(':scope > button')
      if ((await trigger.getAttribute('aria-expanded')) === 'false') await trigger.click()
      await bar.getByRole('button', { name: 'Scroll intent child, running' }).click()
    }
    await openChild()
    const preview = page.getByRole('region', { name: 'Subagents' })
    await expect(preview).toContainText('Historical plan before preview.')
    await expect(preview).toContainText('Read a file')
    await expect(preview).toContainText('Initial delegated evidence.')
    await page.getByRole('button', { name: 'Close preview of Subagents', exact: true }).click()
    await writeFile(releaseFiles[1], '')
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { childHistoryEvents: string[] }).childHistoryEvents.some((text) =>
            text.includes('Reading-position update arrived.')
          )
        )
      )
      .toBe(true)
    await openChild()
    // Read immediately after the actual tab is re-created; no completion or later delta may repair it.
    const text = await preview.textContent()
    expect(text).toContain('Historical plan before preview.')
    expect(text).toContain('Read a file')
    expect(text?.split('Initial delegated evidence.').length).toBe(61)
    expect(text?.split('Reading-position update arrived.').length).toBe(21)
    await expectDurableChildStatus(page, 'Scroll intent child', 'running')
    await writeFile(releaseFiles[2], '')
    await expect(preview).toContainText('Follow-end update arrived.')
    await writeFile(releaseFiles[3], '')
    await expectDurableChildStatus(page, 'Scroll intent child', 'completed')
    await expect(preview).toContainText('Historical plan before preview.')
    expect((await preview.textContent())?.split('Initial delegated evidence.').length).toBe(61)
  } finally {
    await Promise.all(releaseFiles.map((file) => writeFile(file, '')))
  }
})

test('resolves a bare Artifact version_id into a delegated read-only input', async ({ app }) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProject(page, 'Artifact Version input delegation gate')

  await sendPrompt(
    page,
    ARTIFACT_VERSION_INPUT_PROMPT,
    'Artifact Version input delegation completed.',
    120_000
  )
  await expectDurableChildStatus(page, ARTIFACT_VERSION_INPUT_CHILD, 'completed')

  const evidence = await page.evaluate(
    async ({ childName }) => {
      const sessions = (await window.api.sessions.loadAll()).sessions
      for (const session of sessions) {
        const frame = session.conversationGraph?.frames.find(
          (candidate) => candidate.delegateName === childName
        )
        const attempt = session.runtimeContext?.delegatedWork?.records
          .find((record) => record.agentFrameId === frame?.id)
          ?.attempts.at(-1)
        if (!frame || !attempt) continue
        const terminal = session.conversationGraph?.messages.find(
          (message) => message.id === attempt.terminalMessageId
        )
        return {
          status: attempt.status,
          error: attempt.error,
          terminalText: terminal?.content,
          artifactVersions: (session.artifacts ?? [])
            .filter((artifact) => artifact.name === 'provenance-evidence.txt')
            .map((artifact) => artifact.versionId)
        }
      }
      return undefined
    },
    { childName: ARTIFACT_VERSION_INPUT_CHILD }
  )

  expect(evidence).toMatchObject({
    status: 'completed',
    error: undefined,
    terminalText: 'Delegated immutable Artifact Version input verified.'
  })
  expect(evidence?.artifactVersions).toHaveLength(1)
  expect(evidence?.artifactVersions[0]).toMatch(/^[0-9a-f-]{36}$/)
})

test('wakes durable idle Main through production settlement admission and collects its child', async ({
  app
}) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Idle Main settlement release gate')
  const releaseFile = join(await app.createTestDirectory('idle-main-settlement'), 'release')
  const prompt = `${SETTLEMENT_PROMPT}\nRelease file: ${JSON.stringify(releaseFile)}`
  try {
    await sendPrompt(page, prompt, SETTLEMENT_INITIAL_ANSWER, 120_000)
    await expectDurableChildStatus(page, SETTLEMENT_CHILD, 'running')
    const readEvidence = async (): Promise<
      | {
          sessionId: string
          status: PersistedChatSession['status']
          activeRun: PersistedChatSession['activeRun']
          frameId: string
          attemptId: string | undefined
          childStatus: string | undefined
          originSegmentId: string | undefined
          rootUsers: string[]
          rootAnswers: {
            content: string
            status: string
            segmentId: string | undefined
            turnUsage: AcpTurnTokenUsage | undefined
            modelCallUsage: AcpModelCallUsage[] | undefined
          }[]
        }
      | undefined
    > =>
      page.evaluate(
        async ({ childName, prompt }) => {
          const session = (await window.api.sessions.loadAll()).sessions.find((candidate) =>
            candidate.conversationGraph?.frames.some((frame) => frame.delegateName === childName)
          )
          if (!session) return undefined
          const graph = session.conversationGraph!
          const origin = graph.messages.find(
            (message) => message.role === 'user' && message.content === prompt
          )
          const child = graph.frames.find((frame) => frame.delegateName === childName)!
          const attempt = session.runtimeContext?.delegatedWork?.records
            .find((record) => record.agentFrameId === child.id)
            ?.attempts.at(-1)
          return {
            sessionId: session.id,
            status: session.status,
            activeRun: session.activeRun,
            frameId: child.id,
            attemptId: attempt?.id,
            childStatus: attempt?.status,
            originSegmentId: origin?.runtimeSegmentId,
            rootUsers: graph.messages
              .filter(
                (message) => message.agentFrameId === graph.rootFrameId && message.role === 'user'
              )
              .map((message) => message.content),
            rootAnswers: graph.messages
              .filter(
                (message) => message.agentFrameId === graph.rootFrameId && message.role === 'agent'
              )
              .map((message) => ({
                content: message.content,
                status: message.status,
                segmentId: message.runtimeSegmentId,
                turnUsage: message.turnUsage,
                modelCallUsage: message.modelCallUsage
              }))
          }
        },
        { childName: SETTLEMENT_CHILD, prompt }
      )
    await expect.poll(readEvidence).toMatchObject({
      status: 'idle',
      activeRun: undefined,
      childStatus: 'running',
      rootAnswers: [{ content: SETTLEMENT_INITIAL_ANSWER, status: 'complete' }]
    })
    const idle = (await readEvidence())!
    expect(idle.rootAnswers[0].turnUsage).toMatchObject({
      inputTokens: 11,
      cacheTokens: 0,
      outputTokens: 3,
      turnCount: 1
    })
    expect(idle.rootAnswers[0].modelCallUsage).toMatchObject([
      { inputTokens: 11, cacheTokens: 0, outputTokens: 3 }
    ])
    expect(idle.originSegmentId).toBeDefined()
    expect(
      (await app.readFakeAgentPrompts()).filter(
        ({ role, sessionId }) => role === 'main' && sessionId === idle.sessionId
      )
    ).toHaveLength(1)

    await writeFile(releaseFile, '')
    await expectDurableChildStatus(page, SETTLEMENT_CHILD, 'completed')
    await expect
      .poll(async () =>
        (await app.readFakeAgentPrompts()).filter(
          ({ role, sessionId, prompt }) =>
            role === 'main' &&
            sessionId === idle.sessionId &&
            prompt.includes('Delegated work settlement update')
        )
      )
      .toHaveLength(1)
    const settlementPrompt = (await app.readFakeAgentPrompts()).find(
      ({ role, sessionId, prompt }) =>
        role === 'main' &&
        sessionId === idle.sessionId &&
        prompt.includes('Delegated work settlement update')
    )!.prompt
    expect(settlementPrompt).toContain(
      `frame=${idle.frameId}; attempt=${idle.attemptId}; status=completed`
    )
    await expect.poll(readEvidence).toMatchObject({
      status: 'idle',
      activeRun: undefined,
      originSegmentId: idle.originSegmentId,
      rootUsers: [prompt],
      rootAnswers: [
        { content: SETTLEMENT_INITIAL_ANSWER, status: 'complete' },
        { content: SETTLEMENT_FINAL_ANSWER, status: 'complete' }
      ]
    })
    const finished = (await readEvidence())!
    expect(finished.rootAnswers[1].turnUsage).toMatchObject({
      inputTokens: 17,
      cacheTokens: 0,
      outputTokens: 5,
      turnCount: 1
    })
    expect(finished.rootAnswers[1].modelCallUsage).toMatchObject([
      { inputTokens: 17, cacheTokens: 0, outputTokens: 5 }
    ])
    const callIds = finished.rootAnswers.flatMap((answer) =>
      answer.modelCallUsage!.map(({ id }) => id)
    )
    expect(callIds).toHaveLength(2)
    expect(new Set(callIds).size).toBe(2)
    await expect(
      page.getByRole('log').getByText(SETTLEMENT_FINAL_ANSWER, { exact: true })
    ).toBeVisible()
    await expect(page.locator('[data-agent-running="true"]')).toHaveCount(0)
    await page
      .getByRole('textbox', { name: 'Ask anything' })
      .fill('Main is ready for another prompt.')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    await page.getByRole('textbox', { name: 'Ask anything' }).fill('')
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toHaveCount(0)
    expect(finished.rootAnswers[1].segmentId).not.toBe(idle.originSegmentId)
    expect(finished.rootAnswers[1].segmentId).toBeDefined()
    page = await app.restart()
    await expect.poll(readEvidence).toEqual(finished)
    expect(
      (await app.readFakeAgentPrompts()).filter(
        ({ role, sessionId, prompt }) =>
          role === 'main' &&
          sessionId === idle.sessionId &&
          prompt.includes('Delegated work settlement update')
      )
    ).toHaveLength(1)
  } finally {
    await writeFile(releaseFile, '')
  }
})

test('shows each completed Subagent while Main is still waiting for all three', async ({ app }) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await createProject(page, 'Per-Subagent completion progress')
  const directory = await app.createTestDirectory('subagent-completion-progress')
  const releaseFiles = [1, 2, 3].map((index) => join(directory, `release-${index}`))
  const prompt = `${PROGRESS_PROMPT}\nRelease files: ${JSON.stringify(releaseFiles)}`
  const finalAnswer = 'Main collected all three progress results.'
  const readRoot = async (): Promise<{ id: string; status: string; active: boolean } | undefined> =>
    page.evaluate(async () => {
      const session = (await window.api.sessions.loadAll()).sessions.find((session) =>
        session.conversationGraph?.frames.some((frame) => frame.delegateName === 'Progress child 1')
      )
      return (
        session && { id: session.id, status: session.status, active: Boolean(session.activeRun) }
      )
    })
  try {
    await page.getByRole('textbox', { name: 'Ask anything' }).fill(prompt)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    for (const index of [1, 2, 3]) {
      await expectDurableChildStatus(page, `Progress child ${index}`, 'running')
    }
    const root = (await readRoot())!
    await expect(page.getByTestId('subagent-completion')).toHaveCount(0)
    // Release independently: the first two notifications must render before the blocking
    // Host call returns, without admitting another Main prompt or manufacturing an answer.
    for (const index of [1, 2]) {
      await writeFile(releaseFiles[index - 1], '')
      await expectDurableChildStatus(page, `Progress child ${index}`, 'completed')
      await expect(page.getByTestId('subagent-completion')).toHaveCount(index)
      await expect(page.getByTestId('subagent-completion').nth(index - 1)).toContainText(
        `Progress child ${index}`
      )
      await expect(page.getByTestId('subagent-completion').nth(index - 1)).toBeVisible()
      await expect.poll(readRoot).toMatchObject({ status: 'running', active: true })
      await expect(page.getByRole('log').getByText(finalAnswer, { exact: true })).toHaveCount(0)
      expect(
        (await app.readFakeAgentPrompts()).filter(
          ({ role, sessionId }) => role === 'main' && sessionId === root.id
        )
      ).toHaveLength(1)
    }
    await writeFile(releaseFiles[2], '')
    await expect(page.getByTestId('subagent-completion')).toHaveCount(3)
    await expect(page.getByRole('log').getByText(finalAnswer, { exact: true })).toBeVisible()
    await expect.poll(readRoot).toMatchObject({ status: 'idle', active: false })
    const attemptIds = await page
      .getByTestId('subagent-completion')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-attempt-id')))
    expect(attemptIds.every(Boolean)).toBe(true)
    expect(new Set(attemptIds).size).toBe(3)
    page = await app.restart()
    await openRecentSession(page, PROGRESS_PROMPT)
    await expect(page.getByTestId('subagent-completion')).toHaveCount(3)
    expect(
      await page
        .getByTestId('subagent-completion')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-attempt-id')))
    ).toEqual(attemptIds)
    expect(
      (await app.readFakeAgentPrompts()).filter(
        ({ role, sessionId }) => role === 'main' && sessionId === root.id
      )
    ).toHaveLength(1)
  } finally {
    await Promise.all(releaseFiles.map((file) => writeFile(file, '')))
  }
})

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

  const releaseFile = join(await app.createTestDirectory('bounded-delegation'), 'release')
  await sendPrompt(
    page,
    `${BOUNDED_COLLECT_PROMPT}\nRelease file: ${JSON.stringify(releaseFile)}`,
    'Production bounded delegate returned while a Subagent kept running.',
    120_000
  )
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop subagents' })).toBeVisible()
  await writeFile(releaseFile, '')
  await sendPrompt(
    page,
    BOUNDED_RECOLLECT_PROMPT,
    'Production bounded collect journey completed.',
    120_000
  )
  await expectDurableChildStatus(page, 'Complete the bounded fixture after a delay.', 'completed')
  await expectRenderedChildStatus(page, TERMINAL_CHILD, 'completed')

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill(PERMISSION_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()
  const permissionCard = page.getByRole('group', {
    name: `${PERMISSION_CHILD} permission request: Allow tool access?`,
    exact: true
  })
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
  await page.getByRole('button', { name: `${USER_QUESTION_CHILD}, completed`, exact: true }).click()
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
  await expect
    .poll(() =>
      page.evaluate(async (projectId) => {
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
    )
    .toMatchObject({
      rendered: true,
      commands: expect.arrayContaining([
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
    })
})

test('parks an upward message on branch switch and resumes it after restart and restoration', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Reliable branch park release gate')
  const cwd = await app.createTestDirectory('reliable-branch-park')
  // Seed an unfenced durable queue on an idle Session. A running Main turn cannot switch
  // branches; Host RPC admission and concurrent delivery are exercised by the adjacent tests.
  const sessionId = 'e2e-park-session'
  const now = Date.now()
  const rootMessage = {
    id: 'park-origin',
    role: 'user' as const,
    content: RELIABLE_BRANCH_PARK_PROMPT,
    status: 'complete' as const,
    eventIds: [],
    createdAt: now,
    updatedAt: now,
    agentFrameId: 'park-root',
    introducedOnBranchId: 'park-branch',
    revisionRootMessageId: 'park-origin',
    runtimeSegmentId: 'park-segment'
  }
  const fixture: PersistedChatSession = {
    id: sessionId,
    projectId,
    cwd,
    title: RELIABLE_BRANCH_PARK_PROMPT,
    runtimeTranscriptOwner: 'main',
    status: 'idle',
    agentFrameworkId: 'opencode',
    messages: [rootMessage],
    createdAt: now,
    updatedAt: now,
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'park-root',
      activeFrameId: 'park-root',
      frames: [
        {
          id: 'park-root',
          kind: 'root',
          originBindingState: 'root',
          status: 'completed',
          activeBranchId: 'park-branch',
          createdAt: now
        },
        {
          id: 'park-child',
          kind: 'delegate',
          originBindingState: 'validated',
          originMessageId: rootMessage.id,
          parentFrameId: 'park-root',
          delegateName: 'Parked child',
          status: 'completed',
          activeBranchId: 'park-child-branch',
          createdAt: now
        }
      ],
      branches: [
        {
          id: 'park-branch',
          agentFrameId: 'park-root',
          headMessageId: rootMessage.id,
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'park-child-branch',
          agentFrameId: 'park-child',
          headMessageId: 'park-child-prompt',
          createdAt: now,
          updatedAt: now
        }
      ],
      messages: [
        rootMessage,
        {
          ...rootMessage,
          id: 'park-child-prompt',
          agentFrameId: 'park-child',
          introducedOnBranchId: 'park-child-branch',
          revisionRootMessageId: 'park-child-prompt',
          runtimeSegmentId: 'park-child-segment',
          content: 'Send Main a question'
        }
      ],
      runtimeSegments: [
        {
          id: 'park-segment',
          agentFrameId: 'park-root',
          frameworkId: 'opencode',
          startedAt: now
        },
        {
          id: 'park-child-segment',
          agentFrameId: 'park-child',
          frameworkId: 'opencode',
          startedAt: now,
          endedAt: now + 1
        }
      ],
      activities: [],
      activityGroups: []
    },
    runtimeContext: {
      version: 1,
      revision: 1,
      delegatedWork: {
        records: [
          {
            agentFrameId: 'park-child',
            attempts: [
              {
                id: 'park-attempt',
                status: 'completed',
                resolvedAgent: { kind: 'main' },
                runtimeSegmentIds: ['park-child-segment'],
                startedAt: now,
                endedAt: now + 1
              }
            ]
          }
        ],
        messageCommands: [
          {
            messageId: 'park-message',
            requestId: 'e2e-child-park',
            sourcePrincipal: 'park-child\u0000park-attempt',
            canonicalDigest: 'a'.repeat(64),
            sourceFrameId: 'park-child',
            sourceAttemptId: 'park-attempt',
            targetFrameId: 'park-root',
            rootPromptMessageId: 'park-message-root-prompt',
            rootOriginMessageId: rootMessage.id,
            callerRootMessageId: rootMessage.id,
            rootBranchId: 'park-branch',
            rootBranchRevision: `park-branch:${now}`,
            direction: 'to_parent',
            disposition: 'message',
            text: 'Parked reliable child question',
            kind: 'question',
            laneSequence: 1,
            queuedAt: now + 1,
            receipt: { status: 'queued' }
          }
        ]
      }
    }
  }
  page = await app.restartWithSessionFixture(
    applySessionConversationCommands(fixture, [
      {
        id: 'e2e-park-fork',
        kind: 'fork-message',
        timestamp: now + 2,
        branchId: 'e2e-park-other-branch',
        parentBranchId: 'park-branch',
        messageId: rootMessage.id
      }
    ])
  )
  await expect
    .poll(async () =>
      page.evaluate(async (sessionId) => {
        const loaded = await window.api.sessions.loadAll()
        const session = loaded.sessions.find(({ id }) => id === sessionId)!
        return {
          branchId: session.conversationGraph!.frames.find(({ id }) => id === 'park-root')!
            .activeBranchId,
          receipt: session.runtimeContext?.delegatedWork?.messageCommands?.[0]?.receipt
        }
      }, sessionId)
    )
    .toEqual({ branchId: 'e2e-park-other-branch', receipt: { status: 'queued' } })
  await page.screenshot({ path: testInfo.outputPath('late-output-selected-branch.png') })
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

  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    retrySessionRevisionConflict(() =>
      page.evaluate(
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
          await window.api.sessions.saveSession(session, {
            conversationCommands: [
              {
                id: 'e2e-park-restore',
                timestamp: Date.now(),
                kind: 'select-branch',
                branchId: command.rootBranchId,
                previousBranchId: root.activeBranchId
              }
            ]
          })
          window.setTimeout(() => window.location.reload(), 0)
        },
        { projectId, sessionId: sessionId! }
      )
    )
  ])
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
  await page.screenshot({ path: testInfo.outputPath('late-output-restored-branch.png') })
})

test('recovers a post-fence receipt persistence failure as uncertain after process termination', async ({
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
    .toEqual({ sessionStatus: 'running', dispatchStarted: true })
  expect(sessionId).toEqual(expect.any(String))
  page = await app.restartAfterCrash()
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

test('fairly schedules two upward lanes with a concurrent real user prompt', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  const projectId = await createProject(page, 'Reliable fairness release gate')

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  const releaseFile = join(await app.createTestDirectory('fairness-admission'), 'release')
  await composer.fill(`${RELIABLE_FAIRNESS_PROMPT}\nRelease file: ${JSON.stringify(releaseFile)}`)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Two upward lanes are starting.')).toBeVisible({ timeout: 120_000 })
  await expect
    .poll(async () =>
      page.evaluate(async (projectId) => {
        const loaded = await window.api.sessions.loadAll()
        const commands =
          loaded.sessions.find((candidate) => candidate.projectId === projectId)?.runtimeContext
            ?.delegatedWork?.messageCommands ?? []
        return commands
          .filter(({ requestId }) => requestId.startsWith('e2e-fairness-'))
          .map(({ requestId, receipt }) => ({ requestId, status: receipt.status }))
          .sort((left, right) => left.requestId.localeCompare(right.requestId))
      }, projectId)
    )
    .toEqual([
      { requestId: 'e2e-fairness-a', status: 'queued' },
      { requestId: 'e2e-fairness-b', status: 'queued' }
    ])
  await composer.fill(RELIABLE_FAIRNESS_USER_PROMPT)
  await page.getByTestId('composer-queue-submit').click()
  await expect(page.getByTestId('composer-queue-trigger')).toBeVisible()
  await writeFile(releaseFile, '')

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
  await page.screenshot({ path: testInfo.outputPath('concurrent-parent-messages.png') })
})

test('stops only the active branch and exposes a retryable partial failure', async ({
  app
}, testInfo) => {
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
  await expect(
    page.getByRole('alert', { name: /One or more Subagent Attempts could not be stopped/ })
  ).toContainText('One or more Subagent Attempts could not be stopped.')
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
  await page.screenshot({ path: testInfo.outputPath('stopped-selected-branch.png') })
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
  const inheritedChildTrigger = page.getByRole('button', {
    name: INHERITED_SPECIALIST_CHILD,
    exact: true
  })
  await inheritedChildTrigger.click()
  const inheritedPreview = page.getByRole('region', { name: 'Subagents' })
  await expect(inheritedPreview).toContainText('Release Specialist')
  await inheritedPreview.getByRole('button', { name: 'Close Subagents preview' }).click()
  await expect(inheritedChildTrigger).toBeFocused()

  page = await app.restart()
  await openRecentSession(page, INHERITED_SPECIALIST_PROMPT)
  await page.getByRole('button', { name: INHERITED_SPECIALIST_CHILD, exact: true }).click()
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
        return (await window.api.preview.load({ projectId }))?.state.subagents?.selectedAgentFrameId
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

test('preserves a quarantined delegated workspace after restart when Project deletion is retried', async ({
  app
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  const name = 'Protected delegated evidence'
  const projectId = await createProject(page, name)
  await sendPrompt(
    page,
    TERMINAL_PROMPT,
    'Production delegation reached a terminal result.',
    120_000
  )
  await expectDurableChildStatus(page, TERMINAL_CHILD, 'completed')
  const persisted = await page.evaluate(async (projectId) => {
    const session = (await window.api.sessions.loadAll()).sessions.find(
      (candidate) => candidate.projectId === projectId
    )!
    const record = session.runtimeContext!.delegatedWork!.records[0]
    return {
      dataRoot: (await window.api.storage.getInfo()).dataRoot,
      sessionId: session.id,
      frameId: record.agentFrameId,
      attemptId: record.attempts.at(-1)!.id,
      frameworkId: session.agentFrameworkId!
    }
  }, projectId)
  const receiptId = randomUUID()
  const receiptDirectory = join(
    persisted.dataRoot,
    'delegation-process-ownership',
    projectId,
    persisted.sessionId
  )
  const receiptPath = join(receiptDirectory, `${receiptId}.json`)
  const evidence = join(
    persisted.dataRoot,
    'delegation',
    projectId,
    persisted.sessionId,
    'frames',
    persisted.frameId,
    'protected-evidence.txt'
  )
  await writeFile(evidence, 'preserve this evidence')
  await mkdir(receiptDirectory, { recursive: true })
  // Seed the persisted cleanup-failure boundary. This UI test does not manufacture a live orphan;
  // production-composition regressions independently exercise receipt creation from cleanup failure.
  await writeFile(
    receiptPath,
    JSON.stringify({
      version: 1,
      receiptId,
      projectId,
      sessionId: persisted.sessionId,
      frameId: persisted.frameId,
      attemptId: persisted.attemptId,
      frameworkId: persisted.frameworkId,
      phase: 'cleanup-pending',
      createdAt: Date.now()
    })
  )
  try {
    page = await app.restartAfterCrash()
    const projects = page.getByRole('region', { name: 'Projects' })
    await projects.getByRole('button', { name, exact: true }).hover()
    await projects.getByRole('button', { name: `Open actions for ${name}` }).click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Delete project?' })
    for (let retry = 0; retry < 2; retry++) {
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(dialog).toContainText('Could not delete the project. Please try again.')
      expect(await readFile(evidence, 'utf8')).toBe('preserve this evidence')
      await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled()
    }
    await page.screenshot({
      path: testInfo.outputPath('quarantined-project-after-restart.png'),
      animations: 'disabled'
    })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(projects.getByRole('button', { name, exact: true })).toBeVisible()
  } finally {
    // Only this test-generated identity-less fixture is removed; it never represented a live tree.
    await unlink(receiptPath)
  }
})
