import { describe, expect, it, vi } from 'vitest'

// Force the fallback micromamba resolver to "not found" so the "cannot be resolved" case is
// deterministic regardless of whether the host machine happens to have micromamba on PATH (a dev box
// that ran `brew install micromamba` would otherwise resolve a real binary and fail that test). Tests
// that need a resolvable micromamba pass an explicit `micromamba` dep, so they bypass this entirely.
vi.mock('./micromamba', async (importActual) => ({
  ...(await importActual<typeof import('./micromamba')>()),
  resolveMicromamba: () => undefined
}))

import { installPackages, type InstallSpawn, type SpawnResult } from './package-manager'
import {
  envPrefix,
  pipBin,
  rLibraryDir,
  rScriptBin,
  runtimeRoot,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV
} from './runtime-paths'

// A recording spawn that returns a scripted result per call, so no real process is launched.
const scriptedSpawn = (
  results: SpawnResult[]
): { spawn: InstallSpawn; calls: [string, string[], NodeJS.ProcessEnv?][] } => {
  const calls: [string, string[], NodeJS.ProcessEnv?][] = []
  let i = 0
  const spawn: InstallSpawn = async (command, args, env) => {
    calls.push([command, args, env])
    return results[i++] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { spawn, calls }
}

const ok: SpawnResult = { code: 0, stdout: 'done', stderr: '' }
const fail: SpawnResult = { code: 1, stdout: '', stderr: 'boom' }
// micromamba's signal that the package isn't conda-managed (installed via CRAN), which drives the
// R uninstall fallback to remove.packages().
const notManaged: SpawnResult = {
  code: 1,
  stdout: '',
  stderr: 'Failure: packages to remove not found in the environment:\n  - r-someCranOnlyPkg'
}
const base = {
  micromamba: '/mm/bin/micromamba',
  storageRoot: '/root',
  condaChannel: 'https://mirror.test/conda-forge'
}

describe('installPackages', () => {
  it('forwards the installer child PID through onChild (for crash-recovery journaling)', async () => {
    // A spawn that reports a pid via its 4th (onChild) argument, as the real defaultSpawn does.
    const spawn: InstallSpawn = async (_command, _args, _env, onChild) => {
      onChild?.(4321)
      return ok
    }
    const seenPids: number[] = []
    await installPackages(
      { language: 'python', packages: ['numpy'] },
      { spawn, ...base, onChild: (pid) => seenPids.push(pid) }
    )
    expect(seenPids).toContain(4321)
  })

  it('routes python conda installs to micromamba with the resolved channel and default-python prefix', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'python', packages: ['numpy', 'pandas'] },
      { spawn, ...base }
    )

    const [command, args] = calls[0]
    const prefix = envPrefix(runtimeRoot('/root'), DEFAULT_PY_ENV)
    expect(command).toBe('/mm/bin/micromamba')
    // installArgv (A2) emits --prefix/-c, not a short -p flag; assert on its actual argv shape.
    expect(args).toEqual(
      expect.arrayContaining([
        'install',
        '--prefix',
        prefix,
        '-c',
        base.condaChannel,
        'numpy',
        'pandas'
      ])
    )
    expect(result).toEqual({
      ok: true,
      needsRestart: false,
      log: expect.stringContaining('done'),
      method: 'conda',
      prefix
    })
  })

  it('routes python usePip installs to the env pip with the resolved index url', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['seaborn'], usePip: true },
      { spawn, ...base, pypiIndex: 'https://mirror.test/simple' }
    )
    const prefix = envPrefix(runtimeRoot('/root'), DEFAULT_PY_ENV)
    expect(calls[0][0]).toBe(pipBin(prefix))
    expect(calls[0][1]).toEqual(['install', '-i', 'https://mirror.test/simple', 'seaborn'])
  })

  it('installs into an EXTERNAL interpreter via its own pip, never the app-managed prefix', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'python', packages: ['rich'] },
      {
        spawn,
        ...base,
        pypiIndex: 'https://mirror.test/simple',
        interpreter: { command: '/ov/bin/python', args: [] }
      }
    )
    // Runs `<overlay-python> -m pip install -i <index> rich` — the bundled micromamba is untouched.
    expect(calls[0][0]).toBe('/ov/bin/python')
    expect(calls[0][1]).toEqual([
      '-m',
      'pip',
      'install',
      '-i',
      'https://mirror.test/simple',
      'rich'
    ])
    expect(result).toMatchObject({ ok: true, method: 'pip' })
  })

  it('carries launcher args before -m pip for an external interpreter that needs them', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['rich'] },
      { spawn, ...base, interpreter: { command: 'py', args: ['-3'] } }
    )
    expect(calls[0]).toEqual(['py', ['-3', '-m', 'pip', 'install', 'rich'], expect.anything()])
  })

  it('prefixes r packages with r- and installs into default-r via micromamba, needsRestart true', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'r', packages: ['ggplot2', 'r-dplyr'] },
      { spawn, ...base }
    )
    const prefix = envPrefix(runtimeRoot('/root'), DEFAULT_R_ENV)
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    expect(args).toEqual(
      expect.arrayContaining(['install', '--prefix', prefix, 'r-ggplot2', 'r-dplyr'])
    )
    // R is fragile about loading packages into a live session, so a successful R install asks for a restart.
    expect(result.needsRestart).toBe(true)
    expect(result.ok).toBe(true)
    // conda installs append bioconda after the primary channel (so bioconductor-*/bio tools resolve).
    expect(calls[0][1].join(' ')).toContain('bioconda')
  })

  it('installs a Bioconductor R package by its bioconductor- name without r- mangling', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'r', packages: ['bioconductor-deseq2'] },
      { spawn, ...base }
    )
    const args = calls[0][1]
    // Already namespaced → left as-is (NOT turned into r-bioconductor-deseq2), and bioconda is present.
    expect(args).toContain('bioconductor-deseq2')
    expect(args).not.toContain('r-bioconductor-deseq2')
    expect(args.join(' ')).toContain('bioconda')
    expect(result.ok).toBe(true)
  })

  it('points bioconda at the same mirror host when the conda channel is a mirror URL', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['numpy'] },
      {
        spawn,
        ...base,
        condaChannel: 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/'
      }
    )
    // bioconda is derived from the same mirror (…/conda-forge/ -> …/bioconda/), not public bioconda.
    expect(calls[0][1].join(' ')).toContain(
      '-c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/ ' +
        '-c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/bioconda/'
    )
  })

  it('falls back to R install.packages against the CRAN mirror when conda r- install fails', async () => {
    const { spawn, calls } = scriptedSpawn([fail, ok])
    const result = await installPackages(
      { language: 'r', packages: ['someCranOnlyPkg'] },
      { spawn, ...base, cranMirror: 'https://cran.mirror.test' }
    )
    const prefix = envPrefix(runtimeRoot('/root'), DEFAULT_R_ENV)
    const rLib = rLibraryDir(prefix)
    expect(calls[1][0]).toBe(rScriptBin(prefix))
    expect(calls[1][1][0]).toBe('-e')
    // The env R library is created and install is pinned to it via an explicit lib=, so a fronted
    // user library can never receive the package.
    // The code JSON-stringifies the lib path into the R script (so a Windows backslash path is escaped
    // correctly); mirror that here so the assertion holds on both POSIX and Windows.
    expect(calls[1][1][1]).toContain(
      `dir.create(${JSON.stringify(rLib)}, recursive=TRUE, showWarnings=FALSE)`
    )
    expect(calls[1][1][1]).toContain(
      `install.packages(c("someCranOnlyPkg"), lib=${JSON.stringify(rLib)}, repos="https://cran.mirror.test")`
    )
    expect(result).toEqual({
      ok: true,
      needsRestart: true,
      log: expect.stringContaining('boom'),
      method: 'cran',
      // The reported location is the env-scoped R library, not the bare env prefix.
      prefix: rLib
    })
  })

  it('surfaces an error when both conda and CRAN fallback fail', async () => {
    const { spawn } = scriptedSpawn([fail, fail])
    const result = await installPackages({ language: 'r', packages: ['x'] }, { spawn, ...base })
    expect(result.ok).toBe(false)
    expect(result.needsRestart).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('exports the CA bundle to the install subprocess env when configured', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['numpy'] },
      { spawn, ...base, caBundle: '/etc/corp-ca.pem' }
    )
    const env = calls[0][2] ?? {}
    // One PEM path fans out to every download tool's own CA variable.
    expect(env.CONDA_SSL_VERIFY).toBe('/etc/corp-ca.pem')
    expect(env.SSL_CERT_FILE).toBe('/etc/corp-ca.pem')
    expect(env.REQUESTS_CA_BUNDLE).toBe('/etc/corp-ca.pem')
    expect(env.PIP_CERT).toBe('/etc/corp-ca.pem')
    expect(env.CURL_CA_BUNDLE).toBe('/etc/corp-ca.pem')
  })

  it('does not set CA vars when no bundle is configured', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages({ language: 'python', packages: ['numpy'] }, { spawn, ...base })
    const env = calls[0][2] ?? {}
    expect(env.CONDA_SSL_VERIFY).toBeUndefined()
    expect(env.CURL_CA_BUNDLE).toBeUndefined()
  })

  it('rejects an empty package list without spawning', async () => {
    const spawn = vi.fn()
    const result = await installPackages(
      { language: 'python', packages: [] },
      { spawn: spawn as unknown as InstallSpawn }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      needsRestart: false,
      log: '',
      error: 'No packages requested.'
    })
  })

  it('errors when micromamba cannot be resolved for a conda install', async () => {
    const { spawn } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'python', packages: ['numpy'] },
      { spawn, micromamba: undefined, storageRoot: '/root' }
    )
    expect(result).toEqual({
      ok: false,
      needsRestart: false,
      log: '',
      error: 'micromamba not found.'
    })
  })

  it('routes a python install with environment set to a named env prefix, when the env bin exists', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: 'my-analysis' },
      { spawn, ...base, pathExists: () => true }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    expect(args).toEqual(expect.arrayContaining(['install', '--prefix', prefix]))
    expect(result.ok).toBe(true)
  })

  it('routes a python usePip install with environment set to the named env pip', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['seaborn'], usePip: true, environment: 'my-analysis' },
      { spawn, ...base, pathExists: () => true }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    expect(calls[0][0]).toBe(pipBin(prefix))
  })

  it('rejects an install into a non-existent named env without spawning', async () => {
    const spawn = vi.fn()
    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: 'ghost-env' },
      { spawn: spawn as unknown as InstallSpawn, ...base, pathExists: () => false }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      needsRestart: false,
      log: '',
      error:
        'Environment "ghost-env" does not exist. Create it first with ' +
        'manage_environments(action:"create", language:"python", name:"ghost-env").'
    })
  })

  it('does not gate default-env installs on pathExists (real disk absence must still spawn)', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'python', packages: ['numpy'] },
      { spawn, ...base }
    )
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
  })
})

