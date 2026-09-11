import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

import { createRuntimeConfig } from '../../../packages/notebook-network-sandbox/src/config'
import { windowsLaunch } from '../../../packages/notebook-network-sandbox/runtime/src/platform/windows-appcontainer'
import { NotebookKernelExecutor } from './kernel-executor'
import { KernelProcessLifecycleOwner } from './kernel-process-lifecycle.windows-posix'
import type { NotebookProcessSandbox } from './process-sandbox'

it.skipIf(process.platform !== 'win32').each([
  { protectedMode: false, crashAdmission: false },
  ...(process.env.OPEN_SCIENCE_TEST_WINDOWS_SANDBOX === '1'
    ? [
        { protectedMode: true, crashAdmission: false },
        { protectedMode: true, crashAdmission: true }
      ]
    : [])
])(
  'retries only a proven reaped R lane (protected: $protectedMode, admission crash: $crashAdmission)',
  async ({ protectedMode, crashAdmission }) => {
    const root = await mkdtemp(join(tmpdir(), 'kernel-startup-retry-'))
    const loop = join(root, 'loop.cjs')
    const admissionHost = join(root, 'admission.cjs')
    if (crashAdmission) {
      await writeFile(
        admissionHost,
        `
        const fs = require('node:fs')
        const child = require('node:child_process').spawn(process.argv[4], process.argv.slice(5), {
          stdio: 'inherit', windowsHide: true
        })
        fs.writeFileSync('native.pid', String(child.pid))
        setInterval(() => {
          if (fs.existsSync('loop.pid')) {
            // A workload/stdio message must never substitute for the private host acknowledgement.
            console.log('kernel-child-exited')
            process.exit(1)
          }
        }, 10)
      `
      )
    }
    const owner = new KernelProcessLifecycleOwner({ storageRoot: root })
    await owner.ensureReady()
    // The desktop app owns the gateway port. Exercise the real native launch without opening a
    // second gateway; these offline fixtures do not make network requests.
    const config = createRuntimeConfig({
      policy: { allowedDomains: [], deniedDomains: [] },
      resources: { root: resolve('packages/notebook-network-sandbox/vendor') }
    })
    const processSandbox: NotebookProcessSandbox = {
      async wrap(invocation) {
        const wrapped = windowsLaunch({
          ...invocation,
          command: '',
          filesystem: invocation.filesystem,
          gatewayPort: 61200,
          gatewayCredentials: { username: 'offline', password: 'offline' },
          hostPath: config.windowsHostPath,
          installationId: config.installationId,
          ownershipRoot: config.windowsOwnershipRoot
        })
        return {
          ...wrapped,
          executable: wrapped.argv[0]!,
          args: wrapped.argv.slice(1),
          annotateStderr: (stderr) => stderr,
          cleanup: async (_reason, processOutcome) => ({
            processesTerminated: processOutcome.processesTerminated,
            networkClosed: true,
            temporaryResourcesRemoved: true
          })
        }
      }
    }
    const executor = new NotebookKernelExecutor({
      rLoopPath: loop,
      processLifecycle: owner,
      laneKey: 'startup-retry',
      ...(crashAdmission ? { processHostPath: admissionHost } : {}),
      ...(protectedMode ? { processSandbox } : {})
    })
    const request = {
      language: 'r' as const,
      code: 'cat(R.version.string)',
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: root,
      runtimeRoot: join(root, 'runtime'),
      // A real child process reproduces startup exit without requiring an installed R or changing ACLs.
      resolvedInterpreter: { command: process.execPath, args: ['--preserve-symlinks-main'] },
      sessionId: 'startup-retry',
      projectId: 'startup-retry',
      timeoutMs: 5_000
    }
    let descendantPid: number | undefined
    try {
      await writeFile(
        loop,
        crashAdmission
          ? `require('node:fs').writeFileSync('loop.pid', String(process.pid)); setInterval(() => {}, 1000)\n`
          : protectedMode
            ? `const child = require('node:child_process').spawn(process.execPath,
              ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
             child.once('spawn', () => {
               require('node:fs').writeFileSync('descendant.pid', String(child.pid))
               process.exit(1)
             })\n`
            : 'process.exit(1)\n'
      )
      const failed = await executor.execute(request)
      expect(failed.status).toBe('failed')
      expect(failed.stderr).toContain('Notebook kernel process exited with exit code 1.')
      if (protectedMode && !crashAdmission) {
        descendantPid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'))
      }
      const ledger = join(root, 'runtime', 'kernel-processes')
      const entries = await readdir(ledger)
      for (const entry of entries) {
        const record = JSON.parse(await readFile(join(ledger, entry), 'utf8'))
        expect(() => process.kill(record.pid, 0)).toThrow()
      }
      await writeFile(
        loop,
        `process.stdin.once('data', data => {
          const req_id = data.toString().split(' ')[0]
          console.log(JSON.stringify({ req_id, stdout: 'RETRY_OK', stderr: '', error: null, figures: [] }))
        })\n`
      )
      const retried = await executor.execute(request)
      if (protectedMode && !crashAdmission) {
        expect(retried, JSON.stringify(retried)).toMatchObject({
          status: 'completed',
          stdout: 'RETRY_OK'
        })
        // Do not wait for descendant cleanup before requesting the replacement. Admission must
        // complete the teardown itself; the crashed workload cannot survive a successful retry.
        expect(() => process.kill(descendantPid!, 0)).toThrow()
      } else {
        // A dead ordinary parent does not prove that its descendants were reaped.
        expect(retried.status).toBe('failed')
        expect(retried.stderr).toContain('KERNEL_STARTUP_FENCE')
        if (crashAdmission) {
          expect(Number(await readFile(join(root, 'loop.pid'), 'utf8'))).toBeGreaterThan(0)
        }
      }
    } finally {
      if (crashAdmission) {
        const nativePid = Number(await readFile(join(root, 'native.pid'), 'utf8'))
        // This PID belongs to this test's native host, whose live Job Object owns the workload.
        spawnSync('taskkill', ['/PID', String(nativePid), '/T', '/F'], { windowsHide: true })
      }
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL')
        } catch {
          /* Already reaped by the native job. */
        }
      }
      await executor.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  }
)
