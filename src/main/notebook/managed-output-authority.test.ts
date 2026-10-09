import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  createManagedOutputAuthority,
  resolveManagedOutputAuthority,
  revokeManagedOutputAuthority,
  type ManagedOutputAuthority
} from './managed-output-authority'

const roots: string[] = []
const scope = { projectId: 'project', sessionId: 'session', operationId: 'operation' }
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(signal?: AbortSignal): Promise<{
  root: string
  outputRoot: string
  authority: ManagedOutputAuthority
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-output-')))
  roots.push(root)
  const outputRoot = join(root, 'outputs')
  await mkdir(outputRoot)
  await writeFile(join(outputRoot, 'report.json'), '{"actual":true}')
  return {
    root,
    outputRoot,
    authority: createManagedOutputAuthority({ ...scope, outputRoot, signal })
  }
}

it('binds actual files to the exact live operation without serializable authority', async () => {
  const { authority } = await fixture()
  expect(JSON.stringify(authority)).toBe('{}')
  const resolved = await resolveManagedOutputAuthority(authority, scope, 'report.json')
  expect(resolved.path).toBe(join(resolved.root, 'report.json'))
  await expect(
    resolveManagedOutputAuthority({} as ManagedOutputAuthority, scope, 'report.json')
  ).rejects.toThrow('does not belong')
  await expect(
    resolveManagedOutputAuthority(authority, { ...scope, operationId: 'other' }, 'report.json')
  ).rejects.toThrow('does not belong')
})

it('revocation and parent cancellation invalidate existing resolved grants', async () => {
  const controller = new AbortController()
  const { authority } = await fixture(controller.signal)
  const resolved = await resolveManagedOutputAuthority(authority, scope, 'report.json')
  controller.abort()
  expect(resolved.signal.aborted).toBe(true)
  await expect(resolveManagedOutputAuthority(authority, scope, 'report.json')).rejects.toThrow()
  const second = await fixture()
  revokeManagedOutputAuthority(second.authority)
  await expect(
    resolveManagedOutputAuthority(second.authority, scope, 'report.json')
  ).rejects.toThrow('lease has ended')
})

it.each([
  '../report.json',
  '/etc/passwd',
  'a/../../report.json',
  'a\\report.json',
  './report.json',
  'a//report.json',
  'C:report.json',
  'x\0y'
])('rejects unsafe path %j', async (path) => {
  const { authority } = await fixture()
  await expect(resolveManagedOutputAuthority(authority, scope, path)).rejects.toThrow('relative')
})

it.skipIf(process.platform === 'win32')(
  'rejects linked files, parent links and non-files',
  async () => {
    const { root, outputRoot, authority } = await fixture()
    await writeFile(join(root, 'private.txt'), 'private')
    await symlink(join(root, 'private.txt'), join(outputRoot, 'linked.txt'))
    await symlink(root, join(outputRoot, 'linked-directory'))
    await link(join(root, 'private.txt'), join(outputRoot, 'hard.txt'))
    await mkdir(join(outputRoot, 'directory'))
    for (const path of ['linked.txt', 'linked-directory/private.txt', 'hard.txt', 'directory'])
      await expect(resolveManagedOutputAuthority(authority, scope, path)).rejects.toThrow()
  }
)

it.skipIf(process.platform === 'win32')(
  'rejects a root reached through a symlinked ancestor',
  async () => {
    const { root } = await fixture()
    await mkdir(join(root, 'parent'))
    await mkdir(join(root, 'parent', 'output'))
    await writeFile(join(root, 'parent', 'output', 'result.txt'), 'actual')
    await symlink(join(root, 'parent'), join(root, 'alias'))
    const authority = createManagedOutputAuthority({
      ...scope,
      outputRoot: join(root, 'alias', 'output')
    })
    await expect(resolveManagedOutputAuthority(authority, scope, 'result.txt')).rejects.toThrow(
      'canonical'
    )
  }
)
