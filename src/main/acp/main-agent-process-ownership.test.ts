import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DelegatedProcessOwnership } from '../delegation/process-ownership'
import { terminateProcessTree } from '../process-tree'
import type { AgentProcessSpawner } from '../agent-framework/types'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})

const f = vi.hoisted(() => ({
  recover: vi.fn(async () => {}),
  assertMainAgentSessionResumeAllowed: vi.fn<(frameworkId: string) => Promise<void>>(
    async () => {}
  ),
  spawn: vi.fn<
    (
      scope: { attemptId: string },
      ...args: Parameters<AgentProcessSpawner>
    ) => ChildProcessWithoutNullStreams
  >(() => ({}) as ChildProcessWithoutNullStreams)
}))
const options = { env: { FIXTURE: '1' }, stdio: 'pipe' as const }
const spawnConnection = (spawn: AgentProcessSpawner | undefined): ChildProcessWithoutNullStreams =>
  spawn!('fixture-agent', ['--stdio'], options)
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  f.recover.mockResolvedValue(undefined)
  f.assertMainAgentSessionResumeAllowed.mockResolvedValue(undefined)
})

it('recovers before startup and isolates each new connection from historical receipt directories', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  expect(f.recover).toHaveBeenCalledExactlyOnceWith()
  await owner.spawnMainAgentProcess('codex', spawnConnection)
  expect(f.assertMainAgentSessionResumeAllowed).not.toHaveBeenCalled()
  expect(f.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'main-agents',
      sessionId: expect.any(String),
      frameId: 'main-agent',
      frameworkId: 'codex',
      attemptId: expect.any(String)
    }),
    'fixture-agent',
    ['--stdio'],
    options
  )
})

it('does not turn failed startup recovery into a connection fence, but retries old-context recovery', async () => {
  const owner = await import('./main-agent-process-ownership')
  const failure = new Error('unresolved process ownership')
  f.recover.mockRejectedValueOnce(failure)
  await expect(owner.configureMainAgentProcessOwnership(f)).rejects.toBe(failure)
  for (const framework of ['claude', 'codex', 'opencode', 'codebuddy'])
    await owner.spawnMainAgentProcess(framework, spawnConnection)
  expect(f.spawn).toHaveBeenCalledTimes(4)
  f.assertMainAgentSessionResumeAllowed.mockRejectedValueOnce(failure)
  await expect(owner.assertMainAgentSessionResumeAllowed('opencode')).rejects.toThrow(
    'Previous agent cleanup is unconfirmed.'
  )
  await owner.assertMainAgentSessionResumeAllowed('opencode')
  expect(f.assertMainAgentSessionResumeAllowed).toHaveBeenCalledTimes(2)
})

it('closes once and refuses new and already captured spawners', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  let captured!: AgentProcessSpawner
  await owner.spawnMainAgentProcess('opencode', (spawn) => {
    captured = spawn!
    return spawnConnection(spawn)
  })
  f.spawn.mockClear()
  const a = owner.closeMainAgentProcessOwnership()
  const b = owner.closeMainAgentProcessOwnership()
  expect(a).toBe(b)
  await a
  expect(f.recover).toHaveBeenCalledTimes(2)
  expect(f.recover).toHaveBeenLastCalledWith({}, true)
  await expect(owner.spawnMainAgentProcess('codebuddy', spawnConnection)).rejects.toThrow('closed')
  expect(() => captured('fixture-agent', [], { stdio: 'pipe' })).toThrow('closed')
  expect(f.spawn).not.toHaveBeenCalled()
})

it.each(['shutdown', 'replacement', 'reconfigure'] as const)(
  'rejects old-context recovery when %s happens during its asynchronous check',
  async (transition) => {
    const owner = await import('./main-agent-process-ownership')
    await owner.configureMainAgentProcessOwnership(f)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    f.assertMainAgentSessionResumeAllowed.mockImplementationOnce(async () => {
      await blocked
    })
    const pending = owner.assertMainAgentSessionResumeAllowed('opencode')
    if (transition === 'shutdown') await owner.closeMainAgentProcessOwnership()
    else await owner.configureMainAgentProcessOwnership(transition === 'replacement' ? { ...f } : f)
    release()
    await expect(pending).rejects.toThrow('closed')
    expect(f.spawn).not.toHaveBeenCalled()
  }
)

