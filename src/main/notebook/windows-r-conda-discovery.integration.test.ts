import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { defaultDiscoveryDeps } from './environment-discovery'
import { NotebookKernelExecutor } from './kernel-executor'

const prefix = process.env.OPEN_SCIENCE_TEST_R_CONDA_PREFIX

it.skipIf(process.platform !== 'win32' || !prefix)(
  'executes a real x64-only managed R kernel without a resolved interpreter override',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'os-real-managed-r-x64-'))
    const runtimeRoot = join(root, 'runtime')
    const managedPrefix = join(runtimeRoot, 'envs', '.r')
    const rHome = join(managedPrefix, 'Lib', 'R')
    const executor = new NotebookKernelExecutor({
      platform: 'win32',
      processSandbox: {
        // This is a real host execution check of managed selection, not a native containment test.
        wrap: async (invocation) => ({
          executable: invocation.executable,
          args: invocation.args,
          env: invocation.env,
          annotateStderr: (stderr) => stderr,
          cleanup: async (_reason, outcome) => ({
            processesTerminated: outcome.processesTerminated,
            networkClosed: true,
            temporaryResourcesRemoved: true
          })
        })
      }
    })
    try {
      await mkdir(join(rHome, 'bin'), { recursive: true })
      // Expose only x64 binaries, even when the real installation also has root-bin launchers.
      // Junctions reuse read-only runtime assets without installing packages or modifying the source.
      await symlink(join(prefix!, 'Library'), join(managedPrefix, 'Library'), 'junction')
      await symlink(join(prefix!, 'Lib', 'R', 'bin', 'x64'), join(rHome, 'bin', 'x64'), 'junction')
      for (const directory of ['etc', 'library', 'modules', 'share']) {
        await symlink(join(prefix!, 'Lib', 'R', directory), join(rHome, directory), 'junction')
      }
      const result = await executor.execute({
        cwd: root,
        notebookSessionRoot: join(root, 'notebook'),
        inputRoot: join(root, 'inputs'),
        dataRoot: join(root, 'data'),
        runtimeRoot,
        language: 'r',
        code: 'cat(1 + 1)',
        sessionId: 'real-x64-r',
        projectId: 'real-x64-r'
      })
      expect(result.status, result.stderr || result.traceback).toBe('completed')
      expect(result.stdout).toBe('2')
    } finally {
      await executor.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform !== 'win32' || !prefix)(
  'recognizes a runnable Windows conda R in the bin/x64 layout without an activated parent PATH',
  async () => {
    const executable = join(prefix!, 'Lib/R/bin/x64/Rscript.exe')
    const env = { ...process.env, PATH: join(process.env.SystemRoot!, 'System32') }
    // Independent control establishes that this real installation and its protocol package work.
    const control = await promisify(execFile)(
      executable,
      [
        '--vanilla',
        '-e',
        'stopifnot(requireNamespace("jsonlite", quietly=TRUE)); cat("R_DEPENDENCIES_OK")'
      ],
      {
        env: { ...env, PATH: `${join(prefix!, 'Library/bin')};${env.PATH}` },
        windowsHide: true,
        timeout: 15_000
      }
    )
    expect(control.stdout).toContain('R_DEPENDENCIES_OK')

    const discovery = defaultDiscoveryDeps(join(prefix!, 'unused-runtime'), undefined, { env })
    // Calls the existing public probe with real subprocesses, without replacing any collaborator.
    await expect(discovery.rRunnable(executable)).resolves.toBe(true)
  }
)
it.skipIf(process.platform !== 'win32' || !prefix)(
  'rejects a real partial x64 R installation without matching Rscript',
  async () => {
    const { cp } = await import('node:fs/promises')
    const { existsSync } = await import('node:fs')
    const { verifyExecutable } = await import('./provisioner-runtime')
    const root = await mkdtemp(join(tmpdir(), 'os-partial-r-verification-'))
    const rHome = join(root, 'Lib', 'R')
    const bin = join(rHome, 'bin', 'x64')
    try {
      await cp(join(prefix!, 'Lib', 'R', 'bin', 'x64'), bin, {
        recursive: true,
        filter: (source) => !source.toLowerCase().endsWith('rscript.exe')
      })
      await cp(join(prefix!, 'Lib', 'R', 'library', 'base'), join(rHome, 'library', 'base'), {
        recursive: true
      })
      await cp(
        join(prefix!, 'Lib', 'R', 'library', 'compiler'),
        join(rHome, 'library', 'compiler'),
        { recursive: true }
      )
      await symlink(join(prefix!, 'Library'), join(root, 'Library'), 'junction')
      for (const directory of ['etc', 'modules', 'share']) {
        await symlink(join(prefix!, 'Lib', 'R', directory), join(rHome, directory), 'junction')
      }
      expect(existsSync(join(bin, 'Rscript.exe'))).toBe(false)
      await expect(
        verifyExecutable(join(bin, 'R.exe'), {
          prefix: root,
          platform: 'win32',
          env: {
            R_DEFAULT_PACKAGES: 'NULL',
            R_LIBS_USER: join(rHome, 'library'),
            R_USER: root,
            HOME: root
          }
        })
      ).rejects.toThrow(/Rscript\.exe/)
      await cp(join(prefix!, 'Lib', 'R', 'bin', 'x64', 'Rscript.exe'), join(bin, 'Rscript.exe'))
      await expect(
        verifyExecutable(join(bin, 'R.exe'), {
          prefix: root,
          platform: 'win32',
          env: {
            R_DEFAULT_PACKAGES: 'NULL',
            R_LIBS_USER: join(rHome, 'library'),
            R_USER: root,
            HOME: root
          }
        })
      ).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
