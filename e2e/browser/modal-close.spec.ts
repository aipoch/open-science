import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
const cases = [
  'repair',
  'skill-update',
  'collection',
  'artifact',
  'package',
  'providers',
  'connectors',
  'tags',
  'specialists',
  'marketplace',
  'xai',
  'attachment-history',
  'attachment-remove',
  'memory',
  'skill-conflict',
  'library-collection',
  'oauth-connection',
  'library-restore',
  'library-permanent',
  'library-pdf'
]

async function openDialog(page: Page, name: string): Promise<void> {
  if (name === 'library-pdf') {
    await page.getByRole('button', { name: 'All references', exact: true }).click()
    await page.locator('input[type=file][aria-label="Import PDFs"]').setInputFiles({
      name: 'audit-paper.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(
        'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMzAwXSAvUmVzb3VyY2VzIDw8ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAvTGVuZ3RoIDAgPj4Kc3RyZWFtCgplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA1CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDIxOSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDUgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjI2OAolJUVPRg==',
        'base64'
      )
    })
    await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible()
  } else if (name === 'library-restore' || name === 'library-permanent') {
    await page.getByRole('button', { name: 'Trash', exact: true }).click()
    await page
      .getByRole('checkbox', { name: 'Select Audit trashed reference', exact: true })
      .check()
    if (name === 'library-restore')
      await page.getByRole('button', { name: 'Restore', exact: true }).click()
    else {
      await page.getByRole('button', { name: 'More actions', exact: true }).last().click()
      await page.getByRole('menuitem', { name: 'Delete permanently', exact: true }).click()
    }
  } else if (name === 'library-collection') {
    await page.getByRole('button', { name: 'Collection actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete collection' }).click()
  } else if (name === 'oauth-connection')
    await page.getByRole('button', { name: 'Connected', exact: true }).click()
  else if (name === 'providers')
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
  else if (name === 'connectors') {
    await page.getByRole('button', { name: 'Actions for Audit MCP' }).click()
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click()
  } else if (name === 'tags')
    await page.getByRole('button', { name: 'Delete Tag', exact: true }).click()
  else if (name === 'marketplace')
    await page.getByRole('button', { name: 'Remove Audit Marketplace' }).click()
  else if (name === 'specialists') {
    await page.getByRole('button', { name: 'Actions for Audit Specialist' }).click()
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  } else if (name === 'memory') {
    await page.getByRole('button', { name: 'Category actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete category', exact: true }).click()
  } else if (name === 'skill-conflict') {
    await page.getByRole('textbox', { name: 'Skill body' }).fill('My edited draft')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
  } else if (name.startsWith('attachment')) {
    await page.getByRole('button', { name: 'Attachment actions for paper-v2.pdf' }).click()
    await page
      .getByRole('menuitem', {
        name: name === 'attachment-history' ? 'Version history' : 'Remove attachment',
        exact: true
      })
      .click()
  } else await page.getByRole('button', { name: 'Open audit' }).click()
}

for (const name of cases) {
  test(`${name} retains visible content while closing`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(
      name === 'library-collection'
        ? '/literature-recovery.html'
        : name.startsWith('library-')
          ? '/modal-library-close.html'
          : `/modal-close.html?case=${name}`
    )
    await openDialog(page, name)
    const dialog = page.locator('[role=dialog],[role=alertdialog]').last()
    await expect(dialog).toBeVisible()
    await dialog.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((a) => a.finished))
      const sample = (): {
        state: string | null
        text: string
        opacity: string
        height: number
        paint?: boolean
      } => ({
        state: el.getAttribute('data-state'),
        text: (el as HTMLElement).innerText,
        opacity: getComputedStyle(el).opacity,
        height: el.getBoundingClientRect().height
      })
      const observations = [sample()]
      const frame = (): void => {
        if (el.isConnected) {
          observations.push({ ...sample(), paint: true })
          requestAnimationFrame(frame)
        }
      }
      requestAnimationFrame(frame)
      Object.assign(window, { auditFrames: observations })
      const observer = new MutationObserver(() => {
        if (el.isConnected) observations.push(sample())
        else observer.disconnect()
      })
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true
      })
    })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const frames: { state: string | null; text: string; opacity: string }[] = await page.evaluate(
      () => Reflect.get(window, 'auditFrames')
    )
    writeFileSync(
      testInfo.outputPath('closing-frames.json'),
      JSON.stringify({ frames, errors }, null, 2)
    )
    const before = frames[0].text
    const changed = frames.filter(
      (f) => f.state === 'closed' && Number(f.opacity) > 0.2 && f.text !== before
    )
    expect(errors).toEqual([])
    if (name !== 'artifact') expect(frames.some((f) => f.state === 'closed')).toBe(true)
    expect(changed, 'closing content must not change while still visible').toEqual([])
  })
}

for (const name of cases) {
  test(`${name} closes and reopens with reduced motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(
      name === 'library-collection'
        ? '/literature-recovery.html'
        : name.startsWith('library-')
          ? '/modal-library-close.html'
          : `/modal-close.html?case=${name}`
    )
    await openDialog(page, name)
    const dialog = page.locator('[role=dialog],[role=alertdialog]').last()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await openDialog(page, name)
    await expect(dialog).toBeVisible()
    if (name === 'xai') await expect(dialog).not.toContainText('AUDIT-CODE')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
}

test('reopening a repair dialog uses the next name and cancellation remains immediate', async ({
  page
}) => {
  await page.goto('/modal-close.html?case=repair')
  await openDialog(page, 'repair')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Audit Agent 1')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'cancellationRequests')))
    .toEqual(['repair'])
  await expect(dialog).toHaveCount(0)
  await openDialog(page, 'repair')
  await expect(dialog).toContainText('Audit Agent 2')
  await expect(dialog).not.toContainText('Audit Agent 1')
})

test('a collection editor switches from create to a fresh edit after dismissal', async ({
  page
}) => {
  await page.goto('/modal-close.html?case=collection')
  await openDialog(page, 'collection')
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved draft')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Edit another collection' }).click()
  await expect(page.getByRole('dialog')).toContainText('Edit collection')
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Another collection'
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await openDialog(page, 'collection')
  await expect(page.getByRole('dialog')).toContainText('New collection')
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('')
})

test('a new repair request replaces the closing payload before the exit completes', async ({
  page
}) => {
  await page.goto('/modal-close.html?case=repair&reopen=1')
  await openDialog(page, 'repair')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Audit Agent 1')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveAttribute('data-state', 'open')
  await expect(dialog).toContainText('Audit Agent 2')
  await expect(dialog).not.toContainText('Audit Agent 1')
  await expect(dialog).toHaveCount(1)
})
