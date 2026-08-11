import { describe, expect, it, vi } from 'vitest'

import type { ResolvedAgentBackend } from './types'
import { releaseResolvedAgentBackendLeases } from './resolved-agent-backend-leases'

describe('resolved agent backend lease owner', () => {
  it('settles every lease and releases each at most once', async () => {
    const responsesRelease = vi.fn(async () => {
      throw new Error('already closed')
    })
    const anthropicRelease = vi.fn(async () => undefined)
    const transportRelease = vi.fn(() => {
      throw new Error('synchronous close failure')
    })
    const backend = {
      responsesBridgeLease: { release: responsesRelease },
      anthropicBridgeLease: { release: anthropicRelease },
      providerTransportLease: { release: transportRelease }
    } as unknown as ResolvedAgentBackend

    const first = releaseResolvedAgentBackendLeases(backend)
    const second = releaseResolvedAgentBackendLeases(backend)

    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect(responsesRelease).toHaveBeenCalledOnce()
    expect(anthropicRelease).toHaveBeenCalledOnce()
    expect(transportRelease).toHaveBeenCalledOnce()
    await releaseResolvedAgentBackendLeases(backend)
    expect(responsesRelease).toHaveBeenCalledOnce()
  })

  it('releases an aliased lease only once', async () => {
    const release = vi.fn(async () => undefined)
    const aliasedLease = { release }
    const backend = {
      responsesBridgeLease: aliasedLease,
      anthropicBridgeLease: aliasedLease,
      providerTransportLease: aliasedLease
    } as unknown as ResolvedAgentBackend

    await releaseResolvedAgentBackendLeases(backend)

    expect(release).toHaveBeenCalledOnce()
  })
})
