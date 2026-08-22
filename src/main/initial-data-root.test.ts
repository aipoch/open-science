import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { prepareInitialDataRoot, windowsDataParentForExecutable } from './initial-data-root'

type TestOptions = Parameters<typeof prepareInitialDataRoot>[0] & {
  ensureWritable: ReturnType<typeof vi.fn>
  pathExists: ReturnType<typeof vi.fn>
  persistDataRoot: ReturnType<typeof vi.fn>
}

const options = (): TestOptions => ({
  configRoot: join('fixture', 'config'),
  dataFolderName: 'OpenScience',
  hadSettingsDocument: false,
  homeDataRoot: join('fixture', 'home', 'alice', 'OpenScience'),
  preferredFreshDataRoot: join('fixture', 'drive-d', 'Users', 'alice', 'OpenScience'),
  persistDataRoot: vi.fn().mockResolvedValue(undefined),
  pathExists: vi.fn((path: string): boolean => path.length < 0),
  ensureWritable: vi.fn().mockResolvedValue(undefined)
})

describe('windowsDataParentForExecutable', () => {
  it('keeps the home-relative path but replaces a different installation drive', () => {
    expect(
      windowsDataParentForExecutable(
        'C:\\Users\\Alice',
        'D:\\Apps\\Open Science\\Open Science.exe',
        'OpenScience'
      )
    ).toBe('D:\\Users\\Alice')
  })

  it('keeps the normal home path for a same-drive install', () => {
    expect(
      windowsDataParentForExecutable(
        'C:\\Users\\Alice',
        'C:\\Apps\\Open Science\\Open Science.exe',
        'OpenScience'
      )
    ).toBe('C:\\Users\\Alice')
  })

  it('does not derive a local data path from UNC locations', () => {
    expect(
      windowsDataParentForExecutable(
        'C:\\Users\\Alice',
        '\\\\server\\apps\\Open Science.exe',
        'OpenScience'
      )
    ).toBeUndefined()
  })

  it('rejects a derived data root inside the installation directory', () => {
    expect(
      windowsDataParentForExecutable(
        'C:\\Users\\Alice',
        'D:\\Users\\Open Science.exe',
        'OpenScience'
      )
    ).toBeUndefined()
    expect(
      windowsDataParentForExecutable(
        'C:\\Users\\Alice',
        'D:\\Users\\Alice\\OpenScience\\Open Science.exe',
        'OpenScience'
      )
    ).toBeUndefined()
  })

  it('allows a data root beside, but not inside, the installation directory', () => {
    expect(
      windowsDataParentForExecutable(
        'C:\\Users\\Alice',
        'D:\\Users\\Alice\\Apps\\Open Science.exe',
        'OpenScience'
      )
    ).toBe('D:\\Users\\Alice')
  })
})

describe('prepareInitialDataRoot', () => {
  it('persists the install-drive default for a true first installed launch', async () => {
    const input = options()

    await expect(prepareInitialDataRoot(input)).resolves.toBe(input.preferredFreshDataRoot)
    expect(input.ensureWritable).toHaveBeenCalledWith(input.preferredFreshDataRoot)
    expect(input.persistDataRoot).toHaveBeenCalledWith(input.preferredFreshDataRoot)
  })

  it('never recalculates an existing settings dataRoot', async () => {
    const input = { ...options(), settingsDataRoot: 'E:\\Research\\OpenScience' }

    await expect(prepareInitialDataRoot(input)).resolves.toBe(input.settingsDataRoot)
    expect(input.ensureWritable).not.toHaveBeenCalled()
    expect(input.persistDataRoot).not.toHaveBeenCalled()
  })

  it('backfills the former home default when a settings document proves prior use', async () => {
    const input = { ...options(), hadSettingsDocument: true }

    await expect(prepareInitialDataRoot(input)).resolves.toBe(input.homeDataRoot)
    expect(input.persistDataRoot).toHaveBeenCalledWith(input.homeDataRoot)
  })

  it('backfills the former home default when data already exists there', async () => {
    const input = options()
    input.pathExists.mockImplementation((path) => path === input.homeDataRoot)

    await expect(prepareInitialDataRoot(input)).resolves.toBe(input.homeDataRoot)
    expect(input.persistDataRoot).toHaveBeenCalledWith(input.homeDataRoot)
  })

  it.each(['open-science.db', 'sessions', 'runtime'])(
    'backfills the former home default when historical %s data exists',
    async (entry) => {
      const input = options()
      input.pathExists.mockImplementation((path) => path === join(input.configRoot, entry))

      await expect(prepareInitialDataRoot(input)).resolves.toBe(input.homeDataRoot)
      expect(input.persistDataRoot).toHaveBeenCalledWith(input.homeDataRoot)
    }
  )

  it('leaves a legacy config-root install unset so its migration prompt remains available', async () => {
    const input = options()
    input.pathExists.mockImplementation((path) => path === join(input.configRoot, 'artifacts'))

    await expect(prepareInitialDataRoot(input)).resolves.toBeUndefined()
    expect(input.ensureWritable).not.toHaveBeenCalled()
    expect(input.persistDataRoot).not.toHaveBeenCalled()
  })

  it('does not let an existing home folder hide live legacy config-root data', async () => {
    const input = options()
    input.pathExists.mockImplementation(
      (path) => path === join(input.configRoot, 'artifacts') || path === input.homeDataRoot
    )

    await expect(prepareInitialDataRoot(input)).resolves.toBeUndefined()
    expect(input.ensureWritable).not.toHaveBeenCalled()
    expect(input.persistDataRoot).not.toHaveBeenCalled()
  })

  it('falls back to the former home default when the install-drive candidate is not writable', async () => {
    const input = options()
    input.ensureWritable
      .mockRejectedValueOnce(new Error('read only'))
      .mockResolvedValueOnce(undefined)

    await expect(prepareInitialDataRoot(input)).resolves.toBe(input.homeDataRoot)
    expect(input.ensureWritable).toHaveBeenNthCalledWith(1, input.preferredFreshDataRoot)
    expect(input.ensureWritable).toHaveBeenNthCalledWith(2, input.homeDataRoot)
    expect(input.persistDataRoot).toHaveBeenCalledWith(input.homeDataRoot)
  })
})
