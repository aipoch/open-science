import { describe, expect, it, vi } from 'vitest'

import type { DiscoveredInterpreter } from '../../shared/notebook-runtime'
import {
  condaPrefixFromInterpreter,
  listEnvPackages,
  packageListingVia,
  parseMicromambaListJson,
  parsePipListJson,
  parseRPackageList,
  rListPackagesArgs,
  type ListPackagesExec
} from './package-listing'

const env = (overrides: Partial<DiscoveredInterpreter>): DiscoveredInterpreter => ({
  language: 'python',
  provenance: 'app-managed',
  envId: '/data/runtime/envs/default-python/bin/python',
  interpreterPath: '/data/runtime/envs/default-python/bin/python',
  label: 'Python 3.12 (managed)',
  runnable: true,
  ...overrides
})

describe('packageListingVia', () => {
  it('mirrors the mutability via mapping: app-owned conda envs use micromamba', () => {
    expect(packageListingVia(env({ provenance: 'app-managed' }))).toBe('micromamba')
    expect(packageListingVia(env({ provenance: 'agent-created' }))).toBe('micromamba')
    expect(packageListingVia(env({ language: 'r', provenance: 'agent-created' }))).toBe(
      'micromamba'
    )
  })

  it('dispatches user-own envs to their own pip / Rscript regardless of authorization', () => {
    expect(packageListingVia(env({ provenance: 'user-own' }))).toBe('pip')
    expect(packageListingVia(env({ language: 'r', provenance: 'user-own' }))).toBe('r-library')
  })
})

describe('condaPrefixFromInterpreter', () => {
  it('derives the prefix from a Unix interpreter two levels up', () => {
    expect(
      condaPrefixFromInterpreter('/data/runtime/envs/default-python/bin/python', 'python', 'linux')
    ).toBe('/data/runtime/envs/default-python')
    expect(condaPrefixFromInterpreter('/data/runtime/envs/default-r/bin/R', 'r', 'linux')).toBe(
      '/data/runtime/envs/default-r'
    )
  })

  it('derives the Windows python prefix from the interpreter directory', () => {
    expect(condaPrefixFromInterpreter('C:\\rt\\envs\\.p\\python.exe', 'python', 'win32')).toBe(
      'C:\\rt\\envs\\.p'
    )
  })

  it('derives the Windows conda R prefix from the Lib\\R\\bin layout', () => {
    expect(condaPrefixFromInterpreter('C:\\rt\\envs\\.r\\Lib\\R\\bin\\R.exe', 'r', 'win32')).toBe(
      'C:\\rt\\envs\\.r'
    )
  })
})

describe('parseMicromambaListJson', () => {
  it('parses name/version/build/channel entries', () => {
    const stdout = JSON.stringify([
      { name: 'numpy', version: '2.1.3', build: 'py312hb2f4e1b_0', channel: 'conda-forge' },
      { name: 'python', version: '3.12.4', build: 'h1234567_0', channel: 'conda-forge' }
    ])
    expect(parseMicromambaListJson(stdout)).toEqual([
      { name: 'numpy', version: '2.1.3', build: 'py312hb2f4e1b_0', channel: 'conda-forge' },
      { name: 'python', version: '3.12.4', build: 'h1234567_0', channel: 'conda-forge' }
    ])
  })

  it('omits build/channel when absent and skips malformed entries', () => {
    const stdout = JSON.stringify([
      { name: 'wheel', version: '0.44.0' },
      { name: 'no-version' },
      'garbage'
    ])
    expect(parseMicromambaListJson(stdout)).toEqual([{ name: 'wheel', version: '0.44.0' }])
  })

  it('throws a useful error on invalid JSON or a non-array payload', () => {
    expect(() => parseMicromambaListJson('not json')).toThrow(/valid JSON/)
    expect(() => parseMicromambaListJson('{"a": 1}')).toThrow(/JSON array/)
  })
})

describe('parsePipListJson', () => {
  it('parses pip list --format=json entries (name/version only)', () => {
    const stdout = JSON.stringify([
      { name: 'requests', version: '2.32.3' },
      { name: 'urllib3', version: '2.2.3' }
    ])
    expect(parsePipListJson(stdout)).toEqual([
      { name: 'requests', version: '2.32.3' },
      { name: 'urllib3', version: '2.2.3' }
    ])
  })

  it('throws a useful error on invalid JSON', () => {
    expect(() => parsePipListJson('warning: something')).toThrow(/valid JSON/)
  })
})

