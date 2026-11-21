import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
const externalPython = process.env.OPEN_SCIENCE_TEST_STANDARD_PYTHON
const externalR = standardRuntimeRoot && join(standardRuntimeRoot, 'envs/.r/Lib/R/bin/Rscript.exe')
it.skipIf(process.platform !== 'win32').for([
  { name: 'managed R', language: 'r', available: standardRuntimeRoot, command: undefined },
  { name: 'external R', language: 'r', available: externalR, command: externalR },
  {
    name: 'external Python',
    language: 'python',
    available: externalPython,
    command: externalPython
  }
] as const)(
  'executes real $name through the standard-mode gateway without administrator setup',
  { timeout: 45_000 },
  async ({ language, available, command }, { skip }) => {
    skip(!available)
    const root = await mkdtemp(join(tmpdir(), 'standard-r-access-'))
    vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
    const settings = command
      ? { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, windowsProtectionEnabled: false }
      : DEFAULT_NOTEBOOK_NETWORK_SETTINGS
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: resolve('packages/notebook-network-sandbox/vendor'),
      temporaryRoot: join(root, 'notebook-command-temp'),
      allowRuntimeAccessPrompt: false,
      getSettings: async () => settings,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const executor = new NotebookKernelExecutor({ processSandbox: owner })
    try {
      if (command) {
        const { windowsOwnershipRoot } = sandboxConfig.createRuntimeConfig({
          resources: { root },
          policy: { allowedDomains: [], deniedDomains: [] }
        })
        await writeFile(dirname(windowsOwnershipRoot), 'unusable protection directory')
      }
      const expectedStatus = command ? 'standard' : 'setupRequired'
      expect(await owner.status()).toMatchObject({ kind: expectedStatus })
      const result = await executor.execute({
        language,
        code:
          language === 'python'
            ? 'import os, sys; assert os.environ["HTTPS_PROXY"]; print(sys.executable); print(sum(range(1, 6)))'
            : 'stopifnot(nzchar(Sys.getenv("HTTPS_PROXY"))); cat(sum(1:5))',
        cwd: root,
        notebookSessionRoot: root,
        dataRoot: root,
        runtimeRoot: command ? join(root, 'managed-runtime') : standardRuntimeRoot!,
        sessionId: 'standard-r-access',
        projectId: 'standard-r-access',
        timeoutMs: 15000,
        ...(command
          ? {
              resolvedInterpreter: {
                command,
                ...(language === 'r' ? { condaPrefix: join(standardRuntimeRoot!, 'envs/.r') } : {})
              }
            }
          : {})
      })
      expect(result.status, result.stderr).toBe('completed')
      expect(result.stdout.trim()).toMatch(/15$/)
      if (language === 'python')
        expect(result.stdout.toLowerCase()).toContain(command!.toLowerCase())
      expect(await owner.status()).toMatchObject({ kind: expectedStatus })
    } finally {
      await executor.shutdown()
      await owner.dispose()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
)
