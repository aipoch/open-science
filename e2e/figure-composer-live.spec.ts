import { expect, type Page } from '@playwright/test'

import { createProject } from './certification/helpers'
import { test } from './fixtures/electron-app'

const sourceSettingsPath = process.env.OPEN_SCIENCE_FIGURE_E2E_SOURCE_SETTINGS
const liveTest = sourceSettingsPath ? test : test.skip
const sequentialPanels = process.env.OPEN_SCIENCE_FIGURE_E2E_SEQUENTIAL_PANELS === '1'
const liveProvider =
  process.env.OPEN_SCIENCE_FIGURE_E2E_PROVIDER_KIND === 'codex-subscription'
    ? ({ kind: 'codex-subscription' } as const)
    : ({
        kind: 'configured',
        name: process.env.OPEN_SCIENCE_FIGURE_E2E_PROVIDER ?? 'GLM Coding Plan'
      } as const)

type FigureRun = {
  rootDone: boolean
  rootFrameId?: string
  skillForced: boolean
  skillLoaded: boolean
  usedNativeSpawn: boolean
  delegateFrameCount: number
  skillLoads: Array<{ frameId: string; title: string }>
  panelNotebookRuns: Array<{ frameId: string; title: string }>
  panelImageViews: Array<{ frameId: string; title: string; count: number }>
  reviewImageViews: Array<{ frameId: string; title: string; count: number }>
  attempts: Array<{
    frameId: string
    attemptId: string
    name?: string
    status?: string
    startedAt: number
    endedAt?: number
    error?: { code: string; message: string }
    artifactIds: string[]
    structuredOutputEvidencePresent: boolean
    structuredOutput?: unknown
    terminalText?: string
  }>
  artifacts: Array<{
    id: string
    artifactId?: string
    versionId?: string
    name?: string
    path: string
    contentState?: string
    inputVersionIds: string[]
  }>
  files: Array<{
    name: string
    path: string
  }>
  transcript: string
  rootTranscript: string
}

