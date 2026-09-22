import { expect, type Page } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession, sendPrompt } from './certification/helpers'

test.use({ channel: process.env.OPEN_SCIENCE_E2E_BROWSER_CHANNEL })

test('Web observers receive runtime history without saving it, and retain explicit interaction', async ({
  app,
  browser
}, testInfo) => {
  test.setTimeout(150_000)
  await app.completeOnboarding()
  const desktop = await app.configureFakeAgent()
  await desktop.evaluate(() =>
    window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
  )
  const lease = await desktop.evaluate(() => window.api.lifecycle.claimRuntimeWriter())
  expect(lease.token).toBeTruthy()
  const projectId = await createProject(desktop, 'Runtime writer test')
  await sendPrompt(
    desktop,
    'Initialize writer fixture.',
    'Deterministic reply: Summarize the deterministic fixture.'
  )
  await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
  const session = await desktop.evaluate(async (projectId) => {
    const { sessions } = await window.api.sessions.loadAll()
    return sessions.find((s) => s.projectId === projectId)!
  }, projectId)
  const web = await browser.newPage()
  const observer = await browser.newPage()
  web.setDefaultTimeout(15_000)
  observer.setDefaultTimeout(15_000)
  const requests: Array<{ client: string; sessionId: string }> = []
  const watch = (page: Page, client: string): void => {
    page.on('request', (request) => {
      if (decodeURIComponent(new URL(request.url()).pathname) !== '/rpc/sessions:save-session')
        return
      const body = request.postDataJSON()
      requests.push({ client, sessionId: body.args?.[0]?.id })
    })
  }
  const noWarning = async (page: Page): Promise<void> => {
    await expect(
      page.getByText(
        /Open Science could not save the latest conversation changes|This conversation was changed in another window|Conversation storage needs attention/i
      )
    ).toHaveCount(0)
  }
  try {
    const url = await app.authenticatedWebUrl()
    await web.goto(url)
    await observer.goto(url)
    if (await web.getByRole('button', { name: 'All projects', exact: true }).isVisible())
      await web.getByRole('button', { name: 'All projects', exact: true }).click()
    await openProjectSession(web, 'Runtime writer test', session.title)
    await openProjectSession(observer, 'Runtime writer test', session.title)
    await expect(
      web.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: false })
    ).toBeVisible()
    await web.getByRole('button', { name: 'All projects', exact: true }).click()
    await createProject(web, 'Empty phone project')
    console.info('Browser check: empty project and conversation observer opened')
    watch(web, 'empty-project-reader')
    watch(observer, 'conversation-reader')
    await sendPrompt(desktop, 'Stream the long scroll journey.', 'Segment 3 paragraph 7.')
    await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
    await expect(observer.getByText('Segment 3 paragraph 7.', { exact: false })).toBeVisible()
    await noWarning(web)
    await noWarning(observer)
    expect(requests).toEqual([])
    console.info('Browser check: zero observer history writes')
    await web.screenshot({ path: testInfo.outputPath('empty-project-no-storage-warning.png') })
    await observer.screenshot({ path: testInfo.outputPath('observer-received-runtime.png') })
    await observer.context().setOffline(true)
    await sendPrompt(
      desktop,
      'Second desktop update.',
      'Deterministic reply: Summarize the deterministic fixture.'
    )
    await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
    await observer.context().setOffline(false)
    await expect(observer.getByText('Second desktop update.', { exact: true })).toBeVisible({
      timeout: 45_000
    })
    await noWarning(observer)
    expect(requests).toEqual([])
    console.info('Browser check: zero observer history writes')
    if (await web.getByRole('button', { name: 'All projects', exact: true }).isVisible())
      await web.getByRole('button', { name: 'All projects', exact: true }).click()
    await openProjectSession(web, 'Runtime writer test', session.title)
    await sendPrompt(
      web,
      'Explicit browser prompt.',
      'Deterministic reply: Summarize the deterministic fixture.'
    )
    await expect(desktop.getByText('Explicit browser prompt.', { exact: true })).toBeVisible()
    await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
    await noWarning(web)
    await noWarning(observer)
    expect(requests.filter((r) => r.client === 'conversation-reader')).toEqual([])
    const saved = await desktop.evaluate(
      ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
      session
    )
    expect(saved?.messages.filter((m) => m.content === 'Explicit browser prompt.')).toHaveLength(1)
    await testInfo.attach('runtime-writer-browser-evidence', {
      body: JSON.stringify(
        {
          passiveRuntimeSaveRequests: 0,
          explicitBrowserRequestCount: requests.length,
          savedMessageCount: saved?.messages.length,
          offlineRecovery: true
        },
        null,
        2
      ),
      contentType: 'application/json'
    })
  } finally {
    await web.close()
    await observer.close()
  }
})
