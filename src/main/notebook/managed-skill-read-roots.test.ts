import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { managedSkillReadRoots } from './managed-skill-read-roots'

const fixtures: string[] = []
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-skill-roots-')))
  fixtures.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('discovers only existing framework projections, including paths with spaces and Unicode', async () => {
  const root = join(await fixture(), 'Application data 科研')
  const paths = [
    join(root, 'codex', 'skills'),
    join(root, 'codex-subscription', 'skills'),
    join(root, 'opencode', 'config', 'opencode', 'skills'),
    join(root, 'runtime-support', 'agent-skills', 'claude'),
    join(root, 'codebuddy', 'skill-runtime', '.claude', 'skills')
  ]
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })))
  await mkdir(join(root, 'claude', 'skills'), { recursive: true })
  await writeFile(join(root, 'codex', 'auth.json'), 'private')
  expect(await managedSkillReadRoots(root)).toEqual(paths)
})

it('does not create absent projections and discovers them on a later launch', async () => {
  const root = join(await fixture(), 'config')
  expect(await managedSkillReadRoots(root)).toEqual([])
  await mkdir(join(root, 'codex'), { recursive: true })
  await writeFile(join(root, 'codex', 'skills'), 'not a directory')
  expect(await managedSkillReadRoots(root)).toEqual([])
  await rm(join(root, 'codex', 'skills'))
  await mkdir(join(root, 'codex', 'skills'))
  expect(await managedSkillReadRoots(root)).toEqual([join(root, 'codex', 'skills')])
})

it.each(['projection', 'ancestor'] as const)(
  'does not grant a linked %s target',
  async (location) => {
    const root = await fixture()
    const config = join(root, 'config')
    const outside = join(root, 'private')
    await mkdir(join(config, 'codex'), { recursive: true })
    await mkdir(join(outside, 'skills'), { recursive: true })
    const link =
      location === 'projection' ? join(config, 'codex', 'skills') : join(config, 'opencode')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await managedSkillReadRoots(config)).toEqual([])
  }
)

it('resolves an application config root alias without granting the alias parent', async () => {
  const root = await fixture()
  const config = join(root, 'config')
  await mkdir(join(config, 'codex', 'skills'), { recursive: true })
  const alias = join(root, 'config-alias')
  await symlink(config, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await managedSkillReadRoots(alias)).toEqual([join(config, 'codex', 'skills')])
})
