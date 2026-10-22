import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { DelegatedProcessOwnership } from '../delegation/process-ownership'
import { terminateProcessTree } from '../process-tree'
import type { AgentProcessSpawner } from '../agent-framework/types'

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
      if (root) {
        await chmod(
          join(root, 'main-agent-process-ownership', 'main-agents', 'service'),
          0o700
        ).catch(() => {})
        await rm(root, { recursive: true, force: true })
      }
      root = undefined
    })

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
