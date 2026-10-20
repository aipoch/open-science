import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import {
  launchOpenScience,
  closeElectronApplicationForCleanup,
  removeTreeForCleanup
} from './fixtures/electron-app'
import type { UpdateStatus, UpdateRecoveryStatus } from '../src/shared/update'
import type { RuntimeStartupState } from '../src/shared/runtime-startup'

// Actual Electron source application and preload. Only the update/startup IPC results below are
// injected. These images certify presentation and user-action routing, NOT stopping or installation.
// eslint-disable-next-line no-empty-pattern
test('captures all runtime update states in isolated Electron (presentation-only)', async ({}, testInfo) => {
  test.setTimeout(240_000)
  const root = await mkdtemp(join(tmpdir(), 'open-science-update-ui-with spaces-'))
  const storageRoot = join(root, 'storage')
  await mkdir(storageRoot)
  const output = testInfo.outputPath('screenshots')
  await mkdir(output, { recursive: true })
  let application: ElectronApplication | undefined
  const capturedStates: string[] = []
  const views: { id: string; text: string; buttons: string[] }[] = []
  try {
    application = await launchOpenScience(
      {
        storageRoot,
        userDataRoot: join(root, 'profile'),
        fakeAgentBinRoot: join(root, 'bin'),
        fakeRemoteItRoot: join(root, 'remote'),
        fakeRemoteItState: join(root, 'remote-state')
      },
      false,
      false,
      join(root, 'remote'),
      'hidden',
      false
    )
    const page = await application.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.settings), { timeout: 60_000 })
    await expect
      .poll(() => page.evaluate(() => window.api.databaseStartup.getState()), { timeout: 60_000 })
      .toMatchObject({ phase: 'ready' })
    await page.evaluate(() => window.api.settings.markOnboardingComplete())
    await page.evaluate(() => window.api.locale.setPreference({ preference: 'zh-Hans' }))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.api?.update))
    await expect(
      page.locator('header').getByRole('button', { name: '新建项目', exact: true })
    ).toBeVisible()
    const current = await page.evaluate(async () => (await window.api.update.getAppInfo()).version)
    await application.evaluate(({ BrowserWindow, ipcMain }) => {
      type Driver = {
        update: unknown
        failRecheck?: boolean
        startup: unknown
        calls: { action: string; args: unknown[] }[]
        emit?: (channel: string, value: unknown) => void
      }
      const global = globalThis as unknown as { __runtimeUiPresentation: Driver }
      global.__runtimeUiPresentation = { update: {}, startup: { phase: 'idle' }, calls: [] }
      for (const action of ['apply', 'cancel', 'recheck', 'recover', 'get-status']) {
        ipcMain.removeHandler(`update:${action}`)
        ipcMain.handle(`update:${action}`, (_event, ...args) => {
          global.__runtimeUiPresentation.calls.push({ action: `update:${action}`, args })
          if (action === 'recheck' && global.__runtimeUiPresentation.failRecheck)
            throw new Error('fixture recheck unavailable password=fixture-secret')
          return global.__runtimeUiPresentation.update
        })
      }
      for (const action of ['get-state', 'stop-and-continue', 'recover', 'quit']) {
        ipcMain.removeHandler(`runtime-startup:${action}`)
        ipcMain.handle(`runtime-startup:${action}`, (_event, ...args) => {
          global.__runtimeUiPresentation.calls.push({ action: `runtime-startup:${action}`, args })
          return global.__runtimeUiPresentation.startup
        })
      }
      const window = BrowserWindow.getAllWindows()[0]
      const send = window.webContents.send.bind(window.webContents)
      global.__runtimeUiPresentation.emit = send
      window.webContents.send = (channel, ...args) => {
        if (channel !== 'update:status') send(channel, ...args)
      }
      window.setSize(1100, 820)
    })
    const rec = (extra: Partial<UpdateRecoveryStatus> = {}): UpdateRecoveryStatus => ({
      phase: 'preparing',
      runtime: 'running',
      installation: 'unchanged',
      canCancel: true,
      canRetryInstall: false,
      canRecover: false,
      ...extra
    })
    const base: UpdateStatus = {
      state: 'ready',
      current,
      latest: '999.0.0',
      applyKind: 'restart',
      recovery: rec()
    }
    const update = async (status: UpdateStatus): Promise<void> => {
      await application!.evaluate((_, next) => {
        const global = globalThis as unknown as {
          __runtimeUiPresentation: {
            update: unknown
            emit: (channel: string, value: unknown) => void
          }
        }
        global.__runtimeUiPresentation.update = next
        global.__runtimeUiPresentation.emit('update:status', next)
      }, status)
    }
    const startup = async (state: RuntimeStartupState): Promise<void> => {
      await application!.evaluate(({ BrowserWindow }, next) => {
        const global = globalThis as unknown as { __runtimeUiPresentation: { startup: unknown } }
        global.__runtimeUiPresentation.startup = next
        BrowserWindow.getAllWindows()[0].webContents.send('runtime-startup:state-changed', next)
      }, state)
    }
    const getCalls = (): Promise<{ action: string; args: unknown[] }[]> =>
      application!.evaluate(
        () =>
          (
            globalThis as unknown as {
              __runtimeUiPresentation: { calls: { action: string; args: unknown[] }[] }
            }
          ).__runtimeUiPresentation.calls
      )
    const applyCount = async (): Promise<number> =>
      (await getCalls()).filter((call) => call.action === 'update:apply').length
    const capture = async (id: string): Promise<void> => {
      await page.screenshot({ path: join(output, `${id}.png`), animations: 'disabled' })
      capturedStates.push(id)
      const surface = page
        .locator(
          '[role="alertdialog"]:visible, [data-testid="runtime-update-dialog"]:visible, [data-runtime-startup-state]:visible, [data-runtime-update-state] [role="status"]:visible'
        )
        .last()
      const visibleSurface = (await surface.count()) ? surface : page.locator('main').last()
      views.push({
        id,
        text: await visibleSurface.innerText(),
        buttons: await visibleSurface.locator('button:visible').allTextContents()
      })
    }
    await update(base)
    await page.locator('button.update-reminder').first().click()
    await expect(page.getByTestId('runtime-update-dialog')).toBeVisible()
    const states: Record<string, Partial<UpdateStatus>> = {
      S01: {},
      S02: {
        cliConfirmation: {
          token: 'external-fixture',
          pid: 4218,
          port: 2026,
          source: 'another-installation',
          entryPath: '/example/standalone/backend/index.cjs'
        }
      },
      S03: {
        cliConfirmation: {
          token: 'desktop-fixture',
          pid: 4218,
          port: 2026,
          source: 'this-installation',
          entryPath: '/example/app/backend/index.cjs'
        }
      },
      S04: {
        reason: 'active-work',
        blockedBy: ['agent', 'delegated'],
        canForce: true,
        blockedTasks: [
          {
            projectId: 'presentation-only',
            sessionId: 'presentation-only',
            title: '隔离验收：文献综述整理',
            kind: 'agent'
          }
        ]
      },
      S06: { reason: 'runtime-not-controlled', recovery: rec({ detail: 'controller-held' }) },
      S07: { reason: 'installation-busy', recovery: rec({ detail: 'other-runtime' }) },
      S08: { reason: 'runtime-configuration-unsupported' },
      S09: {
        reason: 'runtime-stop-timeout',
        recovery: rec({ runtime: 'unknown', canRecover: true, canCancel: false })
      },
      S10: {
        reason: 'install-failed',
        recovery: rec({
          phase: 'stopped',
          runtime: 'stopped-clean',
          canRetryInstall: true,
          canRecover: true
        })
      },
      S11: {
        reason: 'runtime-stop-unclean',
        recovery: rec({
          phase: 'stopped',
          runtime: 'stopped-unclean',
          canRecover: true,
          canCancel: false
        })
      },
      S12: {
        reason: 'user-cancelled',
        recovery: rec({ phase: 'stopped', runtime: 'unknown', canRecover: true, canCancel: false })
      },
      S13: {
        reason: 'install-failed',
        recovery: rec({
          phase: 'handoff',
          runtime: 'stopped-clean',
          installation: 'unknown',
          canRecover: true,
          canCancel: false
        })
      },
      S14: {
        reason: 'install-failed',
        recovery: rec({
          phase: 'handoff',
          runtime: 'stopped-clean',
          installation: 'incomplete',
          canRecover: true,
          canCancel: false
        })
      },
      S15: { outcome: 'cancelled' },
      S20: { state: 'applying' },
      S21: { state: 'applying', recovery: rec({ phase: 'stopping' }) },
      S22: {
        state: 'applying',
        recovery: rec({ phase: 'install-check', runtime: 'stopped-clean' })
      },
      S23: {
        state: 'applying',
        recovery: rec({
          phase: 'handoff',
          runtime: 'stopped-clean',
          installation: 'pending',
          canCancel: false
        })
      },
      S24: {
        state: 'applying',
        recovery: rec({ phase: 'cancelling', runtime: 'stopped-clean', canCancel: false })
      },
      S25: {
        reason: 'runtime-stop-unclean',
        recovery: rec({
          phase: 'recovering',
          runtime: 'stopped-unclean',
          canRecover: true,
          canCancel: false
        })
      },
      S27: { outcome: 'installed' },
      S28: { outcome: 'recovered' },
      S29: {
        reason: 'runtime-not-controlled',
        recovery: rec({ phase: 'checking', detail: 'controller-held' })
      },
      S30: { recovery: rec({ canRetryInstall: true }) },
      S31: {
        reason: 'installation-busy',
        recovery: rec({
          phase: 'stopped',
          runtime: 'stopped-clean',
          detail: 'other-runtime',
          canRecover: true,
          canCancel: false
        })
      },
      S32: { reason: 'installation-busy', recovery: rec({ detail: 'unsupported-channel' }) },
      S33: { reason: 'installation-busy', recovery: rec({ detail: 'occupancy-unknown' }) },
      S34: { reason: 'runtime-not-controlled', recovery: rec({ detail: 'operation-pending' }) }
    }
    for (const [id, extra] of Object.entries(states)) {
      const status = { ...base, ...extra }
      await update(status)
      if (
        !['S15', 'S27', 'S28'].includes(id) &&
        !(await page.getByTestId('runtime-update-dialog').isVisible())
      )
        await page.locator('button.update-reminder').first().click()
      if (['S02', 'S03'].includes(id)) {
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await expect(page.getByRole('alertdialog')).toHaveCount(0)
        await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible()
      } else if (['S15', 'S27', 'S28'].includes(id))
        await expect(
          page.locator(`[data-runtime-update-state="${id}"] [role="status"]`)
        ).toBeVisible()
      else await expect(page.locator(`[data-runtime-update-state="${id}"]`).first()).toBeVisible()
      if (await page.getByTestId('runtime-update-dialog').isVisible()) {
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await expect(page.getByRole('alertdialog')).toHaveCount(0)
        const footer = page.getByTestId('runtime-update-dialog').locator(':scope > div').last()
        expect(await footer.getByRole('button').count()).toBeLessThanOrEqual(2)
      }
      if (id === 'S23') {
        const desktopState = async (closing: boolean, phase = 'disconnected'): Promise<void> => {
          await application!.evaluate(
            ({ BrowserWindow }, state) => {
              BrowserWindow.getAllWindows()[0].webContents.send(
                'desktop-runtime:state-changed',
                state
              )
            },
            { phase, epoch: 0, closing }
          )
        }
        await desktopState(true)
        await expect(page.locator('[data-runtime-update-state="S23"]')).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await expect(page.getByRole('alertdialog')).toHaveCount(0)
        await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0)
        await page.evaluate(() => window.dispatchEvent(new Event('online')))
        // An announced network probe holds its result for 500 ms. Check the inert background too.
        await page.waitForTimeout(600)
        await expect(
          page.getByRole('button', { name: '互联网检查失败', exact: true, includeHidden: true })
        ).toHaveCount(0)
        await capture('S23-planned-runtime-disconnect')
        await desktopState(false)
        await expect(page.getByRole('alertdialog', { name: '桌面连接已断开' })).toBeVisible()
        await expect(page.getByTestId('runtime-update-dialog')).not.toBeVisible()
        await desktopState(false, 'connected')
        await expect(page.locator('[data-runtime-update-state="S23"]')).toBeVisible()
      }
      await capture(id)
      if (['S13', 'S14', 'S23', 'S24', 'S25'].includes(id)) {
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('runtime-update-dialog')).toBeVisible()
      }
      if (['S23', 'S24'].includes(id))
        await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0)
      if (id === 'S01') {
        await page.getByRole('button', { name: '重启以更新', exact: true }).click()
        await expect.poll(applyCount).toBe(1)
        expect(
          (await getCalls()).filter((call) => call.action === 'update:apply').at(-1)?.args
        ).toEqual([undefined])
      }
      if (id === 'S06') {
        await application.evaluate(() => {
          ;(
            globalThis as unknown as { __runtimeUiPresentation: { failRecheck: boolean } }
          ).__runtimeUiPresentation.failRecheck = true
        })
        await page.getByRole('button', { name: '重试', exact: true }).click()
        await expect(page.getByText('操作未能完成，请重试。')).toBeVisible()
        await page.getByText('诊断', { exact: true }).click()
        await expect(page.locator('pre')).toContainText('fixture recheck unavailable')
        await expect(page.locator('pre')).not.toContainText('fixture-secret')
        await capture('S06-recheck-error')
        const preview = await page.locator('pre').innerText()
        const savedDiagnostics = join(root, 'reviewed-diagnostics.txt')
        await application.evaluate(({ BrowserWindow }, path) => {
          BrowserWindow.getAllWindows()[0].webContents.session.once(
            'will-download',
            (_event, item) => item.setSavePath(path)
          )
        }, savedDiagnostics)
        await page.getByRole('button', { name: '保存诊断信息', exact: true }).click()
        await expect
          .poll(async () => readFile(savedDiagnostics, 'utf8').catch(() => ''))
          .toBe(preview)
        await writeFile(join(output, 'reviewed-diagnostics.txt'), preview)
        await application.evaluate(() => {
          ;(
            globalThis as unknown as { __runtimeUiPresentation: { failRecheck: boolean } }
          ).__runtimeUiPresentation.failRecheck = false
        })
        await page.getByRole('button', { name: '重试', exact: true }).click()
        await expect(page.getByText('操作未能完成，请重试。')).toHaveCount(0)
        await page.getByText('诊断', { exact: true }).click()
        await capture('S06-retried')
      }
      if (['S15', 'S28'].includes(id)) {
        await page.locator('button.update-reminder').first().click()
        await expect(page.getByTestId('runtime-update-dialog')).toBeVisible()
        await capture(`${id}-reopened`)
      }
      if (id === 'S14') await page.getByRole('button', { name: '重试', exact: true }).click()
      if (['S02', 'S03'].includes(id)) {
        const before = await applyCount()
        await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
        expect(await applyCount()).toBe(before)
        await expect(page.getByTestId('runtime-update-dialog')).toHaveCount(0)
        const cliConfirmation = { ...status.cliConfirmation!, token: `${id}-confirmed` }
        await update({ ...status, cliConfirmation })
        await page.locator('button.update-reminder').first().click()
        await page.getByRole('dialog').getByRole('button', { name: '更新', exact: true }).click()
        await expect.poll(applyCount).toBe(before + 1)
        expect(
          (await getCalls()).filter((call) => call.action === 'update:apply').at(-1)?.args
        ).toEqual([{ force: false, cliConsentToken: cliConfirmation.token }])
      }
      if (id === 'S04') {
        await page.getByText('更多选项', { exact: true }).click()
        await page.getByRole('button', { name: '强制更新…', exact: true }).click()
        await expect(page.getByTestId('runtime-force-confirmation-S05')).toBeVisible()
        await capture('S05')
        const before = await applyCount()
        await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
        expect(await applyCount()).toBe(before)
        await page.getByText('更多选项', { exact: true }).click()
        await page.getByRole('button', { name: '强制更新…', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: '更新', exact: true }).click()
        await expect.poll(applyCount).toBe(before + 1)
        expect(
          (await getCalls()).filter((call) => call.action === 'update:apply').at(-1)?.args
        ).toEqual([{ force: true }])
      }
    }
    // Close the presentation update overlay before exercising the real startup gate.
    await update(base)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    const issue = {
      reason: 'version-mismatch' as const,
      desktopVersion: current,
      runtimeVersion: '0.37.1',
      pid: 4218,
      port: 2026,
      canStop: true,
      canRecover: false
    }
    const startupStates: Record<string, RuntimeStartupState> = {
      S16: { phase: 'blocked', issue },
      S18: {
        phase: 'blocked',
        issue: { ...issue, reason: 'startup-recovery-required', canStop: false, canRecover: true }
      },
      S26: { phase: 'stopping', issue }
    }
    for (const [id, state] of Object.entries(startupStates)) {
      await startup(state)
      await expect(page.locator(`[data-runtime-startup-state="${id}"]`)).toBeVisible()
      if (await page.getByTestId('runtime-update-dialog').isVisible()) {
        await expect(page.getByRole('dialog')).toHaveCount(1)
        await expect(page.getByRole('alertdialog')).toHaveCount(0)
        const footer = page.getByTestId('runtime-update-dialog').locator(':scope > div').last()
        expect(await footer.getByRole('button').count()).toBeLessThanOrEqual(2)
      }
      await capture(id)
      if (id === 'S16') {
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await expect(page.getByTestId('runtime-startup-confirmation-S17')).toBeVisible()
        await capture('S17')
        const countStop = async (): Promise<number> =>
          (await getCalls()).filter((call) => call.action === 'runtime-startup:stop-and-continue')
            .length
        const before = await countStop()
        await page
          .getByTestId('runtime-startup-confirmation-S17')
          .getByRole('button', { name: '取消', exact: true })
          .click()
        expect(await countStop()).toBe(before)
        await page.getByRole('button', { name: '继续', exact: true }).click()
        await page
          .getByTestId('runtime-startup-confirmation-S17')
          .getByRole('button', { name: '继续', exact: true })
          .click()
        await expect.poll(countStop).toBe(before + 1)
        expect(
          (await getCalls())
            .filter((call) => call.action === 'runtime-startup:stop-and-continue')
            .at(-1)?.args
        ).toEqual([])
      }
      if (id === 'S26') {
        await expect(page.getByRole('button', { name: '取消', exact: true })).toHaveCount(0)
        await page.keyboard.press('Escape')
        await expect(page.locator('[data-runtime-startup-state="S26"]')).toBeVisible()
      }
    }
    await startup({ phase: 'ready' })
    await expect(
      page.locator('header').getByRole('button', { name: '新建项目', exact: true })
    ).toBeVisible()
    await startup({
      phase: 'recovering',
      issue: { ...issue, reason: 'startup-recovery-required', canStop: false, canRecover: true }
    })
    await expect(page.getByText('检查中…', { exact: true })).toBeVisible()
    await capture('startup-checking')
    await startup({ phase: 'ready' })
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('runtime-startup:get-state')
      ipcMain.handle('runtime-startup:get-state', () => {
        throw new Error('fixture status unavailable')
      })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText('无法检查应用状态，请重试。', { exact: true })).toBeVisible()
    await capture('startup-read-error')
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('runtime-startup:get-state')
      ipcMain.handle('runtime-startup:get-state', () => ({ phase: 'ready' }))
    })
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(
      page.locator('header').getByRole('button', { name: '新建项目', exact: true })
    ).toBeVisible()
    // Connection surfaces use the real mounted app; only connection observations are injected.
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('desktop-runtime:reconnect')
      ipcMain.handle('desktop-runtime:reconnect', () => ({
        phase: 'disconnected',
        epoch: 99,
        closing: false
      }))
      ipcMain.removeHandler('desktop-runtime:reconciled')
      ipcMain.handle('desktop-runtime:reconciled', () => undefined)
    })
    for (const phase of ['disconnected', 'reconnecting', 'reconciling', 'unavailable'] as const) {
      await application.evaluate(({ BrowserWindow }, phase) => {
        BrowserWindow.getAllWindows()[0].webContents.send('desktop-runtime:state-changed', {
          phase,
          epoch: 99,
          closing: false
        })
      }, phase)
      await expect(page.getByRole('alertdialog')).toBeVisible()
      if (phase === 'disconnected')
        await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible()
      else await expect(page.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0)
      await capture(`connection-${phase}`)
    }
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('desktop-runtime:state-changed', {
        phase: 'connected',
        epoch: 99,
        closing: false
      })
    })
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await update({
      ...base,
      reason: 'install-failed',
      recovery: rec({
        phase: 'handoff',
        runtime: 'stopped-clean',
        installation: 'incomplete',
        canRecover: true,
        canCancel: false
      })
    })
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(380, 600)
      window.setSize(480, 760)
    })
    await expect(page.locator('[data-runtime-update-state="S14"]')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(480)
    await capture('S14-narrow')
    const calls = await application.evaluate(
      () =>
        (globalThis as unknown as { __runtimeUiPresentation: { calls: { action: string }[] } })
          .__runtimeUiPresentation.calls
    )
    expect(calls.some((call) => call.action === 'update:cancel')).toBe(true)
    expect(calls.some((call) => call.action === 'update:recheck')).toBe(true)
    expect(calls.some((call) => call.action === 'update:recover')).toBe(true)
    await writeFile(join(output, 'views.json'), JSON.stringify(views, null, 2))
    await writeFile(join(output, 'action-routing.json'), JSON.stringify(calls, null, 2))
    // S19 has no current startup/update surface. Assert every supported state by identity.
    expect(capturedStates.filter((id) => /^S\d\d$/.test(id)).sort()).toEqual(
      Array.from({ length: 34 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`).filter(
        (id) => id !== 'S19'
      )
    )
  } finally {
    if (application)
      await closeElectronApplicationForCleanup(
        {
          close: () => application!.close(),
          forceClose: async () => {
            application!.process().kill('SIGKILL')
          }
        },
        { gracefulTimeoutMs: 5000, forcedTimeoutMs: 5000 }
      )
    await removeTreeForCleanup(root)
  }
})
