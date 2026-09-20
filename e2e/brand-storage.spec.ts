import { readFile, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

for (const mode of ['fresh', 'legacy', 'custom'] as const) {
  test(`keeps ${mode} data and displays the new brand through onboarding and relaunch`, async ({
    app
  }, testInfo) => {
    if (mode !== 'fresh') {
      await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
      const priorPage = await app.completeOnboarding()
      await priorPage.getByRole('button', { name: 'New project' }).click()
      const priorDialog = priorPage.getByRole('dialog', { name: 'New project' })
      await priorDialog.getByLabel('Name').fill('Historical research')
      await priorDialog.getByRole('button', { name: 'Create project' }).click()
      await expect(priorPage.getByRole('heading', { name: 'New conversation' })).toBeVisible()
      await app.restartWithBrandFixture(mode)
    }
    await app.page.evaluate(() => window.api.locale.setPreference({ preference: 'en' }))
    const state = await app.captureBrandState()
    const initial = await app.page.evaluate(() => window.api.storage.getInfo())
    expect(basename(initial.dataRoot)).toBe(
      mode === 'fresh'
        ? state.packaged
          ? 'Open-Science'
          : 'Open-Science-DEV'
        : mode === 'legacy'
          ? state.packaged
            ? 'OpenScience'
            : 'OpenScience-DEV'
          : 'My OpenScience research'
    )
    expect(state.name).toBe(state.packaged ? 'Open-Science' : 'Open-Science (DEV)')
    expect(state.title).toContain('Open-Science')
    expect(state.menus.join(' ')).not.toMatch(/Open Science|OpenScience/)
    expect(await realpath(state.logs)).toBe(await realpath(join(state.profile, 'logs')))
    await app.page.screenshot({ path: testInfo.outputPath(`${mode}-onboarding.png`) })
    let page = await app.completeOnboarding()
    if (mode !== 'fresh')
      await expect(
        page
          .getByRole('region', { name: 'Projects' })
          .getByRole('button', { name: 'Historical research', exact: true })
      ).toBeVisible()
    const projectName = `${mode} retained research`
    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill(projectName)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
    page = await app.restartAfterCrash()
    expect((await page.evaluate(() => window.api.storage.getInfo())).dataRoot).toBe(
      initial.dataRoot
    )
    expect((await app.captureBrandState()).profile).toBe(state.profile)
    await expect(
      page
        .getByRole('region', { name: 'Projects' })
        .getByRole('button', { name: projectName, exact: true })
    ).toBeVisible()
    await app.restartWithBrandFixture('onboarding')
    page = await app.completeOnboarding()
    expect((await page.evaluate(() => window.api.storage.getInfo())).dataRoot).toBe(
      initial.dataRoot
    )
    await expect(
      page
        .getByRole('region', { name: 'Projects' })
        .getByRole('button', { name: projectName, exact: true })
    ).toBeVisible()
    if (mode !== 'fresh')
      expect(
        await readFile(join(initial.dataRoot, 'workspaces', 'historical', 'evidence.txt'), 'utf8')
      ).toBe('Historical research data retained verbatim')
    if (mode === 'fresh') {
      const created = await readdir(dirname(state.profile), { recursive: true })
      expect(
        created.filter((path) =>
          path.split(/[\\/]/).some((part) => /OpenScience|Open Science|^openscience$/.test(part))
        )
      ).toEqual([])
    }
    await testInfo.attach('brand-state', {
      body: JSON.stringify({ mode, ...state, dataRoot: initial.dataRoot }, null, 2),
      contentType: 'application/json'
    })
    await page.screenshot({ path: testInfo.outputPath(`${mode}-retained-project.png`) })
  })
}
