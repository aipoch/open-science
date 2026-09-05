import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Force the fallback micromamba resolver to "not found" so the "cannot be resolved" case is
// deterministic regardless of whether the host machine happens to have micromamba on PATH (a dev box
// that ran `brew install micromamba` would otherwise resolve a real binary and fail that test). Tests
// that need a resolvable micromamba pass an explicit `micromamba` dep, so they bypass this entirely.
vi.mock('./micromamba', async (importActual) => ({
  ...(await importActual<typeof import('./micromamba')>()),
  resolveMicromamba: () => undefined
}))

import {
  CONDA_JSON_CAPTURE_LIMIT_BYTES,
  defaultSpawn,
  INSTALLER_STREAM_LOG_LIMIT_BYTES,
  installPackages,
  type InstallSpawn,
  type SpawnResult
} from './package-manager'
import { micromambaCacheLockKey } from './micromamba-cache'
import { withExclusiveCacheLock } from './pkgs-cache-lock'
import { CHILD_UNCONFIRMED } from './provisioner-runtime'
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
    // Cache maintenance is orthogonal to the transaction result scripts below. The dedicated cache-
    // growth test observes it directly; existing command-contract tests keep recording only the
    // install/remove/pip/R subprocesses they own.
    if (isCacheClean(args)) return ok
    calls.push([command, args, env])
    return results[i++] ?? { code: 0, stdout: '', stderr: '' }
  }
  return { spawn, calls }
}

const ok: SpawnResult = { code: 0, stdout: 'done', stderr: '' }
const isCacheClean = (args: string[]): boolean => args[0] === '--no-rc' && args[1] === 'clean'
const safeRPlan: SpawnResult = {
  code: 0,
  stdout: JSON.stringify({
    success: true,
    actions: { LINK: [{ name: 'r-requested-package', version: '1.0.0' }], UNLINK: [] }
  }),
  stderr: ''
}
const safeRRemovePlan: SpawnResult = {
  code: 0,
  stdout: JSON.stringify({
    success: true,
    actions: { LINK: [], UNLINK: [{ name: 'r-requested-package', version: '1.0.0' }] }
  }),
  stderr: ''
}
const fail: SpawnResult = { code: 1, stdout: '', stderr: 'boom' }
const packageUnavailable: SpawnResult = {
  code: 1,
  stdout: JSON.stringify({
    success: false,
    solver_problems: ['r-someCranOnlyPkg does not exist (perhaps a typo or a missing channel).'],
    actions: { LINK: [], UNLINK: [], FETCH: [] }
  }),
  stderr: 'Diagnostic: package not found.'
}
// micromamba's signal that the package isn't conda-managed (installed via CRAN), which drives the
// R uninstall fallback to remove.packages().
const notManaged: SpawnResult = {
  code: 1,
  stdout: JSON.stringify({
    success: false,
    error: 'packages to remove not found in the environment: r-someCranOnlyPkg',
    actions: {}
  }),
  stderr: 'Diagnostic: package not installed.'
}
const base = {
  micromamba: '/mm/bin/micromamba',
  storageRoot: '/root',
  // Keep baseline tests hermetic on Windows; Windows cache behavior is covered by explicit overrides.
  micromambaEnv: { platform: 'linux' as const },
  condaChannel: 'https://mirror.test/conda-forge',
  readCondaPackageIdentity: () => ({
    name: 'r-base',
    version: '4.4.3',
    build: 'h123_0',
    buildNumber: 0,
    channel: 'conda-forge'
  })
}

