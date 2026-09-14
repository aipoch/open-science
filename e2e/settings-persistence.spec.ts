import { localizedSettingsCases } from './fixtures/localized-settings'
import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { sendPrompt } from './certification/helpers'
import { test } from './fixtures/electron-app'
import { openGeneralSettings, setTheme } from './fixtures/settings-preferences'

// file:// modules do not reliably populate Resource Timing. CDP reports the scripts Chromium
// actually parsed, including those loaded before the test attached to the restarted window.
const loadedLocaleChunks = async (page: Page): Promise<string[]> => {
  const client = await page.context().newCDPSession(page)
  const locales = new Set<string>()
  client.on('Debugger.scriptParsed', ({ url }) => {
    const match = /\/(de|es|fr|ja|ko|ru|zh-Hans|zh-Hant)-[^/]+\.js(?:$|\?)/u.exec(url)
    if (match) locales.add(match[1])
  })
  try {
    await client.send('Debugger.enable')
    return [...locales].sort()
  } finally {
    await client.detach()
  }
}

const expectMemoryConfirmDialogChrome = async (
  dialog: Locator,
  confirmLabel: string
): Promise<void> => {
  await expect(dialog).toHaveCSS('width', '440px')
  await expect(dialog).toHaveCSS('padding', '0px')
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: confirmLabel })).toHaveCSS(
    'color',
    'rgb(255, 255, 255)'
  )
}

