import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { beforeEach, expect, it, vi } from 'vitest'
import { createTrackedAgentSpawner, spawnWithPosixOwnership } from './owned-process-spawn'
import { createCodexFramework } from './agent-framework/codex'
import { createCodeBuddyFramework } from './agent-framework/codebuddy'
import { createOpencodeFramework } from './agent-framework/opencode'
import { spawnClaudeAgentAcp } from './acp/agent-process'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  track: vi.fn(),
  spawn: vi.fn(),
  terminate: vi.fn()
}))
vi.mock('./process-tree', async (importActual) => ({
  ...(await importActual<typeof import('./process-tree')>()),
  createPosixProcessTreeOwnership: mocks.create,
  trackOwnedPosixProcessTree: mocks.track,
  terminateProcessTree: mocks.terminate
}))
vi.mock('node:child_process', async (importActual) => ({
  ...(await importActual<typeof import('node:child_process')>()),
  spawn: mocks.spawn
}))
const child = new EventEmitter() as ChildProcessWithoutNullStreams
beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockImplementation((env, platform) =>
    platform === 'win32'
      ? { env, token: undefined }
      : { env: { ...env, OPEN_SCIENCE_PROCESS_TREE_ID: 'new-owner' }, token: 'new-owner' }
  )
  mocks.spawn.mockReturnValue(child)
  mocks.terminate.mockResolvedValue({ reaped: true })
})

it('creates the marker before spawn and registers the returned child synchronously', () => {
  const events: string[] = []
  mocks.create.mockImplementation((env) => {
    events.push('marker')
    return { env: { ...env, OPEN_SCIENCE_PROCESS_TREE_ID: 'receipt' }, token: 'receipt' }
  })
  mocks.track.mockImplementation(() => events.push('track'))
  const launched = spawnWithPosixOwnership(
    { APP: 'value' },
    (options) => {
      events.push('spawn')
      expect(options).toEqual({
        env: { APP: 'value', OPEN_SCIENCE_PROCESS_TREE_ID: 'receipt' },
        detached: true
      })
      return child
    },
    'darwin'
  )
  expect(launched).toBe(child)
  expect(events).toEqual(['marker', 'spawn', 'track'])
  expect(mocks.track).toHaveBeenCalledWith(child, 'receipt')
})

it('does not register a nonexistent child when admission or spawn fails', () => {
  mocks.create.mockImplementationOnce(() => {
    throw new Error('unavailable')
  })
  expect(() => spawnWithPosixOwnership({}, mocks.spawn, 'darwin')).toThrow('unavailable')
  expect(mocks.spawn).not.toHaveBeenCalled()
  mocks.spawn.mockImplementationOnce(() => {
    throw new Error('spawn failed')
  })
  expect(() => spawnWithPosixOwnership({}, mocks.spawn, 'linux')).toThrow('spawn failed')
  expect(mocks.track).not.toHaveBeenCalled()
})

it('keeps Windows spawning without a POSIX marker, detached group, or tracker', () => {
  const spawner = createTrackedAgentSpawner(mocks.spawn, 'win32')
  expect(spawner('agent.exe', [], { env: { APP: 'value' }, stdio: 'pipe' })).toBe(child)
  expect(mocks.spawn).toHaveBeenCalledWith('agent.exe', [], {
    env: { APP: 'value' },
    stdio: 'pipe',
    detached: false
  })
  expect(mocks.track).not.toHaveBeenCalled()
})

it.each([
  ['Codex', createCodexFramework],
  ['CodeBuddy', createCodeBuddyFramework],
  ['OpenCode', createOpencodeFramework]
] as const)(
  '%s owns normal spawning and leaves delegated ownership to its injected owner',
  (_, create) => {
    const framework = create({ platform: 'linux', sourceEnv: {}, spawnProcess: mocks.spawn })
    const input = { executablePath: '/agent', env: { APP: 'value' }, args: [] }
    expect(framework.spawn(input)).toBe(child)
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.track).toHaveBeenCalledWith(child, 'new-owner')
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({
      env: { OPEN_SCIENCE_PROCESS_TREE_ID: 'new-owner' },
      detached: true
    })
    mocks.create.mockClear()
    mocks.track.mockClear()
    const delegated = vi.fn().mockReturnValue(child)
    expect(
      framework.spawn({
        ...input,
        env: { OPEN_SCIENCE_PROCESS_TREE_ID: 'delegated-receipt' },
        spawnProcess: delegated
      })
    ).toBe(child)
    expect(delegated.mock.calls[0][2].env.OPEN_SCIENCE_PROCESS_TREE_ID).toBe('delegated-receipt')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
  }
)

it('Claude ACP registers normal spawning and does not replace a delegated receipt', () => {
  const input = { executablePath: '/claude', envOverrides: { CLAUDE_CONFIG_DIR: '/owned' } }
  spawnClaudeAgentAcp(input)
  expect(mocks.create).toHaveBeenCalledOnce()
  if (process.platform !== 'win32') expect(mocks.track).toHaveBeenCalledWith(child, 'new-owner')
  mocks.create.mockClear()
  mocks.track.mockClear()
  const delegated = vi.fn().mockReturnValue(child)
  spawnClaudeAgentAcp({
    ...input,
    envOverrides: { ...input.envOverrides, OPEN_SCIENCE_PROCESS_TREE_ID: 'delegated-receipt' },
    spawnProcess: delegated
  })
  expect(delegated.mock.calls[0][2].env.OPEN_SCIENCE_PROCESS_TREE_ID).toBe('delegated-receipt')
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.track).not.toHaveBeenCalled()
})
