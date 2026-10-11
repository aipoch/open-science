import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { reproductionEvidence, reproductionRecipes } from './reproducibility-host'

it('resolves frozen evidence and captured locks from the existing host storage layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reproduction-host-'))
  try {
    const checksum = 'a'.repeat(64)
    const directory = join(root, 'runtime', 'provenance', 'environment-locks')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${checksum}.json`), 'captured bytes\n')
    const evidence = reproductionEvidence(root)
    expect(evidence.resolveFile('frozen/input.csv')).toBe(join(root, 'frozen', 'input.csv'))
    expect(() => evidence.resolveFile('../outside')).toThrow('Invalid provenance storage key')
    await expect(evidence.readEnvironmentLock(checksum)).resolves.toBe('captured bytes\n')
    const controller = new AbortController()
    controller.abort()
    await expect(evidence.readEnvironmentLock(checksum, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(reproductionRecipes.artifactReproducibilityRecipeValue({})).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
