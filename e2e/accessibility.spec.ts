import { expect } from '@playwright/test'
import type { AxeResults } from 'axe-core'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Locator, Page } from 'playwright'
import { createProject, sendPrompt } from './certification/helpers'
import {
  ACCESSIBILITY_ADVISORY,
  ACCESSIBILITY_SCAN_ATTACHMENT,
  ACCESSIBILITY_UI_FINDING_ATTACHMENT,
  ACCESSIBILITY_UI_READY_ATTACHMENT,
  type AccessibilityScan,
  type AccessibilitySurface,
  type AccessibilityUiFinding
} from './accessibility-reporter'
import { test } from './fixtures/electron-app'

const AXE_PATH = resolve(process.cwd(), 'node_modules/axe-core/axe.min.js')
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

test.beforeEach(async ({ app }) => {
  await test.info().attach(ACCESSIBILITY_UI_READY_ATTACHMENT, {
    body: JSON.stringify({ ready: true }),
    contentType: 'application/json'
  })
  void app
})

const blockingViolations = (results: AxeResults): AccessibilityScan['violations'] =>
  results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map<AccessibilityScan['violations'][number]>(({ id, impact, help, nodes }) => ({
      id,
      impact: impact ?? null,
      help,
      nodes: nodes.map(({ html, target }) => ({ html, target }))
    }))

const scanAccessibility = async (page: Page, surface: AccessibilitySurface): Promise<void> => {
  const axeSource = await readFile(AXE_PATH, 'utf8')
  await page.evaluate(axeSource)
  const results = (await page.evaluate(async (tags) => {
    const axe = (
      globalThis as unknown as {
        axe: { run: (context: Document, options: unknown) => Promise<unknown> }
      }
    ).axe

    return axe.run(document, { runOnly: { type: 'tag', values: tags } })
  }, WCAG_TAGS)) as AxeResults
  const blocking = blockingViolations(results)

  await test.info().attach(ACCESSIBILITY_SCAN_ATTACHMENT, {
    body: JSON.stringify({ surface, violations: blocking } satisfies AccessibilityScan),
    contentType: 'application/json'
  })
  if (!ACCESSIBILITY_ADVISORY) {
    expect(blocking, `${surface} has blocking axe violations`).toEqual([])
  }
}

const recordAccessibilityFinding = async (surface: string, message: string): Promise<void> => {
  await test.info().attach(ACCESSIBILITY_UI_FINDING_ATTACHMENT, {
    body: JSON.stringify({ surface, message } satisfies AccessibilityUiFinding),
    contentType: 'application/json'
  })
}

const expectKeyboardOutcome = async (
  page: Page,
  surface: string,
  assertion: () => Promise<void>
): Promise<boolean> => {
  try {
    await assertion()
    return true
  } catch (error) {
    if (!ACCESSIBILITY_ADVISORY) throw error
    await page.evaluate(() => document.readyState)
    await recordAccessibilityFinding(
      surface,
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

const waitForFiniteAnimations = async (page: Page): Promise<void> => {
  await page.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    await Promise.allSettled(animations.map((animation) => animation.finished))
  })
}

const setViewport = async (page: Page, width: number, height = 800): Promise<void> => {
  await page.setViewportSize({ width, height })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
}

const setTheme = async (page: Page, theme: 'Dark' | 'Light'): Promise<void> => {
  const homeThemeMenu = page.getByRole('button', { name: /^Theme:/ })
  const workspaceNavigation = page.getByRole('complementary', { name: 'Workspace navigation' })
  await expect(homeThemeMenu.or(workspaceNavigation)).toBeVisible()
  if (await homeThemeMenu.isVisible()) {
    await homeThemeMenu.click()
    await page.getByRole('menuitem', { name: new RegExp(`^${theme}`) }).click()
  } else {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: 'General', exact: true })
      .click()
    await settings
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: theme })
      .click()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()
  }
  if (theme === 'Dark') await expect(page.locator('html')).toHaveClass(/dark/)
  else await expect(page.locator('html')).not.toHaveClass(/dark/)
}

const focusWithTab = async (page: Page, target: Locator, maxTabs = 80): Promise<boolean> => {
  await expect(target).toBeVisible()
  for (let index = 0; index < maxTabs; index += 1) {
    if (await target.evaluate((element) => document.activeElement === element)) return true
    await page.keyboard.press('Tab')
  }
  if (ACCESSIBILITY_ADVISORY) {
    await recordAccessibilityFinding(
      'Keyboard focus order',
      `Keyboard focus did not reach ${await target.getAttribute('aria-label')}`
    )
    return false
  }
  await expect(
    target,
    `Keyboard focus did not reach ${await target.getAttribute('aria-label')}`
  ).toBeFocused()
  return true
}

test('reports accessibility violations in startup and home surfaces', async ({ app }) => {
  await expect(
    app.page.getByRole('heading', { name: 'Set up your research workspace.' })
  ).toBeVisible()
  await scanAccessibility(app.page, 'Onboarding')

  const page = await app.completeOnboarding()
  await expect(page.getByRole('region', { name: 'Projects' })).toBeVisible()
  await scanAccessibility(page, 'Home')
})

