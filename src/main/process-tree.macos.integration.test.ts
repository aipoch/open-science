import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createPosixProcessTreeOwnership,
  terminateProcessTree,
  trackOwnedPosixProcessTree
} from './process-tree'

const describeMacOS = process.platform === 'darwin' ? describe : describe.skip
const PROBE_TIMEOUT_MS = 10_000
const requestedIterations = Number(process.env.OPEN_SCIENCE_MACOS_PROCESS_TREE_ITERATIONS ?? '1')
const PROBE_ITERATIONS =
  Number.isSafeInteger(requestedIterations) && requestedIterations > 0
    ? Math.min(requestedIterations, 100)
    : 1
const liveProbePids = new Set<number>()

const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for process state.')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('error', reject)
    child.once('exit', () => resolve())
  })

const readPid = (child: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    let output = ''
    const finish = (): void => {
      const match = output.match(/^(\d+)\s*$/u)
      if (!match) return
      const pid = Number(match[1])
      liveProbePids.add(pid)
      resolve(pid)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      finish()
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      finish()
      if (!/^\d+\s*$/u.test(output)) {
        reject(new Error(`Probe exited before reporting its child pid (${code ?? signal}).`))
      }
    })
  })

const spawnTracked = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
  const ownership = createPosixProcessTreeOwnership(options.env ?? process.env)
  const child = spawn(command, args, { ...options, env: ownership.env })
  trackOwnedPosixProcessTree(child, ownership.token)
  return child
}

const spawnShellTree = (leaderExits: boolean, detached: boolean, tracked = true): ChildProcess => {
  const spawnProcess = tracked ? spawnTracked : spawn
  const child = spawnProcess(
    '/bin/sh',
    ['-c', `sleep 30 >/dev/null 2>&1 & printf '%s\\n' "$!"; ${leaderExits ? 'exit 0' : 'wait'}`],
    { detached, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  if (child.pid !== undefined) liveProbePids.add(child.pid)
  return child
}

afterEach(async () => {
  for (const pid of liveProbePids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The probe was reaped by the code under test.
    }
  }
  await waitFor(() => [...liveProbePids].every((pid) => !isAlive(pid))).catch(() => undefined)
  liveProbePids.clear()
})

describeMacOS('terminateProcessTree (real macOS processes)', () => {
  it(
    'reaps a tracked detached leader and its same-group child',
    async () => {
      for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration += 1) {
        const child = spawnShellTree(false, true)
        const descendantPid = await readPid(child)

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        await waitFor(() => !isAlive(descendantPid))
      }
    },
    PROBE_TIMEOUT_MS * PROBE_ITERATIONS
  )

  it(
    'reaps an owned group after its leader exits',
    async () => {
      for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration += 1) {
        const child = spawnShellTree(true, true)
        const descendantPid = await readPid(child)
        await waitForExit(child)

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        await waitFor(() => !isAlive(descendantPid))
      }
    },
    PROBE_TIMEOUT_MS * PROBE_ITERATIONS
  )

  it(
    'reaps a detached descendant after its leader exits and escalates SIGTERM',
    async () => {
      for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration += 1) {
        const stubbornDescendant = [
          "process.on('SIGTERM', () => {})",
          'setInterval(() => {}, 1_000)'
        ].join(';')
        const leader = [
          "const { spawn } = require('node:child_process')",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(stubbornDescendant)}], { detached: true, stdio: 'ignore' })`,
          'console.log(child.pid)',
          'setTimeout(() => process.exit(0), 25)'
        ].join(';')
        const child = spawnTracked(process.execPath, ['-e', leader], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        if (child.pid !== undefined) liveProbePids.add(child.pid)
        const descendantPid = await readPid(child)
        await waitForExit(child)

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        await waitFor(() => !isAlive(descendantPid))
      }
    },
    PROBE_TIMEOUT_MS * PROBE_ITERATIONS
  )

  it(
    'reaps a detached grandchild after its intermediary and leader exit',
    async () => {
      for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration += 1) {
        const helper = 'setInterval(() => {}, 1_000)'
        const intermediary = [
          "const { spawn } = require('node:child_process')",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { detached: true, stdio: 'ignore' })`,
          'child.unref()',
          'console.log(child.pid)'
        ].join(';')
        const leader = [
          "const { spawn } = require('node:child_process')",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(intermediary)}], { stdio: ['ignore', 'pipe', 'inherit'] })`,
          'child.stdout.pipe(process.stdout)',
          "child.on('exit', () => process.exit(0))"
        ].join(';')
        const child = spawnTracked(process.execPath, ['-e', leader], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        if (child.pid !== undefined) liveProbePids.add(child.pid)
        const descendantPid = await readPid(child)
        await waitForExit(child)

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        await waitFor(() => !isAlive(descendantPid))
      }
    },
    PROBE_TIMEOUT_MS * PROBE_ITERATIONS
  )

  it(
    'reaps a marked double-forked helper missed while the JavaScript sampler is blocked',
    async () => {
      for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration += 1) {
        const helper = 'setInterval(() => {}, 1_000)'
        const intermediary = [
          "const { spawn } = require('node:child_process')",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { detached: true, stdio: 'ignore' })`,
          'child.unref()',
          'console.log(child.pid)'
        ].join(';')
        const leader = [
          "const { spawn } = require('node:child_process')",
          'setTimeout(() => {',
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(intermediary)}], { stdio: ['ignore', 'pipe', 'inherit'] })`,
          'child.stdout.pipe(process.stdout)',
          "child.on('exit', () => process.exit(0))",
          '}, 20)'
        ].join(';')
        const child = spawnTracked(process.execPath, ['-e', leader], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        if (child.pid !== undefined) liveProbePids.add(child.pid)

        // Keep every JS timer from running until the leader and short-lived intermediary have both
        // exited. The inherited ownership marker must recover the escaped helper even though its
        // topology chain was never sampled.
        const blockedUntil = Date.now() + 350
        while (Date.now() < blockedUntil) {
          void process.hrtime.bigint()
        }
        const descendantPid = await readPid(child)
        await waitForExit(child)

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        await waitFor(() => !isAlive(descendantPid))
      }
    },
    PROBE_TIMEOUT_MS * PROBE_ITERATIONS
  )

  it(
    'ignores an unrelated orphaned session created while a tracked tree is live',
    async () => {
      for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration += 1) {
        const tracked = spawnTracked(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
          detached: true,
          stdio: 'ignore'
        })
        if (tracked.pid !== undefined) liveProbePids.add(tracked.pid)
        const unrelatedParent = spawn(
          process.execPath,
          [
            '-e',
            [
              "const { spawn } = require('node:child_process')",
              "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { detached: true, stdio: 'ignore' })",
              'child.unref()',
              'console.log(child.pid)'
            ].join(';')
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        if (unrelatedParent.pid !== undefined) liveProbePids.add(unrelatedParent.pid)
        const unrelatedPid = await readPid(unrelatedParent)
        await waitForExit(unrelatedParent)

        await expect(terminateProcessTree(tracked)).resolves.toEqual({ reaped: true })
        expect(isAlive(unrelatedPid)).toBe(true)
      }
    },
    PROBE_TIMEOUT_MS * PROBE_ITERATIONS
  )

  it(
    'preserves cleanup for an unregistered legacy process tree',
    async () => {
      for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration += 1) {
        const child = spawnShellTree(false, false, false)
        const descendantPid = await readPid(child)

        await expect(terminateProcessTree(child)).resolves.toEqual({ reaped: true })
        await waitFor(() => !isAlive(descendantPid))
      }
    },
    PROBE_TIMEOUT_MS * PROBE_ITERATIONS
  )
})
