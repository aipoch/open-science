import { describe, expect, it, vi, type Mock } from 'vitest'

import type { PackageMirror } from '../../shared/mirror'
import { PackageMirrorSettingsOwner } from './package-mirror-settings-owner'

type PackageMirrorHarness = Readonly<{
  owner: PackageMirrorSettingsOwner
  repository: {
    getSettings: Mock<() => Promise<{ packageMirror: PackageMirror }>>
    setPackageMirror: Mock<(next: PackageMirror) => Promise<{ packageMirror: PackageMirror }>>
  }
  validate: Mock<() => Promise<void>>
  apply: Mock<(settings: PackageMirror) => Promise<void>>
  beforeCaBundleChange: Mock<() => Promise<void>>
  current: () => PackageMirror
}>

const setup = (initial: PackageMirror = {}): PackageMirrorHarness => {
  let current = { ...initial }
  const repository = {
    getSettings: vi.fn(async () => ({ packageMirror: { ...current } })),
    setPackageMirror: vi.fn(async (next: PackageMirror) => {
      current = { ...next }
      return { packageMirror: { ...current } }
    })
  }
  const validate = vi.fn(async (): Promise<void> => undefined)
  const apply = vi.fn(async (): Promise<void> => undefined)
  const beforeCaBundleChange = vi.fn(async (): Promise<void> => undefined)
  return {
    owner: new PackageMirrorSettingsOwner({
      repository,
      validate,
      apply,
      beforeCaBundleChange
    }),
    repository,
    validate,
    apply,
    beforeCaBundleChange,
    current: () => current
  }
}

describe('PackageMirrorSettingsOwner', () => {
  it('validates before persisting and applies the committed value', async () => {
    const { owner, repository, validate, apply, beforeCaBundleChange } = setup()

    await expect(owner.set({ caBundle: '/certs/complete.pem' })).resolves.toEqual({
      caBundle: '/certs/complete.pem'
    })
    expect(validate).toHaveBeenCalledBefore(repository.setPackageMirror)
    expect(beforeCaBundleChange).toHaveBeenCalledBefore(repository.setPackageMirror)
    expect(apply).toHaveBeenCalledWith({ caBundle: '/certs/complete.pem' })
  })

  it('does not restart kernels when only a mirror URL changes', async () => {
    const { owner, beforeCaBundleChange } = setup({ caBundle: '/certs/current.pem' })

    await owner.set({ caBundle: '/certs/current.pem', pypiIndex: 'https://pypi.example/simple' })

    expect(beforeCaBundleChange).not.toHaveBeenCalled()
  })

  it('does not persist when stopping kernels for a CA change fails', async () => {
    const { owner, repository, beforeCaBundleChange } = setup()
    beforeCaBundleChange.mockRejectedValueOnce(new Error('shutdown failed'))

    await expect(owner.set({ caBundle: '/certs/new.pem' })).rejects.toThrow('shutdown failed')

    expect(repository.setPackageMirror).not.toHaveBeenCalled()
  })

  it('restores storage and the live runtime when apply fails', async () => {
    const { owner, apply, current } = setup({ condaChannel: 'https://old.example' })
    apply.mockRejectedValueOnce(new Error('runtime failed')).mockResolvedValueOnce(undefined)

    await expect(owner.set({ condaChannel: 'https://new.example' })).rejects.toThrow(
      'runtime failed'
    )
    expect(current()).toEqual({ condaChannel: 'https://old.example' })
    expect(apply).toHaveBeenLastCalledWith({ condaChannel: 'https://old.example' })
  })

  it('serializes concurrent saves', async () => {
    const { owner, apply } = setup()
    let release: (() => void) | undefined
    apply.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const first = owner.set({ condaChannel: 'https://first.example' })
    const second = owner.set({ condaChannel: 'https://second.example' })
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    release?.()
    await Promise.all([first, second])

    expect(apply.mock.calls).toEqual([
      [{ condaChannel: 'https://first.example' }],
      [{ condaChannel: 'https://second.example' }]
    ])
  })
})
