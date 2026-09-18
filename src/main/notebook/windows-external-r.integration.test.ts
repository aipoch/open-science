import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'

// Opt-in native check: use an existing external R with jsonlite and an installed protected sandbox.
// A conda build may supply its DLL directory without granting its complete environment prefix.
const rscript = process.env.OPEN_SCIENCE_TEST_RSCRIPT
it.skipIf(process.platform !== 'win32' || !rscript)(
  'executes an external R kernel whose installation is outside the declared workspace and PATH',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-external-r-'))
    const workspace = join(root, 'workspace')
    const runtimeRoot = join(root, 'runtime')
    await mkdir(workspace)
    await mkdir(runtimeRoot)
    const dllDirectory = process.env.OPEN_SCIENCE_TEST_R_DLL_DIR
    if (dllDirectory) vi.stubEnv('PATH', `${dllDirectory};${process.env.PATH ?? ''}`)
    for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE']) vi.stubEnv(key, 'C.UTF-8')
    const sandbox = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const executor = new NotebookKernelExecutor({
      rLoopPath: resolve('resources/notebook/r_loop.R'),
      processSandbox: sandbox
    })
    try {
      // A host launch must succeed first; missing DLLs/packages are environment failures, not red tests.
      expect(
        execFileSync(
          rscript!,
          [
            '--vanilla',
            '-e',
            'stopifnot(requireNamespace("jsonlite", quietly=TRUE)); cat("HOST_R_OK")'
          ],
          {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 15_000
          }
        )
      ).toContain('HOST_R_OK')
      expect(await sandbox.status()).toMatchObject({ kind: 'ready' })
      const result = await executor.execute({
        language: 'r',
        code: 'cat("SANDBOX_R_OK")',
        cwd: workspace,
        notebookSessionRoot: workspace,
        dataRoot: root,
        runtimeRoot,
        sessionId: 'external-r-probe',
        projectId: 'external-r-probe',
        timeoutMs: 15_000,
        resolvedInterpreter: { command: rscript! }
      })
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' })
      expect(result.stdout).toContain('SANDBOX_R_OK')
      expect(result.stderr).not.toMatch(/Setting LC_.*failed/)
    } finally {
      await executor.shutdown()
      await sandbox.dispose()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  40_000
)