describe('installPackages uninstall', () => {
  // Uninstall is only valid on a NAMED (managed-create) env — the default env is additive-only and
  // refuses uninstall (covered by the default-env policy tests below). These exercise the uninstall
  // MECHANICS, so they target a named env and report its bin as present.
  const named = { ...base, pathExists: () => true }

  it('uninstalls python usePip packages via the env pip uninstall -y', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      {
        language: 'python',
        packages: ['seaborn'],
        usePip: true,
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { spawn, ...named }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    expect(calls[0][0]).toBe(pipBin(prefix))
    expect(calls[0][1]).toEqual(['uninstall', '-y', 'seaborn'])
    expect(result).toEqual({
      ok: true,
      needsRestart: false,
      log: expect.stringContaining('done'),
      method: 'pip',
      prefix
    })
  })

  it('uninstalls python conda packages via micromamba remove scoped to the env prefix', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      {
        language: 'python',
        packages: ['numpy', 'pandas'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { spawn, ...named }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    expect(args).toEqual([
      'remove',
      '--root-prefix',
      runtimeRoot('/root'),
      '--prefix',
      prefix,
      '-y',
      'numpy',
      'pandas'
    ])
    expect(result).toEqual({
      ok: true,
      needsRestart: false,
      log: expect.stringContaining('done'),
      method: 'conda',
      prefix
    })
  })

  it('routes a conda-managed R uninstall through micromamba remove with r-/bioconductor- names, needsRestart true', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      {
        language: 'r',
        packages: ['ggplot2', 'bioconductor-deseq2'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { spawn, ...named }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    // Same conda name-mangling as R install: r- prefix for CRAN-style names, already-namespaced
    // bioconductor-* left untouched.
    expect(args).toEqual([
      'remove',
      '--root-prefix',
      runtimeRoot('/root'),
      '--prefix',
      prefix,
      '-y',
      'r-ggplot2',
      'bioconductor-deseq2'
    ])
    expect(result).toEqual({
      ok: true,
      // R uninstall asks for a restart just like R install: a live session holds namespaces/DLLs.
      needsRestart: true,
      log: expect.stringContaining('done'),
      method: 'conda',
      prefix
    })
  })

  it('falls back to Rscript remove.packages when micromamba reports the package is not conda-managed', async () => {
    const { spawn, calls } = scriptedSpawn([notManaged, ok])
    const result = await installPackages(
      {
        language: 'r',
        packages: ['someCranOnlyPkg'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { spawn, ...named }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    const rLib = rLibraryDir(prefix)
    // First a conda remove is attempted, then the CRAN remove.packages fallback.
    expect(calls[0][0]).toBe('/mm/bin/micromamba')
    expect(calls[1][0]).toBe(rScriptBin(prefix))
    expect(calls[1][1][0]).toBe('-e')
    // Removal is pinned to the env's own R library via an explicit lib=, never .libPaths()[1].
    expect(calls[1][1][1]).toContain(
      `remove.packages(c("someCranOnlyPkg"), lib=${JSON.stringify(rLib)})`
    )
    expect(result).toEqual({
      ok: true,
      needsRestart: true,
      // Log carries both the conda not-found signal and the successful CRAN removal.
      log: expect.stringContaining('not found'),
      method: 'cran',
      // The reported location is the env-scoped R library, deterministic from the prefix.
      prefix: rLib
    })
  })

  it('surfaces an error when an R conda remove fails for a reason other than not-managed', async () => {
    // A conda failure that is NOT "package not found" must not silently trigger a CRAN attempt.
    const { spawn, calls } = scriptedSpawn([fail])
    const result = await installPackages(
      { language: 'r', packages: ['ggplot2'], operation: 'uninstall', environment: 'my-analysis' },
      { spawn, ...named }
    )
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.needsRestart).toBe(false)
    expect(result.method).toBe('conda')
    expect(result.error).toBe('conda remove failed.')
  })

  it('surfaces an error when a conda remove fails', async () => {
    const { spawn } = scriptedSpawn([fail])
    const result = await installPackages(
      {
        language: 'python',
        packages: ['numpy'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { spawn, ...named }
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('conda remove failed.')
  })

  it('rejects an uninstall from a non-existent named env without spawning', async () => {
    const spawn = vi.fn()
    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: 'ghost-env', operation: 'uninstall' },
      { spawn: spawn as unknown as InstallSpawn, ...base, pathExists: () => false }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: false,
      needsRestart: false,
      log: '',
      error:
        'Environment "ghost-env" does not exist. Create it first with ' +
        'manage_environments(action:"create", language:"python", name:"ghost-env").'
    })
  })

  it('refuses uninstall from the default env (additive-only) without spawning', async () => {
    const spawn = vi.fn()
    const result = await installPackages(
      { language: 'python', packages: ['numpy'], operation: 'uninstall' },
      { spawn: spawn as unknown as InstallSpawn, ...base }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('additive-only')
  })

  it('refuses default-env R uninstall too', async () => {
    const spawn = vi.fn()
    const result = await installPackages(
      { language: 'r', packages: ['ggplot2'], operation: 'uninstall' },
      { spawn: spawn as unknown as InstallSpawn, ...base }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('additive-only')
  })
})

describe('installPackages flag-injection guard (all envs)', () => {
  it.each([
    ['--index-url injection', '--index-url'],
    ['a --target overlay escape', '--target'],
    ['an -e editable flag', '-e']
  ])(
    'refuses %s as a package token even for a NAMED env, without spawning',
    async (_label, token) => {
      const spawn = vi.fn()
      const result = await installPackages(
        { language: 'python', packages: [token], usePip: true, environment: 'my-analysis' },
        { spawn: spawn as unknown as InstallSpawn, ...base, pathExists: () => true }
      )
      expect(spawn).not.toHaveBeenCalled()
      expect(result.ok).toBe(false)
      expect(result.error).toContain('not a valid package specifier')
    }
  )

  it('still allows a git+https spec on a named env (does not start with -)', async () => {
    const { spawn } = scriptedSpawn([ok])
    const result = await installPackages(
      {
        language: 'python',
        packages: ['git+https://github.com/u/r.git'],
        usePip: true,
        environment: 'my-analysis'
      },
      { spawn, ...base, pathExists: () => true }
    )
    expect(result.ok).toBe(true)
  })
})

describe('installPackages default-env additive-only policy', () => {
  // Each of these targets the DEFAULT env (no `environment`), which is additive-only.
  // NOTE: flag tokens (e.g. --force-reinstall) start with `-` and are caught earlier by the universal
  // flag-injection guard (different message), so they live in that describe block, not here.
  it.each([
    ['a version range', 'numpy>=1.26'],
    ['a wildcard version', 'numpy==1.*'],
    ['a git/VCS spec', 'git+https://github.com/user/repo.git'],
    ['extras', 'pandas[performance]']
  ])('refuses %s on the default env without spawning', async (_label, spec) => {
    const spawn = vi.fn()
    const result = await installPackages(
      { language: 'python', packages: [spec], usePip: true },
      { spawn: spawn as unknown as InstallSpawn, ...base }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('additive-only')
  })

  it('allows a bare name and passes --freeze-installed to the default conda install', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'python', packages: ['scipy'] },
      { spawn, ...base }
    )
    expect(result.ok).toBe(true)
    expect(calls[0][0]).toBe('/mm/bin/micromamba')
    expect(calls[0][1]).toContain('--freeze-installed')
    expect(calls[0][1]).toContain('scipy')
  })

  it('allows an exact name==version pin on the default env', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      { language: 'python', packages: ['numpy==1.26.0'] },
      { spawn, ...base }
    )
    expect(result.ok).toBe(true)
    expect(calls[0][1]).toContain('numpy==1.26.0')
  })
})
