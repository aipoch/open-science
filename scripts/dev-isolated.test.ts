import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isolatedDevEnvironment } from './dev-isolated.cjs'
import { resolveElectronProfile } from '../src/main/storage/electron-profile'
import { buildDevWebCommand } from './dev-web.cjs'

it('gives worktrees distinct stable config/profile roots and available Web ports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isolated-dev-'))
  try {
    const configs: string[] = []
    const profiles: string[] = []
    for (const name of ['first worktree', 'second worktree']) {
      const worktree = join(root, name)
      await mkdir(worktree)
      const env = isolatedDevEnvironment(worktree, {})
      const configRoot = join(await realpath(worktree), '.dev-isolate', 'runtime')
      expect(env.OPEN_SCIENCE_CONFIG_ROOT).toBe(configRoot)
      expect(isolatedDevEnvironment(worktree, {})).toEqual(env)
      expect(buildDevWebCommand(['node', 'dev-web.cjs'], env).args).toContain('--serve=0')
      configs.push(configRoot)
      profiles.push(resolveElectronProfile({ appData: root, configRoot, packaged: false, env }))
    }
    expect(new Set(configs).size).toBe(2)
    expect(new Set(profiles).size).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['OPEN_SCIENCE_E2E_STORAGE_ROOT', 'OPEN_SCIENCE_CONFIG_ROOT', 'OPEN_SCIENCE_STORAGE_ROOT'])(
  'preserves an explicit %s, profile and port without mutating the caller environment',
  (key) => {
    const env = {
      [key]: join(tmpdir(), 'shared-config'),
      OPEN_SCIENCE_USER_DATA: join(tmpdir(), 'profile'),
      OPEN_SCIENCE_WEB_PORT: '44200'
    }
    expect(isolatedDevEnvironment(process.cwd(), env)).toEqual(env)
    expect(env).not.toHaveProperty('OPEN_SCIENCE_ALLOW_MULTI_INSTANCE')
  }
)

it('does not alter the ordinary development Web port', () => {
  expect(buildDevWebCommand(['node', 'dev-web.cjs'], {}).env.OPEN_SCIENCE_WEB_PORT).toBe('44100')
})
