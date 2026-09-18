import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import type { ReviewWithChecks } from '../src/shared/reviewer'
import type { TaskRun } from '../src/shared/task-api'
import { test } from './fixtures/electron-app'
import { createProject, openRecentSession, sendPrompt } from './certification/helpers'

const execute = promisify(execFile)
const prompt = 'Create a provenance artifact. Automatic Reviewer artifact evidence.'
const expectedContent = 'artifact provenance e2e'
const expectedChecksum = createHash('sha256').update(expectedContent).digest('hex')

type ReviewerCapture = {
  kind: 'dispatch' | 'artifact-read'
  sessionId: string
  appSessionId?: string
  artifactId?: string
  versionId?: string
  checksum?: string
  content?: string
  descriptor?: { checksum: string; contentStatus: string; sizeBytes: number }
  readVersionId?: string
  traceVersionId?: string
}

for (const background of [false, true]) {
  test(`automatically reviews exact published bytes from ${background ? 'an unopened CLI Task' : 'a desktop turn'} once across restart`, async ({
    app
  }, testInfo) => {
    test.setTimeout(240_000)
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await page.evaluate(async () => {
      await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
      await window.api.settings.setReviewerModel({ configuration: { mode: 'inherit' } })
    })
    const projectId = await createProject(
      page,
      `Automatic Reviewer ${background ? 'Task' : 'desktop'}`
    )
    const evidenceRoot = await app.createTestDirectory('automatic-review-evidence')
    const configRoot = join(dirname(evidenceRoot), 'storage')
    const readCaptures = async (): Promise<ReviewerCapture[]> => {
      const text = await readFile(
        join(configRoot, 'e2e-handoff-captures', 'reviewer-artifact-evidence.jsonl'),
        'utf8'
      )
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ReviewerCapture)
    }
    let task: TaskRun | undefined
    if (background) {
      const webUrl = new URL(await app.authenticatedWebUrl())
      const service = JSON.parse(await readFile(join(configRoot, 'web-service.json'), 'utf8'))
      expect(String(service.port)).toBe(webUrl.port)
      const cli = async (args: string[]): Promise<TaskRun> => {
        const { stdout } = await execute(
          process.execPath,
          [
            resolve('packages/open-science/cli.mjs'),
            ...args,
            '--config-root',
            configRoot,
            '--json'
          ],
          { timeout: 30_000, maxBuffer: 1024 * 1024 }
        )
        return JSON.parse(stdout) as TaskRun
      }
      task = await cli([
        'run',
        '--project',
        projectId,
        '--prompt',
        prompt,
        '--approval-profile',
        'auto',
        '--auto-review'
      ])
      const taskId = task.id
      await expect
        .poll(
          async () => {
            task = await cli(['run', 'status', taskId])
            return task.status
          },
          { timeout: 120_000, intervals: [500, 1000] }
        )
        .not.toBe('running')
      expect(task.status).toBe('completed')
      expect(task.error).toBeUndefined()
      expect(task.review).toMatchObject({ started: true, lifecycle: 'complete', outcome: 'pass' })
      // The Task and its automatic Review finish before the desktop opens this Session.
      await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
    } else {
      await page.getByTestId('composer-controls-trigger').click()
      await page.getByRole('menuitem', { name: 'Auto-review', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('composer-controls-trigger')).toHaveAttribute(
        'aria-label',
        /auto-review On/u
      )
      await sendPrompt(page, prompt, 'Artifact provenance verified for session', 90_000)
    }
    const readSession = (): Promise<PersistedChatSession | undefined> =>
      page.evaluate(
        async ({ projectId, prompt }) =>
          (await window.api.sessions.loadAll()).sessions.find(
            (session) =>
              session.projectId === projectId &&
              session.messages.some(
                (message) => message.role === 'user' && message.content === prompt
              )
          ),
        { projectId, prompt }
      )
    await expect.poll(readSession, { timeout: 90_000 }).toMatchObject({
      status: 'idle',
      runtimeTranscriptOwner: 'main',
      autoReviewEnabled: true
    })
    const session = (await readSession())!
    expect(session.activeRun).toBeUndefined()
    expect(session.error).toBeUndefined()
    expect(session.artifacts).toHaveLength(1)
    const artifact = session.artifacts![0]
    expect(artifact.sha256).toBe(expectedChecksum)
    const owners = session.conversationGraph!.messages.filter((message) =>
      message.artifactIds?.includes(artifact.id)
    )
    expect(owners).toHaveLength(1)
    const owner = owners[0]
    expect(owner.responseToMessageId).toBe(session.runtimeTranscriptLastRun?.promptMessageId)
    const readReviews = (): Promise<ReviewWithChecks[]> =>
      page.evaluate(
        async ({ projectId, sessionId }) =>
          window.api.reviewer.getForSession({ projectId, appSessionId: sessionId }),
        { projectId, sessionId: session.id }
      )
    await expect
      .poll(async () => (await readReviews()).map(({ lifecycle }) => lifecycle), {
        timeout: 120_000
      })
      .toEqual(['complete'])
    const [review] = await readReviews()
    expect(review).toMatchObject({
      projectId,
      sessionId: session.id,
      turnMessageId: owner.id,
      lifecycle: 'complete',
      outcome: 'pass',
      scope: { turnMessageId: owner.id, artifactVersionIds: [artifact.versionId] }
    })
    expect(review.errorMessage).toBeUndefined()
    expect(review.stale).not.toBe(true)
    expect(review.checks).toHaveLength(1)
    expect(review.checks[0]).toMatchObject({
      reviewId: review.id,
      status: 'pass',
      artifactVersionId: artifact.versionId,
      artifactBindingState: 'scope_validated'
    })
    expect(review.checks[0].evidence).toContain(expectedChecksum)
    const coverageEntry = review.reviewerLog.find(
      (entry) => entry.kind === 'tool' && entry.toolName === 'review_coverage'
    )
    if (coverageEntry?.kind !== 'tool' || !coverageEntry.rawOutput)
      throw new Error('Reviewer host did not persist evidence coverage.')
    expect(JSON.parse(coverageEntry.rawOutput)).toMatchObject({
      turnRead: true,
      artifactReads: [
        {
          versionId: artifact.versionId,
          role: 'work_product',
          contentRead: true,
          traceRead: true,
          partial: false
        }
      ]
    })
    const captures = await readCaptures()
    expect(captures.filter((entry) => entry.kind === 'dispatch')).toHaveLength(1)
    expect(captures.filter((entry) => entry.kind === 'artifact-read')).toEqual([
      expect.objectContaining({
        appSessionId: session.id,
        artifactId: artifact.artifactId,
        versionId: artifact.versionId,
        readVersionId: artifact.versionId,
        traceVersionId: artifact.versionId,
        content: expectedContent,
        checksum: expectedChecksum,
        descriptor: expect.objectContaining({
          checksum: expectedChecksum,
          contentStatus: 'available',
          sizeBytes: Buffer.byteLength(expectedContent)
        })
      })
    ])
    if (task) {
      expect(task.review?.id).toBe(review.id)
      expect(task.artifacts).toHaveLength(1)
      expect(task.artifacts[0]).toMatchObject({
        versionId: artifact.versionId,
        checksum: expectedChecksum,
        messageId: owner.id
      })
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .locator('button[data-slot="session-open-button"]')
        .filter({ hasText: 'Create a provenance artifact.' })
        .click()
      await expect(
        page.getByText('Artifact provenance verified for session', { exact: false })
      ).toBeVisible()
      expect((await readReviews()).map(({ id }) => id)).toEqual([review.id])
      expect(await readCaptures()).toEqual(captures)
    }
    await testInfo.attach('automatic-review-evidence', {
      body: JSON.stringify({ sessionId: session.id, artifact, review, captures }),
      contentType: 'application/json'
    })
    page = await app.restart()
    await openRecentSession(page, prompt)
    await expect(
      page.getByText('Artifact provenance verified for session', { exact: false })
    ).toBeVisible()
    expect(await readReviews()).toEqual([review])
    expect(await readCaptures()).toEqual(captures)
    expect((await readSession())?.artifacts).toEqual(session.artifacts)
    await page.screenshot({ path: testInfo.outputPath('automatic-review-after-restart.png') })
  })
}
