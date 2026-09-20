import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as sandboxConfig from '../../../packages/notebook-network-sandbox/src/config'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookKernelExecutor } from './kernel-executor'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'

// Opt in with a provisioned managed runtime whose R has not received directory authorization.
// Run alone with the desktop stopped: the native installation owns one shared gateway port.
const runtimeRoot = process.env.OPEN_SCIENCE_TEST_FIRST_R_RUNTIME_ROOT

it.skipIf(process.platform !== 'win32' || !runtimeRoot)(
  'reaches first R authorization while a Python kernel retains its filesystem lease',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'first-r-access-'))
    const rscript = join(runtimeRoot!, 'envs/.r/Lib/R/bin/Rscript.exe')
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot: join(root, 'notebook-command-temp'),
      allowRuntimeAccessPrompt: false,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: resolve('resources/notebook/python_loop.py'),
      processSandbox: owner
    })
    try {
      // Establish host readiness before attributing a failure to sandbox authorization.
      expect(
        execFileSync(
          rscript,
          [
            '--vanilla',
            '-e',
            'stopifnot(requireNamespace("jsonlite", quietly=TRUE)); cat("HOST_R_OK")'
          ],
          {
            env: {
              ...process.env,
              PATH: `${join(runtimeRoot!, 'envs/.r/Library/bin')};${process.env.PATH ?? ''}`
            },
            windowsHide: true,
            encoding: 'utf8',
            timeout: 15_000
          }
        )
      ).toContain('HOST_R_OK')
      const python = await executor.execute({
        language: 'python',
        code: 'print(2)',
        cwd: root,
        notebookSessionRoot: root,
        dataRoot: root,
        runtimeRoot: runtimeRoot!,
        sessionId: 'first-r-access',
        projectId: 'first-r-access',
        timeoutMs: 15_000,
        resolvedInterpreter: { command: join(runtimeRoot!, 'envs/.p/python.exe') }
      })
      expect(python.status).toBe('completed')
      const started = performance.now()
      await expect(
        owner.ensureRuntimeAccess({
          runtime: 'r',
          executable: rscript,
          sessionId: 'first-r-access'
        })
      ).rejects.toThrow('administrator authorization')
      expect(performance.now() - started).toBeLessThan(60_000)
    } finally {
      await executor.shutdown()
      await owner.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  120_000
)

// A fresh test-owned receipt directory exercises real standard-mode admission without installing,
// removing, or modifying the desktop user's protected-mode resources or runtime ACLs.
const standardRuntimeRoot = process.env.OPEN_SCIENCE_TEST_STANDARD_R_RUNTIME_ROOT
it
  .skipIf(process.platform !== 'win32' || !standardRuntimeRoot)
  .each(['managed', 'external'] as const)(
  'executes real %s R through the standard-mode gateway without administrator setup',
  async (selection) => {
    const root = await mkdtemp(join(tmpdir(), 'standard-r-access-'))
    const originalConfig = sandboxConfig.createRuntimeConfig
    const configSpy = vi
      .spyOn(sandboxConfig, 'createRuntimeConfig')
      .mockImplementation((options) => ({
        ...originalConfig(options),
        windowsOwnershipRoot: join(root, originalConfig(options).installationId)
      }))
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot: join(root, 'notebook-command-temp'),
      allowRuntimeAccessPrompt: false,
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const executor = new NotebookKernelExecutor({ processSandbox: owner })
    try {
      expect(await owner.status()).toMatchObject({ kind: 'setupRequired' })
      const result = await executor.execute({
        language: 'r',
        code: 'stopifnot(sum(1:5) == 15); stopifnot(nzchar(Sys.getenv("HTTPS_PROXY"))); cat("STANDARD_R_OK: 15; proxy configured")',
        cwd: root,
        notebookSessionRoot: root,
        dataRoot: root,
        runtimeRoot: standardRuntimeRoot!,
        sessionId: 'standard-r-access',
        projectId: 'standard-r-access',
        timeoutMs: 15000,
        ...(selection === 'external'
          ? {
              resolvedInterpreter: {
                command: join(standardRuntimeRoot!, 'envs/.r/Lib/R/bin/Rscript.exe'),
                condaPrefix: join(standardRuntimeRoot!, 'envs/.r')
              }
            }
          : {})
      })
      expect(result.status, result.stderr).toBe('completed')
      expect(result.stdout).toContain('STANDARD_R_OK: 15; proxy configured')
      expect(await owner.status()).toMatchObject({ kind: 'setupRequired' })
    } finally {
      await executor.shutdown()
      await owner.dispose()
      configSpy.mockRestore()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  45000
)
