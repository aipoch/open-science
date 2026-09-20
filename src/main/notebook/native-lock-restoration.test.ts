import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { zipSync } from 'fflate'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type {
  NotebookEnvironmentLock,
  NotebookEnvironmentLockComponent,
  NotebookEnvironmentLockFile
} from '../../shared/notebook'
import type { InstallSpawn } from './package-manager'
import { nativeLockRestoreState, restoreNativeEnvironmentLock } from './native-lock-restoration'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import { rScriptBin } from './runtime-paths'

type NativeComponent = Extract<NotebookEnvironmentLockComponent, { ecosystem: 'python' | 'r' }>

describe.skipIf(!process.env.OPEN_SCIENCE_TEST_R_ENV)('renv restore API compatibility', () => {
  it.each(['legacy', 'strict', 'retry'] as const)(
    'runs against the %s restore signature',
    async (capability) => {
      const root = await mkdtemp(join(tmpdir(), 'renv-api-compatibility-'))
      const library = join(root, 'lib', 'R', 'library')
      const spawn = vi.fn<InstallSpawn>(async (_command, args) => {
        // Execute the generated R call with versioned API fixtures instead of installing packages.
        // The formals/unused-dots contract matches renv 1.1.5, 1.2.0, and 1.2.4 respectively.
        const expression = args[args.indexOf('-e') + 1]!.replaceAll(
          'renv::restore',
          'restore_fixture'
        )
        const fixture = `restore_fixture <- function(lockfile, library, ..., prompt=TRUE${capability !== 'legacy' ? ', strict=FALSE' : ''}${capability === 'retry' ? ', retry=NULL' : ''}) {
        if (length(list(...))) stop("unused arguments passed to restore")
        stopifnot(identical(lockfile, ${JSON.stringify(join(root, 'renv.lock'))}), identical(library, ${JSON.stringify(library)}), identical(prompt, FALSE))
        ${capability !== 'legacy' ? 'stopifnot(identical(strict, TRUE))' : ''}
        ${capability === 'retry' ? 'stopifnot(identical(retry, FALSE))' : ''}
        cat("restore contract satisfied")
      }\n${expression}`
        const { stdout, stderr } = await promisify(execFile)(
          rScriptBin(process.env.OPEN_SCIENCE_TEST_R_ENV!),
          ['--vanilla', '-e', fixture],
          { timeout: 15_000 }
        )
        expect(stdout).toContain('restore contract satisfied')
        return { code: 0, stdout, stderr }
      })
      try {
        const lock = lockWith(
          {
            ecosystem: 'r',
            format: 'renv-lock',
            resolution: 'locked',
            files: [
              file(
                'renv.lock',
                JSON.stringify({
                  Packages: { ggplot2: { Version: '4.0.3', Source: 'Repository' } }
                })
              )
            ]
          },
          'r-renv',
          'ggplot2'
        )
        // Linux layout makes the selected library explicit and portable for this R API test.
        await restoreNativeEnvironmentLock({
          lock,
          prefix: root,
          locksRoot: root,
          platform: 'linux',
          spawn
        })
        expect(spawn).toHaveBeenCalledOnce()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

const lockWith = (
  component: NativeComponent,
  tool: string,
  packageName: string
): NotebookEnvironmentLock => ({
  schemaVersion: 1,
  format: 'environment-lock-bundle',
  kernelKind: component.ecosystem,
  environmentName: `default-${component.ecosystem}`,
  components: [
    {
      ecosystem: 'conda',
      format: 'conda-explicit-md5',
      resolution: 'locked',
      explicitLock:
        '@EXPLICIT\nhttps://example.test/package.conda#0123456789abcdef0123456789abcdef\n',
      packages: [component.ecosystem === 'python' ? 'python' : 'r-base', tool]
    },
    component
  ],
  untrackedPackages: [`${component.ecosystem}:${packageName}`]
})

const file = (path: string, content: string): NotebookEnvironmentLockFile => ({
  path,
  content,
  checksum: '0'.repeat(64)
})

describe('native Environment lock restoration', () => {
  it.each([
    ['1.2.0', '1.2', 'ready'],
    ['1.2', '1.2.0.0', 'ready'],
    ['1.2.1', '1.2', 'unsupported'],
    ['1.2+custom', '1.2', 'unsupported'],
    ['1.2rc1', '1.2', 'unsupported']
  ])(
    'matches Python native release %s to %s while preserving changed builds',
    (version, locked, state) => {
      const lock = lockWith(
        {
          ecosystem: 'python',
          format: 'pip-requirements',
          resolution: 'locked',
          files: [file('requirements.lock', `six==${locked} --hash=sha256:${'a'.repeat(64)}\n`)]
        },
        'pip',
        'six'
      )
      expect(
        nativeLockRestoreState(lock, [
          {
            name: 'six',
            version,
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ])
      ).toMatchObject({ state })
    }
  )

  it('uses Python os.devnull and removes case-insensitive pip overrides on Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-pip-windows-env-'))
    const spawn = vi.fn<InstallSpawn>(async () => ({ code: 0, stdout: '', stderr: '' }))
    try {
      await restoreNativeEnvironmentLock({
        prefix: join(root, 'env'),
        locksRoot: join(root, 'locks'),
        platform: 'win32',
        spawn,
        inheritedEnv: {
          pip_target: 'C:\\outside',
          Pip_Dry_Run: '1',
          Pip_Config_File: 'C:\\pip.ini'
        },
        lock: lockWith(
          {
            ecosystem: 'python',
            format: 'pip-requirements',
            resolution: 'locked',
            files: [file('requirements.lock', `six==1.17.0 --hash=sha256:${'a'.repeat(64)}\n`)]
          },
          'pip',
          'six'
        )
      })
      const env = spawn.mock.calls[0]?.[2]
      expect(env?.PIP_CONFIG_FILE).toBe('nul')
      expect(env?.pip_target).toBeUndefined()
      expect(env?.Pip_Dry_Run).toBeUndefined()
      expect(env?.Pip_Config_File).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it.skipIf(!process.env.RUN_KERNEL || !process.env.OPEN_SCIENCE_TEST_PYTHON)(
    'installs a hashed wheel into the isolated interpreter despite ambient pip configuration',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'native-lock-isolation-'))
      const prefix = join(root, 'env')
      const execute = promisify(execFile)
      try {
        await execute(process.env.OPEN_SCIENCE_TEST_PYTHON!, ['-I', '-m', 'venv', prefix], {
          timeout: 30_000
        })
        const wheels = join(root, 'wheels')
        const outside = join(root, 'outside')
        await mkdir(wheels)
        await mkdir(outside)
        await writeFile(join(outside, 'marker'), 'untouched')
        const config = join(root, 'pip.conf')
        await writeFile(config, `[install]\ntarget = ${outside}\ndry-run = true\n`)
        const payload: Record<string, Uint8Array> = {
          'lock_probe.py': Buffer.from('VALUE = 42\n'),
          'lock_probe-1.0.dist-info/METADATA': Buffer.from(
            'Metadata-Version: 2.1\nName: lock-probe\nVersion: 1.0\n'
          ),
          'lock_probe-1.0.dist-info/WHEEL': Buffer.from(
            'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
          )
        }
        payload['lock_probe-1.0.dist-info/RECORD'] = Buffer.from(
          [...Object.keys(payload), 'lock_probe-1.0.dist-info/RECORD']
            .map((path) => `${path},,`)
            .join('\n') + '\n'
        )
        const wheel = Buffer.from(zipSync(payload))
        await writeFile(join(wheels, 'lock_probe-1.0-py3-none-any.whl'), wheel)
        const hash = createHash('sha256').update(wheel).digest('hex')
        await restoreNativeEnvironmentLock({
          prefix,
          locksRoot: join(root, 'locks'),
          lock: lockWith(
            {
              ecosystem: 'python',
              format: 'pip-requirements',
              resolution: 'locked',
              files: [file('requirements.lock', `lock-probe==1.0 --hash=sha256:${hash}\n`)]
            },
            'pip',
            'lock-probe'
          ),
          inheritedEnv: {
            PIP_TARGET: outside,
            PIP_DRY_RUN: '1',
            PIP_CONFIG_FILE: config,
            PIP_NO_INDEX: '1',
            PIP_FIND_LINKS: wheels,
            PYTHONHOME: outside,
            PYTHONPATH: outside
          },
          spawn: sandboxedPackageSpawn({
            request: { language: 'python', packages: ['lock-probe'], workspaceCwd: root },
            storageRoot: root,
            runtimeRoot: root,
            processSandbox: {
              wrap: async (invocation) => {
                expect(invocation.env.PIP_CONFIG_FILE).toBe(
                  process.platform === 'win32' ? 'nul' : '/dev/null'
                )
                expect(invocation.env.PIP_REPORT).toBeDefined()
                expect(invocation.filesystem.readWriteRoots).toContain(
                  dirname(invocation.env.PIP_REPORT!)
                )
                return {
                  executable: invocation.executable,
                  args: invocation.args,
                  env: invocation.env,
                  annotateStderr: (stderr) => stderr,
                  cleanup: vi.fn()
                }
              }
            }
          })
        })
        const python = join(
          prefix,
          process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
        )
        const result = await execute(python, [
          '-I',
          '-c',
          'import lock_probe; print(lock_probe.VALUE); print(lock_probe.__file__)'
        ])
        expect(result.stdout).toContain('42\n')
        expect(result.stdout).toContain(prefix)
        expect(await readdir(outside)).toEqual(['marker'])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    60_000
  )
  it.each(['renv-lock', 'pak-lock'] as const)(
    'accepts equivalent R version separators in %s without accepting a different release',
    (format) => {
      const lock = lockWith(
        {
          ecosystem: 'r',
          format,
          resolution: 'locked',
          files: [
            file(
              format === 'renv-lock' ? 'renv.lock' : 'pkg.lock',
              JSON.stringify(
                format === 'renv-lock'
                  ? { Packages: { RColorBrewer: { Version: '1.1-3' } } }
                  : { packages: [{ package: 'RColorBrewer', version: '1.1-3' }] }
              )
            )
          ]
        },
        format === 'renv-lock' ? 'r-renv' : 'r-pak',
        'rcolorbrewer'
      )
      const observed = {
        name: 'RColorBrewer',
        ecosystem: 'r' as const,
        versionStatus: 'known' as const,
        evidenceSources: ['r-session-info' as const]
      }
      expect(nativeLockRestoreState(lock, [{ ...observed, version: '1.1.3' }])).toMatchObject({
        state: 'ready'
      })
      expect(nativeLockRestoreState(lock, [{ ...observed, version: '1.1.4' }])).toMatchObject({
        state: 'unsupported',
        diagnostics: [{ reason: 'package-version-mismatch' }]
      })
    }
  )
  it.each(['renv-lock', 'pak-lock'] as const)(
    'preserves exact R package identities in %s with legacy coverage keys',
    (format) => {
      const makeLock = (names: string[]): NotebookEnvironmentLock =>
        lockWith(
          {
            ecosystem: 'r',
            format,
            resolution: 'locked',
            files: [
              file(
                format === 'renv-lock' ? 'renv.lock' : 'pkg.lock',
                JSON.stringify(
                  format === 'renv-lock'
                    ? {
                        Packages: Object.fromEntries(
                          names.map((name) => [name, { Package: name, Version: '1.0' }])
                        )
                      }
                    : { packages: names.map((name) => ({ package: name, version: '1.0' })) }
                )
              )
            ]
          },
          format === 'renv-lock' ? 'r-renv' : 'r-pak',
          'r-utils'
        )
      const observed = {
        name: 'R.utils',
        ecosystem: 'r' as const,
        version: '1.0',
        versionStatus: 'known' as const,
        evidenceSources: ['r-session-info' as const]
      }
      // Persisted coverage tokens remain canonical; actual R package names do not.
      expect(nativeLockRestoreState(makeLock(['R.utils']), [observed]).state).toBe('ready')
      for (const name of ['r.utils', 'R..utils']) {
        expect(nativeLockRestoreState(makeLock([name]), [observed]).state).toBe('unsupported')
        // Ambiguity must also be rejected when restoring without the original inventory.
        expect(nativeLockRestoreState(makeLock(['R.utils', name])).state).toBe('unsupported')
      }
    }
  )

  it('rejects a renv record whose Package disagrees with its key', () => {
    const lock = lockWith(
      {
        ecosystem: 'r',
        format: 'renv-lock',
        resolution: 'locked',
        files: [
          file(
            'renv.lock',
            JSON.stringify({
              Packages: { 'R.utils': { Package: 'otherPackage', Version: '1.0' } }
            })
          )
        ]
      },
      'r-renv',
      'r-utils'
    )
    expect(nativeLockRestoreState(lock).state).toBe('unsupported')
  })

  it.each([
    {
      format: 'uv-lock' as const,
      tool: 'uv',
      config: '[project.optional-dependencies]\nscience = ["six==1.17.0"]\n',
      fields: ''
    },
    {
      format: 'uv-lock' as const,
      tool: 'uv',
      config: '[dependency-groups]\nscience = ["six==1.17.0"]\n',
      fields: ''
    },
    {
      format: 'uv-lock' as const,
      tool: 'uv',
      config: '',
      fields: 'resolution-markers = [\'sys_platform == "win32"\']\n'
    },
    {
      format: 'poetry-lock' as const,
      tool: 'poetry',
      config: '[tool.poetry.extras]\nscience = ["six"]\n',
      fields: 'optional = true\n'
    },
    {
      format: 'poetry-lock' as const,
      tool: 'poetry',
      config: '[tool.poetry.group.science]\noptional = true\n',
      fields: ''
    },
    {
      format: 'poetry-lock' as const,
      tool: 'poetry',
      config: '',
      fields: 'markers = \'sys_platform == "win32"\'\n'
    }
  ])('keeps unresolved $format installation selections explicit', (fixture) => {
    const lock = lockWith(
      {
        ecosystem: 'python',
        format: fixture.format,
        resolution: 'locked',
        files: [
          file(
            fixture.format === 'uv-lock' ? 'uv.lock' : 'poetry.lock',
            'version = 1\n[[package]]\nname = "six"\nversion = "1.17.0"\n' + fixture.fields
          ),
          file('pyproject.toml', '[project]\nname = "analysis"\n' + fixture.config)
        ]
      },
      fixture.tool,
      'six'
    )
    expect(
      nativeLockRestoreState(lock, [
        {
          name: 'six',
          version: '1.17.0',
          ecosystem: 'python',
          versionStatus: 'known',
          evidenceSources: []
        }
      ])
    ).toMatchObject({
      state: 'unsupported',
      diagnostics: [{ reason: 'project-selection-unresolved' }]
    })
    const conda = lock.components.find((component) => component.ecosystem === 'conda')!
    conda.packages.push('pip')
    lock.components.push({
      ecosystem: 'python',
      format: 'pip-requirements',
      resolution: 'locked',
      files: [file('requirements.lock', `six==1.17.0 --hash=sha256:${'1'.repeat(64)}\n`)]
    })
    // Capture and restore must choose the same exact alternative without guessing extras.
    expect(nativeLockRestoreState(lock)).toMatchObject({
      state: 'ready',
      plan: { component: { format: 'pip-requirements' } }
    })
    expect(
      nativeLockRestoreState(lock, [
        {
          name: 'six',
          version: '1.17.0',
          ecosystem: 'python',
          versionStatus: 'known',
          evidenceSources: []
        }
      ])
    ).toMatchObject({ state: 'ready', plan: { component: { format: 'pip-requirements' } } })
  })

  it.each([
    {
      ecosystem: 'python' as const,
      format: 'uv-lock' as const,
      path: 'uv.lock',
      tool: 'uv',
      content: 'version = 1\n[[package]]\nname = "analysis"\n'
    },
    {
      ecosystem: 'r' as const,
      format: 'pak-lock' as const,
      path: 'pkg.lock',
      tool: 'r-pak',
      content: JSON.stringify({ packages: [{ package: 'analysis' }] })
    },
    {
      ecosystem: 'r' as const,
      format: 'renv-lock' as const,
      path: 'renv.lock',
      tool: 'r-renv',
      content: JSON.stringify({
        Packages: {
          analysis: {
            Version: '1.0',
            Source: 'GitHub',
            RemoteType: 'github',
            RemoteHost: 'api.github.com',
            RemoteUsername: 'research',
            RemoteRepo: 'analysis',
            RemoteRef: 'main'
          }
        }
      })
    }
  ])(
    'rejects incomplete $format locks at restore time without a capture inventory',
    async (fixture) => {
      const lock = lockWith(
        {
          ecosystem: fixture.ecosystem,
          format: fixture.format,
          resolution: 'locked',
          files: [file(fixture.path, fixture.content)]
        } as NativeComponent,
        fixture.tool,
        'analysis'
      )
      const spawn = vi.fn<InstallSpawn>(async () => ({ code: 0, stdout: '', stderr: '' }))
      const root = await mkdtemp(join(tmpdir(), 'native-lock-incomplete-'))
      try {
        await expect(
          restoreNativeEnvironmentLock({
            lock,
            prefix: join(root, 'env'),
            locksRoot: join(root, 'locks'),
            spawn
          })
        ).rejects.toThrow('no exact restorable native package component')
        expect(spawn).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.each([
    {
      ecosystem: 'python' as const,
      format: 'pip-requirements' as const,
      path: 'requirements.lock',
      tool: 'pip',
      content: `analysis==1.0 --hash=sha256:${'1'.repeat(64)}\nextra==2.0 --hash=sha256:${'2'.repeat(64)}\n`
    },
    {
      ecosystem: 'r' as const,
      format: 'renv-lock' as const,
      path: 'renv.lock',
      tool: 'r-renv',
      content: JSON.stringify({
        Packages: { analysis: { Version: '1.0' }, extra: { Version: '2.0' } }
      })
    },
    {
      ecosystem: 'r' as const,
      format: 'pak-lock' as const,
      path: 'pkg.lock',
      tool: 'r-pak',
      content: JSON.stringify({
        packages: [
          { package: 'analysis', version: '1.0' },
          { package: 'extra', version: '2.0' }
        ]
      })
    }
  ])('does not certify $format packages absent from the captured environment', (fixture) => {
    const lock = lockWith(
      {
        ecosystem: fixture.ecosystem,
        format: fixture.format,
        resolution: 'locked',
        files: [file(fixture.path, fixture.content)]
      } as NativeComponent,
      fixture.tool,
      'analysis'
    )
    const observed = {
      name: 'analysis',
      ecosystem: fixture.ecosystem,
      version: '1.0',
      versionStatus: 'known' as const,
      evidenceSources: []
    }
    expect(nativeLockRestoreState(lock, [observed]).state).toBe('unsupported')
    expect(
      nativeLockRestoreState(lock, [observed, { ...observed, name: 'extra', version: '2.0' }]).state
    ).toBe('ready')
  })

  it.each([
    'different-commit',
    'missing-commit',
    'different-repository',
    'different-host',
    'unobserved-source',
    'branch-only',
    'matched'
  ] as const)('checks R GitHub source identity as well as the package version: %s', (scenario) => {
    const lock = lockWith(
      {
        ecosystem: 'r',
        format: 'renv-lock',
        resolution: 'locked',
        files: [
          file(
            'renv.lock',
            JSON.stringify({
              Packages: {
                analysis: {
                  Package: 'analysis',
                  Version: '1.0',
                  Source: 'GitHub',
                  RemoteType: 'github',
                  RemoteHost: scenario === 'different-host' ? 'git.example.test' : 'api.github.com',
                  RemoteUsername: scenario === 'different-repository' ? 'other' : 'research',
                  RemoteRepo: 'analysis',
                  RemoteSha:
                    scenario === 'missing-commit'
                      ? undefined
                      : (scenario === 'different-commit' ? 'b' : 'a').repeat(40)
                }
              }
            })
          )
        ]
      },
      'r-renv',
      'analysis'
    )
    expect(
      nativeLockRestoreState(lock, [
        {
          name: 'analysis',
          ecosystem: 'r',
          version: '1.0',
          versionStatus: 'known',
          evidenceSources: ['r-installed-packages'],
          source:
            scenario === 'unobserved-source'
              ? undefined
              : {
                  type: 'github',
                  repository: 'research/analysis',
                  ref: 'main',
                  commit: scenario === 'branch-only' ? undefined : 'a'.repeat(40)
                }
        }
      ]).state
    ).toBe(scenario === 'matched' ? 'ready' : 'unsupported')
  })

  it.each([
    [undefined, undefined, 'ready'],
    [null, undefined, 'ready'],
    ['', undefined, 'ready'],
    ['packages/analysis', 'packages/analysis', 'ready'],
    ['packages/Analysis', 'packages/analysis', 'unsupported'],
    ['packages/other', 'packages/analysis', 'unsupported'],
    ['packages/analysis', undefined, 'unsupported'],
    [undefined, 'packages/analysis', 'unsupported'],
    ['../analysis', '../analysis', 'unsupported'],
    ['.', '.', 'unsupported'],
    ['packages/', 'packages/', 'unsupported'],
    ['C:/analysis', 'C:/analysis', 'unsupported'],
    ['/analysis', '/analysis', 'unsupported'],
    ['packages\\analysis', 'packages\\analysis', 'unsupported']
  ] as const)(
    'compares GitHub subdirectory %s against captured %s: %s',
    (lockedSubdirectory, subdirectory, expected) => {
      const lock = lockWith(
        {
          ecosystem: 'r',
          format: 'renv-lock',
          resolution: 'locked',
          files: [
            file(
              'renv.lock',
              JSON.stringify({
                Packages: {
                  analysis: {
                    Package: 'analysis',
                    Version: '1.0',
                    Source: 'GitHub',
                    RemoteType: 'github',
                    RemoteHost: 'api.github.com',
                    RemoteUsername: 'research',
                    RemoteRepo: 'analysis',
                    RemoteSha: 'a'.repeat(40),
                    RemoteSubdir: lockedSubdirectory
                  }
                }
              })
            )
          ]
        },
        'r-renv',
        'analysis'
      )
      expect(
        nativeLockRestoreState(lock, [
          {
            name: 'analysis',
            ecosystem: 'r',
            version: '1.0',
            versionStatus: 'known',
            evidenceSources: ['r-installed-packages'],
            source: {
              type: 'github',
              repository: 'research/analysis',
              commit: 'a'.repeat(40),
              subdirectory
            }
          }
        ]).state
      ).toBe(expected)
      if (
        lockedSubdirectory === '.' ||
        lockedSubdirectory?.endsWith('/') ||
        lockedSubdirectory?.includes(':') ||
        lockedSubdirectory?.startsWith('/') ||
        lockedSubdirectory?.includes('..') ||
        lockedSubdirectory?.includes('\\')
      ) {
        expect(nativeLockRestoreState(lock).state).toBe('unsupported')
      }
    }
  )

  it.each([undefined, 'packages/analysis', 'packages/other'] as const)(
    'does not let legacy GitHub metadata override native subdirectory %s',
    (subdirectory) => {
      const lock = lockWith(
        {
          ecosystem: 'r',
          format: 'renv-lock',
          resolution: 'locked',
          files: [
            file(
              'renv.lock',
              JSON.stringify({
                Packages: {
                  analysis: {
                    Version: '1.0',
                    Source: 'GitHub',
                    RemoteType: 'github',
                    RemoteHost: 'api.github.com',
                    RemoteUsername: 'research',
                    RemoteRepo: 'analysis',
                    RemoteSha: 'a'.repeat(40),
                    RemoteSubdir: subdirectory,
                    GithubSubdir: 'packages/analysis'
                  }
                }
              })
            )
          ]
        },
        'r-renv',
        'analysis'
      )
      expect(nativeLockRestoreState(lock).state).toBe(
        subdirectory === 'packages/analysis' ? 'ready' : 'unsupported'
      )
    }
  )

  it.each(['different-release', 'missing-release', 'matched'] as const)(
    'checks the Bioconductor release before restoring: %s',
    (scenario) => {
      const lock = lockWith(
        {
          ecosystem: 'r',
          format: 'renv-lock',
          resolution: 'locked',
          files: [
            file(
              'renv.lock',
              JSON.stringify({
                Bioconductor: {
                  Version:
                    scenario === 'missing-release'
                      ? undefined
                      : scenario === 'matched'
                        ? '3.20'
                        : '3.19'
                },
                Packages: { DESeq2: { Version: '1.44.0', Source: 'Bioconductor' } }
              })
            )
          ]
        },
        'r-renv',
        'DESeq2'
      )
      expect(
        nativeLockRestoreState(lock, [
          {
            name: 'DESeq2',
            ecosystem: 'r',
            version: '1.44.0',
            versionStatus: 'known',
            evidenceSources: ['r-installed-packages'],
            source: { type: 'bioconductor', version: '3.20' }
          }
        ]).state
      ).toBe(scenario === 'matched' ? 'ready' : 'unsupported')
    }
  )

  it('does not count a conditional Python requirement as unconditional lock coverage', () => {
    const lock = lockWith(
      {
        ecosystem: 'python',
        format: 'pip-requirements',
        resolution: 'locked',
        files: [
          file(
            'requirements.lock',
            `numpy==1.0; sys_platform == "win32" --hash=sha256:${'1'.repeat(64)}\n`
          )
        ]
      },
      'pip',
      'numpy'
    )
    expect(
      nativeLockRestoreState(lock, [
        {
          name: 'numpy',
          ecosystem: 'python',
          version: '1.0',
          versionStatus: 'known',
          evidenceSources: ['python-importlib-metadata']
        }
      ]).state
    ).toBe('unsupported')
  })

  it('rejects native locks that would replace a Conda package with a different observed version', () => {
    const lock = lockWith(
      {
        ecosystem: 'python',
        format: 'pip-requirements',
        resolution: 'locked',
        files: [
          file(
            'requirements.lock',
            `scanpy==1.0 --hash=sha256:${'1'.repeat(64)}\nnumpy==1.0 --hash=sha256:${'1'.repeat(64)}\n`
          )
        ]
      },
      'pip',
      'scanpy'
    )
    const conda = lock.components.find((component) => component.ecosystem === 'conda')!
    conda.packages.push('numpy')
    expect(
      nativeLockRestoreState(lock, [
        {
          name: 'scanpy',
          ecosystem: 'python',
          version: '1.0',
          versionStatus: 'known',
          evidenceSources: []
        },
        {
          name: 'numpy',
          ecosystem: 'python',
          version: '2.0',
          versionStatus: 'known',
          evidenceSources: []
        }
      ]).state
    ).toBe('unsupported')
  })

  it.each([
    {
      format: 'uv-lock' as const,
      tool: 'uv',
      path: 'uv.lock',
      content: 'version = 1\n[[package]]\nname = "numpy"\nversion = "1.0"\n'
    },
    {
      format: 'poetry-lock' as const,
      tool: 'poetry',
      path: 'poetry.lock',
      content: '[[package]]\nname = "numpy"\nversion = "1.0"\n'
    },
    {
      format: 'pip-requirements' as const,
      tool: 'pip',
      path: 'requirements.lock',
      content: `numpy==1.0 --hash=sha256:${'1'.repeat(64)}\n`
    },
    {
      format: 'renv-lock' as const,
      tool: 'r-renv',
      path: 'renv.lock',
      content: JSON.stringify({ Packages: { numpy: { Version: '1.0' } } })
    },
    {
      format: 'pak-lock' as const,
      tool: 'r-pak',
      path: 'pkg.lock',
      content: JSON.stringify({ packages: [{ package: 'numpy', version: '1.0' }] })
    }
  ])('checks observed package versions against $format before certifying capture', (fixture) => {
    const component: NativeComponent = {
      ecosystem: fixture.format === 'renv-lock' || fixture.format === 'pak-lock' ? 'r' : 'python',
      format: fixture.format,
      resolution: 'locked',
      files: [file(fixture.path, fixture.content)]
    } as NativeComponent
    const lock = lockWith(component, fixture.tool, 'numpy')
    const observed = {
      name: 'numpy',
      ecosystem: component.ecosystem,
      version: '1.0',
      versionStatus: 'known' as const,
      evidenceSources: []
    }
    expect(nativeLockRestoreState(lock, [observed]).state).toBe('ready')
    expect(nativeLockRestoreState(lock, [{ ...observed, version: '2.0' }]).state).toBe(
      'unsupported'
    )
    expect(
      nativeLockRestoreState(lock, [{ ...observed, versionStatus: 'unavailable' }]).state
    ).toBe('unsupported')
    expect(nativeLockRestoreState(lock, [{ ...observed, version: undefined }]).state).toBe(
      'unsupported'
    )
    expect(nativeLockRestoreState(lock, []).state).toBe('unsupported')
  })

  it.each([
    '[[package]]\nname = "numpy"\n',
    '[[package]]\nname = "numpy"\n[package.dependencies]\nversion = "1.0"\n',
    '[[package]]\nname = "numpy"\nversion = "1.0"\n[[package]]\nname = "numpy"\nversion = "2.0"\n'
  ])('rejects missing or ambiguous TOML package versions: %s', (content) => {
    const lock = lockWith(
      {
        ecosystem: 'python',
        format: 'uv-lock',
        resolution: 'locked',
        files: [file('uv.lock', content)]
      },
      'uv',
      'numpy'
    )
    expect(
      nativeLockRestoreState(lock, [
        {
          name: 'numpy',
          ecosystem: 'python',
          version: '1.0',
          versionStatus: 'known',
          evidenceSources: []
        }
      ]).state
    ).toBe('unsupported')
  })

  it('does not certify a later matching component when restore would select the first stale lock', () => {
    const lock = lockWith(
      {
        ecosystem: 'python',
        format: 'uv-lock',
        resolution: 'locked',
        files: [file('uv.lock', '[[package]]\nname = "numpy"\nversion = "1.0"\n')]
      },
      'uv',
      'numpy'
    )
    const conda = lock.components.find((component) => component.ecosystem === 'conda')!
    conda.packages.push('pip')
    lock.components.push({
      ecosystem: 'python',
      format: 'pip-requirements',
      resolution: 'locked',
      files: [file('requirements.lock', `numpy==2.0 --hash=sha256:${'1'.repeat(64)}\n`)]
    })
    expect(
      nativeLockRestoreState(lock, [
        {
          name: 'numpy',
          ecosystem: 'python',
          version: '2.0',
          versionStatus: 'known',
          evidenceSources: []
        }
      ]).state
    ).toBe('unsupported')
  })

  it.each([
    {
      format: 'uv-lock' as const,
      tool: 'uv',
      packageName: 'scanpy',
      files: [
        file('project/uv.lock', 'version = 1\n[[package]]\nname = "scanpy"\nversion = "1.0"\n'),
        file('project/pyproject.toml', '[project]\nname = "analysis"\n')
      ],
      command: 'uv',
      args: ['sync', '--locked', '--inexact', '--no-install-project']
    },
    {
      format: 'poetry-lock' as const,
      tool: 'poetry',
      packageName: 'scanpy',
      files: [
        file('project/poetry.lock', '[[package]]\nname = "scanpy"\nversion = "1.0"\n'),
        file('project/pyproject.toml', '[tool.poetry]\nname = "analysis"\n')
      ],
      command: 'poetry',
      args: ['install', '--no-root', '--no-interaction']
    },
    {
      format: 'pip-requirements' as const,
      tool: 'pip',
      packageName: 'scanpy',
      files: [file('requirements.lock', `scanpy==1.0 --hash=sha256:${'1'.repeat(64)}\n`)],
      command: 'python',
      args: ['-m', 'pip', 'install', '--require-hashes', '--force-reinstall', '--no-deps']
    },
    {
      format: 'renv-lock' as const,
      tool: 'r-renv',
      packageName: 'DESeq2',
      files: [file('renv.lock', JSON.stringify({ Packages: { DESeq2: { Version: '1.0' } } }))],
      command: 'Rscript',
      args: ['--vanilla', '-e']
    },
    {
      format: 'pak-lock' as const,
      tool: 'r-pak',
      packageName: 'DESeq2',
      files: [
        file('pkg.lock', JSON.stringify({ packages: [{ package: 'DESeq2', version: '1.0' }] }))
      ],
      command: 'Rscript',
      args: ['--vanilla', '-e']
    }
  ])('restores an exact $format component into the Conda prefix', async (fixture) => {
    const locksRoot = await mkdtemp(join(tmpdir(), 'native-lock-restore-'))
    const component = {
      ecosystem: fixture.format === 'renv-lock' || fixture.format === 'pak-lock' ? 'r' : 'python',
      format: fixture.format,
      resolution: 'locked',
      files: fixture.files
    } as NativeComponent
    const lock = lockWith(component, fixture.tool, fixture.packageName)
    const spawn = vi.fn<InstallSpawn>(
      async (_command, _args, _env, _child, _before, _json, _cwd, options) => {
        options?.onOutput?.({ stream: 'stdout', text: 'restored\n' })
        return { code: 0, stdout: 'restored\n', stderr: '' }
      }
    )
    const onOutput = vi.fn()

    try {
      expect(nativeLockRestoreState(lock).state).toBe('ready')
      await restoreNativeEnvironmentLock({
        lock,
        prefix: '/runtime/envs/repro',
        locksRoot,
        spawn,
        platform: 'darwin',
        inheritedEnv: {
          PIP_CACHE_DIR: '/runtime/cache/pip',
          PIP_TARGET: '/outside/install',
          PIP_DRY_RUN: '1',
          PIP_CONFIG_FILE: '/outside/pip.conf',
          PIP_PROXY: 'http://proxy.example:1086',
          PYTHONHOME: '/outside/python',
          PYTHONPATH: '/outside/modules',
          R_HOME: '/outside/R',
          R_LIBS: '/outside/r-library',
          R_LIBS_SITE: '/outside/r-site'
        },
        onOutput
      })

      const [command, args, env, , , , cwd] = spawn.mock.calls[0]!
      expect(basename(command)).toBe(fixture.command)
      expect(args).toEqual(expect.arrayContaining(fixture.args))
      expect(env?.PIP_CACHE_DIR).toBe('/runtime/cache/pip')
      expect(env?.PIP_PROXY).toBe('http://proxy.example:1086')
      expect(env?.PYTHONHOME).toBeUndefined()
      expect(env?.PYTHONPATH).toBeUndefined()
      expect(env?.R_HOME).toBeUndefined()
      expect(env?.R_LIBS).toBeUndefined()
      expect(env?.R_LIBS_SITE).toBeUndefined()
      if (fixture.format === 'pip-requirements') {
        expect(env?.PIP_CONFIG_FILE).toBe('/dev/null')
        expect(env?.PIP_TARGET).toBeUndefined()
        expect(env?.PIP_DRY_RUN).toBeUndefined()
      }
      expect(cwd).toBe(join(locksRoot, fixture.files[0]!.path.includes('/') ? 'project' : ''))
      await expect(readFile(join(locksRoot, fixture.files[0]!.path), 'utf8')).resolves.toBe(
        fixture.files[0]!.content
      )
      expect(onOutput).toHaveBeenCalledWith({ stream: 'stdout', text: 'restored\n' })
    } finally {
      await rm(locksRoot, { recursive: true, force: true })
    }
  })

  it('finds a Conda-native uv executable in the Windows Library bin directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-lock-windows-'))
    const prefix = join(root, 'env')
    const locksRoot = join(root, 'locks')
    const uv = join(prefix, 'Library', 'bin', 'uv.exe')
    await mkdir(dirname(uv), { recursive: true })
    await writeFile(uv, '')
    const component: NativeComponent = {
      ecosystem: 'python',
      format: 'uv-lock',
      resolution: 'locked',
      files: [
        file('project/uv.lock', 'version = 1\n[[package]]\nname = "scanpy"\nversion = "1.0"\n'),
        file('project/pyproject.toml', '[project]\nname = "analysis"\n')
      ]
    }
    const spawn = vi.fn<InstallSpawn>(async () => ({ code: 0, stdout: '', stderr: '' }))

    try {
      await restoreNativeEnvironmentLock({
        lock: lockWith(component, 'uv', 'scanpy'),
        prefix,
        locksRoot,
        spawn,
        platform: 'win32',
        inheritedEnv: {
          Path: 'C:\\caller-bin',
          pythonpath: 'C:\\outside-modules',
          pythonhome: 'C:\\outside-python'
        }
      })
      expect(spawn.mock.calls[0]?.[0]).toBe(uv)
      const env = spawn.mock.calls[0]?.[2]
      expect(env?.PATH).toContain('C:\\caller-bin')
      expect(env?.Path).toBeUndefined()
      expect(env?.pythonpath).toBeUndefined()
      expect(env?.pythonhome).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed when the exact component does not cover the environment or its tool is absent', () => {
    const component: NativeComponent = {
      ecosystem: 'python',
      format: 'pip-requirements',
      resolution: 'locked',
      files: [file('requirements.lock', `numpy==2.0 --hash=sha256:${'1'.repeat(64)}\n`)]
    }
    expect(nativeLockRestoreState(lockWith(component, 'pip', 'scanpy')).state).toBe('unsupported')
    expect(nativeLockRestoreState(lockWith(component, 'not-pip', 'numpy')).state).toBe(
      'unsupported'
    )
  })
})
