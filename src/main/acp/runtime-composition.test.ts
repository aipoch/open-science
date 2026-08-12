// Pins the production Agent Context resolver: createAcpRuntime is Electron-coupled, so the lookup
// policy (trim, blank/missing ⇒ undefined, failure ⇒ undefined instead of throwing) is extracted as
// createProjectAgentContextResolver and covered here against a fake repository.

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { createProjectAgentContextResolver } = await import('./runtime-composition')

describe('createProjectAgentContextResolver', () => {
  it('returns the trimmed Agent Context for a known project', async () => {
    const get = vi.fn(async () => ({ agentContext: '  Always cite DOIs.\n' }))
    const resolver = createProjectAgentContextResolver({ get })

    await expect(resolver('project-1')).resolves.toBe('Always cite DOIs.')
    expect(get).toHaveBeenCalledWith('project-1')
  })

  it('returns undefined when the project is missing or its Agent Context is blank', async () => {
    const missing = createProjectAgentContextResolver({ get: vi.fn(async () => null) })
    const blank = createProjectAgentContextResolver({
      get: vi.fn(async () => ({ agentContext: '   ' }))
    })
    const absent = createProjectAgentContextResolver({ get: vi.fn(async () => ({})) })

    await expect(missing('unknown-id')).resolves.toBeUndefined()
    await expect(blank('project-1')).resolves.toBeUndefined()
    await expect(absent('project-1')).resolves.toBeUndefined()
  })

  it('returns undefined instead of throwing when the lookup fails', async () => {
    const resolver = createProjectAgentContextResolver({
      get: vi.fn(async () => {
        throw new Error('database is locked')
      })
    })

    await expect(resolver('project-1')).resolves.toBeUndefined()
  })
})
