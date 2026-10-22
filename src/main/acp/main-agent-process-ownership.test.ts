import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentProcessSpawner } from '../agent-framework/types'

const f = vi.hoisted(() => ({
  recover: vi.fn(async () => {}),
  admitMainAgentConnection: vi.fn(async (spawn: () => ChildProcessWithoutNullStreams) => spawn()),
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
  f.admitMainAgentConnection.mockImplementation(async (spawn) => spawn())
})

it('recovers before startup and checks admission immediately before each persistent spawn', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  expect(f.recover).toHaveBeenCalledExactlyOnceWith()
  await owner.spawnMainAgentProcess('codex', spawnConnection)
  expect(f.admitMainAgentConnection).toHaveBeenCalledOnce()
  expect(f.spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'main-agents',
      sessionId: 'service',
      frameId: 'main-agent',
      frameworkId: 'codex',
      attemptId: expect.any(String)
    }),
    'fixture-agent',
    ['--stdio'],
    options
  )
})

it('retries current admission evidence after failed startup recovery without caching a global fence', async () => {
  const owner = await import('./main-agent-process-ownership')
  const failure = new Error('unresolved process ownership')
  f.recover.mockRejectedValueOnce(failure)
  await expect(owner.configureMainAgentProcessOwnership(f)).rejects.toBe(failure)
  f.admitMainAgentConnection.mockRejectedValueOnce(failure)
  await expect(owner.spawnMainAgentProcess('claude', spawnConnection)).rejects.toBe(failure)
  expect(f.spawn).not.toHaveBeenCalled()
  await owner.spawnMainAgentProcess('opencode', spawnConnection)
  expect(f.admitMainAgentConnection).toHaveBeenCalledTimes(2)
  expect(f.spawn).toHaveBeenCalledOnce()
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
  'refuses a spawn when %s happens during asynchronous admission',
  async (transition) => {
    const owner = await import('./main-agent-process-ownership')
    await owner.configureMainAgentProcessOwnership(f)
    let admit!: () => ChildProcessWithoutNullStreams
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    f.admitMainAgentConnection.mockImplementationOnce(async (spawn) => {
      admit = spawn
      await blocked
      return admit()
    })
    const pending = owner.spawnMainAgentProcess('opencode', spawnConnection)
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
  expect(f.admitMainAgentConnection).toHaveBeenCalledTimes(2)
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
