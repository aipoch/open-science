// Local integration test for issue #924's portable restore acceptance: an exported @EXPLICIT lock
// must rebuild an equivalent managed environment WITHOUT the original prefix and WITHOUT a
// pre-populated package cache (downloads re-fetch every tarball).
//
// Run with a real micromamba on PATH (or OPEN_SCIENCE_TEST_MICROMAMBA):
//   OPEN_SCIENCE_TEST_MICROMAMBA=$(pwd)/.tmp-micromamba/micromamba \
//     npx vitest run src/main/notebook/environment-lock.restore.integration.test.ts
//
// It is env-gated like the kernel suites (RUN_KERNEL/OPEN_SCIENCE_TEST_PY_ENV) so `npm test`
// never touches the network. Setup, mirroring .github/workflows/runtime-certification.yml:
//   node scripts/fetch-micromamba.mjs linux-64 .tmp-micromamba/micromamba
//   .tmp-micromamba/micromamba create -y -p .tmp-int-env -c conda-forge python=3.12
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { exportEnvironmentLock } from './environment-lock'
import { DefaultRuntimeProvisioner, type ProvisionerDeps } from './provisioner'
import { DEFAULT_PY_ENV, envPrefix, pkgsCache, pythonBin, runtimeRoot } from './runtime-paths'
import { captureMicromamba, verifyExecutable } from './provisioner-runtime'

const mm = process.env.OPEN_SCIENCE_TEST_MICROMAMBA
const gate = mm && existsSync(mm) ? describe : describe.skip

const runMm = (args: string[], opts: { cwd?: string } = {}): string => {
  const result = spawnSync(mm!, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, CONDA_PKGS_DIRS: undefined }
  })
  if (result.status !== 0) {
    throw new Error(`micromamba ${args.join(' ')} failed: ${result.stderr?.slice(0, 400)}`)
  }
  return result.stdout
}

const integrationDeps = (root: string): ProvisionerDeps => ({
  root,
  mm: mm!,
  channel: 'conda-forge',
  fetchBundle: async () => undefined,
  verify: async (bin, prefix) => verifyExecutable(bin, { prefix }),
  runArgv: async (argv) => {
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(
        `micromamba failed (${result.status}; ${argv.join(' ')}):\n${result.stderr?.slice(0, 400)}`
      )
    }
  },
  downloadPackage: async (url, dest, signal) => {
    // Direct URL fetch via the bundled Node fetch; the production wiring uses the shared
    // resilient downloader (system proxy aware). Integration-wise both fetch the same bytes.
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`package request failed (${response.status}): ${url}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    // Stage via rename so a killed download never leaves a torn tarball in staging.
    const temp = `${dest}.part`
    writeFileSync(temp, bytes)
    renameSync(temp, dest)
  },
  now: () => 't-now'
})

gate('environment lock portable restore (integration)', () => {
  it(
    'restores an exported lock into an empty-cache root as an equivalent env',
    { timeout: 600_000 },
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'envlock-restore-'))
      try {
        // Phase 1: create a minimal managed env (python + one small noarch package) in a SOURCE root.
        // --root-prefix binds the source root's own pkgs cache so the test never touches the host's
        // global micromamba cache (the target phase below is fully independent regardless).
        const sourceRoot = runtimeRoot(join(work, 'source-data'))
        const sourceEnvName = DEFAULT_PY_ENV
        runMm(
          [
            'create',
            '-y',
            '--no-rc',
            '--root-prefix',
            sourceRoot,
            '-p',
            envPrefix(sourceRoot, sourceEnvName),
            '-c',
            'conda-forge',
            'python=3.12',
            'six'
          ],
          { cwd: work }
        )
        const lock = await exportEnvironmentLock(
          { name: sourceEnvName, prefix: envPrefix(sourceRoot, sourceEnvName) },
          {
            mm: mm!,
            capture: (argv) => captureMicromamba(argv)
          }
        )
        expect(lock.startsWith('@EXPLICIT\n')).toBe(true)
        expect((lock.match(/^https?:\/\//gm) ?? []).length).toBeGreaterThan(0)

        // Phase 2: a pristine TARGET root — no prefix, no cache. The lock is all we carry over.
        const targetData = join(work, 'target-data')
        const targetRoot = runtimeRoot(targetData)
        const deps = integrationDeps(targetRoot)
        const provisioner = new DefaultRuntimeProvisioner(deps)
        await provisioner.restoreEnvironmentFromLock(sourceEnvName, lock)

        const prefix = envPrefix(targetRoot, sourceEnvName)
        expect(existsSync(pythonBin(prefix))).toBe(true)
        // The restored env lists the SAME pinned packages (URL equality = version+build+md5).
        const restoredLock = await exportEnvironmentLock(
          { name: sourceEnvName, prefix },
          { mm: mm!, capture: (argv) => captureMicromamba(argv) }
        )
        expect(restoredLock).toBe(lock)
        // Verify the interpreter actually runs from the restored prefix.
        const probe = spawnSync(pythonBin(prefix), ['-c', 'import six; print("ok")'], {
          encoding: 'utf8'
        })
        expect(probe.status).toBe(0)
        expect(probe.stdout.trim()).toBe('ok')
        // And the downloads seeded the target's durable cache (portable restore evidence).
        expect(existsSync(pkgsCache(targetRoot))).toBe(true)
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    }
  )
})
