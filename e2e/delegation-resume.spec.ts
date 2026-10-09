import { writeFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

for (const scenario of ['control', 'resume', 'continue-child'] as const) {
  const stop = scenario !== 'control'
  test(`delegation Resume audit: scenario=${scenario}`, async ({ app }, testInfo) => {
    test.setTimeout(180_000)
    await app.completeOnboarding()
    const page = await app.configureFakeAgent()
    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill(`Delegation resume audit ${stop}`)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    if (
      !(await page.getByTestId('composer-controls-trigger').getAttribute('aria-label'))?.includes(
        'Delegation On'
      )
    ) {
      await page.getByTestId('composer-controls-trigger').click()
      await page.getByRole('menuitem', { name: 'Delegation', exact: true }).click()
      await page.keyboard.press('Escape')
    }
    await expect(page.getByTestId('composer-controls-trigger')).toHaveAttribute(
      'aria-label',
      /Delegation On/
    )
    await page
      .getByRole('textbox', { name: 'Ask anything' })
      .fill(
        scenario === 'continue-child'
          ? 'Audit delegation explicit continuation.'
          : stop
            ? 'Audit delegation after Stop Resume.'
            : 'Audit delegation without Stop.'
      )
    await page.getByRole('button', { name: 'Send message' }).click()
    if (stop) {
      await expect(
        page.getByText('Delegation audit ready for Stop.', { exact: false })
      ).toBeVisible()
      await page.getByRole('button', { name: 'Cancel run', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Resume session', exact: true }).click()
    }
    const result = page.getByText('Delegation audit result:', { exact: false })
    await expect(result).toBeVisible({ timeout: 120_000 })
    await expect(result).toContainText(scenario === 'continue-child' ? 'continued' : 'admitted')
    await expect(result).not.toContainText('rejected')
    if (scenario === 'continue-child') {
      await expect(result).toContainText('cancelled')
      const attempts = await page.evaluate(async () => {
        const { sessions } = await window.api.sessions.loadAll()
        return sessions
          .flatMap((s) => s.runtimeContext?.delegatedWork?.records ?? [])
          .find((r) => r.attempts.length === 2)?.attempts
      })
      expect(attempts).toHaveLength(2)
      expect(attempts![0].status).toBe('cancelled')
      expect(attempts![1].id).not.toBe(attempts![0].id)
    }
    const sessions = await page.evaluate(async () => (await window.api.sessions.loadAll()).sessions)
    await writeFile(testInfo.outputPath('sessions.json'), JSON.stringify(sessions, null, 2))
    await writeFile(testInfo.outputPath('result.txt'), await result.innerText())
    await page.screenshot({ path: testInfo.outputPath('result.png'), fullPage: true })
    await app.captureMainLog(`delegation-resume-${stop}.log`)
  })
}
