import { expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession, sendPrompt } from './certification/helpers'

test.use({ channel: process.env.OPEN_SCIENCE_E2E_BROWSER_CHANNEL })

for (const queued of [false, true]) {
  test(`remote ${queued ? 'queued' : 'direct'} send shows one message while its save acknowledgement is delayed`, async ({
    app,
    browser
  }, testInfo) => {
    test.setTimeout(180_000)
    const initial = await app.completeOnboarding()
    await expect(initial.getByRole('button', { name: /^(New project|新建项目)$/ })).toBeVisible()
    const desktop = await app.configureFakeAgent()
    await desktop.evaluate(() =>
      window.api.settings.setSessionDetailsModel({ configuration: { mode: 'disabled' } })
    )
    const projectName = 'Mobile message handoff'
    const projectId = await createProject(desktop, projectName)
    const reply = 'Deterministic reply: Summarize the deterministic fixture.'
    for (let turn = 1; turn <= 5; turn++) {
      await sendPrompt(desktop, `Existing history turn ${turn}.`, reply)
      await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
    }
    const session = await desktop.evaluate(async (projectId) => {
      const { sessions } = await window.api.sessions.loadAll()
      return sessions.find((s) => s.projectId === projectId)!
    }, projectId)
    expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(5)
    const context = await browser.newContext({
      viewport: { width: 1280, height: 915 },
      isMobile: true,
      hasTouch: true
    })
    const phone = await context.newPage()
    const releaseFile = join(await app.createTestDirectory('mobile-handoff-stream'), 'release')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let acknowledged = false
    const text = 'Mobile message handoff probe.'
    const routePattern = /\/rpc\/sessions(?::|%3A)save-session$/i
    try {
      await phone.goto(await app.authenticatedWebUrl())
      await openProjectSession(phone, projectName, session.title)
      await phone.setViewportSize({ width: 412, height: 915 })
      await phone.reload()
      await expect(phone.getByText('Existing history turn 5.', { exact: true })).toBeVisible()
      if (queued) {
        await phone
          .getByRole('textbox', { name: 'Ask anything' })
          .fill(
            `Hold the queue until the reveal finishes. Release file: ${JSON.stringify(releaseFile)}`
          )
        await phone.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect(phone.getByTestId('composer-queue-submit')).toBeVisible()
      }
      await phone.route(routePattern, async (route) => {
        const submitted = route.request().postDataJSON()?.args?.[0]
        if (
          !submitted?.messages?.some((message: { content: string }) => message.content === text)
        ) {
          await route.continue()
          return
        }
        const response = await route.fetch()
        acknowledged = true
        await gate
        await route.fulfill({ response })
      })
      await phone.getByRole('textbox', { name: 'Ask anything' }).fill(text)
      if (queued) {
        await phone.getByTestId('composer-queue-submit').click()
        await phone.getByTestId('composer-queue-trigger').click()
        await expect(phone.getByText(text, { exact: true })).toHaveCount(1)
        await writeFile(releaseFile, '')
      } else {
        await phone.getByRole('button', { name: 'Send message', exact: true }).click()
      }
      await expect.poll(() => acknowledged, { timeout: 45_000 }).toBe(true)
      const saved = await desktop.evaluate(
        ({ projectId, id }) => window.api.sessions.loadOne({ projectId, sessionId: id }),
        session
      )
      expect(
        saved?.messages.filter((message) => message.role === 'user' && message.content === text)
      ).toHaveLength(1)
      await expect(phone.getByText(text, { exact: true })).toHaveCount(1)
      await expect(phone.getByText('Sending…', { exact: true })).toHaveCount(0)
      await expect(phone.getByRole('button', { name: 'Sending…', exact: true })).toHaveCount(0)
      await phone.screenshot({
        path: testInfo.outputPath('pending-save-acknowledgement.png'),
        fullPage: true
      })
      release()
      await expect(phone.getByText(reply, { exact: true })).toHaveCount(6)
      await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
      await phone.unroute(routePattern)
      await phone.reload()
      await expect(phone.getByText(text, { exact: true })).toHaveCount(1)
      await sendPrompt(phone, 'Another message in the existing conversation.', reply)
      await expect(
        phone.getByText('Another message in the existing conversation.', { exact: true })
      ).toHaveCount(1)
      await expect(phone.getByText('Sending…', { exact: true })).toHaveCount(0)
      await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
    } finally {
      release()
      await writeFile(releaseFile, '')
      await context.close()
    }
  })
}