describe('parseRPackageList', () => {
  it('parses tab-separated name/version lines and collapses duplicate rows', () => {
    const stdout = ['jsonlite\t1.8.8', 'IRkernel\t1.3.2', 'jsonlite\t1.8.8', '', 'bad-line'].join(
      '\n'
    )
    expect(parseRPackageList(stdout)).toEqual([
      { name: 'jsonlite', version: '1.8.8' },
      { name: 'IRkernel', version: '1.3.2' }
    ])
  })

  it('emits an installed.packages() one-liner that does not depend on jsonlite', () => {
    const args = rListPackagesArgs()
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain('installed.packages()')
    expect(args[1]).not.toContain('jsonlite')
  })
})

describe('listEnvPackages dispatch', () => {
  const execReturning = (stdout: string): ListPackagesExec =>
    vi.fn(async () => ({ stdout, stderr: '' }))

  it('lists an app-managed env with micromamba against the derived prefix', async () => {
    const exec = execReturning(
      JSON.stringify([{ name: 'numpy', version: '2.1.3', build: 'b0', channel: 'conda-forge' }])
    )
    const target = env({ provenance: 'agent-created' })
    const packages = await listEnvPackages(target, {
      exec,
      micromamba: '/mm',
      runtimeRoot: '/data/runtime',
      platform: 'linux'
    })

    expect(packages).toEqual([
      { name: 'numpy', version: '2.1.3', build: 'b0', channel: 'conda-forge' }
    ])
    const call = vi.mocked(exec).mock.calls[0]
    expect(call[0]).toBe('/mm')
    expect(call[1]).toEqual([
      '--no-rc',
      'list',
      '--root-prefix',
      '/data/runtime',
      '--prefix',
      '/data/runtime/envs/default-python',
      '--json'
    ])
    expect(call[2]?.windowsHide).toBe(true)
    expect(call[2]?.timeout).toBeGreaterThan(0)
  })

  it('uses the shared prepared runner for an app-managed environment', async () => {
    const exec = execReturning('[]')
    const runner = {
      initialPath: '/resources/micromamba.exe',
      resolve: vi.fn().mockResolvedValue('/local-tools/micromamba-compat.exe')
    }

    await listEnvPackages(env({ provenance: 'app-managed' }), {
      exec,
      micromambaRunner: runner,
      runtimeRoot: '/data/runtime',
      platform: 'win32'
    })

    expect(runner.resolve).toHaveBeenCalledOnce()
    expect(vi.mocked(exec).mock.calls[0]?.[0]).toBe('/local-tools/micromamba-compat.exe')
  })

  it('lists a user-own python env with its own interpreter pip', async () => {
    const exec = execReturning(JSON.stringify([{ name: 'requests', version: '2.32.3' }]))
    const target = env({
      provenance: 'user-own',
      envId: '/usr/bin/python3',
      interpreterPath: '/usr/bin/python3',
      label: 'System Python'
    })
    const packages = await listEnvPackages(target, { exec })

    expect(packages).toEqual([{ name: 'requests', version: '2.32.3' }])
    const call = vi.mocked(exec).mock.calls[0]
    expect(call[0]).toBe('/usr/bin/python3')
    expect(call[1]).toEqual(['-m', 'pip', 'list', '--format=json'])
  })

  it('lists a user-own R env with the Rscript sibling of its R binary', async () => {
    const exec = execReturning('jsonlite\t1.8.8\n')
    const target = env({
      language: 'r',
      provenance: 'user-own',
      envId: '/usr/local/bin/R',
      interpreterPath: '/usr/local/bin/R',
      label: 'System R'
    })
    const packages = await listEnvPackages(target, { exec })

    expect(packages).toEqual([{ name: 'jsonlite', version: '1.8.8' }])
    const call = vi.mocked(exec).mock.calls[0]
    expect(call[0]).toBe('/usr/local/bin/Rscript')
    expect(call[1][0]).toBe('-e')
  })

  it('wraps a tool failure in a useful error naming the env and tool', async () => {
    const exec: ListPackagesExec = vi.fn(async () => {
      throw new Error('exit code 1')
    })
    await expect(
      listEnvPackages(env({ provenance: 'user-own', interpreterPath: '/usr/bin/python3' }), {
        exec
      })
    ).rejects.toThrow(/Could not list packages in .* \(pip failed: exit code 1\)/)
  })

  it('fails clearly when micromamba is needed but unavailable', async () => {
    // Empty string stands in for "resolution found no binary" without touching the real machine.
    await expect(
      listEnvPackages(env({ provenance: 'app-managed' }), {
        exec: execReturning('[]'),
        micromamba: '',
        runtimeRoot: '/data/runtime'
      })
    ).rejects.toThrow(/micromamba/)
  })
})