describe('defaultSpawn (fail-closed spawn hooks)', () => {
  it('calls onBeforeSpawn before spawning, and fails closed (no spawn) when it throws', async () => {
    const order: string[] = []
    await defaultSpawn(
      process.execPath,
      ['-e', 'process.exit(0)'],
      undefined,
      () => order.push('child'),
      () => order.push('before')
    )
    expect(order[0]).toBe('before')

    let childSpawned = false
    const result = await defaultSpawn(
      process.execPath,
      ['-e', 'process.exit(0)'],
      undefined,
      () => {
        childSpawned = true
      },
      () => {
        throw new Error('intent write failed')
      }
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/spawn intent/)
    expect(childSpawned).toBe(false) // never spawned
  })

  it('kills the child and reports failure when onChild (PID recording) throws', async () => {
    let killedPid: number | undefined
    const result = await defaultSpawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      undefined,
      (pid) => {
        killedPid = pid
        throw new Error('sidecar write failed')
      }
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/Failed to record the installer worker/)
    expect(killedPid).toBeGreaterThan(0)
    await vi.waitFor(() => expect(() => process.kill(killedPid as number, 0)).toThrow())
  })

  it('retains bounded stdout/stderr tails and reports the exact discarded byte counts', async () => {
    const stdoutPrefix = 'stdout-old\n'
    const stdoutTail = '\nstdout-tail'
    const stderrPrefix = 'stderr-old\n'
    const stderrTail = '\nstderr-tail'
    const result = await defaultSpawn(process.execPath, [
      '-e',
      [
        `process.stdout.write(${JSON.stringify(stdoutPrefix)} + 'x'.repeat(${INSTALLER_STREAM_LOG_LIMIT_BYTES}) + ${JSON.stringify(stdoutTail)});`,
        `process.stderr.write(${JSON.stringify(stderrPrefix)} + 'y'.repeat(${INSTALLER_STREAM_LOG_LIMIT_BYTES}) + ${JSON.stringify(stderrTail)});`
      ].join('')
    ])

    expect(result.code).toBe(0)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(INSTALLER_STREAM_LOG_LIMIT_BYTES)
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBe(INSTALLER_STREAM_LOG_LIMIT_BYTES)
    expect(result.stdout).not.toContain(stdoutPrefix)
    expect(result.stderr).not.toContain(stderrPrefix)
    expect(result.stdout.endsWith(stdoutTail)).toBe(true)
    expect(result.stderr.endsWith(stderrTail)).toBe(true)
    expect(result.stdoutDroppedBytes).toBe(Buffer.byteLength(stdoutPrefix + stdoutTail, 'utf8'))
    expect(result.stderrDroppedBytes).toBe(Buffer.byteLength(stderrPrefix + stderrTail, 'utf8'))
  })

  it('reduces oversized micromamba JSON without retaining the complete document in memory', async () => {
    const result = await defaultSpawn(process.execPath, [
      '-e',
      [
        `const value = {`,
        `error: ['Invalid package cache; file is missing; Package cache error', String.fromCharCode(39) + 'C:/cache/' + 'p'.repeat(280) + String.fromCharCode(39), 'for ' + String.fromCharCode(39) + 'broken-package-1.0-0.conda' + String.fromCharCode(39)],`,
        `padding: 'x'.repeat(${INSTALLER_STREAM_LOG_LIMIT_BYTES}),`,
        `solver_problems: ['unsatisfiable dependency constraints'],`,
        `actions: { LINK: [{ name: 'r-base', version: '4.5.0' }], UNLINK: [], FETCH: [{ fn: 'r-base-4.5.0.conda', sha256: 'a'.repeat(64) }] }`,
        `};`,
        `process.stdout.write(JSON.stringify(value));`
      ].join(''),
      '--',
      '--json'
    ])

    expect(result.code).toBe(0)
    expect(result.stdoutDroppedBytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(INSTALLER_STREAM_LOG_LIMIT_BYTES)
    expect(result.structuredCondaResult).toEqual({
      transaction: true,
      actions: {
        LINK: [{ name: 'r-base', version: '4.5.0' }],
        UNLINK: []
      },
      archives: [{ file: 'r-base-4.5.0.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }],
      archiveEvidenceComplete: true,
      diagnostics: ['solver failed']
    })
    expect(result.maxPathRecoveryEvidence).toMatch(/Invalid package cache/)
    expect(result.maxPathRecoveryEvidence).toContain('broken-package-1.0-0.conda')
  })

  it('marks summarized archive evidence incomplete instead of silently capping it', async () => {
    const result = await defaultSpawn(process.execPath, [
      '-e',
      [
        `const fetch = Array.from({ length: 1025 }, (_, index) => ({ fn: 'pkg-' + index + '.conda', sha256: index.toString(16).padStart(64, '0') }));`,
        `const value = { padding: 'x'.repeat(${INSTALLER_STREAM_LOG_LIMIT_BYTES}), actions: { FETCH: fetch } };`,
        `process.stdout.write(JSON.stringify(value));`
      ].join(''),
      '--',
      '--json'
    ])

    expect(result.code).toBe(0)
    expect(result.stdoutDroppedBytes).toBeGreaterThan(0)
    expect(result.structuredCondaResult?.archives).toHaveLength(1024)
    expect(result.structuredCondaResult?.archiveEvidenceComplete).toBe(false)
  })

  it('retains archive authority from summarized URLs with query parameters', async () => {
    const result = await defaultSpawn(process.execPath, [
      '-e',
      [
        `const value = { padding: 'x'.repeat(${INSTALLER_STREAM_LOG_LIMIT_BYTES}), actions: { FETCH: [{ url: 'https://packages.example.test/pkg-1.0-0.conda?token=temporary', sha256: 'b'.repeat(64) }] } };`,
        `process.stdout.write(JSON.stringify(value));`
      ].join(''),
      '--',
      '--json'
    ])

    expect(result.stdoutDroppedBytes).toBeGreaterThan(0)
    expect(result.structuredCondaResult?.archives).toEqual([
      { file: 'pkg-1.0-0.conda', algorithm: 'sha256', digest: 'b'.repeat(64) }
    ])
    expect(result.structuredCondaResult?.archiveEvidenceComplete).toBe(true)
  })

  it('fails closed when micromamba JSON exceeds the bounded temporary capture', async () => {
    const result = await defaultSpawn(process.execPath, [
      '-e',
      [
        `const value = { padding: 'x'.repeat(${CONDA_JSON_CAPTURE_LIMIT_BYTES}), actions: { LINK: [{ name: 'r-base', version: '4.5.0' }], UNLINK: [] } };`,
        `process.stdout.write(JSON.stringify(value));`
      ].join(''),
      '--',
      '--json'
    ])

    expect(result.code).toBe(0)
    expect(result.stdoutDroppedBytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(INSTALLER_STREAM_LOG_LIMIT_BYTES)
    expect(result.structuredCondaResult).toBeUndefined()
    expect(result.maxPathRecoveryEvidence).toBeUndefined()
  })
})

describe('installPackages', () => {
  it('aggregates discarded stream bytes into structured install-log truncation metadata', async () => {
    const truncated: SpawnResult = {
      code: 0,
      stdout: 'latest output',
      stderr: 'latest warning',
      stdoutDroppedBytes: 23,
      stderrDroppedBytes: 19
    }
    const { spawn } = scriptedSpawn([truncated])
    const result = await installPackages(
      { language: 'python', packages: ['numpy'], usePip: true },
      { spawn, ...base }
    )

    expect(result.log).toContain('latest output')
    expect(result.logTruncation).toEqual({ droppedBytes: 42 })
  })

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
    expect(result).toMatchObject({
      ok: true,
      needsRestart: false,
      log: expect.stringContaining('done'),
      method: 'conda',
      prefix
    })
    expect(result.attempts).toEqual([
      expect.objectContaining({ installer: 'conda', status: 'succeeded', groupOrdinal: 0 })
    ])
  })

  it('uses the shared prepared runner for a managed conda install', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const runner = {
      initialPath: '/resources/micromamba.exe',
      resolve: vi.fn().mockResolvedValue('/local-tools/micromamba-compat.exe')
    }

    const result = await installPackages(
      { language: 'python', packages: ['numpy'] },
      { spawn, ...base, micromamba: undefined, micromambaRunner: runner }
    )

    expect(result.ok).toBe(true)
    expect(runner.resolve).toHaveBeenCalledOnce()
    expect(calls[0][0]).toBe('/local-tools/micromamba-compat.exe')
  })

  it('reports archive digests from the successful micromamba transaction', async () => {
    const digest = 'a'.repeat(64)
    const transaction: SpawnResult = {
      code: 0,
      stdout: JSON.stringify({
        success: true,
        actions: { FETCH: [{ fn: 'numpy-1.conda', sha256: digest }] }
      }),
      stderr: ''
    }
    const { spawn } = scriptedSpawn([transaction])
    const onCondaArchiveAuthorizations = vi.fn()

    await installPackages(
      { language: 'python', packages: ['numpy'] },
      { spawn, ...base, onCondaArchiveAuthorizations }
    )

    expect(onCondaArchiveAuthorizations).toHaveBeenCalledWith(
      [{ file: 'numpy-1.conda', algorithm: 'sha256', digest }],
      expect.stringMatching(/[\\/]pkgs$/u),
      true
    )
  })

  it('does not report an empty archive publication for a transaction without fetch records', async () => {
    const transaction: SpawnResult = {
      code: 0,
      stdout: JSON.stringify({ success: true, actions: { LINK: [] } }),
      stderr: ''
    }
    const { spawn } = scriptedSpawn([transaction])
    const onCondaArchiveAuthorizations = vi.fn()

    await installPackages(
      { language: 'python', packages: ['already-installed'] },
      { spawn, ...base, onCondaArchiveAuthorizations }
    )

    expect(onCondaArchiveAuthorizations).not.toHaveBeenCalled()
  })

  it('reports incomplete archive evidence when successful JSON output was truncated', async () => {
    const transaction: SpawnResult = {
      code: 0,
      stdout: 'truncated-json-tail',
      stderr: '',
      stdoutDroppedBytes: 1
    }
    const { spawn } = scriptedSpawn([transaction])
    const onCondaArchiveAuthorizations = vi.fn()

    await installPackages(
      { language: 'python', packages: ['numpy'] },
      { spawn, ...base, onCondaArchiveAuthorizations }
    )

    expect(onCondaArchiveAuthorizations).toHaveBeenCalledWith(
      [],
      expect.stringMatching(/[\\/]pkgs$/u),
      false
    )
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
    const { spawn, calls } = scriptedSpawn([safeRPlan])
    const result = await installPackages(
      { language: 'r', packages: ['ggplot2', 'r-dplyr'] },
      { spawn, ...base }
    )
    const prefix = envPrefix(runtimeRoot('/root'), DEFAULT_R_ENV)
    expect(calls).toHaveLength(2)
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    expect(args).toEqual(
      expect.arrayContaining([
        'install',
        '--dry-run',
        '--prefix',
        prefix,
        'r-base=4.4.3=h123_0',
        'r-ggplot2',
        'r-dplyr'
      ])
    )
    expect(calls[1][1]).toEqual(
      expect.arrayContaining([
        'install',
        '--prefix',
        prefix,
        'r-base=4.4.3=h123_0',
        'r-ggplot2',
        'r-dplyr'
      ])
    )
    expect(calls[1][1]).not.toContain('--dry-run')
    // R is fragile about loading packages into a live session, so a successful R install asks for a restart.
    expect(result.needsRestart).toBe(true)
    expect(result.ok).toBe(true)
    // conda installs append bioconda after the primary channel (so bioconductor-*/bio tools resolve).
    expect(calls[0][1].join(' ')).toContain('bioconda')
  })

  it('never executes an R conda transaction whose dry-run would change r-base', async () => {
    const protectedPlan: SpawnResult = {
      code: 0,
      stdout: JSON.stringify({
        success: true,
        actions: {
          UNLINK: [{ name: 'r-base', version: '4.4.3' }],
          LINK: [
            { name: 'r-base', version: '4.5.3' },
            { name: 'r-dplyr', version: '1.2.1' }
          ]
        }
      }),
      stderr: ''
    }
    const { spawn, calls } = scriptedSpawn([protectedPlan])

    const result = await installPackages(
      { language: 'r', packages: ['dplyr'] },
      {
        spawn,
        ...base,
        readCondaPackageIdentity: () => ({
          name: 'r-base',
          version: '4.4.3',
          build: 'h123_0',
          buildNumber: 0,
          channel: 'conda-forge'
        })
      }
    )

    const prefix = envPrefix(runtimeRoot('/root'), DEFAULT_R_ENV)
    expect(calls[0][1]).toEqual(
      expect.arrayContaining([
        'install',
        '--dry-run',
        '--prefix',
        prefix,
        'r-base=4.4.3=h123_0',
        'r-dplyr'
      ])
    )
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({
      ok: false,
      method: 'conda',
      fallbackUsed: false,
      needsRestart: false
    })
    expect(result.log).toMatch(/r-base.*4\.4\.3.*4\.5\.3/i)
  })

  it('fails closed before solving when the installed r-base build identity is incomplete', async () => {
    const spawn = vi.fn()

    const result = await installPackages(
      { language: 'r', packages: ['dplyr'] },
      {
        ...base,
        spawn: spawn as unknown as InstallSpawn,
        readCondaPackageIdentity: () => ({ name: 'r-base', version: '4.4.3' })
      }
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, needsRestart: false })
    expect(result.error).toMatch(/version and build.*repair/i)
  })

  it('quarantines an R runtime when the transaction changes only the r-base build identity', async () => {
    const identities = [
      { name: 'r-base', version: '4.4.3', build: 'h123_0', buildNumber: 0 },
      { name: 'r-base', version: '4.4.3', build: 'h999_1', buildNumber: 1 }
    ]
    const { spawn, calls } = scriptedSpawn([safeRPlan, ok])

    const result = await installPackages(
      { language: 'r', packages: ['dplyr'] },
      {
        spawn,
        ...base,
        readCondaPackageIdentity: () => identities.shift()
      }
    )

    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: false, repairRequired: true, needsRestart: false })
    expect(result.error).toMatch(/h123_0.*h999_1.*Repair/i)
  })

  it('quarantines r-base changes even when the conda transaction exits non-zero', async () => {
    const identities = [
      { name: 'r-base', version: '4.4.3', build: 'h123_0', buildNumber: 0 },
      { name: 'r-base', version: '4.4.3', build: 'h999_1', buildNumber: 1 }
    ]
    const failedAfterMutation: SpawnResult = {
      code: 1,
      stdout: JSON.stringify({ success: false, actions: { UNLINK: [{ name: 'r-base' }] } }),
      stderr: 'transaction failed after unlink'
    }
    const { spawn, calls } = scriptedSpawn([safeRPlan, failedAfterMutation])

    const result = await installPackages(
      { language: 'r', packages: ['dplyr'] },
      {
        spawn,
        ...base,
        readCondaPackageIdentity: () => identities.shift()
      }
    )

    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: false, repairRequired: true, needsRestart: false })
    expect(result.error).toMatch(/h123_0.*h999_1.*Repair/i)
  })

  it('checks r-base after the first real MAX_PATH attempt before allowing a retry', async () => {
    const identities = [
      { name: 'r-base', version: '4.4.3', build: 'h123_0', buildNumber: 0 },
      { name: 'r-base', version: '4.5.3', build: 'h999_1', buildNumber: 1 }
    ]
    const failedWithMaxPath: SpawnResult = {
      code: 1,
      stdout: '',
      stderr:
        "Invalid package cache, file 'C:\\runtime\\pkgs\\broken\\missing' is missing; Package cache error"
    }
    const { spawn, calls } = scriptedSpawn([safeRPlan, failedWithMaxPath, ok])

    const result = await installPackages(
      { language: 'r', packages: ['dplyr'] },
      {
        spawn,
        ...base,
        readCondaPackageIdentity: () => identities.shift(),
        micromambaEnv: {
          platform: 'win32',
          env: { PATH: 'C:\\Windows' },
          selectCache: () => ({ path: 'C:\\runtime\\pkgs', lockKey: 'c:\\runtime\\pkgs' })
        }
      }
    )

    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({ ok: false, repairRequired: true, needsRestart: false })
    expect(result.error).toMatch(/4\.4\.3.*4\.5\.3.*Repair/i)
  })

  it('journals the approved R transaction but not the read-only dry-run', async () => {
    const order: string[] = []
    let call = 0
    const spawn: InstallSpawn = async (_command, args, _env, onChild, onBeforeSpawn) => {
      if (isCacheClean(args)) return ok
      onBeforeSpawn?.()
      order.push(`spawn#${call}`)
      onChild?.(4100 + call)
      if (onChild) order.push(`child#${call}`)
      return call++ === 0 ? safeRPlan : ok
    }

    const result = await installPackages(
      { language: 'r', packages: ['dplyr'] },
      {
        ...base,
        spawn,
        onBeforeSpawn: () => order.push('intent'),
        onChild: () => undefined
      }
    )

    expect(result.ok).toBe(true)
    expect(order).toEqual(['spawn#0', 'intent', 'spawn#1', 'child#1'])
  })

  it('installs a Bioconductor R package by its bioconductor- name without r- mangling', async () => {
    const { spawn, calls } = scriptedSpawn([safeRPlan])
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

  it('installs R packages through BiocManager and records the release', async () => {
    const { spawn, calls } = scriptedSpawn([
      { code: 0, stdout: 'OPEN_SCIENCE_BIOC_VERSION\t3.21\ndone', stderr: '' }
    ])
    const result = await installPackages(
      { language: 'r', packages: ['DESeq2'], installer: 'biocmanager' },
      { spawn, ...base, cranMirror: 'https://cran.mirror.test' }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(rScriptBin(envPrefix(runtimeRoot('/root'), DEFAULT_R_ENV)))
    expect(calls[0][1].join(' ')).toContain('BiocManager::install')
    expect(calls[0][1].join(' ')).toContain('update=FALSE')
    expect(result).toMatchObject({
      ok: true,
      method: 'biocmanager',
      needsRestart: true,
      source: { type: 'bioconductor', version: '3.21' }
    })
  })

  it('installs an R package from GitHub with the requested ref', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    const result = await installPackages(
      {
        language: 'r',
        packages: ['tidyverse/ggplot2@main'],
        installer: 'github',
        environment: 'analysis-r'
      },
      { spawn, ...base, pathExists: () => true, cranMirror: 'https://cran.mirror.test' }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0][1].join(' ')).toContain('remotes::install_github')
    expect(calls[0][1].join(' ')).toContain('dependencies=TRUE')
    expect(calls[0][1].join(' ')).toContain('upgrade="never"')
    expect(result).toMatchObject({
      ok: true,
      method: 'github',
      source: { type: 'github', repository: 'tidyverse/ggplot2', ref: 'main' }
    })
  })

  it.each([
    ['biocmanager' as const, 'DESeq2', undefined],
    ['github' as const, 'tidyverse/ggplot2@main', 'analysis-r']
  ])(
    'does not report %s source metadata after a failed install',
    async (installer, pkg, environment) => {
      const { spawn } = scriptedSpawn([
        { code: 1, stdout: 'OPEN_SCIENCE_BIOC_VERSION\t3.21\n', stderr: 'install failed' }
      ])
      const result = await installPackages(
        { language: 'r', packages: [pkg], installer, ...(environment ? { environment } : {}) },
        { spawn, ...base, pathExists: () => true }
      )

      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('source')
    }
  )

  it('rejects malformed GitHub R package specs before spawning', async () => {
    const { spawn, calls } = scriptedSpawn([])
    const result = await installPackages(
      {
        language: 'r',
        packages: ['https://github.com/tidyverse/ggplot2'],
        installer: 'github',
        environment: 'analysis-r'
      },
      { spawn, ...base, pathExists: () => true }
    )

    expect(result).toMatchObject({ ok: false, method: 'github' })
    expect(result.error).toContain('owner/repository')
    expect(calls).toHaveLength(0)
  })

  it('does not run an R source installer when the protected r-base identity is unavailable', async () => {
    const { spawn, calls } = scriptedSpawn([])
    const result = await installPackages(
      { language: 'r', packages: ['DESeq2'], installer: 'biocmanager' },
      { spawn, ...base, readCondaPackageIdentity: () => undefined }
    )

    expect(result).toMatchObject({ ok: false, method: 'biocmanager', attempts: [] })
    expect(result.error).toContain('Cannot verify the installed r-base version and build')
    expect(calls).toHaveLength(0)
  })

  it('points bioconda at the same mirror host when the conda channel is a mirror URL', async () => {
    const { spawn, calls } = scriptedSpawn([safeRRemovePlan, ok])
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
    const { spawn, calls } = scriptedSpawn([packageUnavailable, ok])
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
    expect(result).toMatchObject({
      ok: true,
      needsRestart: true,
      log: expect.stringContaining('does not exist'),
      method: 'cran',
      // The reported location is the env-scoped R library, not the bare env prefix.
      prefix: rLib
    })
    expect(result.fallbackUsed).toBe(true)
    expect(result.attempts).toEqual([
      expect.objectContaining({
        installer: 'conda',
        reason: 'package-not-found',
        mutationRisk: 'none'
      }),
      expect.objectContaining({ installer: 'r-install-packages', status: 'succeeded' })
    ])
  })

  it('retains the approved R dry-run plan when the real transaction falls back to CRAN', async () => {
    const { spawn } = scriptedSpawn([safeRPlan, packageUnavailable, ok])

    const result = await installPackages(
      { language: 'r', packages: ['someCranOnlyPkg'] },
      { spawn, ...base }
    )

    expect(result).toMatchObject({ ok: true, method: 'cran', fallbackUsed: true })
    expect(result.log).toContain('r-requested-package')
    expect(result.log).toContain('does not exist')
    expect(result.log).toContain('done')
  })

  it('never authorizes a fallback from human-readable conda stderr alone', async () => {
    const rawDiagnostic: SpawnResult = {
      code: 1,
      stdout: '',
      stderr: 'PackagesNotFoundError: r-only-on-cran does not exist'
    }
    const { spawn, calls } = scriptedSpawn([rawDiagnostic, ok])

    const result = await installPackages(
      { language: 'r', packages: ['only-on-cran'] },
      { spawn, ...base }
    )

    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, fallbackUsed: false })
    expect(result.attempts).toEqual([
      expect.objectContaining({
        installer: 'conda',
        mutationRisk: 'unknown',
        reason: 'unknown'
      })
    ])
  })

  it('falls back from structured solver failure for Python and records both attempts', async () => {
    const solverFailure: SpawnResult = {
      code: 1,
      stdout: JSON.stringify({
        success: false,
        solver_problems: ['Could not solve: unsatisfiable dependency constraints'],
        actions: {}
      }),
      stderr: 'solver failed'
    }
    const { spawn, calls } = scriptedSpawn([solverFailure, ok])

    const result = await installPackages(
      { language: 'python', packages: ['special-wheel'] },
      { spawn, ...base, pypiIndex: 'https://pypi.example/simple' }
    )

    expect(calls).toHaveLength(2)
    expect(calls[1][0]).toBe(pipBin(envPrefix(runtimeRoot('/root'), DEFAULT_PY_ENV)))
    expect(result).toMatchObject({ ok: true, method: 'pip', fallbackUsed: true })
    expect(result.attempts).toEqual([
      expect.objectContaining({ installer: 'conda', reason: 'solver-failed' }),
      expect.objectContaining({ installer: 'pip', status: 'succeeded' })
    ])
  })

  it('falls back using the reduced summary when bounded logs truncate structured output', async () => {
    const solverFailure: SpawnResult = {
      code: 1,
      stdout: 'truncated-json-tail',
      stderr: 'solver failed',
      stdoutDroppedBytes: INSTALLER_STREAM_LOG_LIMIT_BYTES,
      structuredCondaResult: {
        transaction: false,
        actions: { LINK: [], UNLINK: [] },
        archives: [],
        diagnostics: ['solver failed']
      }
    }
    const { spawn, calls } = scriptedSpawn([solverFailure, ok])

    const result = await installPackages(
      { language: 'python', packages: ['special-wheel'] },
      { spawn, ...base, pypiIndex: 'https://pypi.example/simple' }
    )

    expect(calls).toHaveLength(2)
    expect(result).toMatchObject({
      ok: true,
      method: 'pip',
      fallbackUsed: true,
      logTruncation: { droppedBytes: INSTALLER_STREAM_LOG_LIMIT_BYTES }
    })
    expect(result.attempts?.[0]).toMatchObject({
      installer: 'conda',
      reason: 'solver-failed',
      mutationRisk: 'none'
    })
  })

  it('refuses fallback when structured conda actions show possible mutation', async () => {
    const partialTransaction: SpawnResult = {
      code: 1,
      stdout: JSON.stringify({
        success: false,
        solver_problems: ['package missing'],
        actions: { LINK: [{ name: 'dependency' }] }
      }),
      stderr: 'Transaction starting\nLinking dependency'
    }
    const { spawn, calls } = scriptedSpawn([partialTransaction, ok])

    const result = await installPackages(
      { language: 'python', packages: ['special-wheel'] },
      { spawn, ...base }
    )

    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ ok: false, fallbackUsed: false })
    expect(result.attempts).toEqual([
      expect.objectContaining({ installer: 'conda', mutationRisk: 'possible' })
    ])
  })

  it('fails closed without CRAN fallback when conda failure may have mutated the environment', async () => {
    const { spawn, calls } = scriptedSpawn([fail])
    const result = await installPackages(
      { language: 'r', packages: ['ggplot2'] },
      { spawn, ...base }
    )

    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({
      ok: false,
      needsRestart: false,
      method: 'conda',
      error: 'conda install failed.'
    })
  })

  it('surfaces an error when both conda and CRAN fallback fail', async () => {
    const { spawn } = scriptedSpawn([packageUnavailable, fail])
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

  it('routes pip and R workload caches under the configured data storage runtime', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['numpy'], usePip: true },
      { spawn, ...base }
    )
    const env = calls[0][2] ?? {}
    const cacheRoot = join(runtimeRoot(base.storageRoot), 'cache', 'notebook')

    expect(env).toMatchObject({
      OPEN_SCIENCE_NOTEBOOK_CACHE_DIR: cacheRoot,
      PIP_CACHE_DIR: join(cacheRoot, 'pip'),
      UV_CACHE_DIR: join(cacheRoot, 'uv'),
      R_USER_CACHE_DIR: join(cacheRoot, 'r')
    })
  })

  it('passes the workload cache to conda and its nested pip subprocesses', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages({ language: 'python', packages: ['pandas'] }, { spawn, ...base })
    const cacheRoot = join(runtimeRoot(base.storageRoot), 'cache', 'notebook')

    expect(calls[0][2]?.PIP_CACHE_DIR).toBe(join(cacheRoot, 'pip'))
    expect(calls[0][2]?.OPEN_SCIENCE_NOTEBOOK_CACHE_DIR).toBe(cacheRoot)
  })

  it('does not set CA vars when no bundle is configured', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages({ language: 'python', packages: ['numpy'] }, { spawn, ...base })
    const env = calls[0][2] ?? {}
    expect(env.CONDA_SSL_VERIFY).toBeUndefined()
    expect(env.CURL_CA_BUNDLE).toBeUndefined()
  })

  it('uses the app-owned short cache only for Windows micromamba subprocesses', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['numpy'] },
      {
        spawn,
        ...base,
        micromambaEnv: {
          platform: 'win32',
          env: {
            PATH: 'C:\\Windows',
            CONDA_PKGS_DIRS: 'Z:\\foreign',
            MAMBA_ROOT_PREFIX: 'Z:\\foreign-root'
          },
          selectCache: () => ({
            path: 'C:\\osp1234567890',
            lockKey: 'c:\\osp1234567890'
          })
        }
      }
    )

    const env = calls[0][2] ?? {}
    expect(env.CONDA_PKGS_DIRS).toBe('C:\\osp1234567890')
    expect(env.MAMBA_ROOT_PREFIX).toBeUndefined()
  })

  it('does not inject the package cache into a pip subprocess', async () => {
    const { spawn, calls } = scriptedSpawn([ok])
    await installPackages(
      { language: 'python', packages: ['numpy'], usePip: true },
      {
        spawn,
        ...base,
        micromambaEnv: {
          platform: 'win32',
          env: { PATH: 'C:\\Windows' },
          selectCache: () => ({
            path: 'C:\\osp1234567890',
            lockKey: 'c:\\osp1234567890'
          })
        }
      }
    )

    expect(calls[0][0]).toContain('pip')
    expect(calls[0][2]?.CONDA_PKGS_DIRS).toBeUndefined()
  })

  it('retries a conda install once after safe Windows MAX_PATH cache cleanup and preserves both logs', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'os-pm-maxpath-'))
    const cache = join(storageRoot, 'runtime', 'pkgs')
    const leaf = 'broken-package-1.0-0'
    const packageDir = join(cache, 'https', 'host', 'channel', 'noarch', leaf)
    mkdirSync(packageDir, { recursive: true })
    const missing = join(packageDir, 'Library', 'x'.repeat(280))
    const results: SpawnResult[] = [
      {
        code: 1,
        stdout: 'original install stdout',
        stderr: 'truncated diagnostic tail',
        stderrDroppedBytes: INSTALLER_STREAM_LOG_LIMIT_BYTES,
        maxPathRecoveryEvidence:
          `Invalid package cache; file is missing; Package cache error.\n` +
          `for '${leaf}.conda'\n'${missing}'`
      },
      { code: 1, stdout: 'retry install stdout', stderr: 'retry install failed' }
    ]
    let calls = 0
    const spawn: InstallSpawn = async (_command, args) => {
      if (isCacheClean(args)) return ok
      calls += 1
      return results[calls - 1]
    }

    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: 'my-analysis' },
      {
        spawn,
        ...base,
        readCondaPackageIdentity: () => undefined,
        storageRoot,
        pathExists: () => true,
        micromambaEnv: {
          platform: 'win32',
          env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
          selectCache: () => ({ path: cache, lockKey: cache })
        }
      }
    )

    expect(calls).toBe(2)
    expect(result.log).toContain('Original failure before MAX_PATH recovery')
    expect(result.log).toContain('Retry failure after MAX_PATH recovery')
    expect(result.log).toContain('original install stdout')
    expect(result.log).toContain('retry install stdout')
    expect(result.logTruncation).toEqual({ droppedBytes: INSTALLER_STREAM_LOG_LIMIT_BYTES })
    expect(result.error).toMatch(/short Windows package cache[^]*shorter data location/i)
    expect(result.error).not.toMatch(/LongPathsEnabled|administrator/i)
  })

  it('threads onBeforeSpawn through the conda path on BOTH the first spawn and the MAX_PATH retry', async () => {
    // Regression: the conda runConda path used to call baseSpawn WITHOUT deps.onBeforeSpawn, so the
    // {spawning} intent sidecar was never written before conda install/remove. A crash in the
    // spawn→onChild window then left no sidecar and recovery misread it as "never spawned" — reconciling
    // or retrying under a possibly-live installer. Both the first spawn and the fresh retry after MAX_PATH
    // recovery must re-arm the intent, mirroring defaultSpawn's ordering (before, then child).
    const storageRoot = mkdtempSync(join(tmpdir(), 'os-pm-conda-intent-'))
    const cache = join(storageRoot, 'runtime', 'pkgs')
    const leaf = 'broken-package-1.0-0'
    const packageDir = join(cache, 'https', 'host', 'channel', 'noarch', leaf)
    mkdirSync(packageDir, { recursive: true })
    const missing = join(packageDir, 'Library', 'x'.repeat(280))
    const results: SpawnResult[] = [
      {
        code: 1,
        stdout: '',
        stderr: `Invalid package cache, file '${missing}' is missing for '${leaf}.conda'; Package cache error`
      },
      { code: 0, stdout: 'ok', stderr: '' } // retry succeeds
    ]
    const order: string[] = []
    let i = 0
    // deps.onBeforeSpawn is threaded to baseSpawn as its 5th arg; a faithful stub invokes it (as the real
    // defaultSpawn does) BEFORE reporting the child, so we can assert both that it ran and that it ran first.
    const spawn: InstallSpawn = async (_command, args, _env, onChild, onBeforeSpawn) => {
      if (isCacheClean(args)) {
        onBeforeSpawn?.()
        order.push('cleanup-child')
        onChild?.(999)
        return ok
      }
      onBeforeSpawn?.()
      order.push(`child#${i}`)
      onChild?.(1000 + i)
      return results[i++]
    }

    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: 'my-analysis' },
      {
        spawn,
        ...base,
        readCondaPackageIdentity: () => undefined,
        storageRoot,
        pathExists: () => true,
        onBeforeSpawn: () => order.push('intent'),
        micromambaEnv: {
          platform: 'win32',
          env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
          selectCache: () => ({ path: cache, lockKey: cache })
        }
      }
    )

    expect(result.ok).toBe(true)
    // The intent fired before the child on the FIRST spawn AND again on the RETRY (old bug: zero intents,
    // since runConda dropped deps.onBeforeSpawn entirely).
    expect(order).toEqual(['intent', 'cleanup-child', 'intent', 'child#0', 'intent', 'child#1'])
    expect(i).toBe(2)
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
      { spawn, ...base, pathExists: () => true, readCondaPackageIdentity: () => undefined }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    expect(calls).toHaveLength(1)
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    expect(args).toEqual(expect.arrayContaining(['install', '--prefix', prefix]))
    expect(result.ok).toBe(true)
  })

  it('rejects a Python conda plan that would replace r-base in a shared named environment', async () => {
    const protectedPlan: SpawnResult = {
      code: 0,
      stdout: JSON.stringify({
        success: true,
        actions: {
          UNLINK: [{ name: 'r-base', version: '4.4.3' }],
          LINK: [{ name: 'r-base', version: '4.5.3' }]
        }
      }),
      stderr: ''
    }
    const { spawn, calls } = scriptedSpawn([protectedPlan, ok])

    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: 'my-analysis' },
      { spawn, ...base, pathExists: () => true }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain('--dry-run')
    expect(calls[0][1]).toContain('--json')
    expect(result).toMatchObject({ ok: false, fallbackUsed: false, needsRestart: false })
    expect(result.error).toMatch(/proposed changing protected r-base/i)
  })

  it('rejects a Python conda plan that would replace r-base in default-r', async () => {
    const protectedPlan: SpawnResult = {
      code: 0,
      stdout: JSON.stringify({
        success: true,
        actions: {
          UNLINK: [{ name: 'r-base', version: '4.4.3' }],
          LINK: [{ name: 'r-base', version: '4.5.3' }]
        }
      }),
      stderr: ''
    }
    const { spawn, calls } = scriptedSpawn([protectedPlan, ok])

    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: DEFAULT_R_ENV },
      { spawn, ...base, pathExists: () => true }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain('--dry-run')
    expect(calls[0][1]).toContain('--json')
    expect(calls[0][1]).toContain('r-base=4.4.3=h123_0')
    expect(result).toMatchObject({ ok: false, fallbackUsed: false, needsRestart: false })
    expect(result.error).toMatch(/proposed changing protected r-base/i)
  })

  it('quarantines a shared named environment when a Python conda install changes r-base', async () => {
    const identities = [
      { name: 'r-base', version: '4.4.3', build: 'h123_0', buildNumber: 0 },
      { name: 'r-base', version: '4.5.3', build: 'h999_1', buildNumber: 1 }
    ]
    const { spawn } = scriptedSpawn([safeRPlan, ok])

    const result = await installPackages(
      { language: 'python', packages: ['numpy'], environment: 'my-analysis' },
      {
        spawn,
        ...base,
        pathExists: () => true,
        readCondaPackageIdentity: () => identities.shift()
      }
    )

    expect(result).toMatchObject({ ok: false, repairRequired: true, needsRestart: false })
    expect(result.error).toMatch(/r-base changed unexpectedly.*Repair/i)
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
    expect(result).toMatchObject({
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
      { spawn, ...named, readCondaPackageIdentity: () => undefined }
    )
    const prefix = envPrefix(runtimeRoot('/root'), 'my-analysis')
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    expect(args).toEqual([
      '--no-rc',
      'remove',
      '--json',
      '--root-prefix',
      runtimeRoot('/root'),
      '--prefix',
      prefix,
      '-y',
      'numpy',
      'pandas'
    ])
    expect(result).toMatchObject({
      ok: true,
      needsRestart: false,
      log: expect.stringContaining('done'),
      method: 'conda',
      prefix
    })
  })

  it.each(['r-base', 'r-base=4.4.3', 'conda-forge::r-base=4.4.3=h123_0'])(
    'refuses to uninstall protected r-base through the Python conda branch: %s',
    async (packageName) => {
      const spawn = vi.fn()

      const result = await installPackages(
        {
          language: 'python',
          packages: [packageName],
          operation: 'uninstall',
          environment: 'my-analysis'
        },
        { ...named, spawn: spawn as unknown as InstallSpawn }
      )

      expect(spawn).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: false, needsRestart: false })
      expect(result.error).toMatch(/protected R kernel/i)
    }
  )

  it('rejects a Python conda remove plan that would change r-base in a shared environment', async () => {
    const protectedPlan: SpawnResult = {
      code: 0,
      stdout: JSON.stringify({
        success: true,
        actions: {
          UNLINK: [{ name: 'r-base', version: '4.4.3' }],
          LINK: [{ name: 'r-base', version: '4.5.3' }]
        }
      }),
      stderr: ''
    }
    const { spawn, calls } = scriptedSpawn([protectedPlan, ok])

    const result = await installPackages(
      {
        language: 'python',
        packages: ['numpy'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { spawn, ...named }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain('--dry-run')
    expect(calls[0][1]).toContain('--json')
    expect(result).toMatchObject({ ok: false, fallbackUsed: false, needsRestart: false })
    expect(result.error).toMatch(/proposed changing protected r-base/i)
  })

  it('routes a conda-managed R uninstall through micromamba remove with r-/bioconductor- names, needsRestart true', async () => {
    const { spawn, calls } = scriptedSpawn([safeRRemovePlan, ok])
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
    expect(calls).toHaveLength(2)
    const [command, args] = calls[0]
    expect(command).toBe('/mm/bin/micromamba')
    // Same conda name-mangling as R install: r- prefix for CRAN-style names, already-namespaced
    // bioconductor-* left untouched.
    expect(args).toEqual([
      '--no-rc',
      'remove',
      '--dry-run',
      '--json',
      '--root-prefix',
      runtimeRoot('/root'),
      '--prefix',
      prefix,
      '-y',
      'r-ggplot2',
      'bioconductor-deseq2'
    ])
    expect(calls[1][1]).not.toContain('--dry-run')
    expect(result).toMatchObject({
      ok: true,
      // R uninstall asks for a restart just like R install: a live session holds namespaces/DLLs.
      needsRestart: true,
      log: expect.stringContaining('done'),
      method: 'conda',
      prefix
    })
  })

  it.each(['r-base', 'base', 'r-base=4.4.3', 'base=4.4.3', 'conda-forge::r-base=4.4.3=h123_0'])(
    'refuses to uninstall the protected R kernel package %s from a named environment',
    async (packageName) => {
      const spawn = vi.fn()

      const result = await installPackages(
        {
          language: 'r',
          packages: [packageName],
          operation: 'uninstall',
          environment: 'my-analysis'
        },
        { ...named, spawn: spawn as unknown as InstallSpawn }
      )

      expect(spawn).not.toHaveBeenCalled()
      expect(result).toMatchObject({ ok: false, needsRestart: false })
      expect(result.error).toMatch(/protected R kernel/i)
    }
  )

  it('quarantines an R uninstall transaction that unexpectedly changes r-base', async () => {
    const identities = [
      { name: 'r-base', version: '4.4.3', build: 'h123_0', buildNumber: 0 },
      { name: 'r-base', version: '4.4.3', build: 'h999_1', buildNumber: 1 }
    ]
    const { spawn } = scriptedSpawn([safeRRemovePlan, ok])

    const result = await installPackages(
      {
        language: 'r',
        packages: ['dplyr'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { ...named, spawn, readCondaPackageIdentity: () => identities.shift() }
    )

    expect(result).toMatchObject({ ok: false, repairRequired: true, needsRestart: false })
    expect(result.error).toMatch(/h123_0.*h999_1.*Repair/i)
  })

  it('rejects an R uninstall dry-run that would change r-base before the real remove', async () => {
    const protectedPlan: SpawnResult = {
      code: 0,
      stdout: JSON.stringify({
        success: true,
        actions: {
          UNLINK: [{ name: 'r-base', version: '4.4.3' }],
          LINK: [{ name: 'r-base', version: '4.5.3' }]
        }
      }),
      stderr: ''
    }
    const { spawn, calls } = scriptedSpawn([protectedPlan, ok])

    const result = await installPackages(
      {
        language: 'r',
        packages: ['dplyr'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { ...named, spawn }
    )

    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain('--dry-run')
    expect(result).toMatchObject({ ok: false, fallbackUsed: false, needsRestart: false })
    expect(result.error).toMatch(/proposed changing protected r-base/i)
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
    expect(result).toMatchObject({
      ok: true,
      needsRestart: true,
      // Log carries both the conda not-found signal and the successful CRAN removal.
      log: expect.stringContaining('not found'),
      method: 'cran',
      // The reported location is the env-scoped R library, deterministic from the prefix.
      prefix: rLib
    })
    expect(result.fallbackUsed).toBe(true)
    expect(result.attempts).toEqual([
      expect.objectContaining({ installer: 'conda', mutationRisk: 'none' }),
      expect.objectContaining({ installer: 'r-install-packages', status: 'succeeded' })
    ])
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
      {
        spawn,
        ...base,
        pathExists: () => true,
        readCondaPackageIdentity: () => undefined
      }
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

describe('installPackages shared pkgs cache lock', () => {
  it('removes a superseded cached package before the next conda mutation', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'os-package-cache-growth-'))
    const root = runtimeRoot(storageRoot)
    const cachePath = join(root, 'pkgs')
    const stalePackage = join(cachePath, 'zlib-1.2.13-h2466b09_6')
    mkdirSync(stalePackage, { recursive: true })
    const order: string[] = []
    let cleanEnv: NodeJS.ProcessEnv | undefined
    let cleanArgs: string[] | undefined
    const spawn: InstallSpawn = async (_command, args, env) => {
      if (isCacheClean(args)) {
        order.push('clean')
        cleanArgs = args
        cleanEnv = env
        rmSync(stalePackage, { recursive: true, force: true })
      } else {
        order.push('install')
      }
      return ok
    }

    const result = await installPackages(
      { language: 'python', packages: ['zlib==1.3.1'] },
      {
        ...base,
        storageRoot,
        spawn,
        micromambaEnv: {
          selectCache: () => ({
            path: cachePath,
            lockKey: micromambaCacheLockKey(cachePath)
          })
        },
        onCacheMaintenanceSettled: () => void order.push('settled')
      }
    )

    expect(result.ok).toBe(true)
    expect(existsSync(stalePackage)).toBe(false)
    expect(order).toEqual(['clean', 'settled', 'install'])
    expect(cleanArgs).toEqual(['--no-rc', 'clean', '--packages', '--yes'])
    expect(cleanEnv).toMatchObject({
      MAMBA_ROOT_PREFIX: root,
      CONDA_PKGS_DIRS: cachePath
    })
  })

  it('continues the requested install when cache maintenance fails', async () => {
    const order: string[] = []
    const spawn: InstallSpawn = async (_command, args) => {
      if (isCacheClean(args)) {
        order.push('clean-failed')
        return { code: 1, stdout: '', stderr: 'cleanup failed' }
      }
      order.push('install')
      return ok
    }

    const result = await installPackages(
      { language: 'python', packages: ['numpy'] },
      { ...base, spawn, onCacheMaintenanceSettled: () => void order.push('settled') }
    )

    expect(result.ok).toBe(true)
    expect(order).toEqual(['clean-failed', 'settled', 'install'])
  })

  it('does not continue when the cleanup worker cannot be confirmed stopped', async () => {
    let installStarted = false
    const onCacheMaintenanceSettled = vi.fn()
    const spawn: InstallSpawn = async (_command, args) => {
      if (isCacheClean(args)) {
        throw new Error(`${CHILD_UNCONFIRMED}: cleanup worker may still be running`)
      }
      installStarted = true
      return ok
    }

    await expect(
      installPackages(
        { language: 'python', packages: ['numpy'] },
        { ...base, spawn, onCacheMaintenanceSettled }
      )
    ).rejects.toThrow(CHILD_UNCONFIRMED)
    expect(installStarted).toBe(false)
    expect(onCacheMaintenanceSettled).not.toHaveBeenCalled()
  })

  it.each(['legacy', 'selected'] as const)(
    'holds the %s physical cache identity while micromamba runs',
    async (heldCache) => {
      const storageRoot = mkdtempSync(join(tmpdir(), 'os-package-lock-'))
      const root = runtimeRoot(storageRoot)
      const shortCache = { path: 'C:\\osp1234567890', lockKey: 'c:\\osp1234567890' }
      const legacyKey = micromambaCacheLockKey(join(root, 'pkgs'), {
        platform: 'win32',
        canonicalize: (path) => path
      })
      const heldKey = heldCache === 'legacy' ? legacyKey : shortCache.lockKey
      let releaseCache!: () => void
      let cacheHeld!: () => void
      const release = new Promise<void>((resolve) => {
        releaseCache = resolve
      })
      const held = new Promise<void>((resolve) => {
        cacheHeld = resolve
      })
      const reader = withExclusiveCacheLock(heldKey, async () => {
        cacheHeld()
        await release
      })
      await held
      const spawn = vi.fn<InstallSpawn>(async () => ok)
      const install = installPackages(
        { language: 'python', packages: ['numpy'] },
        {
          ...base,
          storageRoot,
          spawn,
          micromambaEnv: {
            platform: 'win32',
            canonicalize: (path) => path,
            selectCache: () => shortCache
          }
        }
      )

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(spawn).not.toHaveBeenCalled()
      releaseCache()
      await Promise.all([reader, install])
      expect(spawn.mock.calls.filter(([, args]) => !isCacheClean(args))).toHaveLength(1)
    }
  )

  // Regression: micromamba install/remove extract into and mutate the SHARED pkgs cache, so they must
  // hold the shared cache lock (keyed by runtimeRoot(storageRoot)) — otherwise a concurrent corrupt-cache
  // repair (cache-exclusive, deletes incomplete extractions) could delete a package dir mid-op. We prove
  // it with the same ordering technique as the provisioner create test: the conda spawn holds the lock
  // across a delay, and an exclusive holder requested meanwhile must wait until the spawn releases it.
  it('holds the shared lock across a conda install, so a concurrent exclusive repair cannot run mid-install', async () => {
    const order: string[] = []
    let markInstallStarted!: () => void
    const installStarted = new Promise<void>((resolve) => (markInstallStarted = resolve))
    const spawn: InstallSpawn = async (_command, args) => {
      if (isCacheClean(args)) return ok
      order.push('install-start')
      markInstallStarted()
      await new Promise((r) => setTimeout(r, 10))
      order.push('install-end')
      return ok
    }

    // Kick off the conda install (holds the shared lock synchronously), then request the cache EXCLUSIVE
    // on the same key the source uses.
    const install = installPackages({ language: 'python', packages: ['numpy'] }, { spawn, ...base })
    await installStarted
    const cacheKey = micromambaCacheLockKey(join(runtimeRoot(base.storageRoot), 'pkgs'), {
      platform: 'linux'
    })
    const exclusive = withExclusiveCacheLock(cacheKey, async () => {
      order.push('repair')
    })
    await Promise.all([install, exclusive])

    expect(order).toEqual(['install-start', 'install-end', 'repair'])
  })

  it('holds the shared lock across a conda remove, so a concurrent exclusive repair cannot run mid-remove', async () => {
    const order: string[] = []
    let markRemoveStarted!: () => void
    const removeStarted = new Promise<void>((resolve) => (markRemoveStarted = resolve))
    const spawn: InstallSpawn = async (_command, args) => {
      if (isCacheClean(args)) return ok
      order.push('remove-start')
      markRemoveStarted()
      await new Promise((r) => setTimeout(r, 10))
      order.push('remove-end')
      return ok
    }

    // Uninstall is only valid on a named env, so target one and report its bin present. micromamba
    // remove takes the same shared lock as install.
    const remove = installPackages(
      {
        language: 'python',
        packages: ['numpy'],
        operation: 'uninstall',
        environment: 'my-analysis'
      },
      { spawn, ...base, pathExists: () => true }
    )
    await removeStarted
    const cacheKey = micromambaCacheLockKey(join(runtimeRoot(base.storageRoot), 'pkgs'), {
      platform: 'linux'
    })
    const exclusive = withExclusiveCacheLock(cacheKey, async () => {
      order.push('repair')
    })
    await Promise.all([remove, exclusive])

    expect(order).toEqual(['remove-start', 'remove-end', 'repair'])
  })

  it('does NOT take the shared lock on a pip install (env-prefix only), so a repair can interleave', async () => {
    // Contrast test: pip writes only into the env prefix, never the shared cache, so it uses `run`
    // directly (unlocked). An exclusive repair requested meanwhile runs WITHOUT waiting — this both
    // documents the intended scope and guards against over-locking pip behind the cache lock.
    const order: string[] = []
    const spawn: InstallSpawn = async () => {
      order.push('pip-start')
      await new Promise((r) => setTimeout(r, 10))
      order.push('pip-end')
      return ok
    }

    const install = installPackages(
      { language: 'python', packages: ['seaborn'], usePip: true, environment: 'my-analysis' },
      { spawn, ...base, pathExists: () => true }
    )
    const cacheKey = micromambaCacheLockKey(join(runtimeRoot(base.storageRoot), 'pkgs'), {
      platform: 'linux'
    })
    const exclusive = withExclusiveCacheLock(cacheKey, async () => {
      order.push('repair')
    })
    await Promise.all([install, exclusive])

    // The repair interleaved (ran before pip finished) because pip never held the shared lock.
    expect(order).toEqual(['pip-start', 'repair', 'pip-end'])
  })
})
