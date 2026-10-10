import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageAppImageCli } from './appimage-launcher.mjs'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('retains a complete immutable payload after the source AppImage mount disappears, including concurrent installs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appimage-node-'))
  roots.push(root)
  const image = join(root, 'Science.AppImage'),
    mount = join(root, 'mount'),
    backend = join(mount, 'backend'),
    node = join(mount, 'node-runtime')
  await mkdir(backend, { recursive: true })
  await mkdir(node)
  await writeFile(image, 'test artifact')
  await writeFile(join(backend, 'cli.mjs'), 'CLI')
  await writeFile(join(node, 'node'), 'ordinary Node')
  const destinations = await Promise.all([
    stageAppImageCli(image, backend, node, join(root, 'cache')),
    stageAppImageCli(image, backend, node, join(root, 'cache'))
  ])
  expect(destinations[0]).toBe(destinations[1])
  await rm(mount, { recursive: true })
  expect(await stageAppImageCli(image, backend, node, join(root, 'cache'))).toBe(destinations[0])
  expect(await readFile(join(destinations[0], 'backend/cli.mjs'), 'utf8')).toBe('CLI')
  expect(await readFile(join(destinations[0], 'node-runtime/node'), 'utf8')).toBe('ordinary Node')
  await writeFile(image, 'new artifact')
  await expect(stageAppImageCli(image, backend, node, join(root, 'cache'))).rejects.toThrow()
  expect(await readFile(join(destinations[0], 'complete.json'), 'utf8')).toContain('image')
})
