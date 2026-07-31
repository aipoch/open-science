import { describe, expect, it, vi } from 'vitest'

import { isPermissionGrantScopeLive } from './scope-liveness'

const createDependencies = (overrides?: {
  projectExists?: boolean
  persistedSessionExists?: boolean
  liveSessionExists?: boolean
}): {
  projectExists: ReturnType<typeof vi.fn<(projectId: string) => Promise<boolean>>>
  persistedSessionExists: ReturnType<
    typeof vi.fn<(projectId: string, sessionId: string) => Promise<boolean>>
  >
  liveSessionExists: ReturnType<typeof vi.fn<(projectId: string, sessionId: string) => boolean>>
} => ({
  projectExists: vi
    .fn<(projectId: string) => Promise<boolean>>()
    .mockResolvedValue(overrides?.projectExists ?? true),
  persistedSessionExists: vi
    .fn<(projectId: string, sessionId: string) => Promise<boolean>>()
    .mockResolvedValue(overrides?.persistedSessionExists ?? false),
  liveSessionExists: vi
    .fn<(projectId: string, sessionId: string) => boolean>()
    .mockReturnValue(overrides?.liveSessionExists ?? false)
})

describe('isPermissionGrantScopeLive', () => {
  it('accepts global and existing project scopes without a session lookup', async () => {
    const dependencies = createDependencies()

    await expect(isPermissionGrantScopeLive({ kind: 'global' }, dependencies)).resolves.toBe(true)
    await expect(
      isPermissionGrantScopeLive({ kind: 'project', projectId: 'project-1' }, dependencies)
    ).resolves.toBe(true)

    expect(dependencies.persistedSessionExists).not.toHaveBeenCalled()
    expect(dependencies.liveSessionExists).not.toHaveBeenCalled()
  })

  it('rejects every non-global scope whose project no longer exists', async () => {
    const dependencies = createDependencies({ projectExists: false, liveSessionExists: true })

    await expect(
      isPermissionGrantScopeLive(
        { kind: 'session', projectId: 'missing-project', sessionId: 'session-1' },
        dependencies
      )
    ).resolves.toBe(false)

    expect(dependencies.persistedSessionExists).not.toHaveBeenCalled()
    expect(dependencies.liveSessionExists).not.toHaveBeenCalled()
  })

  it('accepts a session that is already durable', async () => {
    const dependencies = createDependencies({ persistedSessionExists: true })

    await expect(
      isPermissionGrantScopeLive(
        { kind: 'session', projectId: 'project-1', sessionId: 'session-1' },
        dependencies
      )
    ).resolves.toBe(true)

    expect(dependencies.liveSessionExists).not.toHaveBeenCalled()
  })

  it('accepts an active ACP session while its first durable save is pending', async () => {
    const dependencies = createDependencies({ liveSessionExists: true })

    await expect(
      isPermissionGrantScopeLive(
        { kind: 'session', projectId: 'project-1', sessionId: 'session-1' },
        dependencies
      )
    ).resolves.toBe(true)

    expect(dependencies.liveSessionExists).toHaveBeenCalledWith('project-1', 'session-1')
  })
})