test('reports accessibility violations in core dialog and workspace surfaces', async ({ app }) => {
  const page = await app.completeOnboarding()

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await expect(projectDialog).toBeVisible()
  await scanAccessibility(page, 'New project dialog')

  await projectDialog.getByLabel('Name').fill('Accessible Electron project')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
  await scanAccessibility(page, 'Workspace')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'General', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await scanAccessibility(page, 'Settings')
})

test('reports accessibility violations in permission and file preview states', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'New project' }).click()
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  await projectDialog.getByLabel('Name').fill('Accessible dynamic states')
  await projectDialog.getByRole('button', { name: 'Create project' }).click()

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  await composer.fill('Request fixture permission.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Write fixture output', { exact: true })).toBeVisible()
  await waitForFiniteAnimations(page)
  try {
    await scanAccessibility(page, 'Permission request')
  } finally {
    await page.getByRole('button', { name: 'Deny', exact: true }).click()
  }
  await expect(page.getByText('Fixture permission denied.', { exact: true })).toBeVisible()

  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'accessible-preview.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Accessible preview\n\nRendered in the file dialog.')
  })
  await expect(
    page.getByRole('button', { name: 'Remove attachment accessible-preview.md' })
  ).toBeVisible()
  await composer.fill('Preview the attached file.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await setViewport(page, 767)
  await expect(page.locator('[data-testid="files-view"]')).toBeVisible()
  await waitForFiniteAnimations(page)
  await scanAccessibility(page, 'Project files (narrow)')
  await page.getByRole('button', { name: 'Preview uploaded file accessible-preview.md' }).click()
  const preview = page.getByRole('dialog', { name: 'Preview accessible-preview.md' })
  await expect(preview).toBeVisible()
  await waitForFiniteAnimations(page)
  await scanAccessibility(page, 'File preview dialog')
})

test('reports accessibility violations across representative state combinations', async ({
  app
}) => {
  await app.completeOnboarding()
  let page = await app.configureFakeAgent()
  await setViewport(page, 1280)
  const projectId = await createProject(page, 'Accessible state matrix')

  const prompts = [
    'Summarize how reproducible research benefits from keeping inputs, code, environment details, and outputs together for later inspection.',
    'Compare a quick exploratory analysis with a documented workflow that another researcher can audit, rerun, and extend.',
    'List the practical checks a team should make before sharing a computational result with collaborators or reviewers.'
  ]
  for (const prompt of prompts) {
    await sendPrompt(page, prompt, 'Deterministic reply: Summarize the deterministic fixture.')
  }
  await setTheme(page, 'Dark')
  await scanAccessibility(page, 'Long conversation (dark)')

  await sendPrompt(
    page,
    'Create a provenance artifact.',
    'Artifact provenance verified for session',
    90_000
  )
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await page
    .locator('[data-testid="files-view"]')
    .getByRole('button', { name: 'Preview generated file provenance-evidence.txt' })
    .click()
  const preview = page.getByRole('dialog', { name: 'Preview provenance-evidence.txt' })
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: 'Open Provenance for provenance-evidence.txt' }).click()
  const provenance = page.locator('[data-testid="artifact-provenance"]')
  await expect(provenance).toBeVisible()
  await expect(provenance.getByLabel('Loading Provenance')).toBeHidden({ timeout: 30_000 })
  await scanAccessibility(page, 'Artifact provenance')
  await provenance.getByRole('button', { name: 'Close Provenance' }).click()
  await preview.getByRole('button', { name: 'Close preview of provenance-evidence.txt' }).click()
  await page
    .getByRole('tablist', { name: 'Open previews' })
    .getByRole('tab', { name: 'Files' })
    .press('Delete')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Compute', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'SSH hosts' })).toBeVisible()
  await setViewport(page, 767)
  await scanAccessibility(page, 'Compute settings (narrow, dark)')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toBeHidden()

  page = await app.restartWithCorruptHistoricalSessionFile(projectId)
  const recoveryAlert = page
    .getByRole('alert')
    .filter({ hasText: 'Project archive needs attention' })
  await expect(recoveryAlert).toBeVisible()
  await scanAccessibility(page, 'Conversation recovery warning')
})

