import { readFile, lstat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect } from '@playwright/test'
import { test } from './fixtures/electron-app'

for (const failedPreparing of [false, true]) {
  test(`upgrades isolated historical workspace, conversation and attachment through actual startup${failedPreparing ? ' after a failed preparing attempt' : ''}`, async ({
    app
  }) => {
    await app.completeOnboarding()
    let page = await app.configureFakeAgent()
    await page.getByRole('button', { name: 'New project' }).click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByLabel('Name').fill('Historical brand migration')
    await dialog.getByRole('button', { name: 'Create project' }).click()
    const content = '# Preserved research\n\nMigration keeps the complete attachment.'
    await page.locator('input[type="file"][multiple]').setInputFiles({
      name: 'history.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(content)
    })
    await expect(page.getByRole('button', { name: 'Remove attachment history.md' })).toBeVisible()
    await page
      .getByRole('textbox', { name: 'Ask anything' })
      .fill('Remember this historical experiment.')
    await page.getByRole('button', { name: 'Send message' }).click()
    await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()

    const migrated = await app.restartWithLegacyBrandPaths(failedPreparing)
    page = migrated.page
    expect(migrated.identityAfter).toEqual(migrated.identityBefore)
    expect((await lstat(migrated.oldRoot)).isSymbolicLink()).toBe(true)
    expect(await page.evaluate(async () => (await window.api.storage.getInfo()).dataRoot)).toBe(
      migrated.newRoot
    )
    await expect(
      page.getByText('Remember this historical experiment.', { exact: true }).first()
    ).toBeVisible()
    await page
      .getByRole('region', { name: 'Recent sessions' })
      .getByRole('button', { name: /Remember this historical experiment/ })
      .click()
    await expect(page.getByText('Deterministic reply:', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await page.getByRole('button', { name: 'Preview uploaded file history.md' }).click()
    const preview = page.getByRole('dialog', { name: 'Preview history.md' })
    await expect(preview.getByText('Preserved research', { exact: true })).toBeVisible()
    await expect(
      preview.getByText('Migration keeps the complete attachment.', { exact: true })
    ).toBeVisible()
    const storageRoot = dirname(migrated.newRoot)
    const receipt = JSON.parse(
      await readFile(join(`${storageRoot}.brand-migration`, 'journal.json'), 'utf8')
    )
    expect(receipt.status).toBe('committed')
    expect(receipt.database.tables).toBeGreaterThan(50)
    if (failedPreparing) {
      expect(await readFile(join(migrated.newRoot, 'fresh-retry.txt'), 'utf8')).toBe(
        'created after the failed attempt'
      )
      if (process.platform === 'darwin') {
        expect(
          (await lstat(join(migrated.newRoot, 'runtime', 'pkgs', 'cache'))).mode & 0o7777
        ).toBe(0o2775)
        for (const [name, value] of [
          ['com.apple.cs.CodeSignature', ''],
          ['com.apple.quarantine', '0081;65000000;Fixture;']
        ])
          expect(
            execFileSync(
              '/usr/bin/xattr',
              ['-p', name, join(migrated.newRoot, 'fresh-retry.txt')],
              { encoding: 'utf8' }
            ).trim()
          ).toBe(value)
      }
      const archives = (await readdir(`${storageRoot}.brand-migration`)).filter((name) =>
        name.endsWith('.abandoned.json')
      )
      expect(archives).toHaveLength(1)
      const abandoned = JSON.parse(
        await readFile(join(`${storageRoot}.brand-migration`, archives[0]), 'utf8')
      )
      expect(abandoned.id).not.toBe(receipt.id)
      expect((await lstat(abandoned.participants[0].stage)).isDirectory()).toBe(true)
    }
    await preview.getByRole('button', { name: 'Close preview of history.md' }).click()
    page = await app.restart()
    await expect(
      page.getByText('Remember this historical experiment.', { exact: true }).first()
    ).toBeVisible()
  })
}