const selectLanguage = async (page: Page, label: string): Promise<void> => {
  const settings = await openGeneralSettings(page)
  await settings.getByRole('combobox', { name: 'Interface language' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
  // The dialog name changes with the locale; use Escape rather than the old English close label.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
}

test('persists the selected theme after closing settings and relaunching', async ({ app }) => {
  let page = await app.completeOnboarding()

  await setTheme(page, 'Dark')
  await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveCount(0)

  page = await app.restart()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveCount(0)
  const settings = await openGeneralSettings(page)
  await expect(
    settings.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' })
  ).toBeChecked()
})

test('persists editable memory across an application restart', async ({ app }) => {
  let page = await app.completeOnboarding()
  await page.evaluate(async () => {
    await window.api.locale.setPreference({ preference: 'en' })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  const openMemory = async (): Promise<Locator> => {
    await page.getByRole('button', { name: 'Model settings' }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: 'Memory', exact: true })
      .click()
    return settings
  }

  let settings = await openMemory()
  await expect(
    settings.getByText('Memory is off. Agents will not save or recall notes', { exact: false })
  ).toBeVisible()
  await expect(settings.getByRole('button', { name: 'About you', exact: false })).toBeVisible()

  await settings.getByRole('button', { name: 'Add', exact: true }).click()
  await settings.getByPlaceholder('Add a note…').fill('Prefers reproducible experiments.')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  const initialAboutNote = settings
    .getByRole('paragraph')
    .filter({ hasText: 'Prefers reproducible experiments.' })
  await expect(initialAboutNote).toBeVisible()

  await initialAboutNote.hover()
  await settings.getByRole('button', { name: 'Edit note' }).click()
  const editor = settings.getByPlaceholder('Add a note…')
  await editor.fill('Prefers reproducible and concise experiments.')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    settings
      .getByRole('paragraph')
      .filter({ hasText: 'Prefers reproducible and concise experiments.' })
  ).toBeVisible()

  await settings.getByRole('button', { name: 'New category' }).click()
  await settings.getByRole('textbox', { name: 'Name' }).fill('Experiment results')
  await settings
    .getByRole('textbox', { name: 'When should the agent save a note here?' })
    .fill('Save costly experimental findings.')
  await settings.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(
    settings.getByRole('button', { name: 'Experiment results', exact: false })
  ).toBeVisible()

  await settings.getByRole('button', { name: 'Experiment results', exact: false }).click()
  await settings.getByRole('button', { name: 'Add', exact: true }).click()
  await settings.getByPlaceholder('Add a note…').fill('Use a 30 second exposure.')
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings.getByRole('button', { name: 'Turn on' })).toHaveCount(0)
  await settings.getByRole('switch', { name: 'Memory' }).click()
  await expect(settings.getByRole('switch', { name: 'Memory' })).toBeChecked()

  await settings.getByRole('button', { name: 'Close settings' }).click()
  page = await app.restart()
  settings = await openMemory()
  await expect(settings.getByRole('switch', { name: 'Memory' })).toBeChecked()
  await expect(
    settings.getByRole('button', { name: 'Experiment results', exact: false })
  ).toBeVisible()
  await settings.getByRole('button', { name: 'Experiment results', exact: false }).click()
  await expect(settings.getByText('Use a 30 second exposure.')).toBeVisible()
  await settings.getByRole('button', { name: 'About you', exact: false }).click()
  await expect(settings.getByText('Prefers reproducible and concise experiments.')).toBeVisible()
})

test('shows project-scoped memory and opens its project from Settings', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  await page.evaluate(async () => {
    await window.api.locale.setPreference({ preference: 'en' })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  const projectName = 'Memory project scope'
  await page.getByRole('button', { name: 'New project' }).click()
  const createProject = page.getByRole('dialog', { name: 'New project' })
  await createProject.getByLabel('Name').fill(projectName)
  await createProject.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()

  await page.evaluate(async () => {
    const project = (await window.api.projects.list()).find(
      (candidate) => candidate.name === 'Memory project scope'
    )
    if (!project) throw new Error('Project was not created.')
    const categorySnapshot = await window.api.memory.createCategory({
      name: 'Research protocol',
      guidance: 'Save durable protocol decisions.',
      autoRecall: true
    })
    const category = categorySnapshot.categories.find(
      (candidate) => 'name' in candidate && candidate.name === 'Research protocol'
    )
    if (!category) throw new Error('Memory category was not created.')
    await window.api.memory.createEntry({
      categoryId: category.id,
      projectId: project.id,
      content: 'Use a 15 minute incubation.'
    })
  })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Memory', exact: true })
    .click()
  await settings.getByRole('button', { name: projectName, exact: false }).click()

  const entry = settings
    .locator('[data-slot="memory-entry"]')
    .filter({ hasText: 'Use a 15 minute incubation.' })
  await expect(entry).toContainText('Research protocol')
  await expect(entry.locator('[data-slot="memory-entry-metadata"]')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('memory-project-scope.png') })

  await settings.getByRole('button', { name: 'Open project' }).click()
  await expect(settings).toBeHidden()
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
})

test('injects recent auto-recall memory after reopen into an unrelated Agent turn', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()
  await page.evaluate(async () => {
    const snapshot = await window.api.memory.snapshot()
    const aboutYou = snapshot.categories.find(
      (category) => 'systemKey' in category && category.systemKey === 'about-you'
    )
    if (!aboutYou) throw new Error('About you category was not seeded.')
    await window.api.memory.createEntry({
      categoryId: aboutYou.id,
      content: 'Keep every response concise and welcoming.'
    })
    await window.api.memory.setEnabled({ enabled: true })
  })
  page = await app.restart()

  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Memory recall project')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await sendPrompt(
    page,
    'Verify automatic memory recall.',
    'Automatic memory recall reached the provider.'
  )
})

