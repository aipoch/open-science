import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { x as extractArchive } from 'tar'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'
import { createProject } from './certification/helpers'
import { expectCompletedAssistant, submitPromptViaUi } from './fixtures/conversation'
import { configureWebModel, startWebModel } from './fixtures/web-model'
import type { WebResult } from '../src/shared/web-tools'

// Actual public fetch + native package transfer. Unapproved sharing stays omitted; this test
// never promotes the development service's terms to an approved release policy.
test('exports unconfirmed Web evidence as omissions and imports it offline without execution authority', async ({
  app
}, testInfo) => {
  test.setTimeout(240_000)
  let modelCalls = 0
  const gateway = await startWebModel(
    'web-package',
    (body) => {
      if (body.messages.at(-1)?.role === 'tool') return 'WEB_PACKAGE_READY'
      return {
        id: 'web-package-fetch',
        name: body.tools!.find((tool) => tool.function.name.endsWith('__web_fetch'))!.function.name,
        args: { url: 'https://example.org/', max_chars: 240 }
      }
    },
    {
      probe: 'stop',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      onPost: () => {
        modelCalls++
      }
    }
  )
  try {
    const page = await app.completeOnboarding()
    const archive = await app.configureSessionPackageDialogs()
    await configureWebModel(page, gateway.baseUrl, {
      name: 'Web package acceptance',
      model: 'web-package',
      key: 'local-fixture'
    })
    const projectId = await createProject(page, 'Web package acceptance')
    await submitPromptViaUi(page, 'Read https://example.org/ and report WEB_PACKAGE_READY.')
    await expect(page.getByText('WEB_PACKAGE_READY', { exact: true })).toBeVisible({
      timeout: 60000
    })
    await expectCompletedAssistant(page, 'WEB_PACKAGE_READY')
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.api.acp.getState()).promptInFlightSessionIds)
      )
      .toEqual([])
    const before = await page.evaluate(async (projectId) => {
      const summary = (await window.api.sessions.loadAll()).sessions.find(
        (session) => session.projectId === projectId
      )!
      return (await window.api.sessions.loadOne({ projectId, sessionId: summary.id }))!
    }, projectId)
    const activity = before.activities!.find((item) => item.appOwned)!
    const evidence = activity.toolContent!.flatMap((block) => {
      const content = (block as { content?: { type?: string; text?: string } }).content
      if (content?.type !== 'text' || !content.text) return []
      try {
        const result = JSON.parse(content.text) as WebResult
        return result.schema === 'open-science.web.v1' ? [result] : []
      } catch {
        return []
      }
    })[0]
    expect(evidence.status).toBe('ok')
    const dataRoot = await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)
    const evidenceRoot = join(dataRoot, 'web-evidence')
    const bodyRelative = (await readdir(evidenceRoot, { recursive: true })).find((name) =>
      String(name).endsWith(`${evidence.document!.snapshot_id}.json`)
    )!
    const bodyPath = join(evidenceRoot, String(bodyRelative))
    const originalBody = await readFile(bodyPath)
    const callsBeforeTransfer = modelCalls

    await page
      .getByRole('navigation', { name: 'Sessions' })
      .locator(`[data-session-id="${before.id}"]`)
      .getByRole('button', { name: /^Open actions for/ })
      .click()
    await page.getByRole('menuitem', { name: 'Export', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'Export Session package', exact: true }).click()
    const exporting = page.getByRole('dialog', { name: 'Export Session package', exact: true })
    await exporting.getByRole('button', { name: 'Choose save location…', exact: true }).click()
    await expect(
      exporting.getByRole('button', { name: 'Show in folder', exact: true })
    ).toBeVisible({ timeout: 60000 })
    await expect(exporting.getByTestId('package-web-omissions')).toContainText(
      'Sharing permission has not been confirmed'
    )
    await page.screenshot({ path: testInfo.outputPath('web-export-omissions.png') })
    await exporting.getByRole('button', { name: 'Close', exact: true }).click()
    const unpacked = testInfo.outputPath('unpacked')
    await mkdir(unpacked, { recursive: true })
    await extractArchive({ file: archive, cwd: unpacked })
    const recordsText = await readFile(join(unpacked, 'records.json'), 'utf8')
    const sessionText = await readFile(join(unpacked, 'session.json'), 'utf8')
    expect(recordsText).toContain('webEvidence')
    expect(recordsText + sessionText).not.toContain(
      JSON.stringify(evidence.document!.text).slice(1, -1)
    )
    expect((await readFile(bodyPath)).equals(originalBody)).toBe(true)
    const unchanged = await page.evaluate((scope) => window.api.sessions.loadOne(scope), {
      projectId,
      sessionId: before.id
    })
    expect(unchanged?.activities).toEqual(before.activities)

    await page.evaluate(async () => {
      await window.api.settings.setNetworkProxy({
        mode: 'manual',
        server: 'http://127.0.0.1:1',
        bypassRules: 'localhost,127.0.0.1'
      })
    })
    await page.getByRole('button', { name: 'Web package acceptance', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Import Session package…', exact: true }).click()
    const importing = page.getByRole('dialog', { name: 'Import Session package', exact: true })
    await expect(importing.getByRole('button', { name: 'Import', exact: true })).toBeVisible({
      timeout: 60000
    })
    await expect(importing.getByTestId('package-web-omissions')).toContainText('Fetched page text')
    await importing.getByRole('button', { name: 'Import', exact: true }).click()
    await expect(
      importing.getByRole('status').filter({ hasText: /^Session imported$/ })
    ).toBeVisible({ timeout: 60000 })
    await importing.getByRole('button', { name: 'Open imported Session', exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'Imported research history', exact: true })
    ).toBeVisible()
    const replay = page.getByTestId('replay-panel')
    await replay.getByRole('slider', { name: 'Replay progress', exact: true }).focus()
    await page.keyboard.press('End')
    await expect(replay.getByTestId('tool-group-header')).toHaveCount(1)
    await replay.getByTestId('tool-group-header').click()
    await replay.getByTestId('tool-chip').click()
    await expect(replay.getByTestId('package-web-evidence')).toContainText('Content unavailable')
    await expect(page.getByRole('textbox', { name: 'Ask anything' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    const imported = await page.evaluate(async (projectId) => {
      const summary = (await window.api.sessions.loadAll()).sessions.find(
        (session) => session.projectId === projectId && session.packageOrigin
      )!
      return (await window.api.sessions.loadOne({ projectId, sessionId: summary.id }))!
    }, projectId)
    expect(imported.id).not.toBe(before.id)
    const importedActivity = imported.activities!.find((item) => item.packageWebEvidence)!
    expect(importedActivity).toBeDefined()
    expect(importedActivity.executionInvocationId).not.toBe(activity.executionInvocationId)
    expect(importedActivity.packageWebEvidence?.invocationId).toBe(
      importedActivity.executionInvocationId
    )
    expect(importedActivity.webInvocation?.retryEligible).not.toBe(true)
    expect(modelCalls).toBe(callsBeforeTransfer)
    await page.screenshot({ path: testInfo.outputPath('web-import-read-only.png') })
  } finally {
    await gateway.close()
  }
})
