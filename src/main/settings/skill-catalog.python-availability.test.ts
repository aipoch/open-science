import type { SpawnOptions } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'

// Exercise real process launch failures on a host without Python. An explicit empty
// child PATH prevents POSIX's implicit /usr/bin lookup from finding the test host's Python.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
      actual.spawn(command, args, {
        ...options,
        env: { ...options?.env, PATH: '' }
      })
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { SkillRegistry } from '../skills/registry'
import { SettingsRepository } from './repository'
import { SkillCatalogModule } from './skill-catalog'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['zip', 'github'] as const)(
  'imports a text-only Skill through %s without Python when the production bundled helpers are installed',
  async (source) => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'skill-import-no-python-'))
    roots.push(storageRoot)
    const catalog = new SkillCatalogModule({
      storageRoot,
      repository: new SettingsRepository(storageRoot),
      skillRegistry: new SkillRegistry(resolve(__dirname, '../../../resources/skills')),
      githubFetch: async (url) => {
        if (url === 'https://api.github.com/repos/example/text-only/contents/?ref=main') {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                type: 'file',
                name: 'SKILL.md',
                path: 'SKILL.md',
                download_url: 'https://raw.githubusercontent.com/example/text-only/main/SKILL.md'
              }
            ],
            arrayBuffer: async () => new ArrayBuffer(0)
          }
        }
        if (url === 'https://raw.githubusercontent.com/example/text-only/main/SKILL.md') {
          return {
            ok: true,
            status: 200,
            json: async () => ({}),
            arrayBuffer: async () =>
              new TextEncoder().encode(
                '---\nname: text-only\ndescription: Text instructions\n---\nRead carefully.\n'
              ).buffer
          }
        }
        throw new Error(`Unexpected fixture URL: ${url}`)
      }
    })
    const dataBase64 = Buffer.from(
      zipSync({
        'SKILL.md': strToU8(
          '---\nname: text-only\ndescription: Text instructions\n---\nRead carefully.\n'
        )
      })
    ).toString('base64')

    vi.stubEnv('PATH', '')
    await expect(
      source === 'zip'
        ? catalog.importSkillZip({ dataBase64 })
        : catalog.importSkill({ url: 'https://github.com/example/text-only/tree/main' })
    ).resolves.toMatchObject({
      id: 'imported-text-only'
    })
    expect(await catalog.listSkills()).toContainEqual(
      expect.objectContaining({ id: 'imported-text-only' })
    )
  }
)

it('imports the same text-only Skill without Python when no bundled helper exists', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'skill-import-no-helpers-'))
  roots.push(storageRoot)
  const catalog = new SkillCatalogModule({
    storageRoot,
    repository: new SettingsRepository(storageRoot),
    skillRegistry: { list: async () => [] } as unknown as SkillRegistry
  })
  const dataBase64 = Buffer.from(
    zipSync({
      'SKILL.md': strToU8(
        '---\nname: text-only\ndescription: Text instructions\n---\nRead carefully.\n'
      )
    })
  ).toString('base64')

  vi.stubEnv('PATH', '')
  await expect(catalog.importSkillZip({ dataBase64 })).resolves.toMatchObject({
    id: 'imported-text-only'
  })
})
