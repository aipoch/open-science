import { expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from './fixtures/electron-app'
import { createProject, openProjectSession, sendPrompt } from './certification/helpers'

const PROJECT = 'Recovered message fixture'
const WARMUP = 'Summarize the deterministic fixture.'
const FOLLOW_UP = 'Review the results after recovery.'
const ATTACHMENT_NAME = 'recovery-notes.md'
const ATTACHMENT_CONTENT = '# Recovery evidence\nPreserve these exact attachment bytes.\n'

test('preserves queued input through backend crash in the Web client and requires explicit resume', async ({
  app,
  browser
}, testInfo) => {
  test.setTimeout(180_000)
  await app.completeOnboarding()
  await app.configureFakeAgent()
  const web = await browser.newPage()
  let releaseFile: string | undefined
  try {
    const desktop = app.page
    await createProject(desktop, PROJECT)
    await sendPrompt(desktop, WARMUP, `Deterministic reply: ${WARMUP}`)
    await expect.poll(() => desktop.evaluate(() => window.api.storage.detectActive())).toEqual([])
    releaseFile = join(await app.createTestDirectory('pending-recovery'), 'release')
    await desktop
      .getByRole('textbox', { name: 'Ask anything' })
      .fill(
        `Hold the queue until the reveal finishes. Release file: ${JSON.stringify(releaseFile)}`
      )
    await desktop.getByRole('button', { name: 'Send message' }).click()
    const queue = desktop.getByTestId('composer-queue-submit')
    await expect(queue).toBeVisible()
    await desktop.locator('input[type="file"][multiple]').setInputFiles({
      name: ATTACHMENT_NAME,
      mimeType: 'text/markdown',
      buffer: Buffer.from(ATTACHMENT_CONTENT)
    })
    await expect(
      desktop.getByRole('button', { name: `Remove attachment ${ATTACHMENT_NAME}` })
    ).toBeVisible()
    await desktop.getByRole('textbox', { name: 'Ask anything' }).fill(FOLLOW_UP)
    await queue.click()
    await expect(desktop.getByRole('textbox', { name: 'Ask anything' })).toHaveText('')
    await expect(desktop.getByTestId('composer-queue-trigger')).toBeVisible()
    const before = await desktop.evaluate(() =>
      window.api.pendingInputs.execute({ operation: 'list' })
    )
    expect(before.items).toHaveLength(1)
    expect(before.items[0].phase).toBe('queued')
    const id = before.items[0].id
    const attachment = before.items[0].snapshot.attachments[0]
    expect(attachment.versionId).toBeTruthy()
    expect(attachment.versionNumber).toBeGreaterThan(0)
    expect(attachment).not.toHaveProperty('draftReceipt')
    expect(attachment).not.toHaveProperty('path')
    expect(attachment).not.toHaveProperty('checksum')
    await app.restartAfterCrash()
    await app.page.goto('about:blank')
    await web.goto(await app.authenticatedWebUrl())
    await openProjectSession(web, PROJECT, WARMUP)
    const afterRestart = await web.evaluate(() =>
      window.api.pendingInputs.execute({ operation: 'list' })
    )
    expect(afterRestart.items).toHaveLength(1)
    expect(afterRestart.items[0].phase).toBe('recovery-required')
    await expect(web.getByTestId('composer-queue-trigger')).toBeVisible()
    await web.getByTestId('composer-queue-trigger').click()
    await expect(
      web.getByText(
        'Recovered message. Review before sending; an interrupted send may already have reached the agent.'
      )
    ).toBeVisible()
    const recovered = await web.evaluate(() =>
      window.api.pendingInputs.execute({ operation: 'list' })
    )
    expect(recovered.items[0]).toMatchObject({ id, phase: 'recovery-required', text: FOLLOW_UP })
    expect(recovered.items[0].snapshot.attachments).toEqual(before.items[0].snapshot.attachments)
    const bytes = await web.evaluate(async (input) => {
      const attachment = input.snapshot.attachments[0]
      const resource = await window.api.previewResources.acquire({
        source: 'upload',
        projectId: input.projectId,
        fileId: attachment.id,
        versionId: attachment.versionId
      })
      try {
        const response = await fetch(resource.url)
        if (!response.ok) throw new Error(`Attachment read failed: ${response.status}`)
        return Array.from(new Uint8Array(await response.arrayBuffer()))
      } finally {
        await window.api.previewResources.release({ resourceId: resource.id })
      }
    }, recovered.items[0])
    expect(Buffer.from(bytes).toString('utf8')).toBe(ATTACHMENT_CONTENT)
    expect(
      (await app.readFakeAgentPrompts()).filter((entry) => entry.prompt.includes(FOLLOW_UP))
    ).toHaveLength(0)
    await web.screenshot({ path: testInfo.outputPath('recovered-queued-input.png') })
    for (const [preference, label] of [
      ['zh-Hans', '队列（1）'],
      ['zh-Hant', '佇列（1）'],
      ['ja', 'キュー (1)']
    ] as const) {
      await web.evaluate(
        (preference) => localStorage.setItem('open-science-language', preference),
        preference
      )
      await web.reload()
      await expect(web.getByTestId('composer-queue-trigger')).toHaveText(label)
      await web.getByTestId('composer-queue-trigger').click()
      await web.screenshot({
        path: testInfo.outputPath(`recovered-queued-input-${preference}.png`)
      })
    }
    await web.evaluate(() => localStorage.setItem('open-science-language', 'en'))
    await web.reload()
    await web.getByTestId('composer-queue-trigger').click()
    await web.getByRole('button', { name: 'Resume sending', exact: true }).click()
    await expect(
      web.getByRole('region', { name: 'Conversation' }).getByText(FOLLOW_UP, { exact: true })
    ).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(
        async () =>
          (await web.evaluate(() => window.api.pendingInputs.execute({ operation: 'list' }))).items
            .length
      )
      .toBe(0)
    await expect
      .poll(
        async () =>
          (await app.readFakeAgentPrompts()).filter((entry) => entry.prompt.includes(FOLLOW_UP))
            .length
      )
      .toBe(1)
    await web.screenshot({ path: testInfo.outputPath('resumed-queued-input.png') })
  } finally {
    if (releaseFile) await writeFile(releaseFile, '')
    await web.close()
  }
})