type PanelOutput = { panelVersionId: string }
type CompositeOutput = { compositeVersionId: string }
type ReviewOutput = { editor_verdict: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasStringProperty = <Key extends string>(
  value: unknown,
  key: Key
): value is Record<Key, string> => isRecord(value) && typeof value[key] === 'string'

const isPanelOutput = (value: unknown): value is PanelOutput =>
  hasStringProperty(value, 'panelVersionId')

const isCompositeOutput = (value: unknown): value is CompositeOutput =>
  hasStringProperty(value, 'compositeVersionId')

const isReviewOutput = (value: unknown): value is ReviewOutput =>
  hasStringProperty(value, 'editor_verdict')

const readFigureRun = async (page: Page, projectId: string): Promise<FigureRun> =>
  page.evaluate(
    async ({ projectId }) => {
      const sessions = (await window.api.sessions.loadAll()).sessions
      const session = sessions.find((candidate) => candidate.projectId === projectId)
      if (!session) {
        return {
          rootDone: false,
          rootFrameId: undefined,
          skillForced: false,
          skillLoaded: false,
          usedNativeSpawn: false,
          delegateFrameCount: 0,
          skillLoads: [],
          panelNotebookRuns: [],
          panelImageViews: [],
          reviewImageViews: [],
          attempts: [],
          artifacts: [],
          files: [],
          transcript: '',
          rootTranscript: ''
        }
      }

      const messages = session.conversationGraph?.messages ?? []
      const delegateFrames = (session.conversationGraph?.frames ?? []).filter(
        (frame) => frame.kind === 'delegate'
      )
      const attempts = delegateFrames
        .flatMap((frame) => {
          const record = session.runtimeContext?.delegatedWork?.records.find(
            (candidate) => candidate.agentFrameId === frame.id
          )
          return (record?.attempts ?? []).map((attempt) => {
            const structuredMessage = messages.find(
              (message) =>
                message.agentFrameId === frame.id &&
                message.structuredOutputEvidence?.attemptId === attempt.id
            )
            const structuredEvidence = structuredMessage?.structuredOutputEvidence
            const terminal = messages.find((message) => message.id === attempt.terminalMessageId)
            return {
              frameId: frame.id,
              attemptId: attempt.id,
              name: frame.delegateName,
              status: attempt.status,
              startedAt: attempt.startedAt,
              endedAt: attempt.endedAt,
              error: attempt.error,
              artifactIds: terminal?.artifactIds ?? [],
              structuredOutputEvidencePresent:
                structuredEvidence?.accepted !== undefined &&
                structuredMessage?.structuredOutputEvidenceInvalid !== true,
              structuredOutput: structuredEvidence?.accepted?.value,
              terminalText: terminal?.content
            }
          })
        })
        .sort((left, right) => left.startedAt - right.startedAt)

      const artifacts = await Promise.all(
        (session.artifacts ?? []).map(async (artifact) => {
          const provenance =
            artifact.artifactId && artifact.versionId
              ? await window.api.artifacts.getVersionProvenance({
                  projectId,
                  appSessionId: session.id,
                  artifactId: artifact.artifactId,
                  versionId: artifact.versionId
                })
              : undefined
          return {
            id: artifact.id,
            artifactId: artifact.artifactId,
            versionId: artifact.versionId,
            name: artifact.name,
            path: artifact.path,
            contentState: provenance?.contentStatus.state,
            inputVersionIds:
              provenance?.evidence.inputs
                .filter((input) => input.source_kind === 'artifact-version')
                .map((input) => input.input_file_version_id) ?? []
          }
        })
      )
      const files = await window.api.artifacts.listProjectFiles({ projectId })
      const rootFrameId = session.conversationGraph?.rootFrameId
      const rootMessages = messages.filter((message) => message.agentFrameId === rootFrameId)
      const isTerminalActivity = (status: string): boolean =>
        status === 'completed' || status === 'failed'
      const skillLoads = (session.conversationGraph?.activities ?? [])
        .filter(
          (activity) =>
            isTerminalActivity(activity.status) &&
            (activity.title.startsWith('Loaded skill: ') ||
              /os-figure-(?:composer|style)|figure-(?:composer|style)/i.test(activity.title))
        )
        .map((activity) => ({ frameId: activity.agentFrameId, title: activity.title }))
      const reviewerFrameIds = new Set(
        delegateFrames
          .filter((frame) => /review/i.test(frame.delegateName ?? ''))
          .map((frame) => frame.id)
      )
      const panelFrameIds = new Set(
        delegateFrames
          .filter((frame) => /panel[_-][ab](?:[_-]|$)/i.test(frame.delegateName ?? ''))
          .map((frame) => frame.id)
      )
      const panelNotebookRuns = (session.conversationGraph?.activities ?? [])
        .filter(
          (activity) =>
            isTerminalActivity(activity.status) &&
            panelFrameIds.has(activity.agentFrameId) &&
            activity.title === 'mcp.open-science-notebook.notebook_execute'
        )
        .map((activity) => ({ frameId: activity.agentFrameId, title: activity.title }))
      const imageViews = (session.conversationGraph?.activities ?? [])
        .filter((activity) => isTerminalActivity(activity.status))
        .flatMap((activity) => {
          const serializedContent = JSON.stringify(activity.toolContent ?? [])
          const transientImageCount =
            serializedContent.match(/\[image:\s*image\/(?:png|jpeg)\]/giu)?.length ?? 0
          const count = Math.max(
            activity.title.startsWith('View Image ') ? 1 : 0,
            transientImageCount
          )
          return count > 0 ? [{ frameId: activity.agentFrameId, title: activity.title, count }] : []
        })
      const panelImageViews = imageViews.filter((view) => panelFrameIds.has(view.frameId))
      const reviewImageViews = imageViews.filter((view) => reviewerFrameIds.has(view.frameId))
      return {
        rootDone: session.status === 'idle',
        rootFrameId,
        skillForced: messages.some((message) =>
          message.parts?.some((part) => part.type === 'skill' && part.id === 'figure-composer')
        ),
        skillLoaded: (session.activities ?? []).some(
          (activity) =>
            activity.status === 'completed' &&
            (activity.title === 'Loaded skill: figure-composer' ||
              activity.title === 'Loaded skill: os-figure-composer' ||
              activity.title.includes('/skills/os-figure-composer/SKILL.md'))
        ),
        usedNativeSpawn: (session.activities ?? []).some(
          (activity) => activity.title === 'spawnAgent'
        ),
        delegateFrameCount: delegateFrames.length,
        skillLoads,
        panelNotebookRuns,
        panelImageViews,
        reviewImageViews,
        attempts,
        artifacts,
        files: files
          .filter((file) => file.sessionId === session.id)
          .map((file) => ({
            name: file.name,
            path: file.path
          })),
        transcript: messages.map((message) => message.content).join('\n'),
        rootTranscript: rootMessages.map((message) => message.content).join('\n')
      }
    },
    { projectId }
  )

liveTest('completes figure-composer panel delegation in the real Electron app', async ({ app }) => {
  test.setTimeout(60 * 60_000)
  const page = await app.configureLiveProviderFromSettings({
    sourceSettingsPath: sourceSettingsPath!,
    provider: liveProvider,
    model: process.env.OPEN_SCIENCE_FIGURE_E2E_MODEL ?? 'glm-5.3-flash'
  })
  const projectId = await createProject(page, 'Figure composer live release gate')

  const prompt = [
    'Create a minimal two-panel scientific figure with the forced figure-composer Skill.',
    'This is an orchestration test: use exactly panels A and B, both simple schematics with no input data.',
    'Panel A shows input flowing into analysis; panel B shows analysis flowing into a result.',
    'Treat A and B as two locally complete stage summaries, not one diagram continued across the seam; use distinct node styling so the repeated Analysis label is context, not a shared seam node.',
    'Use a 120 mm, 12-column outline with one compact 38 mm row: A at row 0, col 0, colspan 6; B at row 0, col 6, colspan 6.',
    'Set fixed_panel_set true because the exact two-panel A/B set is a user requirement; review must preserve it.',
    'Delegate both panel renderings to Subagents using the Skill workflow, compose them, and return the final Artifact.',
    sequentialPanels
      ? 'For this provider regression, use ordered waves of one: collect panel A to completion before dispatching panel B.'
      : '',
    'Do not ask questions and do not add extra panels.'
  ]
    .filter(Boolean)
    .join(' ')
  const editor = page.getByRole('textbox', { name: 'Ask anything' })
  await editor.fill('/figure')
  const skillOption = page
    .getByRole('listbox', { name: 'Skill suggestions' })
    .getByRole('option')
    .filter({ hasText: 'Figure Composer' })
  await expect(skillOption).toHaveCount(1)
  await skillOption.click()
  await expect(editor.locator('[data-skill-id]')).toHaveCount(1)
  await editor.press('End')
  await editor.pressSequentially(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect
    .poll(async () => (await readFigureRun(page, projectId)).rootDone, {
      timeout: 58 * 60_000,
      intervals: [1_000, 2_000, 5_000]
    })
    .toBe(true)

  const result = await readFigureRun(page, projectId)
  const diagnostics = JSON.stringify(result, null, 2)
  type FigureAttempt = (typeof result.attempts)[number]
  type PanelAttempt = FigureAttempt & { structuredOutput: PanelOutput }
  type CompositeAttempt = FigureAttempt & { structuredOutput: CompositeOutput }
  const isPanelAttempt = (attempt: FigureAttempt): attempt is PanelAttempt =>
    isPanelOutput(attempt.structuredOutput)
  const isCompositeAttempt = (attempt: FigureAttempt): attempt is CompositeAttempt =>
    isCompositeOutput(attempt.structuredOutput)
  const panelLetter = (attempt: FigureAttempt): 'a' | 'b' | undefined => {
    const letter = attempt.name?.match(/panel[_-]([ab])(?:[_-]|$)/i)?.[1]?.toLowerCase()
    return letter === 'a' || letter === 'b' ? letter : undefined
  }
  const rawPanelAttempts = result.attempts.filter((attempt) => panelLetter(attempt) !== undefined)
  const panelAttempts = result.attempts.filter(isPanelAttempt)
  const compositeAttempts = result.attempts.filter(isCompositeAttempt)
  const reviewAttempts = result.attempts.filter((attempt) =>
    isReviewOutput(attempt.structuredOutput)
  )
  const panelArtifact = (attempt: PanelAttempt): FigureRun['artifacts'][number] | undefined => {
    const letter = panelLetter(attempt)
    if (!letter) return undefined
    const versionId = attempt.structuredOutput.panelVersionId
    return result.artifacts.find(
      (candidate) =>
        candidate.id === versionId &&
        candidate.versionId === versionId &&
        candidate.artifactId !== undefined &&
        candidate.name?.toLowerCase() === `panel_${letter}.png` &&
        candidate.contentState === 'available'
    )
  }
  const validPanelAttempts = panelAttempts.filter(
    (attempt) =>
      attempt.artifactIds.length === 1 &&
      attempt.artifactIds[0] === attempt.structuredOutput.panelVersionId &&
      panelArtifact(attempt) !== undefined
  )
  const rejectedPanelAttempts = rawPanelAttempts.filter(
    (attempt) => !isPanelAttempt(attempt) || !validPanelAttempts.includes(attempt)
  )
  const compositeArtifact = (
    attempt: CompositeAttempt
  ): FigureRun['artifacts'][number] | undefined => {
    const versionId = attempt.structuredOutput.compositeVersionId
    return result.artifacts.find(
      (candidate) =>
        candidate.id === versionId &&
        candidate.versionId === versionId &&
        candidate.artifactId !== undefined &&
        candidate.name === 'figure.png' &&
        candidate.contentState === 'available'
    )
  }
  const latestValidatedPanelBefore = (
    letter: 'a' | 'b',
    startedAt: number
  ): PanelAttempt | undefined => {
    const latest = panelAttempts
      .filter((attempt) => panelLetter(attempt) === letter && attempt.startedAt <= startedAt)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    return latest?.endedAt !== undefined &&
      latest.endedAt <= startedAt &&
      validPanelAttempts.includes(latest)
      ? latest
      : undefined
  }

  expect(result.skillForced, diagnostics).toBe(true)
  expect(result.skillLoaded, diagnostics).toBe(true)
  expect(result.usedNativeSpawn, diagnostics).toBe(false)
  expect(result.transcript, diagnostics).not.toContain('ACP connection closed')
  expect(result.transcript, diagnostics).not.toMatch(
    /delegation inputs must be immutable|delegation input is unavailable/i
  )
  expect(result.attempts.length, diagnostics).toBeGreaterThanOrEqual(4)
  expect(result.attempts.length, diagnostics).toBeLessThanOrEqual(8)
  expect(new Set(result.attempts.map((attempt) => attempt.frameId)).size, diagnostics).toBe(
    result.delegateFrameCount
  )
  expect(result.attempts, diagnostics).not.toContainEqual(
    expect.objectContaining({ status: 'running' })
  )
  expect(
    result.attempts.every((attempt) => attempt.status === 'completed'),
    diagnostics
  ).toBe(true)
  expect(
    result.attempts.every(
      (attempt) =>
        rejectedPanelAttempts.includes(attempt) || attempt.structuredOutputEvidencePresent
    ),
    diagnostics
  ).toBe(true)
  expect(
    result.attempts.every(
      (attempt) =>
        rejectedPanelAttempts.includes(attempt) ||
        isPanelOutput(attempt.structuredOutput) ||
        isCompositeOutput(attempt.structuredOutput) ||
        isReviewOutput(attempt.structuredOutput)
    ),
    diagnostics
  ).toBe(true)
  expect(rawPanelAttempts.length, diagnostics).toBeGreaterThanOrEqual(2)
  expect(rawPanelAttempts.length, diagnostics).toBeLessThanOrEqual(4)
  for (const attempt of rawPanelAttempts) {
    expect(
      result.panelNotebookRuns.filter((run) => run.frameId === attempt.frameId).length,
      diagnostics
    ).toBeLessThanOrEqual(2)
    expect(
      result.panelImageViews
        .filter((view) => view.frameId === attempt.frameId)
        .reduce((total, view) => total + view.count, 0),
      diagnostics
    ).toBe(0)
  }
  expect(
    validPanelAttempts.filter((attempt) => panelLetter(attempt) === 'a').length,
    diagnostics
  ).toBeGreaterThanOrEqual(1)
  expect(
    validPanelAttempts.filter((attempt) => panelLetter(attempt) === 'b').length,
    diagnostics
  ).toBeGreaterThanOrEqual(1)
  for (const attempt of validPanelAttempts) {
    expect(attempt.status, diagnostics).toBe('completed')
    expect(attempt.artifactIds, diagnostics).toHaveLength(1)
    const artifact = panelArtifact(attempt)
    expect(attempt.artifactIds[0], diagnostics).toBe(attempt.structuredOutput.panelVersionId)
    expect(artifact, diagnostics).toBeDefined()
    expect(artifact?.path.length, diagnostics).toBeGreaterThan(0)
  }
  for (const rejected of rejectedPanelAttempts) {
    const letter = panelLetter(rejected)
    const retry = panelAttempts.find(
      (candidate) =>
        letter !== undefined &&
        panelLetter(candidate) === letter &&
        candidate.attemptId !== rejected.attemptId &&
        candidate.startedAt > rejected.startedAt
    )
    expect(rejected.status, diagnostics).toBe('completed')
    expect(rejected.endedAt, diagnostics).toBeDefined()
    if (!isPanelAttempt(rejected)) {
      expect(rejected.structuredOutputEvidencePresent, diagnostics).toBe(false)
      expect(rejected.artifactIds, diagnostics).toHaveLength(0)
    }
    expect(letter, diagnostics).toBeDefined()
    expect(retry, diagnostics).toBeDefined()
    expect(retry?.startedAt, diagnostics).toBeGreaterThanOrEqual(
      rejected.endedAt ?? Number.MAX_VALUE
    )
    expect(retry && validPanelAttempts.includes(retry), diagnostics).toBe(true)
    expect(retry?.frameId, diagnostics).not.toBe(rejected.frameId)
    expect(retry?.name, diagnostics).not.toBe(rejected.name)
  }
  expect(compositeAttempts.length, diagnostics).toBeGreaterThanOrEqual(1)
  expect(compositeAttempts.length, diagnostics).toBeLessThanOrEqual(2)
  for (const attempt of compositeAttempts) {
    expect(attempt.status, diagnostics).toBe('completed')
    expect(attempt.artifactIds, diagnostics).toHaveLength(1)
    const artifact = compositeArtifact(attempt)
    expect(attempt.artifactIds[0], diagnostics).toBe(attempt.structuredOutput.compositeVersionId)
    expect(artifact, diagnostics).toBeDefined()
    expect(artifact?.path.length, diagnostics).toBeGreaterThan(0)

    const panelA = latestValidatedPanelBefore('a', attempt.startedAt)
    const panelB = latestValidatedPanelBefore('b', attempt.startedAt)
    expect(panelA, diagnostics).toBeDefined()
    expect(panelB, diagnostics).toBeDefined()
    expect(artifact?.inputVersionIds, diagnostics).toEqual([
      panelA?.structuredOutput.panelVersionId,
      panelB?.structuredOutput.panelVersionId
    ])
  }
  expect(reviewAttempts.length, diagnostics).toBeGreaterThanOrEqual(1)
  expect(reviewAttempts.length, diagnostics).toBeLessThanOrEqual(2)
  for (const review of reviewAttempts) {
    const imageViewCount = result.reviewImageViews
      .filter((view) => view.frameId === review.frameId)
      .reduce((total, view) => total + view.count, 0)
    expect(imageViewCount, diagnostics).toBeGreaterThanOrEqual(1)
    expect(imageViewCount, diagnostics).toBeLessThanOrEqual(2)
  }

  const rootFigureAutoLoads = result.skillLoads.filter(
    (load) =>
      load.title.startsWith('Loaded skill: ') &&
      /figure-composer|os-figure-composer/i.test(load.title)
  )
  expect(rootFigureAutoLoads, diagnostics).toHaveLength(1)
  expect(result.rootFrameId, diagnostics).toBeDefined()
  expect(rootFigureAutoLoads[0]?.frameId, diagnostics).toBe(result.rootFrameId)
  const rootComposerSkillReads = result.skillLoads.filter(
    (load) =>
      load.frameId === result.rootFrameId &&
      !load.title.startsWith('Loaded skill: ') &&
      /os-figure-composer\/SKILL\.md|figure-composer\/SKILL\.md/i.test(load.title)
  )
  expect(rootComposerSkillReads, diagnostics).toHaveLength(1)
  const unexpectedRootFigureAccesses = result.skillLoads.filter(
    (load) =>
      load.frameId === result.rootFrameId &&
      /figure-composer|os-figure-composer|figure-style/i.test(load.title) &&
      !(
        load.title.startsWith('Loaded skill: ') &&
        /figure-composer|os-figure-composer/i.test(load.title)
      ) &&
      !rootComposerSkillReads.includes(load)
  )
  expect(unexpectedRootFigureAccesses, diagnostics).toEqual([])
  expect(
    result.skillLoads.filter(
      (load) =>
        load.frameId !== result.rootFrameId &&
        /figure-composer|os-figure-composer|figure-style/i.test(load.title)
    ),
    diagnostics
  ).toEqual([])

  const latestComposite = compositeAttempts.at(-1)
  expect(latestComposite, diagnostics).toBeDefined()
  const finalCompositeArtifact = latestComposite && compositeArtifact(latestComposite)
  const latestPanelA = validPanelAttempts.filter((attempt) => panelLetter(attempt) === 'a').at(-1)
  const latestPanelB = validPanelAttempts.filter((attempt) => panelLetter(attempt) === 'b').at(-1)
  expect(
    panelAttempts.every(
      (attempt) => latestComposite !== undefined && attempt.startedAt <= latestComposite.startedAt
    ),
    diagnostics
  ).toBe(true)
  expect(finalCompositeArtifact?.inputVersionIds, diagnostics).toEqual([
    latestPanelA?.structuredOutput.panelVersionId,
    latestPanelB?.structuredOutput.panelVersionId
  ])
  expect(finalCompositeArtifact?.versionId, diagnostics).toBe(
    latestComposite?.structuredOutput.compositeVersionId
  )
  expect(result.rootTranscript, diagnostics).toMatch(/\[figure\.png\]\([^)]+\)/)

  const expectedNames = new Set([
    ...validPanelAttempts.map((attempt) => panelArtifact(attempt)?.name),
    ...compositeAttempts.map((attempt) => compositeArtifact(attempt)?.name)
  ])
  expectedNames.delete(undefined)
  for (const name of expectedNames) {
    const versionCount = result.artifacts.filter((artifact) => artifact.name === name).length
    expect(versionCount, diagnostics).toBeGreaterThan(0)
    expect(
      result.files.filter((file) => file.name === name && file.path.length > 0).length,
      diagnostics
    ).toBeGreaterThanOrEqual(versionCount)
  }
})
