import { expect } from '@playwright/test'
import type { Locator, Page } from 'playwright'
import { test } from './fixtures/electron-app'

const expectVisibleTextButtonsToFit = async (page: Page): Promise<void> => {
  const clippedButtons = await page.locator('[data-slot="button"]:visible').evaluateAll((buttons) =>
    buttons.flatMap((button) => {
      if (!(button instanceof HTMLElement) || !button.innerText.trim()) return []
      return button.scrollWidth > button.clientWidth + 1
        ? [
            {
              label: button.innerText.trim(),
              clientWidth: button.clientWidth,
              scrollWidth: button.scrollWidth
            }
          ]
        : []
    })
  )

  expect(clippedButtons).toEqual([])
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

test('persists the selected theme after closing settings and relaunching', async ({ app }) => {
  let page = await app.completeOnboarding()

  await page
    .locator('button')
    .filter({ has: page.locator('svg.lucide-languages') })
    .click()
  await page.getByRole('menuitem', { name: 'English', exact: true }).click()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', {
      name: 'General',
      exact: true
    })
    .click()

  const theme = settings.getByRole('radiogroup', { name: 'Theme' })
  await theme.getByRole('radio', { name: 'Dark' }).click()
  await expect(theme.getByRole('radio', { name: 'Dark' })).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/dark/)

  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible()

  page = await app.restart()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByRole('button', { name: 'Theme: Dark' })).toBeVisible()
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
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Verify automatic memory recall.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Automatic memory recall reached the provider.')).toBeVisible()
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

