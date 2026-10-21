import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareFixture, verifyFixture } from './fixture'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it('seeds actual production stores once, observes preservation without repairing corrupt data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-update-fixture-'))
  roots.push(root)
  const config = { configRoot: join(root, 'config'), dataRoot: join(root, 'data') }
  await prepareFixture(config)
  const manifest = JSON.parse(await readFile(join(root, 'fixture-manifest.json'), 'utf8'))
  const before = await stat(manifest.sessionPath)
  expect(await verifyFixture(config)).toMatchObject({
    preserved: true,
    recoveryWrite: { exists: false }
  })
  expect((await stat(manifest.sessionPath)).mtimeMs).toBe(before.mtimeMs)
  await expect(prepareFixture(config)).rejects.toThrow('Refusing to reseed')
  await writeFile(manifest.attachment.path, 'corrupt fixture')
  expect(await verifyFixture(config)).toMatchObject({
    preserved: false,
    checks: { attachment: false }
  })
  expect(await readFile(manifest.attachment.path, 'utf8')).toBe('corrupt fixture')
  await writeFile(join(manifest.workspace, 'recovery-write.txt'), 'LOCAL_UPDATE_RECOVERY_WRITE\n')
  expect(await verifyFixture(config)).toMatchObject({ recoveryWrite: { exists: true } })
  const database = join(config.configRoot, 'open-science.db')
  await rm(database)
  expect(await verifyFixture(config)).toMatchObject({
    preserved: false,
    checks: { project: false }
  })
  await expect(stat(database)).rejects.toMatchObject({ code: 'ENOENT' })
}, 30000)
