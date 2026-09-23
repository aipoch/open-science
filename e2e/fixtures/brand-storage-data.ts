import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const prepareBrandStorageFixture = async (
  storageRoot: string,
  testRoot: string,
  mode: 'legacy' | 'legacy-config' | 'custom' | 'onboarding',
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
    if (mode === 'legacy-config') {
      // Reproduce an already-onboarded client from before dataRoot was persisted.
      // Its research and runtime lived alongside settings, not in a branded folder.
      await cp(settings.dataRoot, storageRoot, { recursive: true })
      await rm(settings.dataRoot, { recursive: true })
      delete settings.dataRoot
      delete settings.dataRootIsInitialDefault
      await writeFile(settingsPath, JSON.stringify(settings) + '\n')
      return
    }
    const next =
      mode === 'legacy'
        ? join(storageRoot, packaged ? 'OpenScience' : 'OpenScience-DEV')
        : join(testRoot, 'My OpenScience research')
    await rename(settings.dataRoot, next)
    settings.dataRoot = next
    delete settings.dataRootIsInitialDefault
  }
  delete settings.onboardingCompletedAt
  await writeFile(settingsPath, JSON.stringify(settings) + '\n')
}