test('persists Russian into the built main-process native quit dialog', async ({ app }) => {
  let page = await app.completeOnboarding()

  await page
    .locator('button')
    .filter({ has: page.locator('svg.lucide-languages') })
    .click()
  await page.getByRole('menuitem', { name: 'Русский', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')

  await expect
    .poll(() => app.capturePersistedLocaleNativeQuitDialog())
    .toEqual({
      buttons: ['Отмена', 'Выйти'],
      detail: 'Выполнение ещё не завершено. При выходе работа будет прервана.',
      includesRendererCatalog: false,
      message: 'Выйти из Open Science?'
    })

  page = await app.restart()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru')
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

  await page
    .locator('button')
    .filter({ has: page.locator('svg.lucide-languages') })
    .click()
  await page.getByRole('menuitem', { name: 'Deutsch', exact: true }).click()
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

const localizedSettingsCases = [
  {
    language: 'Simplified Chinese',
    pickerLabel: '简体中文',
    locale: 'zh-Hans',
    projects: '项目',
    modelSettings: '模型设置',
    settings: '设置',
    openNavigation: '打开设置导航',
    general: '通用',
    appearance: '外观',
    interfaceLanguage: '界面语言',
    mainModel: '主模型',
    scenarioModels: '场景模型',
    expandSubagent: '展开子智能体设置',
    reasoningEffort: '推理强度',
    defaultEffort: '默认',
    closeSettings: '关闭设置'
  },
  {
    language: 'Traditional Chinese',
    pickerLabel: '繁體中文',
    locale: 'zh-Hant',
    projects: '專案',
    modelSettings: '模型設定',
    settings: '設定',
    openNavigation: '開啟設定導覽',
    general: '一般',
    appearance: '外觀',
    interfaceLanguage: '介面語言',
    mainModel: '主模型',
    scenarioModels: '情境模型',
    expandSubagent: '展開子智能體設定',
    reasoningEffort: '推理強度',
    defaultEffort: '預設',
    closeSettings: '關閉設定'
  },
  {
    language: 'Japanese',
    pickerLabel: '日本語',
    locale: 'ja',
    projects: 'プロジェクト',
    modelSettings: 'モデル設定',
    settings: '設定',
    openNavigation: '設定ナビゲーションを開く',
    general: '一般',
    appearance: '外観',
    interfaceLanguage: '表示言語',
    mainModel: 'メインモデル',
    scenarioModels: 'シナリオモデル',
    expandSubagent: 'サブエージェント設定を展開',
    reasoningEffort: '推論強度',
    defaultEffort: 'デフォルト',
    closeSettings: '設定を閉じる'
  },
  {
    language: 'Korean',
    pickerLabel: '한국어',
    locale: 'ko',
    projects: '프로젝트',
    modelSettings: '모델 설정',
    settings: '설정',
    openNavigation: '설정 탐색 열기',
    general: '일반',
    appearance: '외관',
    interfaceLanguage: '인터페이스 언어',
    mainModel: '메인 모델',
    scenarioModels: '시나리오 모델',
    expandSubagent: '서브에이전트 설정 펼치기',
    reasoningEffort: '추론 강도',
    defaultEffort: '기본값',
    closeSettings: '설정 닫기'
  },
  {
    language: 'Russian',
    pickerLabel: 'Русский',
    locale: 'ru',
    projects: 'Проекты',
    modelSettings: 'Настройки модели',
    settings: 'Настройки',
    openNavigation: 'Открыть навигацию по настройкам',
    general: 'Общие',
    appearance: 'Внешний вид',
    interfaceLanguage: 'Язык интерфейса',
    mainModel: 'Основная модель',
    scenarioModels: 'Сценарные модели',
    expandSubagent: 'Развернуть настройки: Субагент',
    reasoningEffort: 'Глубина рассуждений',
    defaultEffort: 'По умолчанию',
    closeSettings: 'Закрыть настройки'
  },
  {
    language: 'French',
    pickerLabel: 'Français',
    locale: 'fr',
    projects: 'Projets',
    modelSettings: 'Paramètres du modèle',
    settings: 'Paramètres',
    openNavigation: 'Ouvrir la navigation des paramètres',
    general: 'Général',
    appearance: 'Apparence',
    interfaceLanguage: "Langue de l'interface",
    mainModel: 'Modèle principal',
    scenarioModels: 'Modèles de scénario',
    expandSubagent: 'Développer les paramètres de Sous-agent',
    reasoningEffort: 'Effort de raisonnement',
    defaultEffort: 'Par défaut',
    closeSettings: 'Fermer les paramètres'
  },
  {
    language: 'Spanish',
    pickerLabel: 'Español',
    locale: 'es',
    projects: 'Proyectos',
    modelSettings: 'Configuración del modelo',
    settings: 'Configuración',
    openNavigation: 'Abrir navegación de configuración',
    general: 'General',
    appearance: 'Apariencia',
    interfaceLanguage: 'Idioma de la interfaz',
    mainModel: 'Modelo principal',
    scenarioModels: 'Modelos de escenario',
    expandSubagent: 'Expandir configuración de Subagente',
    reasoningEffort: 'Esfuerzo de razonamiento',
    defaultEffort: 'Predeterminado',
    closeSettings: 'Cerrar configuración'
  },
  {
    language: 'German',
    pickerLabel: 'Deutsch',
    locale: 'de',
    projects: 'Projekte',
    modelSettings: 'Modelleinstellungen',
    settings: 'Einstellungen',
    openNavigation: 'Einstellungsnavigation öffnen',
    general: 'Allgemein',
    appearance: 'Darstellung',
    interfaceLanguage: 'Sprache der Benutzeroberfläche',
    mainModel: 'Hauptmodell',
    scenarioModels: 'Szenariomodelle',
    expandSubagent: 'Unteragent-Einstellungen erweitern',
    reasoningEffort: 'Reasoning-Aufwand',
    defaultEffort: 'Standard',
    closeSettings: 'Einstellungen schließen'
  }
] as const

for (const localized of localizedSettingsCases) {
  const viewportWidths = localized.locale === 'ru' ? ([640, 768] as const) : ([640] as const)
  for (const viewportWidth of viewportWidths) {
    test(`switches to ${localized.language} at ${viewportWidth}px without clipping and persists it`, async ({
      app
    }) => {
      let page = await app.completeOnboarding()
      await page.setViewportSize({ width: viewportWidth, height: 800 })

      await page
        .locator('button')
        .filter({ has: page.locator('svg.lucide-languages') })
        .click()
      await page.getByRole('menuitem', { name: localized.pickerLabel, exact: true }).click()

      await expect(page.locator('html')).toHaveAttribute('lang', localized.locale)
      await expect(page.getByRole('region', { name: localized.projects })).toBeVisible()
      await expectVisibleTextButtonsToFit(page)
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
          )
        )
        .toBe(true)

      await page.getByRole('button', { name: localized.modelSettings }).click()
      const settings = page.getByRole('dialog', { name: localized.settings })
      // Active model and Reasoning effort now share the Main model region; the effort control is
      // still a named radiogroup, but the parent region title is Main model.
      const mainModel = settings.getByRole('region', { name: localized.mainModel })
      const effort = mainModel.getByRole('radiogroup', {
        name: localized.reasoningEffort
      })
      await expect(effort).toBeVisible()
      await expect
        .poll(() =>
          mainModel.locator('p').evaluate((description) => {
            if (!(description instanceof HTMLElement)) return false
            return description.scrollWidth <= description.clientWidth + 1
          })
        )
        .toBe(true)
      await expect
        .poll(() =>
          effort.locator('[data-slot="settings-segment-label"]').evaluateAll((labels) =>
            labels.flatMap((label) => {
              const text = label.querySelector('[data-slot="settings-segment-label-text"]')
              if (!(label instanceof HTMLElement) || !(text instanceof HTMLElement)) {
                return [{ label: label.textContent, error: 'missing measurable text element' }]
              }
              const labelBox = label.getBoundingClientRect()
              const textBox = text.getBoundingClientRect()
              const fits =
                text.scrollWidth <= text.clientWidth + 1 &&
                text.scrollHeight <= text.clientHeight + 1 &&
                textBox.left >= labelBox.left - 1 &&
                textBox.right <= labelBox.right + 1 &&
                textBox.top >= labelBox.top - 1 &&
                textBox.bottom <= labelBox.bottom + 1
              return fits
                ? []
                : [
                    {
                      label: text.textContent,
                      error: 'text overflow',
                      compact: label.dataset.compact,
                      fontSize: getComputedStyle(text).fontSize,
                      clientWidth: text.clientWidth,
                      scrollWidth: text.scrollWidth,
                      clientHeight: text.clientHeight,
                      scrollHeight: text.scrollHeight
                    }
                  ]
            })
          )
        )
        .toEqual([])

      const highLabel = effort
        .getByRole('radio', { name: 'High', exact: true })
        .locator('[data-slot="settings-segment-label"]')
      await expect(highLabel).not.toHaveAttribute('data-compact', 'true')
      if (localized.locale === 'ru') {
        await expect(
          effort
            .getByRole('radio', { name: localized.defaultEffort, exact: true })
            .locator('[data-slot="settings-segment-label"]')
        ).toHaveAttribute('data-compact', 'true')
      }
      const clippedPolicyLabels = async (): Promise<Array<string | undefined>> =>
        settings
          .locator('[data-slot="settings-row"] [data-slot="select-trigger"] .truncate')
          .evaluateAll((labels) =>
            labels.flatMap((label) =>
              label instanceof HTMLElement && label.scrollWidth > label.clientWidth + 1
                ? [label.textContent?.trim()]
                : []
            )
          )
      expect(await clippedPolicyLabels()).toEqual([])
      const mainModelRow = mainModel.locator('[data-slot="settings-row"]').first()
      await expect
        .poll(() =>
          mainModelRow.evaluate(
            (row) => getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/).length
          )
        )
        .toBe(1)

      await settings.getByRole('button', { name: localized.expandSubagent, exact: true }).click()
      const scenarioModels = settings.getByRole('region', { name: localized.scenarioModels })
      const subagentRow = scenarioModels.locator('[data-slot="settings-row"]').first()
      await expect(subagentRow).toBeVisible()
      await expect
        .poll(() =>
          subagentRow.evaluate(
            (row) => getComputedStyle(row).gridTemplateColumns.trim().split(/\s+/).length
          )
        )
        .toBe(1)
      expect(await clippedPolicyLabels()).toEqual([])

      const navigation = settings.getByRole('navigation', { name: localized.settings })
      if (!(await navigation.isVisible())) {
        await settings.getByRole('button', { name: localized.openNavigation }).click()
      }
      await navigation.getByRole('button', { name: localized.general, exact: true }).click()

      await expect(settings.getByRole('heading', { name: localized.appearance })).toBeVisible()
      await expect(
        settings.getByRole('combobox', { name: localized.interfaceLanguage })
      ).toContainText(localized.pickerLabel)
      await expectVisibleTextButtonsToFit(page)

      const closeButton = settings.getByRole('button', { name: localized.closeSettings })
      await closeButton.hover()
      const tooltip = page.locator('[data-slot="tooltip-content"]:visible')
      await expect(tooltip).toContainText(localized.closeSettings)
      await expect(tooltip).toHaveCSS('white-space', 'normal')
      const tooltipBox = await tooltip.boundingBox()
      expect(tooltipBox).not.toBeNull()
      expect(tooltipBox?.x).toBeGreaterThanOrEqual(0)
      // Windows reports fractional bounding boxes; 1px matches the button-clipping helper.
      expect((tooltipBox?.x ?? 0) + (tooltipBox?.width ?? 0)).toBeLessThanOrEqual(viewportWidth + 1)

      await closeButton.click()
      page = await app.restart()
      await expect(page.locator('html')).toHaveAttribute('lang', localized.locale)
      await expect(page.getByRole('region', { name: localized.projects })).toBeVisible()
    })
  }
}
