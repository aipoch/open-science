import { beforeEach, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ recover: vi.fn(async () => {}), spawn: vi.fn() }))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  f.recover.mockResolvedValue(undefined)
})

it('recovers only the main-agent receipt directory before admitting a persistent spawner', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  expect(f.recover).toHaveBeenCalledExactlyOnceWith()
  const spawn = owner.mainAgentProcessSpawner('codex')!
  const options = { env: { FIXTURE: '1' }, stdio: 'pipe' as const }
  spawn('fixture-agent', ['--stdio'], options)
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

it('retains failed cold-recovery evidence and refuses new main-agent work', async () => {
  const owner = await import('./main-agent-process-ownership')
  const failure = new Error('unresolved process ownership')
  f.recover.mockRejectedValueOnce(failure)
  await expect(owner.configureMainAgentProcessOwnership(f)).rejects.toBe(failure)
  expect(() => owner.mainAgentProcessSpawner('claude')).toThrow(failure)
  expect(f.spawn).not.toHaveBeenCalled()
})

it('closes once and refuses both newly requested and already captured spawners', async () => {
  const owner = await import('./main-agent-process-ownership')
  await owner.configureMainAgentProcessOwnership(f)
  const spawn = owner.mainAgentProcessSpawner('opencode')!
  const a = owner.closeMainAgentProcessOwnership()
  const b = owner.closeMainAgentProcessOwnership()
  expect(a).toBe(b)
  await a
  expect(f.recover).toHaveBeenCalledTimes(2)
  expect(f.recover).toHaveBeenLastCalledWith({}, true)
  expect(() => owner.mainAgentProcessSpawner('codebuddy')).toThrow('closed')
  expect(() => spawn('fixture-agent', [], { stdio: 'pipe' })).toThrow('closed')
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
