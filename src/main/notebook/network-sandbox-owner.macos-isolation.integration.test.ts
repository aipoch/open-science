import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import type { NotebookSandboxInvocation, NotebookSandboxedSpawn } from './process-sandbox'

it.skipIf(process.platform !== 'darwin').each([1, 65])(
  'executes independent Bash beside %i retained native commands, including a live unknown process',
  async (retainedCount) => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'os-cleanup-isolation-')))
    const workspace = join(fixture, 'workspace')
    await mkdir(workspace)
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(fixture, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny'
    })
    const invocation = (sessionId: string, script: string): NotebookSandboxInvocation => ({
      executable: '/bin/bash',
      args: ['--noprofile', '--norc', '-c', script],
      env: { PATH: '/usr/bin:/bin', HOME: fixture },
      cwd: workspace,
      commandText: script,
      sessionId,
      projectId: 'cleanup-isolation-fixture',
      runtime: 'bash',
      filesystem: {
        readOnlyRoots: [],
        readWriteRoots: [workspace],
        deniedReadRoots: [],
        deniedWriteRoots: []
      }
    })
    const children: Array<{
      child: ChildProcessWithoutNullStreams
      closed: Promise<unknown[]>
    }> = []
    const launch = (wrapped: NotebookSandboxedSpawn): ChildProcessWithoutNullStreams => {
      wrapped.beginExecution?.()
      const child = spawn(wrapped.executable, [...wrapped.args], {
        cwd: workspace,
        env: wrapped.env,
        stdio: 'pipe'
      })
      children.push({ child, closed: once(child, 'close') })
      return child
    }
    const retained: NotebookSandboxedSpawn[] = []
    let a: NotebookSandboxedSpawn | undefined
    let b: NotebookSandboxedSpawn | undefined
    let teardownConfirmed = false
    // Only this fixture's original process owner supplies proof. No sandbox layer is mocked.
    const confirmTermination = vi.fn(async () => teardownConfirmed)
    try {
      a = await owner.wrap(invocation('retained-A', 'printf "ready\\n"; read -r release'))
      const aRoot = a.env.TMPDIR!
      const childA = launch(a)
      const [ready] = await once(childA.stdout, 'data')
      expect(ready.toString()).toBe('ready\n')
      const incomplete = await a.cleanup('cancel', {
        processesTerminated: false,
        confirmTermination
      })
      expect(incomplete.processesTerminated).toBe(false)
      expect(incomplete.networkClosed).toBe(true)
      expect(() => a!.beginExecution?.()).toThrow('already closed')
      expect(childA.exitCode).toBeNull()
      expect(childA.signalCode).toBeNull()
      expect(existsSync(aRoot)).toBe(true)
      expect(existsSync(`${aRoot}.receipt`)).toBe(true)

      retained.push(a)
      // Exercise the former global limit with this owner's real launches, not old directory fixtures.
      // SIGKILL each additional shell, but keep termination unconfirmed to retain its receipt.
      for (let index = 1; index < retainedCount; index += 1) {
        const command = await owner.wrap(
          invocation(`failed-${index}`, 'printf "ready\\n"; read -r release')
        )
        retained.push(command)
        const child = launch(command)
        await once(child.stdout, 'data')
        child.kill('SIGKILL')
        await children.at(-1)!.closed
        expect(
          await command.cleanup('cancel', { processesTerminated: false, confirmTermination })
        ).toMatchObject({ processesTerminated: false, networkClosed: true })
        expect(existsSync(`${command.env.TMPDIR}.receipt`)).toBe(true)
      }
      const nonce = randomUUID()
      b = await owner.wrap(
        invocation('independent-B', `printf '${nonce}\\n'; read -r release; printf 'done\\n'`)
      )
      const childB = launch(b)
      let output = ''
      childB.stdout.on('data', (chunk) => {
        output += chunk.toString()
      })
      await once(childB.stdout, 'data')
      expect(output).toBe(`${nonce}\n`)
      const retry = await a.cleanup('cancel', { processesTerminated: false, confirmTermination })
      expect(retry.processesTerminated).toBe(false)
      expect(childB.exitCode).toBeNull()
      expect(childB.signalCode).toBeNull()
      childB.stdin.write('release\n')
      const [code] = await children.at(-1)!.closed
      expect(code).toBe(0)
      expect(output).toBe(`${nonce}\ndone\n`)
      await b.cleanup('exit', { processesTerminated: true })
      expect(confirmTermination).toHaveBeenCalled()
      expect(await confirmTermination()).toBe(false)
      for (const command of retained) {
        expect(existsSync(command.env.TMPDIR!)).toBe(true)
        expect(existsSync(`${command.env.TMPDIR}.receipt`)).toBe(true)
      }
      expect(childA.exitCode).toBeNull()
      expect(childA.signalCode).toBeNull()
      expect(existsSync(aRoot)).toBe(true)
      expect(existsSync(`${aRoot}.receipt`)).toBe(true)
    } finally {
      // These shells use only builtins, so the retained fixture has no descendant workloads.
      // Signal only ChildProcess handles created above, never user processes or scanned PIDs.
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed
      }
      teardownConfirmed = true
      for (const command of retained) await command.cleanup('cancel', { processesTerminated: true })
      if (a && !retained.includes(a)) await a.cleanup('cancel', { processesTerminated: true })
      if (b) await b.cleanup('exit', { processesTerminated: true })
      await owner.dispose()
      await rm(fixture, { recursive: true, force: true })
    }
  },
  120_000
)