it('checks concurrent connections independently and gives each its own process receipt attempt', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  await Promise.all([
    owner.spawnMainAgentProcess('opencode', spawnConnection),
    owner.spawnMainAgentProcess('codex', spawnConnection)
  ])
  expect(f.assertMainAgentSessionResumeAllowed).not.toHaveBeenCalled()
  expect(new Set(f.spawn.mock.calls.map(([scope]) => scope.attemptId)).size).toBe(2)
})

it('does not let a captured spawner outlive its synchronous admission callback', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  let captured!: AgentProcessSpawner
  await owner.spawnMainAgentProcess('opencode', (spawn) => {
    captured = spawn!
    return {} as ChildProcessWithoutNullStreams
  })
  expect(() => captured('fixture-agent', [], { stdio: 'pipe' })).toThrow('expired')
  expect(f.spawn).not.toHaveBeenCalled()
})

it('preserves shutdown failure instead of treating unresolved trees as clean', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  const failure = new Error('known process tree could not be reaped')
  f.recover.mockRejectedValueOnce(failure)
  await expect(owner.closeMainAgentProcessOwnership()).rejects.toBe(failure)
  await expect(owner.closeMainAgentProcessOwnership()).rejects.toBe(failure)
  expect(f.recover).toHaveBeenCalledTimes(2)
})

