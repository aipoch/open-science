import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotebookKernelExecutor } from './kernel-executor'
import { sandboxedPackageSpawn } from './package-process-sandbox'
import type { NotebookProcessSandbox } from './process-sandbox'
import { runShellCommand } from './shell-process'

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip
const REPL_LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')
const temporaryDirectories = new Set<string>()
const liveHelperPids = new Set<number>()

const waitForDead = async (pid: number): Promise<void> => {
  await vi.waitFor(
    () => {
      expect(() => process.kill(pid, 0)).toThrow()
    },
    { timeout: 5_000 }
  )
}

const recordHelperPid = (value: string): number => {
  const pid = Number(value)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid helper pid: ${value}`)
  liveHelperPids.add(pid)
  return pid
}

afterEach(async () => {
  for (const pid of liveHelperPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The consumer's tracked teardown already reaped it.
    }
  }
  liveHelperPids.clear()
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
  )
  temporaryDirectories.clear()
})

describeMacOS('macOS process-tree consumers (real processes)', () => {
  it('reaps a setsid helper through the shell consumer', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'open-science-shell-consumer-'))
    temporaryDirectories.add(runtimeRoot)
    const helperScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
    const parentScript = [
      "const {spawn}=require('node:child_process')",
      `const helper=spawn(process.execPath,['-e',${JSON.stringify(helperScript)}],{stdio:'ignore',detached:true})`,
      'helper.unref()',
      'process.stdout.write(String(helper.pid))'
    ].join(';')

    const result = await runShellCommand({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`,
      cwd: process.cwd(),
      handoffDir: process.cwd(),
      runtimeRoot,
      sessionId: 'process-tree-consumer-session',
      projectId: 'process-tree-consumer-project',
      platform: process.platform,
      timeoutMs: 5_000
    })

    const helperPid = recordHelperPid(result.stdout)
    expect(result.exitCode).toBe(0)
    await waitForDead(helperPid)
  }, 15_000)

  it('reaps a setsid helper through the package installer consumer', async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'open-science-package-consumer-'))
    temporaryDirectories.add(runtimeRoot)
    const cleanup = vi.fn().mockResolvedValue({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    })
    const processSandbox: NotebookProcessSandbox = {
      wrap: vi.fn(async (invocation) => ({
        executable: invocation.executable,
        args: invocation.args,
        env: invocation.env,
        annotateStderr: (stderr: string) => stderr,
        cleanup
      }))
    }
    const spawn = sandboxedPackageSpawn({
      processSandbox,
      request: { language: 'python', packages: ['example'] },
      runtimeRoot,
      storageRoot: process.cwd(),
      platform: process.platform
    })
    const result = await spawn(process.execPath, [
      '-e',
      "const {spawn}=require('node:child_process');const helper=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',detached:true});helper.unref();process.stdout.write(String(helper.pid));"
    ])

    const helperPid = recordHelperPid(result.stdout)
    expect(result.code).toBe(0)
    await waitForDead(helperPid)
    expect(cleanup).toHaveBeenCalledWith('exit', { processesTerminated: true })
  }, 15_000)

  it('reaps a setsid helper through the persistent kernel consumer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'open-science-kernel-consumer-'))
    temporaryDirectories.add(cwd)
    const pidFile = join(cwd, 'helper.pid')
    const executor = new NotebookKernelExecutor({
      replLoopPath: REPL_LOOP,
      platform: process.platform
    })

    try {
      await executor.execute({
        cwd,
        notebookSessionRoot: join(cwd, 'nb'),
        inputRoot: join(cwd, 'inputs'),
        dataRoot: join(cwd, 'nb', 'data'),
        runtimeRoot: join(cwd, 'runtime'),
        code: [
          "const { spawn } = require('node:child_process')",
          "const fs = require('node:fs')",
          `const helper = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")}], { stdio: 'ignore', detached: true })`,
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))`,
          'setTimeout(() => process.exit(0), 25)',
          "return 'scheduled'"
        ].join(';'),
        kind: 'repl'
      })
      await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true))
      const helperPid = recordHelperPid(await readFile(pidFile, 'utf8'))

      await expect(executor.shutdown()).resolves.toEqual({ reaped: true })
      await waitForDead(helperPid)
    } finally {
      await executor.shutdown()
    }
  }, 15_000)
})
