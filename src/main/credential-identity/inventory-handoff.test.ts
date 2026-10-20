import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareCredentialValidation } from './bootstrap'
import { readCredentialCiphertexts } from './ciphertext-inventory'
import {
  consumeCredentialInventoryFromEnv,
  readCredentialInventory,
  writeCredentialInventory
} from './inventory-handoff'

const roots: string[] = []
const startup = {
  attemptId: 'a64f6d2b-5bc3-41fb-b63b-55ffb43af30b',
  configRoot: 'C:\\isolated\\config',
  profilePath: 'C:\\isolated\\profile'
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const paths = async (): Promise<{ root: string; path: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'credential-handoff-'))
  roots.push(root)
  return { root, path: join(root, 'inventory.json') }
}

describe('credential inventory handoff', () => {
  it('rejects a handoff changed into an empty inventory before credential validation', async () => {
    const target = await paths()
    const actual = {
      ...startup,
      configRoot: target.root,
      profilePath: join(target.root, 'profile')
    }
    await writeFile(
      join(target.root, 'settings.json'),
      JSON.stringify({
        version: 1,
        providers: [],
        githubTokenRef: `enc:${Buffer.from('synthetic-ciphertext').toString('base64')}`
      })
    )
    await writeCredentialInventory({
      path: target.path,
      ...actual,
      ciphertexts: readCredentialCiphertexts(actual)
    })
    const original = await readFile(target.path, 'utf8')
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH', target.path)
    vi.stubEnv(
      'OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256',
      createHash('sha256').update(original).digest('hex')
    )
    await writeFile(target.path, JSON.stringify({ ...JSON.parse(original), ciphertexts: [] }))
    const validate = async (): Promise<void> => {
      const inventory = await consumeCredentialInventoryFromEnv(actual)
      prepareCredentialValidation(
        { backend: 'windows-dpapi', appName: 'Open-Science test' },
        actual,
        inventory
      )
    }
    await expect(validate()).rejects.toThrow('integrity')
    await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not bypass missing-key validation for an intact non-empty handoff', async () => {
    const target = await paths()
    const actual = {
      ...startup,
      configRoot: target.root,
      profilePath: join(target.root, 'profile')
    }
    await writeFile(
      join(target.root, 'settings.json'),
      JSON.stringify({
        version: 1,
        providers: [],
        githubTokenRef: `enc:${Buffer.from('synthetic-ciphertext').toString('base64')}`
      })
    )
    const digest = await writeCredentialInventory({
      path: target.path,
      ...actual,
      ciphertexts: readCredentialCiphertexts(actual)
    })
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH', target.path)
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256', digest)
    const inventory = await consumeCredentialInventoryFromEnv(actual)
    expect(() =>
      prepareCredentialValidation(
        { backend: 'windows-dpapi', appName: 'Open-Science test' },
        actual,
        inventory
      )
    ).toThrow('needs recovery')
  })
  it('runs credential validation for a legitimate empty profile without requiring a key', async () => {
    const target = await paths()
    const actual = {
      ...startup,
      configRoot: target.root,
      profilePath: join(target.root, 'profile')
    }
    const digest = await writeCredentialInventory({
      path: target.path,
      ...actual,
      ciphertexts: readCredentialCiphertexts(actual)
    })
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH', target.path)
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256', digest)
    const inventory = await consumeCredentialInventoryFromEnv(actual)
    const cipher = {
      isEncryptionAvailable: () => true,
      encryptString: vi.fn(),
      decryptString: vi.fn()
    }
    prepareCredentialValidation(
      { backend: 'windows-dpapi', appName: 'Open-Science test' },
      actual,
      inventory
    )(cipher, vi.fn())
    expect(cipher.decryptString).not.toHaveBeenCalled()
    expect(process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256).toBeUndefined()
  })
  it.each([-60_001, 60_000])(
    'rejects snapshots outside the startup lifetime (%i ms)',
    async (offset) => {
      const target = await paths()
      const digest = await writeCredentialInventory({
        path: target.path,
        ...startup,
        ciphertexts: [],
        capturedAt: Date.now() + offset
      })
      vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH', target.path)
      vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256', digest)
      await expect(consumeCredentialInventoryFromEnv(startup)).rejects.toThrow('expired')
      await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it('rejects a handoff without integrity metadata and removes its temporary file', async () => {
    const target = await paths()
    await writeCredentialInventory({ path: target.path, ...startup, ciphertexts: [] })
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH', target.path)
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256', undefined)
    await expect(consumeCredentialInventoryFromEnv(startup)).rejects.toThrow('integrity metadata')
    await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('binds a non-empty snapshot to the startup attempt and target paths, then consumes it', async () => {
    const target = await paths()
    await writeCredentialInventory({
      path: target.path,
      ...startup,
      ciphertexts: [Buffer.from('cookie-ciphertext')]
    })

    await expect(readCredentialInventory({ path: target.path, ...startup })).resolves.toEqual([
      Buffer.from('cookie-ciphertext')
    ])
    await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a valid empty profile distinct from an absent snapshot', async () => {
    const target = await paths()
    await writeCredentialInventory({ path: target.path, ...startup, ciphertexts: [] })

    await expect(readCredentialInventory({ path: target.path, ...startup })).resolves.toEqual([])
  })

  it.each([
    ['wrong attempt', { attemptId: '4f2f5c14-4df5-4d89-a11e-2a7e6bdf3d7d' }],
    ['wrong config root', { configRoot: 'C:\\other\\config' }],
    ['wrong profile', { profilePath: 'C:\\other\\profile' }]
  ])('rejects a %s snapshot and removes it before retry', async (_name, override) => {
    const target = await paths()
    await writeCredentialInventory({ path: target.path, ...startup, ciphertexts: [] })

    await expect(
      readCredentialInventory({ path: target.path, ...startup, ...override })
    ).rejects.toThrow('does not match this startup')
    await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects malformed inventory data without treating it as an empty profile', async () => {
    const target = await paths()
    await writeFile(
      target.path,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: Date.now(),
        attemptId: startup.attemptId,
        configRoot: startup.configRoot,
        profilePath: startup.profilePath,
        ciphertexts: ['not-base64']
      })
    )

    await expect(readCredentialInventory({ path: target.path, ...startup })).rejects.toThrow(
      'invalid ciphertext data'
    )
    await expect(stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a missing snapshot explicitly', async () => {
    const target = await paths()
    await expect(readCredentialInventory({ path: target.path, ...startup })).rejects.toThrow(
      'unavailable or invalid'
    )
    await expect(readFile(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('consumes and clears the inherited path before descendants can inherit it', async () => {
    const target = await paths()
    const digest = await writeCredentialInventory({
      path: target.path,
      ...startup,
      ciphertexts: []
    })
    vi.stubEnv('OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256', digest)
    const previous = process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
    process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH = target.path
    try {
      await expect(consumeCredentialInventoryFromEnv(startup)).resolves.toEqual([])
      expect(process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
      else process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH = previous
    }
  })

  it('ignores an inherited path when no launch attempt is present', async () => {
    const target = await paths()
    await writeCredentialInventory({
      path: target.path,
      ...startup,
      ciphertexts: [Buffer.from('keep')]
    })
    const previous = process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
    process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH = target.path
    try {
      await expect(
        consumeCredentialInventoryFromEnv({ ...startup, attemptId: '' })
      ).resolves.toBeUndefined()
      expect(process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH).toBeUndefined()
      await expect(stat(target.path)).resolves.toBeDefined()
    } finally {
      if (previous === undefined) delete process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH
      else process.env.OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH = previous
    }
  })
})
