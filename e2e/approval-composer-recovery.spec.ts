import { expect } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { test } from './fixtures/electron-app'
import { createProjectViaUi } from './fixtures/project'
import { submitPromptViaUi } from './fixtures/conversation'

// Inject the inconsistent presentation state without claiming to reproduce a provider's cause.
test.use({ windowMode: 'normal' })
for (const status of ['waiting-permission', 'waiting-for-user'] as const) {
  test(`keeps a draft usable during ${status} without a request`, async ({ app }, testInfo) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await createProjectViaUi(page, 'Missing interaction recovery')
    await submitPromptViaUi(page, 'Summarize the deterministic fixture.')
    await expect(
      page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
    ).toBeVisible()
    const saved = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
    const application = (app as unknown as { application: ElectronApplication }).application
    // Rehydrate only the renderer with a stale wait; the real persisted Session and runtime
    // remain attached. Recovery must come from Stop, never from a test-injected idle event.
    await application.evaluate(
      ({ BrowserWindow }, { saved, status }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents
        contents.send('session:deleted', { projectId: saved.projectId, sessionId: saved.id })
        contents.send('session:updated', {
          session: { ...saved, status, runtimeContext: undefined, activeRun: undefined },
          originClientId: 'test:missing-request'
        })
      },
      { saved, status }
    )
    await page.locator(`[data-session-id="${saved.id}"]`).first().click()
    const form = page.getByTestId('ordinary-composer-form')
    const editor = page.getByRole('textbox', { name: 'Ask anything' })
    const notice = page.getByTestId('missing-interaction-notice')
    await expect(form).not.toHaveAttribute('inert')
    await expect(editor).toBeVisible()
    await expect(notice).toContainText('Waiting request unavailable')
    await expect(notice.getByRole('button', { name: 'Stop waiting', exact: true })).toBeEnabled()
    await expect(page.getByTestId('blocking-composer-overlay')).toHaveCount(0)
    await editor.fill('Keep this draft during recovery')
    const promptsBefore = await app.readFakeAgentPrompts()
    await editor.press('Enter')
    await expect(editor).toHaveText('Keep this draft during recovery')
    expect(await app.readFakeAgentPrompts()).toEqual(promptsBefore)
    await page.screenshot({ path: testInfo.outputPath('missing-request-recovery.png') })
    // Hold the real durable read while a newer native snapshot reaches the renderer. Even a
    // harmless global refresh used to invalidate recovery, just like another Session's update.
    await application.evaluate(({ ipcMain }, sessionId) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (event: unknown, request: { sessionId: string }) => Promise<unknown>
      >
      const original = handlers.get('sessions:load-one')!
      const probe = { started: false, release: (): void => {} }
      const gate = new Promise<void>((resolve) => {
        probe.release = resolve
      })
      Reflect.set(globalThis, 'stopRecoveryRead', probe)
      handlers.set('sessions:load-one', async (event, request) => {
        if (request.sessionId !== sessionId) return original(event, request)
        handlers.set('sessions:load-one', original)
        const authority = await original(event, request)
        probe.started = true
        await gate
        return authority
      })
    }, saved.id)
    await notice.getByRole('button', { name: 'Stop waiting', exact: true }).click()
    await expect
      .poll(() => application.evaluate(() => Reflect.get(globalThis, 'stopRecoveryRead').started))
      .toBe(true)
    const latest = await page.evaluate(async () => {
      window.api.acp.onState((state) => {
        Reflect.set(window, 'stopRecoveryObservedRevision', state.revision)
      })
      return window.api.acp.getState()
    })
    await application.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows()[0].webContents.send('acp:state', state)
    }, latest)
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'stopRecoveryObservedRevision')))
      .toBe(latest.revision)
    await application.evaluate(() => Reflect.get(globalThis, 'stopRecoveryRead').release())
    await expect(notice).toHaveCount(0)
    await expect(editor).toHaveText('Keep this draft during recovery')
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(
      page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
    ).toHaveCount(2)
    expect(JSON.stringify(await app.readFakeAgentPrompts())).toContain(
      'Keep this draft during recovery'
    )
    await page.screenshot({ path: testInfo.outputPath('reconciled-draft.png') })
  })
}

test('stops a real permission wait when its request payload is lost in delivery', async ({
  app
}, testInfo) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await createProjectViaUi(page, 'Lost permission delivery')
  const application = (app as unknown as { application: ElectronApplication }).application
  // Only the test window's delivered payloads lose request details; the backend retains the
  // actual pending permission, and Stop must travel through the production cancellation path.
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args): void => {
      if (channel === 'acp:state' && args[0]) {
        args[0] = { ...args[0], pendingPermissions: [] }
      }
      if (channel === 'session:updated' && args[0]?.session?.runtimeContext?.permission) {
        const session = args[0].session
        const runtimeContext = { ...session.runtimeContext }
        delete runtimeContext.permission
        args[0] = { ...args[0], session: { ...session, runtimeContext } }
      }
      send(channel, ...args)
    }
  })
  await submitPromptViaUi(page, 'Request fixture permission.')
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.api.acp.getState()).pendingPermissions.length)
    )
    .toBe(1)
  const saved = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions[0])
  // Recreate the renderer projection from a status-only snapshot, as in the original repro.
  // This does not delete or alter the backend Session or its pending permission.
  await application.evaluate(({ BrowserWindow }, session) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.send('session:deleted', { projectId: session.projectId, sessionId: session.id })
    contents.send('session:updated', {
      session: { ...session, status: 'waiting-permission', runtimeContext: undefined },
      originClientId: 'test:missing-request'
    })
  }, saved)
  await page.locator(`[data-session-id="${saved.id}"]`).first().click()
  const notice = page.getByTestId('missing-interaction-notice')
  await expect(notice).toBeVisible()
  const editor = page.getByRole('textbox', { name: 'Ask anything' })
  await editor.fill('Follow up after stopping')
  await page.screenshot({ path: testInfo.outputPath('lost-permission.png') })
  await notice.getByRole('button', { name: 'Stop waiting', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.api.acp.getState()).pendingPermissions.length)
    )
    .toBe(0)
  await expect(notice).toHaveCount(0)
  await expect(editor).toHaveText('Follow up after stopping')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
  ).toBeVisible()
  expect(JSON.stringify(await app.readFakeAgentPrompts())).toContain('Follow up after stopping')
  await page.screenshot({ path: testInfo.outputPath('stopped-and-followed-up.png') })
})
