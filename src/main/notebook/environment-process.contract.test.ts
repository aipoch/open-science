import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { defaultSpawn, runMicromamba, installEnvironmentPackages } from './environment-process'

it('aborts a running installer only after its process tree is confirmed stopped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-science-installer-abort-'))
  const descendantPidPath = join(directory, 'descendant.pid')
  const controller = new AbortController()
  let rootPid: number | undefined
  try {
    const pending = defaultSpawn(
      process.execPath,
      [
        '-e',
        [
          `const { spawn } = require('node:child_process');`,
          `const { writeFileSync } = require('node:fs');`,
          `const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);`,
          // Keep the fixture parent alive to reap its child on POSIX. Otherwise simultaneous
          // SIGTERM can orphan the child and make success depend on the runner's init reaping it.
          // Ignoring the parent's signal also ensures killing only the parent cannot pass.
          `process.on('SIGTERM', () => {});`,
          `descendant.on('exit', () => process.exit(0));`,
          `writeFileSync(process.env.DESCENDANT_PID_PATH, String(descendant.pid));`,
          `setTimeout(() => {}, 15000);`
        ].join('')
      ],
      { ...process.env, DESCENDANT_PID_PATH: descendantPidPath },
      (pid) => {
        rootPid = pid
      },
      undefined,
      undefined,
      undefined,
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(existsSync(descendantPidPath)).toBe(true))
    const descendantPid = Number(readFileSync(descendantPidPath, 'utf8'))
    controller.abort(new DOMException('Request cancelled.', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(rootPid).toBeGreaterThan(0)
    expect(() => process.kill(rootPid as number, 0)).toThrow()
    expect(() => process.kill(descendantPid, 0)).toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('does not settle cancellation while a descendant can still write the target prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-mm-cancel-tree-'))
  const descendantPidPath = join(dir, 'descendant.pid')
  const prefixWritePath = join(dir, 'prefix-write.log')
  const workerSource = [
    "const { appendFileSync } = require('node:fs')",
    "setInterval(() => appendFileSync(process.env.MM_PREFIX_WRITE_PATH, 'write\\n'), 20)"
  ].join(';')
  const supervisorSource = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const worker = spawn(process.execPath, ['-e', process.env.MM_WORKER_SOURCE], { detached: true, env: process.env, stdio: 'ignore' })",
    'writeFileSync(process.env.MM_DESCENDANT_PID_PATH, String(worker.pid))',
    'worker.unref()',
    'setInterval(() => {}, 1000)'
  ].join(';')
  const abort = new AbortController()
  const running = runMicromamba(
    [process.execPath, '-e', supervisorSource],
    {
      MM_DESCENDANT_PID_PATH: descendantPidPath,
      MM_PREFIX_WRITE_PATH: prefixWritePath,
      MM_WORKER_SOURCE: workerSource
    },
    abort.signal
  )
  let descendantPid: number | undefined

  try {
    await vi.waitFor(() => {
      expect(existsSync(descendantPidPath)).toBe(true)
      descendantPid = Number(readFileSync(descendantPidPath, 'utf8'))
      expect(descendantPid).toBeGreaterThan(0)
      expect(readFileSync(prefixWritePath, 'utf8')).toContain('write')
    })

    abort.abort()
    const error = await running.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)

    const writesWhenCancellationSettled = readFileSync(prefixWritePath, 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 150))
    if ((error as Error).message === 'Runtime setup cancelled.') {
      // A normal cancellation is safe only after every discovered writer has stopped.
      expect(readFileSync(prefixWritePath, 'utf8')).toBe(writesWhenCancellationSettled)
      expect(() => process.kill(descendantPid as number, 0)).toThrow()
    } else {
      // If the platform cannot prove the tree is gone, fail closed so the journal is retained and a
      // retry cannot race this still-possible writer.
      expect((error as Error).message).toContain('RUNTIME_CHILD_UNCONFIRMED')
    }
  } finally {
    abort.abort()
    await running.catch(() => undefined)
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL')
      } catch {
        // The fixed path already reaped it.
      }
    }
  }
})

it('maps host workspace to installer cwd and supplies the process supervisor without a sandbox override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'environment-host-install-'))
  try {
    const result = await installEnvironmentPackages(
      {
        language: 'python',
        packages: ['fixture'],
        usePip: true,
        projectId: 'host-project',
        sessionId: 'host-session',
        workspaceCwd: root
      },
      {
        storageRoot: root,
        interpreter: {
          command: process.execPath,
          args: ['-e', 'process.stdout.write(process.cwd())', '--']
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(result.log).toContain(realpathSync(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
