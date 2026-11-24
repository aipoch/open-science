import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDatabaseFixture } from '../database/migrated-database.test-support'
import { createProjectDbClient } from './prisma-client'
import { ProjectRepository } from './repository'

const locationProbe = vi.hoisted(() => vi.fn())
vi.mock('./project-folder-location', () => ({ detectProjectFolderWarnings: locationProbe }))

describe('Project folder capability-first warnings', () => {
  const database = registerDatabaseFixture()
  let root: string
  let client: ReturnType<typeof createProjectDbClient>
  let repository: ProjectRepository
  const preflight = vi.fn()
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'folder-warning-admission-')))
    for (const name of ['home', 'data', 'config', 'project']) await mkdir(join(root, name))
    client = await database(join(root, 'config'))
    preflight.mockReset().mockResolvedValue(undefined)
    locationProbe.mockReset().mockResolvedValue(['network', 'removable'])
    repository = new ProjectRepository(async () => client, undefined, {
      homePath: join(root, 'home'),
      dataRoot: join(root, 'data'),
      configRoot: join(root, 'config'),
      preflight
    })
  })
  afterEach(async () => {
    await client?.$disconnect()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it.each([
    'WINDOWS_ACL_NETWORK_PATH_UNSUPPORTED',
    'WINDOWS_ACL_NETWORK_TARGET_UNSUPPORTED',
    'WINDOWS_ACL_VOLUME_UNSUPPORTED'
  ])(
    'preserves %s as a blocking protection failure before showing any location warning',
    async (code) => {
      preflight.mockRejectedValue(
        new Error(`${code}: Selected location is unsupported in the current protected mode.`)
      )
      const result = await repository.validateFolder({ path: join(root, 'project') })
      expect(result).toMatchObject({
        ok: false,
        kind: 'unavailable',
        diagnostics: expect.stringContaining(code)
      })
      expect(locationProbe).not.toHaveBeenCalled()
      await expect(
        repository.create({ name: 'Still blocked', rootPath: join(root, 'project') })
      ).rejects.toMatchObject({ code: 'project-folder-unavailable' })
      expect(await client.project.count()).toBe(0)
    }
  )

  it('returns nonblocking risk signals only after successful access and protection checks', async () => {
    expect(await repository.validateFolder({ path: join(root, 'project') })).toEqual({
      ok: true,
      path: join(root, 'project'),
      warnings: ['network', 'removable']
    })
    expect(locationProbe).toHaveBeenCalledExactlyOnceWith(join(root, 'project'))
    expect(preflight).toHaveBeenCalledWith(
      join(root, 'project'),
      'rw',
      join(root, 'project'),
      'tree'
    )
    await expect(
      repository.create({
        name: 'Supported network or removable location',
        rootPath: join(root, 'project')
      })
    ).resolves.toMatchObject({ rootPath: join(root, 'project') })
  })
})
