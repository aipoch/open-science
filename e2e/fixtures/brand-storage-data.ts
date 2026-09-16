import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const prepareBrandStorageFixture = async (
  storageRoot: string,
  testRoot: string,
  mode: 'legacy' | 'custom' | 'onboarding',
  packaged: boolean
): Promise<void> => {
  const settingsPath = join(storageRoot, 'settings.json')
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  if (mode !== 'onboarding') {
    await mkdir(join(settings.dataRoot, 'workspaces', 'historical'), { recursive: true })
    await writeFile(
      join(settings.dataRoot, 'workspaces', 'historical', 'evidence.txt'),
      'Historical research data retained verbatim'
    )
    const next =
      mode === 'legacy'
        ? join(storageRoot, packaged ? 'OpenScience' : 'OpenScience-DEV')
        : join(testRoot, 'My OpenScience research')
    await rename(settings.dataRoot, next)
    if (mode === 'legacy') {
      delete settings.dataRoot
      // This fixture predates the durable profile/location bootstrap record. Keeping a completed
      // new-version record would correctly mean a lost selection, not a legacy upgrade.
      await rm(join(storageRoot, 'electron-profile.json'), { force: true })
    } else settings.dataRoot = next
    delete settings.dataRootIsInitialDefault
  }
  delete settings.onboardingCompletedAt
  await writeFile(settingsPath, JSON.stringify(settings) + '\n')
}