describe.skipIf(!['linux', 'darwin', 'win32'].includes(process.platform))(
  'real connection recovery isolation',
  () => {
    let root: string | undefined
    const children: ChildProcessWithoutNullStreams[] = []
    afterEach(async () => {
      await Promise.all(children.splice(0).map((child) => terminateProcessTree(child)))
      vi.restoreAllMocks()
      if (root) {
        await chmod(
          join(root, 'main-agent-process-ownership', 'main-agents', 'service'),
          0o700
        ).catch(() => {})
        await rm(root, { recursive: true, force: true })
      }
      root = undefined
    })

    it.each([
      { major: 1 as const, startupFailure: false },
      { major: 2 as const, startupFailure: false },
      { major: 2 as const, startupFailure: true },
      { major: 2 as const, startupFailure: false, acpSpawnFailure: true },
      { major: 2 as const, startupFailure: false, receiptFailure: 'companion' },
      { major: 2 as const, startupFailure: false, receiptFailure: 'acp' }
    ])(
      'releases a retained OpenCode $major store after main recovery (startup failure: $startupFailure, ACP spawn failure: $acpSpawnFailure, receipt failure: $receiptFailure)',
      async ({ major, startupFailure, acpSpawnFailure, receiptFailure }) => {
        root = await mkdtemp(join(tmpdir(), 'main-opencode-store-recovery-'))
        const tree = await import('../process-tree')
        const { DelegatedProcessOwnership: Ownership } =
          await import('../delegation/process-ownership')
        const ownership = new Ownership(root, 'main-agent-process-ownership')
        const main = await import('./main-agent-process-ownership')
        const framework = await import('../agent-framework/opencode')
        const { AcpAgentConnectionAdapter } = await import('./agent-connection-adapter')
        const { AcpBackendGenerationOwner } = await import('./backend-generation-owner')
        const { AcpConnectionResourceOwner } = await import('./connection-resource-owner')
        const { acquireOpenCodeStore } = await import('./opencode-store')
        const { acquireRuntimeDirectorySync } = await import('../runtime-ownership')
        const realTerminate = tree.terminateProcessTree
        const realRegister = tree.registerProcessTreeOwnership
        const settlements = new Map<
          Parameters<typeof tree.registerProcessTreeOwnership>[0],
          Parameters<typeof tree.registerProcessTreeOwnership>[1]
        >()
        vi.spyOn(tree, 'registerProcessTreeOwnership').mockImplementation((child, record) => {
          settlements.set(child, record)
          children.push(child as ChildProcessWithoutNullStreams)
          realRegister(child, record)
        })
        let failCleanup = true
        let retainCompanion = false
        vi.spyOn(tree, 'terminateProcessTree').mockImplementation(async (child, ...args) => {
          if (failCleanup || (retainCompanion && child === children[0])) {
            const result = { reaped: false }
            settlements.get(child)?.settled(result)
            return result
          }
          return realTerminate(child, ...args)
        })
        vi.spyOn(framework, 'spawnOpenCodeProcess').mockImplementation((input) => {
          const child = input.spawnProcess!(
            process.execPath,
            [
              '-e',
              `process.stdout.write(JSON.stringify({url:"http://${startupFailure ? 'invalid' : '127.0.0.1'}:42876"})+"\\n");process.stdin.resume();setInterval(()=>{},1000)`
            ],
            { stdio: 'pipe' }
          ) as ChildProcessWithoutNullStreams
          return child
        })
        if (receiptFailure) {
          const fs = await import('node:fs')
          const { renameSync: rename } = await vi.importActual<typeof import('node:fs')>('node:fs')
          let injected = false
          vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
            if (
              !injected &&
              children.length === (receiptFailure === 'companion' ? 1 : 2) &&
              String(target).includes('main-agent-process-ownership') &&
              JSON.parse(fs.readFileSync(source, 'utf8')).phase === 'owned'
            ) {
              injected = true
              throw new Error('Ownership publication fixture failure')
            }
            rename(source, target)
          })
        }
        const selectedFramework = acpSpawnFailure
          ? {
              ...framework.opencodeFramework,
              spawn: () => {
                throw new Error('ACP spawn rejected')
              }
            }
          : framework.opencodeFramework
        const backend = {
          framework: selectedFramework,
          executablePath: process.execPath,
          env: { XDG_DATA_HOME: root },
          opencodeMajorVersion: major
        }
        const backendOwner = new AcpBackendGenerationOwner(framework.opencodeFramework)
        const connectionOwner = new AcpConnectionResourceOwner()
        const hooks = {
          createElicitation: vi.fn(async () => ({ action: 'decline' as const })),
          requestPermission: vi.fn(async () => ({ outcome: { outcome: 'cancelled' as const } })),
          observeSessionUpdate: vi.fn(),
          observeClaudeSdkMessage: vi.fn(),
          filesystem: { resolveSessionCwd: () => root!, protectedReadRoots: () => [] },
          onBackendResolved: vi.fn(),
          onProcessSpawned: vi.fn(),
          onBackendPublished: vi.fn(),
          onProcessTreeReaped: vi.fn(),
          markProcessExitExpected: vi.fn(),
          onProcessStderr: vi.fn(),
          onProcessError: vi.fn(),
          onProcessExit: vi.fn(),
          onConnectionClosed: vi.fn(),
          reportCleanupFailure: vi.fn(),
          reportProcessTreeError: vi.fn()
        }
        await main.configureMainAgentProcessOwnership(ownership)
        try {
          const pending = connectionOwner.connect(async (attempt) => {
            const candidate = await new AcpAgentConnectionAdapter().open(
              {
                epoch: attempt.epoch,
                resolveBackend: async () => backend,
                prepareBackend: (resolved) => backendOwner.prepare(attempt, resolved),
                isCurrent: () => true,
                isShuttingDown: () => false
              },
              hooks
            )
            candidate.transferTo(attempt)
            return attempt.publish({ close: false, delete: false, resume: false, steering: false })
          })
          if (receiptFailure)
            await expect(pending).rejects.toThrow(
              receiptFailure === 'companion'
                ? 'spawn is unconfirmed'
                : 'Ownership publication fixture failure'
            )
          else if (acpSpawnFailure) await expect(pending).rejects.toThrow('ACP spawn rejected')
          else if (startupFailure) await expect(pending).rejects.toThrow('could not be stopped')
          else {
            await pending
            await connectionOwner.teardown(connectionOwner.epoch)
          }
          expect(ownership.receipts().length).toBeGreaterThan(0)
          expect(() => acquireRuntimeDirectorySync(join(root!, 'opencode'))).toThrow(
            'already using'
          )
          // Same-major reconnect is allowed; the defect is the retained lease after proven recovery.
          const sameMajor = await acquireOpenCodeStore(root!, major)
          sameMajor.release()
          failCleanup = false
          if (
            major === 2 &&
            !startupFailure &&
            !acpSpawnFailure &&
            receiptFailure !== 'companion'
          ) {
            retainCompanion = true
            await expect(main.assertMainAgentSessionResumeAllowed('opencode')).rejects.toThrow(
              'Previous agent cleanup is unconfirmed'
            )
            expect(() => acquireRuntimeDirectorySync(join(root!, 'opencode'))).toThrow(
              'already using'
            )
            retainCompanion = false
          }
          await main.assertMainAgentSessionResumeAllowed('opencode')
          expect(ownership.receipts()).toEqual([])
          if (major === 1) {
            const upgraded = await acquireOpenCodeStore(root!, 2)
            upgraded.release()
          }
          const available = acquireRuntimeDirectorySync(join(root!, 'opencode'))
          available.release()
        } finally {
          failCleanup = false
          retainCompanion = false
          await connectionOwner.teardown(connectionOwner.epoch)
          await main.closeMainAgentProcessOwnership()
        }
      }
    )

    it.each([1, 2] as const)(
      'keeps the OpenCode %s store locked when native spawn throws without a child handle',
      async (major) => {
        root = await mkdtemp(join(tmpdir(), 'main-opencode-unknown-spawn-'))
        const main = await import('./main-agent-process-ownership')
        const { opencodeFramework } = await import('../agent-framework/opencode')
        const { AcpAgentConnectionAdapter } = await import('./agent-connection-adapter')
        const { AcpBackendGenerationOwner } = await import('./backend-generation-owner')
        const { acquireRuntimeDirectorySync } = await import('../runtime-ownership')
        const backendOwner = new AcpBackendGenerationOwner(opencodeFramework)
        const identity = { epoch: 1, assertCurrent: vi.fn() }
        const failure = new Error('Native spawn did not return a process handle')
        f.spawn.mockImplementationOnce(() => {
          throw failure
        })
        await main.configureMainAgentProcessOwnership(f)
        let releaseStore: (() => void) | undefined
        try {
          await expect(
            new AcpAgentConnectionAdapter().open(
              {
                epoch: 1,
                resolveBackend: async () => ({
                  framework: opencodeFramework,
                  executablePath: process.execPath,
                  env: { XDG_DATA_HOME: root! },
                  opencodeMajorVersion: major
                }),
                prepareBackend: (backend) => backendOwner.prepare(identity, backend),
                isCurrent: () => true,
                isShuttingDown: () => false,
                registerOpenCodeStoreRelease: (release) => {
                  releaseStore = release
                }
              },
              {
                createElicitation: vi.fn(),
                requestPermission: vi.fn(),
                observeSessionUpdate: vi.fn(),
                observeClaudeSdkMessage: vi.fn(),
                filesystem: { resolveSessionCwd: () => root!, protectedReadRoots: () => [] },
                onBackendResolved: vi.fn(),
                onProcessSpawned: vi.fn(),
                onBackendPublished: vi.fn(),
                onProcessTreeReaped: vi.fn(),
                markProcessExitExpected: vi.fn(),
                onProcessStderr: vi.fn(),
                onProcessError: vi.fn(),
                onProcessExit: vi.fn(),
                onConnectionClosed: vi.fn(),
                reportCleanupFailure: vi.fn(),
                reportProcessTreeError: vi.fn()
              }
            )
          ).rejects.toThrow(/Native spawn did not return|spawn is unconfirmed/)
          expect(f.spawn).toHaveBeenCalledOnce()
          expect(() => acquireRuntimeDirectorySync(join(root!, 'opencode'))).toThrow(
            'already using'
          )
        } finally {
          // This fixture throws before creating a process; production cannot assume that proof.
          releaseStore?.()
          await main.closeMainAgentProcessOwnership()
        }
      }
    )

    it.each(['recover', 'closed'] as const)(
      'includes the OpenCode companion in service ownership: %s',
      async (scenario) => {
        root = await mkdtemp(join(tmpdir(), 'opencode-companion-ownership-'))
        const ownership = new DelegatedProcessOwnership(root, 'main-agent-process-ownership')
        const owner = await import('./main-agent-process-ownership')
        const framework = await import('../agent-framework/opencode')
        // A real process with the public readiness message, deliberately ignoring stdin EOF.
        // Ownership recovery must reap it even when cooperative lifetime cleanup is unavailable.
        vi.spyOn(framework, 'spawnOpenCodeProcess').mockImplementation((input) => {
          const child = (input.spawnProcess ?? spawn)(
            process.execPath,
            [
              '-e',
              'process.stdout.write(JSON.stringify({url:"http://127.0.0.1:42876"})+"\\n");process.stdin.resume();setInterval(()=>{},1000)'
            ],
            { stdio: 'pipe' }
          ) as ChildProcessWithoutNullStreams
          children.push(child)
          return child
        })
        await owner.configureMainAgentProcessOwnership(ownership)
        const { startOpenCodeService } = await import('./opencode-service')
        if (scenario === 'closed') await owner.closeMainAgentProcessOwnership()
        let service: Awaited<ReturnType<typeof startOpenCodeService>> | undefined
        try {
          const pending = startOpenCodeService(
            { framework: framework.opencodeFramework, executablePath: process.execPath, env: {} },
            vi.fn()
          ).then((value) => (service = value))
          if (scenario === 'closed') {
            await expect(pending).rejects.toThrow('Main agent process ownership is closed.')
            expect(children).toHaveLength(0)
          } else {
            await pending
            expect(children).toHaveLength(1)
            await owner.closeMainAgentProcessOwnership()
            await expect
              .poll(() => children[0].exitCode !== null || children[0].signalCode !== null)
              .toBe(true)
          }
        } finally {
          await service?.release()
        }
      }
    )

    it.each(
      (['identity-less', 'truncated', 'pending', 'unreadable-directory'] as const).filter(
        // Windows chmod does not model a POSIX directory search-permission failure.
        (kind) => process.platform !== 'win32' || kind !== 'unreadable-directory'
      )
    )(
      'starts and stops fresh connections despite a historical %s receipt, preserving the evidence',
      async (kind) => {
        root = await mkdtemp(join(tmpdir(), 'main-agent-isolation-'))
        const directory = join(root, 'main-agent-process-ownership', 'main-agents', 'service')
        await mkdir(directory, { recursive: true })
        const receiptId = '00000000-0000-4000-8000-000000000001'
        const historicalPath = join(
          directory,
          receiptId + (kind === 'pending' ? '.json.pending' : '.json')
        )
        const bytes =
          kind === 'truncated'
            ? '{'
            : JSON.stringify({
                version: 1,
                receiptId,
                projectId: 'main-agents',
                sessionId: 'service',
                frameId: 'main-agent',
                attemptId: 'old-attempt',
                frameworkId: 'opencode',
                phase: 'starting',
                createdAt: Date.now(),
                ownership: { platform: process.platform }
              })
        await writeFile(historicalPath, bytes)
        if (kind === 'unreadable-directory') await chmod(directory, 0)
        const ownership = new DelegatedProcessOwnership(root, 'main-agent-process-ownership')
        const owner = await import('./main-agent-process-ownership')
        await expect(owner.configureMainAgentProcessOwnership(ownership)).rejects.toThrow()
        for (const framework of ['claude', 'codex', 'opencode', 'codebuddy']) {
          const child = await owner.spawnMainAgentProcess(framework, (spawn) =>
            spawn!(
              process.execPath,
              ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
              { stdio: 'pipe' }
            )
          )
          children.push(child)
          // The native Windows wrapper can publish spawn before the async call returns.
          const [output] = await once(child.stdout, 'data')
          expect(output.toString()).toBe('ready')
          expect(child.pid).toBeGreaterThan(0)
        }
        const scopes = []
        // Read only the new attempts: historical malformed bytes cannot poison their ownership.
        const { readdir } = await import('node:fs/promises')
        for (const sessionId of await readdir(
          join(root, 'main-agent-process-ownership', 'main-agents')
        )) {
          if (sessionId === 'service') continue
          scopes.push({ projectId: 'main-agents', sessionId })
          expect(ownership.receipts({ projectId: 'main-agents', sessionId })).toHaveLength(1)
        }
        expect(scopes).toHaveLength(4)
        // Strict shutdown still reports the old debt, but must reap all discoverable new trees.
        await expect(owner.closeMainAgentProcessOwnership()).rejects.toThrow()
        for (const scope of scopes) expect(ownership.receipts(scope)).toHaveLength(0)
        if (kind === 'unreadable-directory') await chmod(directory, 0o700)
        expect(await readFile(historicalPath, 'utf8')).toBe(bytes)
        await expect(ownership.recover()).rejects.toThrow()
      }
    )
  }
)