test('supports the core project journey with keyboard input only', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()

  const newProject = page.getByRole('button', { name: 'New project' })
  if (!(await focusWithTab(page, newProject))) return
  await page.keyboard.press('Enter')
  const projectDialog = page.getByRole('dialog', { name: 'New project' })
  if (
    !(await expectKeyboardOutcome(page, 'Open a new project with Enter', async () => {
      await expect(projectDialog).toBeVisible()
    }))
  )
    return
  const name = projectDialog.getByLabel('Name')
  if (!(await focusWithTab(page, name))) return
  await page.keyboard.type('Keyboard journey')
  const create = projectDialog.getByRole('button', { name: 'Create project' })
  if (!(await focusWithTab(page, create))) return
  await page.keyboard.press('Enter')
  if (
    !(await expectKeyboardOutcome(page, 'Create a project with Enter', async () => {
      await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
    }))
  )
    return

  const composer = page.getByRole('textbox', { name: 'Ask anything' })
  if (!(await focusWithTab(page, composer))) return
  await page.keyboard.type('Summarize the deterministic fixture.')
  const send = page.getByRole('button', { name: 'Send message' })
  if (!(await focusWithTab(page, send))) return
  await page.keyboard.press('Enter')
  if (
    !(await expectKeyboardOutcome(page, 'Send a message with Enter', async () => {
      await expect(
        page
          .getByLabel('Conversation', { exact: true })
          .getByText('Summarize the deterministic fixture.', { exact: true })
      ).toBeVisible()
    }))
  )
    return

  const files = page.getByRole('button', { name: 'Files', exact: true })
  if (!(await focusWithTab(page, files))) return
  await page.keyboard.press('Enter')
  if (
    !(await expectKeyboardOutcome(page, 'Open project files with Enter', async () => {
      await expect(page.locator('[data-testid="files-view"]')).toBeVisible()
    }))
  )
    return

  const settingsTrigger = page.getByRole('button', { name: 'Settings', exact: true })
  if (!(await focusWithTab(page, settingsTrigger))) return
  await page.keyboard.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  if (
    !(await expectKeyboardOutcome(page, 'Open settings with Enter', async () => {
      await expect(settings).toBeVisible()
    }))
  )
    return
  const compute = settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Compute', exact: true })
  if (!(await focusWithTab(page, compute))) return
  await page.keyboard.press('Enter')
  if (
    !(await expectKeyboardOutcome(page, 'Open Compute settings with Enter', async () => {
      await expect(settings.getByRole('heading', { name: 'SSH hosts' })).toBeVisible()
    }))
  )
    return
  await page.keyboard.press('Escape')
  if (
    !(await expectKeyboardOutcome(page, 'Close settings with Escape', async () => {
      await expect(settings).toBeHidden()
    }))
  )
    return
  const settingsFocusRestored = await settingsTrigger.evaluate(
    (element) => document.activeElement === element
  )
  if (ACCESSIBILITY_ADVISORY && !settingsFocusRestored) {
    await recordAccessibilityFinding(
      'Keyboard focus restoration',
      'Closing settings did not restore focus to the settings trigger.'
    )
    return
  }
  await expect(settingsTrigger).toBeFocused()
})

for (const width of [375, 767] as const) {
  for (const theme of ['Light', 'Dark'] as const) {
    test(`home has named project actions at ${width}px in ${theme}`, async ({ app }) => {
      const page = await app.completeOnboarding()
      await setTheme(page, theme)
      await setViewport(page, width)
      await waitForFiniteAnimations(page)
      const surface = `Home (${width}px, ${theme === 'Light' ? 'light' : 'dark'})` as const
      await scanAccessibility(page, surface)
      await expectKeyboardOutcome(page, surface, async () => {
        const action = page.getByRole('button', { name: 'New project', exact: true }).first()
        await expect(action).toBeVisible()
        await action.click()
        await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible()
      })
    })
  }
}

for (const theme of ['Light', 'Dark'] as const) {
  test(`reported text keeps sufficient contrast in ${theme}`, async ({ app }) => {
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await setTheme(page, theme)
    await createProject(page, `Contrast regression ${theme}`)
    await page.evaluate(await readFile(AXE_PATH, 'utf8'))
    const violations: AccessibilityScan['violations'] = []

    const checkContrast = async (target: Locator, label: string): Promise<void> => {
      await expect(target).toBeVisible()
      await waitForFiniteAnimations(page)
      const result = await target.evaluate(async (element) => {
        const axe = (
          globalThis as unknown as {
            axe: { run: (context: Element, options: unknown) => Promise<AxeResults> }
          }
        ).axe
        return axe.run(element, { runOnly: { type: 'rule', values: ['color-contrast'] } })
      })
      await test.info().attach(label, {
        body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete }),
        contentType: 'application/json'
      })
      violations.push(...blockingViolations(result))
      if (!ACCESSIBILITY_ADVISORY) expect.soft(result.violations, label).toEqual([])
      expect.soft(result.incomplete, `${label} must be measurable`).toEqual([])
    }

    for (const width of [1280, 767]) {
      await setViewport(page, width)
      await checkContrast(
        page.getByText('Discover, share, and collaborate on research that matters', {
          exact: true
        }),
        `Empty conversation ${width}px`
      )
      await checkContrast(
        page
          .getByRole('button', { name: 'Select model', exact: true })
          .getByText('e2e-model', { exact: true }),
        `Model ${width}px`
      )
    }
    await page.getByRole('textbox', { name: 'Ask anything' }).fill('Request fixture permission.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect(page.getByText('Fixture permission denied.', { exact: true })).toBeVisible()
    await checkContrast(
      page.getByText('Declined by you: tool', { exact: true }),
      'Declined tool 767px'
    )
    await test.info().attach(ACCESSIBILITY_SCAN_ATTACHMENT, {
      body: JSON.stringify({
        surface: theme === 'Light' ? 'Reported text (light)' : 'Reported text (dark)',
        violations
      } satisfies AccessibilityScan),
      contentType: 'application/json'
    })
  })
}
