import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

  it('defaults Agent environment creation to allowed and persists an explicit choice', async () => {
    const settings = await createModule()

    await expect(settings.getAgentEnvironmentCreationEnabled()).resolves.toBe(true)
    await expect(settings.setAgentEnvironmentCreationEnabled(false)).resolves.toBe(false)
    await expect(settings.getAgentEnvironmentCreationEnabled()).resolves.toBe(false)
  })

  it('rejects a non-boolean Agent environment creation policy', async () => {
    const settings = await createModule()

    await expect(settings.setAgentEnvironmentCreationEnabled('false' as never)).rejects.toThrow(
      'must be a boolean'
    )
    await expect(settings.getAgentEnvironmentCreationEnabled()).resolves.toBe(true)
  })

  it('persists and clears a runtime selection through the repository policy', async () => {
    const settings = await createModule()
    const interpreterPath = resolve('/usr/bin/python3')
    const selection = {
      source: 'external' as const,
      interpreterPath,
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
    const interpreterPath = resolve('/usr/bin/python3')

    await expect(settings.setEnvironmentEnabled('python', interpreterPath, true)).resolves.toEqual({
      enabled: { [interpreterPath]: true },
      installAuthorized: {}
    })
    await expect(settings.setInstallAuthorized('python', interpreterPath, false)).resolves.toEqual({
      enabled: { [interpreterPath]: true },
      installAuthorized: { [interpreterPath]: false }
    })

    const snapshot = await settings.getSnapshot('python')
    snapshot.runtimeEnablement.enabled[interpreterPath] = false
    expect((await settings.getSnapshot('python')).runtimeEnablement).toEqual({
      enabled: { [interpreterPath]: true },
      installAuthorized: { [interpreterPath]: false }
    })
  })

  it('preserves concurrent environment enablement updates', async () => {
    const settings = await createModule()
    const firstPath = resolve('/usr/bin/python3')
    const secondPath = resolve('/opt/python/bin/python3')

    await Promise.all([
      settings.setEnvironmentEnabled('python', firstPath, true),
      settings.setEnvironmentEnabled('python', secondPath, false)
    ])

    expect((await settings.getSnapshot('python')).runtimeEnablement.enabled).toEqual({
      [firstPath]: true,
      [secondPath]: false
    })
  })

  it('preserves concurrent manual interpreter additions', async () => {
    const settings = await createModule()
    const firstPath = resolve('/usr/bin/python3')
    const secondPath = resolve('/opt/python/bin/python3')

    await Promise.all([
      settings.addManualInterpreter('python', firstPath),
      settings.addManualInterpreter('python', secondPath)
    ])

    expect((await settings.getSnapshot('python')).manualInterpreters).toEqual([
      firstPath,
      secondPath
    ])
  })

  it('preserves repository normalization for manual interpreters and package mirrors', async () => {
    const settings = await createModule()
    const interpreterPath = resolve('/opt/python/bin/python3')

    await settings.addManualInterpreter('python', `  ${interpreterPath}  `)
    await expect(settings.addManualInterpreter('python', interpreterPath)).resolves.toEqual([
      interpreterPath
    ])
    await expect(
      settings.setPackageMirror({
        condaChannel: ' https://mirror.example/conda ',
        pypiIndex: ''
      })
    ).resolves.toEqual({ condaChannel: ' https://mirror.example/conda ' })

    const snapshot = await settings.getSnapshot('python')
    expect(snapshot.manualInterpreters).toEqual([interpreterPath])
    expect(snapshot.packageMirror).toEqual({ condaChannel: ' https://mirror.example/conda ' })

    await expect(settings.removeManualInterpreter('python', interpreterPath)).resolves.toEqual([])
    await expect(settings.setPackageMirror({})).resolves.toEqual({})
  })
})
