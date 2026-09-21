import { expect } from '@playwright/test'
import type { PersistedChatSession } from '../src/shared/session-persistence'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'

for (const recovery of [
  'ordinary-generation',
  'provider-stream-interruption-same-model',
  'provider-stream-interruption-switch-model',
  'snapshot'
] as const) {
  const isResume = recovery !== 'ordinary-generation'
  const switchModel =
    recovery === 'provider-stream-interruption-switch-model' || recovery === 'snapshot'
  const PROMPT = !isResume
    ? 'Create a PNG without interruption.'
    : recovery === 'snapshot'
      ? 'Create a PNG after interrupted recovery.'
      : 'Create a PNG after provider execution failure.'

  test(`publishes a PNG after ${recovery} and reloads its preview`, async ({ app }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await page.evaluate(async () => {
      await window.api.settings.upsertProvider({
        type: 'custom',
        name: 'Resume alternate provider',
        apiEndpoints: ['openai'],
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'resume-e2e-model',
        key: 'e2e-key'
      })
      await window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    })
    await createProject(page, 'Resumed PNG publication')
    await page.getByRole('textbox', { name: 'Ask anything' }).fill(PROMPT)
    await page.getByRole('button', { name: 'Send message' }).click()
    if (isResume) {
      await expect(
        page.getByText('PNG recovery checkpoint reached.', { exact: false })
      ).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(
            async (prompt) =>
              (await window.api.sessions.loadAll()).sessions
                .find((session) =>
                  session.messages.some(
                    (message) => message.role === 'user' && message.content === prompt
                  )
                )
                ?.messages.some(
                  (message) =>
                    message.role === 'agent' &&
                    message.content.includes('PNG recovery checkpoint reached.')
                ),
            PROMPT
          )
        )
        .toBe(true)
    }
    await expect
      .poll(() =>
        page.evaluate(
          async (prompt) =>
            (await window.api.sessions.loadAll()).sessions.some((session) =>
              session.messages.some(
                (message) => message.role === 'user' && message.content === prompt
              )
            ),
          PROMPT
        )
      )
      .toBe(true)
    const interrupted = await page.evaluate(async (prompt) => {
      const session = (await window.api.sessions.loadAll()).sessions.find((candidate) =>
        candidate.messages.some((message) => message.role === 'user' && message.content === prompt)
      )
      if (!session) throw new Error('The running Session was not persisted.')
      return session
    }, PROMPT)
    if (isResume) {
      if (recovery === 'snapshot') expect(interrupted.status).toBe('running')
      expect(interrupted.artifacts ?? []).toHaveLength(0)
      if (recovery === 'snapshot') {
        // Restore an actual in-flight record: graceful process-tree shutdown otherwise records an error.
        await expect(
          page.getByText('PNG initial attempt finished.', { exact: false })
        ).toBeVisible()
        await expect
          .poll(() =>
            page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0]?.status)
          )
          .toBe('idle')
        page = await app.restartWithSessionFixture(interrupted)
        await page
          .getByRole('region', { name: 'Recent sessions' })
          .getByRole('button', { name: PROMPT })
          .click()
      } else {
        await expect(
          page.getByRole('button', { name: 'Resume session', exact: true })
        ).toBeVisible()
        await expect
          .poll(() =>
            page.evaluate(
              async (id) =>
                (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id)
                  ?.resumeRecovery,
              interrupted.id
            )
          )
          .toMatchObject({ kind: 'resume-required', cause: 'connection-lost' })
      }
      if (switchModel) {
        await page.getByRole('button', { name: 'Select model', exact: true }).click()
        await page.getByRole('menuitem', { name: /^Model/ }).hover()
        await page.getByRole('menuitemradio', { name: 'resume-e2e-model', exact: true }).focus()
        await page.keyboard.press('Enter')
        await expect
          .poll(() =>
            page.evaluate(
              async (id) =>
                (await window.api.sessions.loadAll()).sessions.find((session) => session.id === id)
                  ?.agentConfiguration?.model,
              interrupted.id
            )
          )
          .toBe('resume-e2e-model')
      }
      await page.getByRole('button', { name: 'Resume session', exact: true }).click()
    }
    try {
      await expect(
        page.getByText(isResume ? 'Resumed PNG artifact created.' : 'PNG artifact created.', {
          exact: false
        })
      ).toBeVisible()
    } catch (error) {
      await testInfo.attach('resume-diagnostics', {
        body: JSON.stringify({
          sessions: await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions),
          prompts: await app.readFakeAgentPrompts()
        }),
        contentType: 'application/json'
      })
      throw error
    }
    const readSession = (): Promise<PersistedChatSession | undefined> =>
      page.evaluate(
        async (id) =>
          (await window.api.sessions.loadAll()).sessions.find((candidate) => candidate.id === id),
        interrupted.id
      )
    await expect.poll(async () => (await readSession())?.artifacts?.length).toBe(1)
    await expect.poll(async () => (await readSession())?.status).toBe('idle')
    const completed = (await readSession())!
    expect(completed.error).toBeUndefined()
    if (switchModel) {
      expect(completed.agentModel).toMatch(/(?:^|\/)resume-e2e-model$/)
      expect(completed.agentConfiguration?.model).toBe('resume-e2e-model')
      expect(completed.agentBackendId).not.toBe(interrupted.agentBackendId)
    } else {
      expect(completed.agentConfiguration?.model).toBe(interrupted.agentConfiguration?.model)
    }
    expect(completed.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    const artifact = completed.artifacts![0]
    const graph = completed.conversationGraph!
    const prompt = graph.messages.find((message) => message.role === 'user')!
    const owners = graph.messages.filter((message) => message.artifactIds?.includes(artifact.id))
    expect(owners).toHaveLength(1)
    if (switchModel) expect(graph.runtimeSegments.at(-1)?.id).not.toBe(prompt.runtimeSegmentId)
    else expect(graph.runtimeSegments.at(-1)?.id).toBe(prompt.runtimeSegmentId)
    expect(owners[0].runtimeSegmentId).toBe(graph.runtimeSegments.at(-1)?.id)
    expect(
      completed.runtimeSessionAdmissions?.some(
        (admission) =>
          admission.runtimeSegmentId === graph.runtimeSegments.at(-1)?.id &&
          admission.promptMessageId === prompt.id
      )
    ).toBe(true)
    expect(artifact.versionId).toBeTruthy()
    // Exercise the exact IPC reported by the user, in addition to live publication.
    // Repeating reconciliation must return the same Version, not duplicate publication.
    for (let retry = 0; retry < 2; retry += 1) {
      const reconciled = await page.evaluate(
        (request) => window.api.artifacts.reconcilePendingArtifacts(request),
        {
          projectId: completed.projectId!,
          sessionId: completed.id,
          messageId: owners[0].id,
          pendingPaths: [],
          artifactVersionIds: [artifact.versionId!]
        }
      )
      expect(reconciled).toEqual([
        expect.objectContaining({ versionId: artifact.versionId, isPublished: true })
      ])
    }
    await expect(page.getByText(/artifact finalization.*(failed|does not match)/i)).toHaveCount(0)
    page = await app.restart()
    await page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button', { name: PROMPT })
      .click()
    expect((await readSession())?.artifacts).toEqual(completed.artifacts)
    expect(
      (await readSession())?.messages.filter((message) => message.role === 'user')
    ).toHaveLength(1)
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page
      .getByTestId('project-files-scroll')
      .getByRole('button', { name: /Preview generated file/ })
      .filter({ has: page.getByRole('img', { name: 'Preview of resumed-figure.png' }) })
      .click()
    await expect(
      page.getByRole('button', { name: 'Close preview of resumed-figure.png' })
    ).toBeVisible()
    const image = page.getByRole('img', { name: 'resumed-figure.png', exact: true })
    await expect(image).toBeVisible()
    await expect
      .poll(() =>
        image.evaluate((element) => {
          const png = element as HTMLImageElement
          return { complete: png.complete, width: png.naturalWidth, height: png.naturalHeight }
        })
      )
      .toEqual({ complete: true, width: 160, height: 112 })
    const previewScreenshot = testInfo.outputPath('published-preview-after-restart.png')
    await page.screenshot({ path: previewScreenshot })
    await testInfo.attach('published-preview-after-restart', {
      path: previewScreenshot,
      contentType: 'image/png'
    })
  })
}
