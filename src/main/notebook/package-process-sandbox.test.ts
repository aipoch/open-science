import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { sandboxedPackageSpawn } from './package-process-sandbox'
import type { NotebookProcessSandbox } from './process-sandbox'

describe('sandboxedPackageSpawn', () => {
  it('runs an installer through the Notebook sandbox and preserves its lifecycle', async () => {
    const endExecution = vi.fn()
    const cleanup = vi.fn()
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        beginExecution: () => endExecution,
        annotateStderr: (stderr) => `${stderr}<sandbox_violations>blocked</sandbox_violations>`,
        cleanup
      }))
    }
    const storageRoot = process.cwd()
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: {
        language: 'python',
        packages: ['example'],
        sessionId: 'session-1',
        projectId: 'project-1',
        workspaceCwd: process.cwd()
      },
      runtimeRoot: join(storageRoot, '.open-science-test-runtime', 'package-sandbox', 'runtime'),
      storageRoot
    })

    const result = await spawn(process.execPath, ['-e', 'process.stderr.write("installer")'], {
      PATH: process.env.PATH,
      PIP_CERT: '/trusted/bundle.pem',
      CONDA_PKGS_DIRS: '/tmp',
      OPENAI_API_KEY: 'must-not-cross'
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('installer<sandbox_violations>blocked</sandbox_violations>')
    expect(processSandbox.wrap).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'project-1',
        runtime: 'python',
        cwd: process.cwd()
      })
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).toMatchObject({
      PATH: process.env.PATH,
      PIP_CERT: '/trusted/bundle.pem'
    })
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].env).not.toHaveProperty(
      'OPENAI_API_KEY'
    )
    expect(vi.mocked(processSandbox.wrap).mock.calls[0]?.[0].filesystem.readWriteRoots).toContain(
      '/tmp'
    )
    expect(endExecution).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
