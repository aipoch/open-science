import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NotebookRuntimeSettingsModule } from './notebook-runtime-settings'
import { SettingsRepository } from './repository'

const roots: string[] = []

const createModule = async (): Promise<NotebookRuntimeSettingsModule> => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-runtime-settings-'))
  roots.push(root)
  return new NotebookRuntimeSettingsModule(new SettingsRepository(root))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('NotebookRuntimeSettingsModule', () => {
  it('returns a detached default policy snapshot for one language', async () => {
    const settings = await createModule()

    const snapshot = await settings.getSnapshot('python')

    expect(snapshot).toEqual({
      language: 'python',
      runtimeEnablement: { enabled: {}, installAuthorized: {} },
      manualInterpreters: [],
      packageMirror: {}
    })
  })

  it('persists and clears a runtime selection through the repository policy', async () => {
    const settings = await createModule()
    const selection = {
      source: 'external' as const,
      interpreterPath: '/usr/bin/python3',
      interpreterArgs: ['-I'],
      appOwnedOverlay: false,
      packageInstallAuthorized: true
    }

    await expect(settings.setRuntimeSelection('python', selection)).resolves.toEqual(selection)

    const snapshot = await settings.getSnapshot('python')
    expect(snapshot.runtimeSelection).toEqual(selection)
    if (snapshot.runtimeSelection?.source === 'external') {
      snapshot.runtimeSelection.interpreterArgs?.push('--mutated')
    }
    expect((await settings.getSnapshot('python')).runtimeSelection).toEqual(selection)

    await expect(settings.setRuntimeSelection('python', null)).resolves.toBeUndefined()
    expect((await settings.getSnapshot('python')).runtimeSelection).toBeUndefined()
  })

  it('keeps environment enablement and install authorization as separate choices', async () => {
    const settings = await createModule()

    await expect(
      settings.setEnvironmentEnabled('python', '/usr/bin/python3', true)
    ).resolves.toEqual({
      enabled: { '/usr/bin/python3': true },
      installAuthorized: {}
    })
    await expect(
      settings.setInstallAuthorized('python', '/usr/bin/python3', false)
    ).resolves.toEqual({
      enabled: { '/usr/bin/python3': true },
      installAuthorized: { '/usr/bin/python3': false }
    })

    const snapshot = await settings.getSnapshot('python')
    snapshot.runtimeEnablement.enabled['/usr/bin/python3'] = false
    expect((await settings.getSnapshot('python')).runtimeEnablement).toEqual({
      enabled: { '/usr/bin/python3': true },
      installAuthorized: { '/usr/bin/python3': false }
    })
  })

  it('preserves repository normalization for manual interpreters and package mirrors', async () => {
    const settings = await createModule()

    await settings.addManualInterpreter('python', '  /opt/python/bin/python3  ')
    await expect(
      settings.addManualInterpreter('python', '/opt/python/bin/python3')
    ).resolves.toEqual(['/opt/python/bin/python3'])
    await expect(
      settings.setPackageMirror({
        condaChannel: ' https://mirror.example/conda ',
        pypiIndex: ''
      })
    ).resolves.toEqual({ condaChannel: ' https://mirror.example/conda ' })

    const snapshot = await settings.getSnapshot('python')
    expect(snapshot.manualInterpreters).toEqual(['/opt/python/bin/python3'])
    expect(snapshot.packageMirror).toEqual({ condaChannel: ' https://mirror.example/conda ' })

    await expect(
      settings.removeManualInterpreter('python', '/opt/python/bin/python3')
    ).resolves.toEqual([])
    await expect(settings.setPackageMirror({})).resolves.toEqual({})
  })
})
