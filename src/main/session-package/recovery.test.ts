import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionPackageService } from './service'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('recovers through an explicitly configured data-root alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'package-recovery-alias-'))
  roots.push(root)
  const data = join(root, 'data')
  const alias = join(root, 'configured-root')
  const id = randomUUID()
  const stage = join(data, 'session-package-imports', id)
  await mkdir(stage, { recursive: true })
  await writeFile(join(stage, '.session-package-owner'), id)
  await symlink(data, alias, 'junction')
  const service = new SessionPackageService({
    storageRoot: alias,
    getClient: async () => {
      throw new Error('No transaction started')
    }
  })
  await expect(service.recover()).resolves.toBeUndefined()
  await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['database', 'data-root'] as const)(
  'keeps the recovery gate closed when the %s is unavailable',
  async (fault) => {
    const root = await mkdtemp(join(tmpdir(), 'package-recovery-gate-'))
    roots.push(root)
    const operation = randomUUID()
    const stage = join(root, 'session-package-imports', operation)
    await mkdir(stage, { recursive: true })
    await writeFile(
      join(stage, 'journal.json'),
      JSON.stringify({
        schemaVersion: 1,
        projectId: 'target',
        sessionId: `import-${randomUUID()}`,
        directories: []
      })
    )
    const service = new SessionPackageService({
      configRoot: root,
      storageRoot: fault === 'data-root' ? join(root, 'disconnected') : root,
      getClient: async () => {
        throw new Error('Database unavailable')
      }
    })
    await expect(service.recover()).rejects.toThrow()
    expect((await stat(join(stage, 'journal.json'))).isFile()).toBe(true)
  }
)

it.each(['invalid-name', 'invalid-journal'] as const)(
  'retains %s while recovering a healthy private import',
  async (fault) => {
    const root = await mkdtemp(join(tmpdir(), 'package-recovery-'))
    roots.push(root)
    const imports = join(root, 'session-package-imports')
    const bad = join(imports, fault === 'invalid-name' ? 'unexpected' : randomUUID())
    await mkdir(bad, { recursive: true })
    await writeFile(join(bad, 'journal.json'), '{invalid')
    const id = randomUUID()
    const healthy = join(imports, id)
    await mkdir(healthy)
    await writeFile(join(healthy, '.session-package-owner'), id)
    const getClient = vi.fn(async (): Promise<never> => {
      throw new Error('No native transaction has started')
    })
    const service = new SessionPackageService({ storageRoot: root, getClient })
    await expect(service.recover()).resolves.toBeUndefined()
    await expect(service.recover()).resolves.toBeUndefined()
    expect(await readFile(join(bad, 'journal.json'), 'utf8')).toBe('{invalid')
    await expect(stat(healthy)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getClient).not.toHaveBeenCalled()
  }
)