test('contains long memory lists and layers destructive confirmations above settings', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  await page.evaluate(async () => {
    await window.api.locale.setPreference({ preference: 'en' })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Memory', exact: true })
    .click()

  await settings.getByRole('button', { name: 'New category' }).click()
  const create = settings.getByRole('button', { name: 'Create', exact: true })
  await settings.getByRole('textbox', { name: 'Name' }).fill('Layer check')
  await expect(create).toBeDisabled()
  await settings
    .getByRole('textbox', { name: 'When should the agent save a note here?' })
    .fill('Save notes used to verify nested dialog behavior.')
  await expect(create).toBeEnabled()
  await create.click()

  await page.evaluate(async () => {
    const snapshot = await window.api.memory.snapshot()
    const aboutYou = snapshot.categories.find(
      (category) => 'systemKey' in category && category.systemKey === 'about-you'
    )
    if (!aboutYou) throw new Error('About you category was not seeded.')
    for (let index = 1; index <= 24; index += 1) {
      await window.api.memory.createEntry({
        categoryId: aboutYou.id,
        content: `Overflow note ${String(index).padStart(2, '0')}`
      })
    }
  })

  await settings.getByRole('button', { name: 'About you', exact: false }).click()
  const entryList = settings.locator('[data-slot="memory-entry-list"]')
  const entries = entryList.locator('[data-slot="memory-entry"]')
  await expect(entries.first()).toContainText('Overflow note 24')
  await expect
    .poll(() => entryList.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await entryList.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(settings.getByText('Overflow note 01')).toBeVisible()
  await expect
    .poll(() =>
      entryList
        .locator('[data-slot="memory-entry"]')
        .first()
        .evaluate((element) => getComputedStyle(element).borderBottomWidth)
    )
    .toBe('0px')
  await page.screenshot({ path: testInfo.outputPath('memory-long-list.png') })

  await settings.getByRole('button', { name: 'Clear all' }).click()
  const clearDialog = page.getByRole('alertdialog', { name: 'Clear all memory?' })
  await expect(clearDialog).toBeVisible()
  await expect(clearDialog).toHaveCSS('z-index', '70')
  await expectMemoryConfirmDialogChrome(clearDialog, 'Clear all')
  await page.screenshot({ path: testInfo.outputPath('memory-clear-confirmation.png') })
  await clearDialog.getByRole('button', { name: 'Cancel' }).click()

  await entryList.evaluate((element) => {
    element.scrollTop = 0
  })
  const lastNote = settings.getByText('Overflow note 24')
  const lastNoteRow = settings
    .locator('[data-slot="memory-entry"]')
    .filter({ hasText: 'Overflow note 24' })
  await lastNoteRow.hover()
  await expect(settings).toHaveCSS('z-index', '50')
  await lastNoteRow.getByRole('button', { name: 'Delete note' }).click()
  const noteDialog = page.getByRole('alertdialog', { name: 'Delete note?' })
  await expect(noteDialog).toBeVisible()
  await expect(noteDialog).toHaveCSS('z-index', '70')
  await expectMemoryConfirmDialogChrome(noteDialog, 'Delete note')
  await page.screenshot({ path: testInfo.outputPath('memory-note-confirmation.png') })
  await noteDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(lastNote).toBeVisible()

  await settings.getByRole('button', { name: 'Layer check', exact: false }).click()
  await settings.getByRole('button', { name: 'Category actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete category' }).click()
  const categoryDialog = page.getByRole('alertdialog', { name: 'Delete category?' })
  await expect(categoryDialog).toBeVisible()
  await expect(categoryDialog).toHaveCSS('z-index', '70')
  await expectMemoryConfirmDialogChrome(categoryDialog, 'Delete category')
  await page.screenshot({ path: testInfo.outputPath('memory-category-confirmation.png') })
  await categoryDialog.getByRole('button', { name: 'Cancel' }).click()
})

test('persists Russian into the built main-process native quit dialog', async ({
  app
}, testInfo) => {
  let page = await app.completeOnboarding()

  expect(await loadedLocaleChunks(page)).toEqual([])
  await selectLanguage(page, 'Русский')
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  expect(await loadedLocaleChunks(page)).toEqual(['ru'])

  await expect
    .poll(() => app.capturePersistedLocaleNativeQuitDialog())
    .toEqual({
      buttons: ['Отмена', 'Выйти'],
      detail: 'Выполнение ещё не завершено. При выходе работа будет прервана.',
      includesRendererCatalog: false,
      message: 'Выйти из Open Science?'
    })

  const screenshot = testInfo.outputPath('russian-locale-loaded.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('russian-locale-loaded', { path: screenshot, contentType: 'image/png' })
  page = await app.restart()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
  expect(await loadedLocaleChunks(page)).toEqual(['ru'])
  await expect
    .poll(() => app.capturePersistedLocaleNativeQuitDialog())
    .toEqual({
      buttons: ['Отмена', 'Выйти'],
      detail: 'Выполнение ещё не завершено. При выходе работа будет прервана.',
      includesRendererCatalog: false,
      message: 'Выйти из Open Science?'
    })
})

test('persists German into the built main-process native quit dialog', async ({ app }) => {
  let page = await app.completeOnboarding()

  await selectLanguage(page, 'Deutsch')
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')

  const expectedDialog = {
    buttons: ['Abbrechen', 'Beenden'],
    detail: 'Die Arbeit läuft noch und wird beim Beenden unterbrochen.',
    includesRendererCatalog: false,
    message: 'Open Science beenden?'
  }

  await expect.poll(() => app.capturePersistedLocaleNativeQuitDialog()).toEqual(expectedDialog)

  page = await app.restart()
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  await expect.poll(() => app.capturePersistedLocaleNativeQuitDialog()).toEqual(expectedDialog)
})

for (const localized of localizedSettingsCases) {
  test(`persists ${localized.language} after an Electron restart`, async ({ app }) => {
    let page = await app.completeOnboarding()
    await selectLanguage(page, localized.pickerLabel)
    await expect(page.locator('html')).toHaveAttribute('lang', localized.locale)
    page = await app.restart()
    await expect(page.locator('html')).toHaveAttribute('lang', localized.locale)
    await expect(page.getByRole('region', { name: localized.projects })).toBeVisible()
  })
}

test('preserves Memory drafts and shows externally saved values on conflict', async ({
  app
}, testInfo) => {
  const page = await app.completeOnboarding()
  await page.evaluate(async () => {
    await window.api.locale.setPreference({ preference: 'en' })
    await window.api.memory.createEntry({
      categoryId: 'memory-category-about-you',
      content: 'Original note'
    })
    await window.api.memory.createCategory({
      name: 'Experiments',
      guidance: 'Save reusable findings.',
      autoRecall: true
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Memory', exact: true })
    .click()
  await settings.getByText('Original note', { exact: true }).hover()
  await settings.getByRole('button', { name: 'Edit note' }).click()
  await settings
    .getByRole('textbox', { name: 'Memory note' })
    .fill('My draft: repeat the buffer experiment at pH 7.4.')
  await page.evaluate(async () => {
    const snapshot = await window.api.memory.snapshot()
    const entry = snapshot.categories[0]!.entries[0]!
    await window.api.memory.updateEntry({
      id: entry.id,
      expectedRevision: entry.revision,
      content: 'Another window saved: use pH 6.8 for this buffer.'
    })
  })
  await expect(settings.getByRole('region', { name: 'Latest saved version' })).toContainText(
    'Another window saved: use pH 6.8'
  )
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText(
    'Memory note changed or no longer exists.'
  )
  await expect(settings.getByRole('textbox', { name: 'Memory note' })).toHaveValue(
    'My draft: repeat the buffer experiment at pH 7.4.'
  )
  await page.screenshot({ path: testInfo.outputPath('memory-note-conflict.png') })
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click()
  await settings.getByRole('button', { name: 'Experiments', exact: false }).click()
  await settings.getByRole('button', { name: 'Category actions' }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  await settings.getByRole('textbox', { name: 'Name', exact: true }).fill('My draft experiments')
  await page.evaluate(async () => {
    const snapshot = await window.api.memory.snapshot()
    const category = snapshot.categories.find(
      (item) => 'name' in item && item.name === 'Experiments'
    )!
    await window.api.memory.updateCategory({
      id: category.id,
      expectedRevision: category.revision,
      name: 'Reviewed experiments',
      guidance: 'Save only validated findings after peer review.',
      autoRecall: false
    })
  })
  await expect(settings.getByRole('region', { name: 'Latest saved version' })).toContainText(
    'Reviewed experiments'
  )
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText('Memory category changed.')
  await expect(settings.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'My draft experiments'
  )
  await expect(settings.getByRole('switch', { name: 'Auto-recall' })).toBeChecked()
  await expect(settings.getByRole('region', { name: 'Latest saved version' })).toContainText(
    'Disabled'
  )
  await page.screenshot({ path: testInfo.outputPath('memory-category-conflict.png') })
  const saved = await page.evaluate(() => window.api.memory.snapshot())
  expect(saved.categories[0]!.entries[0]!.content).toBe(
    'Another window saved: use pH 6.8 for this buffer.'
  )
  expect(
    saved.categories.find((item) => 'name' in item && item.name === 'Reviewed experiments')
  ).toMatchObject({
    autoRecall: false,
    guidance: 'Save only validated findings after peer review.'
  })
})
