import { expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Page } from 'playwright'
import { test } from './fixtures/electron-app'

const PROJECT_NAME = 'Skill permission project'
const SKILL_PERMISSION_PROMPT = 'Request fixture skill permission.'
const SKILL_NAME = 'fixture-skill'
// Long enough to exceed the transcript sheet's 320px cap, so the permission card's roomier
// 480px sheet is what the expanded screenshot exercises.
const SKILL_BODY = [
  '# Fixture Skill',
  '',
  'Review fixture evidence carefully.',
  '',
  '## Steps',
  '',
  ...Array.from({ length: 18 }, (_, index) => `${index + 1}. Check fixture detail ${index + 1}.`)
].join('\n')
// PR-summary screenshots land in the git-ignored test-results root, outside the per-test outputDir.
const SCREENSHOT_ROOT = resolve(process.cwd(), 'test-results')

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill(PROJECT_NAME)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

// Seed the skills catalog through the real Settings bridge. The workspace composer loads the
// catalog into the renderer settings store on mount, so reload once to pick the new skill up
// before the permission card tries to resolve it.
const seedFixtureSkill = async (page: Page): Promise<void> => {
  await page.evaluate(
    async ({ name, body }) => {
      await window.api.settings.createSkill({
        name,
        description: 'Fixture skill for the permission card journey.',
        body
      })
    },
    { name: SKILL_NAME, body: SKILL_BODY }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('Loading settings...').waitFor({ state: 'hidden', timeout: 60_000 })
}

test('renders the SKILL.md document in the skill load permission card', async ({ app }) => {
  await app.completeOnboarding()
  const page = await app.configureFakeAgent()
  await seedFixtureSkill(page)
  await createProject(page)

  await page.getByRole('textbox', { name: 'Ask anything' }).fill(SKILL_PERMISSION_PROMPT)
  await page.getByRole('button', { name: 'Send message' }).click()

  const card = page.getByTestId('permission-card')
  await expect(card).toBeVisible()
  const toggle = page.getByTestId('permission-skill-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(card.getByText('Review fixture evidence carefully.')).toBeVisible()
  // The skill document replaces the generic MCP JSON preview entirely.
  await expect(page.getByTestId('permission-code-toggle')).toHaveCount(0)
  await expect(card.getByText('External service input')).toHaveCount(0)

  await mkdir(SCREENSHOT_ROOT, { recursive: true })
  await card.screenshot({ path: join(SCREENSHOT_ROOT, 'skill-permission-card-expanded.png') })

  await toggle.evaluate((element: HTMLButtonElement) => element.click())
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(card.getByText('Review fixture evidence carefully.')).toBeHidden()
  await card.screenshot({ path: join(SCREENSHOT_ROOT, 'skill-permission-card-collapsed.png') })

  // The approval flow still completes through the new section.
  const allow = page.getByTestId('permission-actions').getByTestId('allow-primary')
  await expect(allow).toBeEnabled()
  await allow.evaluate((element: HTMLButtonElement) => element.click())
  await expect(page.getByText('Fixture skill permission allowed.', { exact: true })).toBeVisible()
})
