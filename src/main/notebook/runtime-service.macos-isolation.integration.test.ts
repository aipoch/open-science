import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Client as ModelContextProtocolClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { NotebookLocalRpcServer } from './local-rpc-server'
import { createNotebookMcpServer } from './mcp-server'
import { expect, it, vi } from 'vitest'

import * as processTree from '../process-tree'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { createRootNotebookLane } from './lane-identity'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import type { NotebookSandboxedSpawn } from './process-sandbox'
import { NotebookRunRepository } from './repository'
import { NotebookRuntimeService } from './runtime-service'

// Point at an existing, read-only interpreter fixture. This suite never provisions environments.
const python = process.env.OPEN_SCIENCE_TEST_PY_ENV

it
  .skipIf(process.platform !== 'darwin' || !python)
  .each([
    'clean',
    'transient-proof',
    'escaped-child',
    'unknown-proof',
    'unknown-proof-with-history'
  ])(
  'keeps warm and new sessions executable after a real Python SIGKILL (%s)',
  async (scenario) => {
    const unknownProof = scenario.startsWith('unknown-proof')
    const storage = await realpath(await mkdtemp(join(tmpdir(), 'notebook-sigkill-isolation-')))
    const projectId = 'sigkill-isolation'
    const historicalRoots: string[] = []
    if (scenario === 'unknown-proof-with-history') {
      await mkdir(join(storage, 'commands'))
      for (let index = 0; index < 100; index += 1) {
        const name = `command-${randomUUID()}`
        const root = join(storage, 'commands', name)
        await mkdir(root)
        await writeFile(`${root}.receipt`, `v1 ${name} native\n`)
        await writeFile(join(root, 'sentinel'), 'historical workload')
        historicalRoots.push(root)
      }
    }
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(storage, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny',
      getGrantedLocalRoots: async () => [
        {
          id: 'python-fixture',
          path: await realpath(dirname(dirname(python!))),
          name: 'Python fixture',
          access: 'ro'
        }
      ]
    })
    const originalTerminate = processTree.terminateProcessTree
    let retainProof = unknownProof
    let transientProofPending = scenario === 'transient-proof'
    const terminate =
      unknownProof || transientProofPending
        ? vi.spyOn(processTree, 'terminateProcessTree').mockImplementation(async (...args) => {
            const result = await originalTerminate(...args)
            // Only suppress the proof for the actual SIGKILL victim, after performing real OS teardown.
            // This makes the production incident's unknown ownership repeatable without host-wide races.
            if (args[0].signalCode === 'SIGKILL' && (retainProof || transientProofPending)) {
              transientProofPending = false
              return { reaped: false }
            }
            return result
          })
        : undefined
    const service = new NotebookRuntimeService({
      configRoot: storage,
      dataRoot: storage,
      projectId,
      repository: new NotebookRunRepository(storage),
      processSandbox: owner,
      discoverRuntimes: async (language) =>
        language === 'python'
          ? [
              {
                language: 'python',
                provenance: 'user-own',
                envId: python!,
                interpreterPath: python!,
                label: 'existing test interpreter',
                version: 'fixture',
                runnable: true
              }
            ]
          : [],
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: { enabled: { [python!]: true }, installAuthorized: {} },
          manualInterpreters: [],
          packageMirror: {}
        })
      }
    })
    const scope = (
      sessionId: string
    ): { projectId: string; sessionId: string; workspaceCwd: string } => ({
      projectId,
      sessionId,
      workspaceCwd: storage
    })
    const rpc = new NotebookLocalRpcServer(service, { transport: 'tcp' })
    const connection = await rpc.issueSessionConnection(
      'crashed-A',
      projectId,
      'root-frame-crashed-A'
    )
    rpc.setArtifactTurnBinding('crashed-A', {
      ownerExecutionId: 'recovery-turn',
      projectId,
      provenanceContext: {
        rootFrameId: 'root-frame-crashed-A',
        agentFrameId: 'root-frame-crashed-A',
        messageBranchId: 'branch',
        runtimeSegmentId: 'runtime',
        promptMessageId: 'prompt'
      }
    })
    const mcp = createNotebookMcpServer({
      ...connection,
      projectId,
      sessionId: 'crashed-A',
      workspaceCwd: storage
    })
    const client = new ModelContextProtocolClient({ name: 'kernel-recovery-test', version: '1.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await mcp.connect(serverTransport)
    await client.connect(clientTransport)
    let escapedPid: number | undefined
    let retiredRoot: string | undefined
    try {
      for (const sessionId of ['crashed-A', 'warm-B']) {
        await service.bindRuntime({ ...scope(sessionId), language: 'python', runtimeId: python! })
        expect(
          await service.execute({
            ...scope(sessionId),
            code: 'import os; sentinel = 42; print(os.environ["TMPDIR"])'
          })
        ).toMatchObject({ status: 'completed' })
      }
      retiredRoot = (await service.state(scope('crashed-A'))).runs[0].text.stdout.trim()
      if (scenario === 'escaped-child') {
        expect(
          await service.execute({
            ...scope('crashed-A'),
            code: [
              'import subprocess, sys',
              'helper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
              'print(helper.pid)'
            ].join('\n')
          })
        ).toMatchObject({ status: 'completed' })
        escapedPid = Number((await service.state(scope('crashed-A'))).runs[1].text.stdout.trim())
        expect(escapedPid).toBeGreaterThan(0)
      }
      await service.executeControl({
        ...scope('crashed-A'),
        code: 'globalThis.recoverySentinel = 73'
      })
      // The shipped loop, OS signal, descendant teardown, sandbox and storage are real.
      // Self-signalling exercises the same uncatchable exit as jetsam without exhausting host memory.
      const crashReply = await client.callTool({
        name: 'notebook_execute',
        arguments: {
          code: 'import os, signal; os.kill(os.getpid(), signal.SIGKILL)'
        }
      })
      expect(JSON.stringify(crashReply)).toContain('SIGKILL')
      const crashed = await service.state(scope('crashed-A'))
      expect(crashed.runs).toHaveLength(scenario === 'escaped-child' ? 4 : 3)
      const failedRun = crashed.runs.at(-1)!
      expect(failedRun.status).not.toBe('completed')
      expect(failedRun.recovery).toMatchObject({
        execution: 'may-have-run',
        retryAfter: unknownProof ? 'cleanup-verified' : 'runtime-ready',
        kernel: {
          kind: 'python',
          environment: 'default-python',
          signal: 'SIGKILL',
          cause: 'unknown',
          cleanup: unknownProof ? 'unverified' : 'verified'
        }
      })
      const crashContext = JSON.parse(
        (crashReply.content as Array<{ type: string; text?: string }>).find(
          (item) => item.type === 'text'
        )!.text!
      )
      // Verify the actual agent-facing payload, not only a signal substring or service-side state.
      expect(crashContext.recovery).toMatchObject(failedRun.recovery!)
      expect(crashContext.recovery.guidance).toContain(
        'SIGKILL alone does not establish memory pressure'
      )
      if (unknownProof) {
        expect(crashContext.recovery.guidance).toContain('notebook_restart')
        expect(crashContext.recovery.guidance).toContain('default-python')
      } else {
        expect(crashContext.recovery.guidance).not.toContain('notebook_restart')
        // Exercise the advertised path through MCP: verified cleanup needs no explicit restart.
        const next = await client.callTool({
          name: 'notebook_execute',
          arguments: { code: 'assert "sentinel" not in globals(); print("fresh-after-exit")' }
        })
        expect(next.isError).not.toBe(true)
        expect((await service.state(scope('crashed-A'))).runs.at(-1)).toMatchObject({
          status: 'completed',
          text: { stdout: 'fresh-after-exit\n' }
        })
      }
      if (escapedPid) {
        await vi.waitFor(() => expect(() => process.kill(escapedPid!, 0)).toThrow())
        escapedPid = undefined
      }
      if (unknownProof) {
        expect(existsSync(retiredRoot)).toBe(true)
        expect(existsSync(`${retiredRoot}.receipt`)).toBe(true)
        const rejected = await client.callTool({
          name: 'notebook_execute',
          arguments: { code: 'print(99)' }
        })
        expect(rejected).toMatchObject({ isError: true })
        const rejectedContext = JSON.parse(
          (rejected.content as Array<{ type: string; text?: string }>).find(
            (item) => item.type === 'text'
          )!.text!
        )
        expect(rejectedContext.recovery).toMatchObject({
          execution: 'not-started',
          retryAfter: 'cleanup-verified',
          kernel: failedRun.recovery!.kernel
        })
        expect(rejectedContext.recovery.guidance).toContain('This command was not started.')
      }

      for (const sessionId of ['warm-B', 'new-C']) {
        if (sessionId === 'new-C')
          await service.bindRuntime({ ...scope(sessionId), language: 'python', runtimeId: python! })
        const nonce = randomUUID()
        const pythonCode =
          sessionId === 'warm-B'
            ? `assert sentinel == 42; print(${JSON.stringify(nonce)})`
            : `print(${JSON.stringify(nonce)})`
        expect(await service.execute({ ...scope(sessionId), code: pythonCode })).toMatchObject({
          status: 'completed'
        })
        expect(
          await service.executeShell({ ...scope(sessionId), command: `printf '${nonce}\\n'` })
        ).toMatchObject({ exitCode: 0, stdout: `${nonce}\n` })
        expect(
          await service.executeControl({
            ...scope(sessionId),
            code: `console.log(${JSON.stringify(nonce)})`
          })
        ).toMatchObject({ status: 'completed' })
        const disk = await new NotebookRunRepository(storage).loadOrCreate({
          ...scope(sessionId),
          lane: createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`)
        })
        const completed = disk.runs.filter((run) => run.text.stdout === `${nonce}\n`)
        expect(completed.map((run) => run.kernelKind).sort()).toEqual(['bash', 'python', 'repl'])
        expect(completed.every((run) => run.status === 'completed')).toBe(true)
      }
      if (unknownProof) {
        await expect(service.execute({ ...scope('crashed-A'), code: 'print(99)' })).rejects.toThrow(
          'process tree could not be stopped'
        )
        // The failed interpreter must not block healthy kernels in its own Session, even
        // through the agent's existing Turn and while cleanup proof is still withheld.
        const healthyRepl = await client.callTool({
          name: 'repl_execute',
          arguments: { code: 'console.log(globalThis.recoverySentinel)' }
        })
        expect(healthyRepl.isError).not.toBe(true)
        expect(JSON.stringify(healthyRepl)).toContain('73')
        const healthyShell = await client.callTool({
          name: 'bash_execute',
          arguments: { command: 'printf same-session-healthy' }
        })
        expect(healthyShell.isError).not.toBe(true)
        const healthyRuns = (await service.state(scope('crashed-A'))).runs.slice(-2)
        expect(healthyRuns.map((run) => [run.kernelKind, run.status, run.text.stdout])).toEqual([
          ['repl', 'completed', '73\n'],
          ['bash', 'completed', 'same-session-healthy']
        ])
        expect(retainProof).toBe(true)
        expect(existsSync(retiredRoot)).toBe(true)
        expect(existsSync(`${retiredRoot}.receipt`)).toBe(true)
      }
      retainProof = false
      const restarted = await client.callTool({
        name: 'notebook_restart',
        arguments: {
          language: 'python',
          environment: ' python '
        }
      })
      expect(restarted.isError).not.toBe(true)
      expect(JSON.stringify(restarted)).toContain('restarted')
      // A verified recovery must discharge this turn's prior stop failure, without ending the task.
      await expect(
        rpc.clearArtifactTurnBinding('crashed-A', 'recovery-turn')
      ).resolves.toBeUndefined()
      expect(
        await service.executeControl({
          ...scope('crashed-A'),
          code: 'console.log(globalThis.recoverySentinel)'
        })
      ).toMatchObject({ stdout: '73\n' })
      expect(await service.execute({ ...scope('crashed-A'), code: 'print(123)' })).toMatchObject({
        status: 'completed'
      })
      expect(
        await service.execute({ ...scope('crashed-A'), code: 'after_recovery = 123' })
      ).toMatchObject({ status: 'completed' })
      expect(
        await client.callTool({ name: 'notebook_restart', arguments: { kernel: 'repl' } })
      ).not.toMatchObject({ isError: true })
      expect(
        await service.execute({ ...scope('crashed-A'), code: 'assert after_recovery == 123' })
      ).toMatchObject({ status: 'completed' })
      expect(existsSync(retiredRoot)).toBe(false)
      expect(
        await service.execute({ ...scope('warm-B'), code: 'assert sentinel == 42' })
      ).toMatchObject({ status: 'completed' })
      expect(failedRun.text.stderr).toContain('SIGKILL')
      for (const root of historicalRoots) {
        expect(await readFile(join(root, 'sentinel'), 'utf8')).toBe('historical workload')
        expect(existsSync(`${root}.receipt`)).toBe(true)
      }
    } finally {
      retainProof = false
      await client.close()
      await mcp.close()
      connection.release?.()
      await rpc.close()
      await service.shutdownAll()
      terminate?.mockRestore()
      if (escapedPid) {
        try {
          process.kill(escapedPid, 'SIGKILL')
        } catch {
          /* Already reaped. */
        }
      }
      await owner.dispose()
      await rm(storage, { recursive: true, force: true })
    }
  },
  120_000
)

for (const runtime of ['bash', 'repl', 'python'] as const) {
  it.skipIf(process.platform !== 'darwin' || (runtime === 'python' && !python))(
    `persists one real ${runtime} consumer result while another session retains a live unknown Bash`,
    async () => {
      const fixture = await realpath(await mkdtemp(join(tmpdir(), 'notebook-consumer-isolation-')))
      const workspaceA = join(fixture, 'retained-workspace')
      const storage = join(fixture, 'consumer-storage')
      await mkdir(workspaceA)
      await mkdir(storage)
      const owner = new NotebookNetworkSandboxOwner({
        resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
        temporaryRoot: join(fixture, 'commands'),
        getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        requestDecision: async () => 'deny',
        // The existing conda fixture lives outside this disposable storage root. Authorize its
        // prefix read-only so the actual interpreter can load its standard library.
        getGrantedLocalRoots: async () =>
          runtime === 'python' && python
            ? [
                {
                  id: 'python-fixture',
                  path: await realpath(dirname(dirname(python))),
                  name: 'Python fixture',
                  access: 'ro'
                }
              ]
            : []
      })
      const projectId = 'consumer-isolation'
      const sessionId = `independent-${runtime}`
      const scope = { projectId, sessionId, workspaceCwd: storage }
      const service = new NotebookRuntimeService({
        configRoot: storage,
        dataRoot: storage,
        projectId,
        repository: new NotebookRunRepository(storage),
        processSandbox: owner,
        // Only runtime discovery/settings are injected. The normal executor, shipped loops,
        // process host, OS policy, network gateway and repository perform the actual execution.
        discoverRuntimes: async (language) =>
          language === 'python' && python
            ? [
                {
                  language: 'python',
                  provenance: 'user-own',
                  envId: python,
                  interpreterPath: python,
                  label: 'existing test interpreter',
                  version: 'fixture',
                  runnable: true
                }
              ]
            : [],
        notebookRuntimeSettings: {
          getSnapshot: async (language) => ({
            language,
            runtimeEnablement: { enabled: python ? { [python]: true } : {}, installAuthorized: {} },
            manualInterpreters: [],
            packageMirror: {}
          })
        }
      })
      let wrappedA: NotebookSandboxedSpawn | undefined
      let childA: ChildProcessWithoutNullStreams | undefined
      let aClosed: Promise<unknown[]> | undefined
      let fixtureTerminationProven = false
      const confirmTermination = vi.fn(async () => fixtureTerminationProven)
      try {
        wrappedA = await owner.wrap({
          executable: '/bin/bash',
          args: ['--noprofile', '--norc', '-c', 'printf "ready\\n"; read -r release'],
          env: { PATH: '/usr/bin:/bin', HOME: workspaceA },
          cwd: workspaceA,
          commandText: 'retained builtin-only fixture',
          sessionId: 'retained-A',
          projectId,
          runtime: 'bash',
          filesystem: {
            readOnlyRoots: [],
            readWriteRoots: [workspaceA],
            deniedReadRoots: [],
            deniedWriteRoots: []
          }
        })
        wrappedA.beginExecution?.()
        childA = spawn(wrappedA.executable, [...wrappedA.args], {
          cwd: workspaceA,
          env: wrappedA.env,
          stdio: 'pipe'
        })
        aClosed = once(childA, 'close')
        const [ready] = await once(childA.stdout, 'data')
        expect(ready.toString()).toBe('ready\n')
        const aRoot = wrappedA.env.TMPDIR!
        const retained = await wrappedA.cleanup('cancel', {
          processesTerminated: false,
          confirmTermination
        })
        expect(retained).toMatchObject({ processesTerminated: false, networkClosed: true })
        expect(existsSync(aRoot)).toBe(true)
        expect(existsSync(`${aRoot}.receipt`)).toBe(true)

        if (runtime === 'python') {
          await service.bindRuntime({ ...scope, language: 'python', runtimeId: python! })
        }
        const nonce = `consumer-${randomUUID()}`
        if (runtime === 'bash') {
          const pending = service.executeShell({
            ...scope,
            command: `sleep 0.1; printf '${nonce}\\n'`
          })
          // Retry only A's original proof while B is outstanding; it stays false throughout execution.
          await wrappedA.cleanup('cancel', { processesTerminated: false, confirmTermination })
          const result = await pending
          expect(result, JSON.stringify(result)).toMatchObject({
            exitCode: 0,
            stdout: `${nonce}\n`
          })
        } else if (runtime === 'repl') {
          const result = await service.executeControl({
            ...scope,
            code: `console.log(${JSON.stringify(nonce)});`
          })
          expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' })
        } else {
          const result = await service.execute({
            ...scope,
            code: `print(${JSON.stringify(nonce)})`
          })
          expect(result, JSON.stringify(result)).toMatchObject({ status: 'completed' })
        }
        const retry = await wrappedA.cleanup('cancel', {
          processesTerminated: false,
          confirmTermination
        })
        expect(retry.processesTerminated).toBe(false)
        expect(confirmTermination).toHaveBeenCalled()
        expect(childA.exitCode).toBeNull()
        expect(childA.signalCode).toBeNull()
        expect(existsSync(aRoot)).toBe(true)
        expect(existsSync(`${aRoot}.receipt`)).toBe(true)

        const state = await service.state(scope)
        expect(state.runs).toHaveLength(1)
        expect(state.runs[0]).toMatchObject({ kernelKind: runtime, status: 'completed' })
        expect(state.runs[0].text.stdout).toBe(`${nonce}\n`)
        // A fresh repository reads persisted state rather than the service's live projection/cache.
        const disk = await new NotebookRunRepository(storage).loadOrCreate({
          ...scope,
          lane: createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`)
        })
        expect(disk.runs).toHaveLength(1)
        expect(disk.runs[0]).toMatchObject({
          runId: state.runs[0].runId,
          kernelKind: runtime,
          status: 'completed'
        })
        expect(disk.runs[0].text.stdout).toBe(`${nonce}\n`)
      } finally {
        try {
          await service.shutdownAll()
        } finally {
          // A has no descendants: only bash builtins run. Never signal scanned or user PIDs.
          if (childA && childA.exitCode === null && childA.signalCode === null)
            childA.kill('SIGKILL')
          await aClosed
          fixtureTerminationProven = true
          if (wrappedA) await wrappedA.cleanup('cancel', { processesTerminated: true })
          await owner.dispose()
          await rm(fixture, { recursive: true, force: true })
        }
      }
    },
    60_000
  )
}
