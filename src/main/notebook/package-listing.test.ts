import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
  envId: '/data/runtime/envs/fixture-python/bin/python',
  interpreterPath: '/data/runtime/envs/fixture-python/bin/python',
  label: 'Test managed Python',
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
      condaPrefixFromInterpreter('/data/runtime/envs/fixture-python/bin/python', 'python', 'linux')
    ).toBe('/data/runtime/envs/fixture-python')
    expect(condaPrefixFromInterpreter('/data/runtime/envs/fixture-r/bin/R', 'r', 'linux')).toBe(
      '/data/runtime/envs/fixture-r'
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

// Synthetic records exercise both response formats without depending on an installed inventory.
const micromambaRecords = [
  {
    name: 'fixture-alpha',
    version: '1.2.3',
    build_string: 'fixture_build_0',
    channel: 'fixture-channel'
  },
  {
    name: 'fixture-beta',
    version: '4.5.6',
    build_string: 'fixture_build_1',
    channel: 'fixture-channel'
  }
]
const expectedMicromambaPackages = [
  {
    name: 'fixture-alpha',
    version: '1.2.3',
    build: 'fixture_build_0',
    channel: 'fixture-channel'
  },
  { name: 'fixture-beta', version: '4.5.6', build: 'fixture_build_1', channel: 'fixture-channel' }
]
const micromambaOutputs = [
  { version: '2.8.1', stdout: JSON.stringify(micromambaRecords) },
  {
    version: '2.9.0',
    stdout: JSON.stringify({
      packages: micromambaRecords,
      log_history: [{ level: 'info', message: 'Package inventory complete' }]
    })
  }
]

describe('parseMicromambaListJson', () => {
  it.each(micromambaOutputs)('parses $version name/version/build/channel entries', ({ stdout }) => {
    expect(parseMicromambaListJson(stdout)).toEqual(expectedMicromambaPackages)
  })

  it('prefers build_string and falls back to a string build field', () => {
    const stdout = JSON.stringify([
      { name: 'preferred', version: '1', build_string: 'current', build: 'legacy' },
      { name: 'legacy', version: '1', build: 'legacy' },
      { name: 'invalid-current', version: '1', build_string: 123, build: 'legacy' },
      { name: 'invalid-builds', version: '1', build_string: null, build: 123, channel: 123 },
      { name: 'missing-builds', version: '1' }
    ])
    expect(parseMicromambaListJson(stdout)).toEqual([
      { name: 'preferred', version: '1', build: 'current' },
      { name: 'legacy', version: '1', build: 'legacy' },
      { name: 'invalid-current', version: '1', build: 'legacy' },
      { name: 'invalid-builds', version: '1' },
      { name: 'missing-builds', version: '1' }
    ])
  })

  it.each(['array', 'object'])('skips malformed entries in an %s payload', (shape) => {
    const entries = [
      { name: 'valid-package', version: '1.0.0' },
      { name: 'no-version' },
      { name: 123, version: '1' },
      { name: 'numeric-version', version: 1 },
      null,
      123,
      [],
      'garbage'
    ]
    const stdout = JSON.stringify(shape === 'array' ? entries : { packages: entries })
    expect(parseMicromambaListJson(stdout)).toEqual([{ name: 'valid-package', version: '1.0.0' }])
  })

  it.each(['[]', '{"packages":[],"log_history":[]}'])(
    'accepts an empty inventory: %s',
    (stdout) => {
      expect(parseMicromambaListJson(stdout)).toEqual([])
    }
  )

  it('throws a useful error on invalid JSON', () => {
    expect(() => parseMicromambaListJson('not json')).toThrow(/valid JSON/)
  })

  it.each([
    'null',
    'false',
    '1',
    '"packages"',
    '{}',
    '{"log_history":[]}',
    '{"packages":null}',
    '{"packages":{}}',
    '{"packages":"[]"}'
  ])('rejects an unexpected payload instead of showing an empty inventory: %s', (stdout) => {
    expect(() => parseMicromambaListJson(stdout)).toThrow(/unexpected shape/)
  })
})

describe('parsePipListJson', () => {
  it('parses pip list --format=json entries (name/version only)', () => {
    const stdout = JSON.stringify([
      { name: 'pip-fixture-alpha', version: '1.2.3' },
      { name: 'pip-fixture-beta', version: '4.5.6' }
    ])
    expect(parsePipListJson(stdout)).toEqual([
      { name: 'pip-fixture-alpha', version: '1.2.3' },
      { name: 'pip-fixture-beta', version: '4.5.6' }
    ])
  })

  it('throws a useful error on invalid JSON', () => {
    expect(() => parsePipListJson('warning: something')).toThrow(/valid JSON/)
  })
})

describe('parseRPackageList', () => {
  it('parses tab-separated name/version lines and collapses duplicate rows', () => {
    const stdout = [
      'rFixtureAlpha\t1.2.3',
      'rFixtureBeta\t4.5.6',
      'rFixtureAlpha\t1.2.3',
      '',
      'bad-line'
    ].join('\n')
    expect(parseRPackageList(stdout)).toEqual([
      { name: 'rFixtureAlpha', version: '1.2.3' },
      { name: 'rFixtureBeta', version: '4.5.6' }
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

  describe.each(micromambaOutputs)('micromamba $version', ({ stdout }) => {
    it.each([
      { language: 'python', provenance: 'app-managed', prefix: 'fixture-python', binary: 'python' },
      { language: 'r', provenance: 'app-managed', prefix: 'fixture-r', binary: 'R' },
      {
        language: 'python',
        provenance: 'agent-created',
        prefix: 'fixture-created-python',
        binary: 'python'
      }
    ] as const)('lists $prefix against the derived prefix', async (target) => {
      const exec = execReturning(stdout)
      const interpreterPath = `/data/runtime/envs/${target.prefix}/bin/${target.binary}`
      const packages = await listEnvPackages(
        env({
          language: target.language,
          provenance: target.provenance,
          envId: interpreterPath,
          interpreterPath
        }),
        { exec, micromamba: '/mm', runtimeRoot: '/data/runtime', platform: 'linux' }
      )

      expect(packages).toEqual(expectedMicromambaPackages)
      const call = vi.mocked(exec).mock.calls[0]
      expect(call[0]).toBe('/mm')
      expect(call[1]).toEqual([
        '--no-rc',
        'list',
        '--root-prefix',
        '/data/runtime',
        '--prefix',
        `/data/runtime/envs/${target.prefix}`,
        '--json'
      ])
      expect(call[2]?.windowsHide).toBe(true)
      expect(call[2]?.timeout).toBeGreaterThan(0)
    })
  })

  it('passes macOS executable and prefix paths as literal arguments to the limit shim', async () => {
    const exec = execReturning(micromambaOutputs[1].stdout)
    const runtimeRoot = '/data/runtime spaces; $(exit 99)'
    const micromamba = '/tools/micro mamba; $(exit 99)'
    const prefix = `${runtimeRoot}/envs/python 'quoted'`
    await listEnvPackages(env({ interpreterPath: `${prefix}/bin/python` }), {
      exec,
      micromamba,
      runtimeRoot,
      platform: 'darwin'
    })
    const [file, args] = vi.mocked(exec).mock.calls[0]
    expect(file).toBe('/bin/sh')
    expect(args[0]).toBe('-c')
    expect(args[1]).not.toContain(micromamba)
    expect(args[1]).not.toContain(prefix)
    expect(args.slice(2)).toEqual([
      'micromamba-package-list',
      micromamba,
      '--no-rc',
      'list',
      '--root-prefix',
      runtimeRoot,
      '--prefix',
      prefix,
      '--json'
    ])
  })

  it.runIf(process.platform === 'darwin')(
    'bounds only excessive child soft limits and preserves literal paths and the hard limit',
    async ({ skip }) => {
      const execute = promisify(execFile)
      const { stdout: parentLimits } = await execute('/bin/sh', [
        '-c',
        'ulimit -S -n; ulimit -H -n'
      ])
      const hardLimit = parentLimits.trim().split('\n')[1]
      if (hardLimit.trim() !== 'unlimited' && Number(hardLimit) < 1048578) skip()
      const directory = await mkdtemp(join(tmpdir(), 'package-list-limit-'))
      const micromamba = join(directory, `micro mamba; $(exit 99) 'quoted'`)
      const prefix = join(directory, `envs/python; $(exit 99) 'quoted'`)
      try {
        await writeFile(
          micromamba,
          [
            '#!/bin/sh',
            '[ "$6" = "$EXPECTED_PREFIX" ] || exit 91',
            `printf '[{"name":"limit","version":"%s","build_string":"%s"}]' "$(ulimit -S -n)" "$(ulimit -H -n)"`
          ].join('\n')
        )
        await chmod(micromamba, 0o700)
        for (const [inherited, expected] of [
          ['1048578', '65536'],
          ['1048576', '1048576'],
          ['1048575', '1048575'],
          ['64', '64'],
          ...(hardLimit === 'unlimited' ? [['unlimited', '65536']] : [])
        ]) {
          const packages = await listEnvPackages(
            env({ interpreterPath: join(prefix, 'bin/python') }),
            {
              micromamba,
              runtimeRoot: directory,
              platform: 'darwin',
              exec: (file, args, options) =>
                execute(
                  '/bin/sh',
                  [
                    '-c',
                    'ulimit -S -n "$1" || exit; shift; exec "$@"',
                    'inherited-limit',
                    inherited,
                    file,
                    ...args
                  ],
                  { ...options, env: { ...options.env, EXPECTED_PREFIX: prefix } }
                )
            }
          )
          expect(packages).toEqual([{ name: 'limit', version: expected, build: hardLimit.trim() }])
        }
        const { stdout: unchangedLimits } = await execute('/bin/sh', [
          '-c',
          'ulimit -S -n; ulimit -H -n'
        ])
        expect(unchangedLimits).toBe(parentLimits)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

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
    const exec = execReturning(JSON.stringify([{ name: 'pip-fixture-alpha', version: '1.2.3' }]))
    const target = env({
      provenance: 'user-own',
      envId: '/usr/bin/python3',
      interpreterPath: '/usr/bin/python3',
      label: 'System Python'
    })
    const packages = await listEnvPackages(target, { exec })

    expect(packages).toEqual([{ name: 'pip-fixture-alpha', version: '1.2.3' }])
    const call = vi.mocked(exec).mock.calls[0]
    expect(call[0]).toBe('/usr/bin/python3')
    expect(call[1]).toEqual(['-m', 'pip', 'list', '--format=json'])
  })

  it('lists a user-own R env with the Rscript sibling of its R binary', async () => {
    const exec = execReturning('rFixtureAlpha\t1.2.3\n')
    const target = env({
      language: 'r',
      provenance: 'user-own',
      envId: '/usr/local/bin/R',
      interpreterPath: '/usr/local/bin/R',
      label: 'System R'
    })
    const packages = await listEnvPackages(target, { exec })

    expect(packages).toEqual([{ name: 'rFixtureAlpha', version: '1.2.3' }])
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
