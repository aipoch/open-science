import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  prepareSkillRuntimeEnvironment,
  type SkillRuntimeEnvironmentContributor
} from './agent-skill-runtime-environment'

const roots: string[] = []

const makeRuntimeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-skill-runtime-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const expectDirectoryInside = async (root: string, path: string): Promise<void> => {
  expect(relative(await realpath(root), await realpath(path))).not.toMatch(/^\.\.(?:[/\\]|$)/)
  expect((await stat(path)).isDirectory()).toBe(true)
}

describe('prepareSkillRuntimeEnvironment', () => {
  it('prepares common temporary and cache directories for an agent Skill runtime', async () => {
    const runtimeRoot = await makeRuntimeRoot()

    const prepared = await prepareSkillRuntimeEnvironment(runtimeRoot)

    expect(prepared.env).toMatchObject({
      TMPDIR: join(runtimeRoot, 'tmp'),
      TMP: join(runtimeRoot, 'tmp'),
      TEMP: join(runtimeRoot, 'tmp'),
      XDG_CACHE_HOME: join(runtimeRoot, 'cache')
    })
    await Promise.all(prepared.directories.map((path) => expectDirectoryInside(runtimeRoot, path)))
  })

  it('isolates Python bytecode, package, and user installation state', async () => {
    const runtimeRoot = await makeRuntimeRoot()

    const prepared = await prepareSkillRuntimeEnvironment(runtimeRoot)

    expect(prepared.env).toMatchObject({
      PYTHONPYCACHEPREFIX: join(runtimeRoot, 'python', 'pycache'),
      PIP_CACHE_DIR: join(runtimeRoot, 'python', 'pip-cache'),
      PYTHONUSERBASE: join(runtimeRoot, 'python', 'user-base')
    })
    await Promise.all(
      ['PYTHONPYCACHEPREFIX', 'PIP_CACHE_DIR', 'PYTHONUSERBASE'].map((name) =>
        expectDirectoryInside(runtimeRoot, prepared.env[name])
      )
    )
  })

  it('isolates Node compilation and npm caches', async () => {
    const runtimeRoot = await makeRuntimeRoot()

    const prepared = await prepareSkillRuntimeEnvironment(runtimeRoot)

    expect(prepared.env).toMatchObject({
      NODE_COMPILE_CACHE: join(runtimeRoot, 'node', 'compile-cache'),
      npm_config_cache: join(runtimeRoot, 'node', 'npm-cache')
    })
    await Promise.all(
      ['NODE_COMPILE_CACHE', 'npm_config_cache'].map((name) =>
        expectDirectoryInside(runtimeRoot, prepared.env[name])
      )
    )
  })

  it('isolates R cache, configuration, data, and user libraries', async () => {
    const runtimeRoot = await makeRuntimeRoot()

    const prepared = await prepareSkillRuntimeEnvironment(runtimeRoot)

    expect(prepared.env).toMatchObject({
      R_USER_CACHE_DIR: join(runtimeRoot, 'r', 'cache'),
      R_USER_CONFIG_DIR: join(runtimeRoot, 'r', 'config'),
      R_USER_DATA_DIR: join(runtimeRoot, 'r', 'data'),
      R_LIBS_USER: join(runtimeRoot, 'r', 'library')
    })
    await Promise.all(
      ['R_USER_CACHE_DIR', 'R_USER_CONFIG_DIR', 'R_USER_DATA_DIR', 'R_LIBS_USER'].map((name) =>
        expectDirectoryInside(runtimeRoot, prepared.env[name])
      )
    )
  })

  it('adds a new language through a contributor without replacing built-in environments', async () => {
    const runtimeRoot = await makeRuntimeRoot()
    const julia: SkillRuntimeEnvironmentContributor = {
      directoryEnvironment: { JULIA_DEPOT_PATH: 'julia/depot' }
    }

    const prepared = await prepareSkillRuntimeEnvironment(runtimeRoot, [julia])

    expect(prepared.env).toMatchObject({
      TMPDIR: join(runtimeRoot, 'tmp'),
      PYTHONPYCACHEPREFIX: join(runtimeRoot, 'python', 'pycache'),
      NODE_COMPILE_CACHE: join(runtimeRoot, 'node', 'compile-cache'),
      R_USER_CACHE_DIR: join(runtimeRoot, 'r', 'cache'),
      JULIA_DEPOT_PATH: join(runtimeRoot, 'julia', 'depot')
    })
    await expectDirectoryInside(runtimeRoot, prepared.env.JULIA_DEPOT_PATH)
  })
})
