import { describe, expect, it, vi } from 'vitest'

import { opencodeFramework, type ResolvedAgentBackend } from '../agent-framework'
import { createDelegateExecutionBackendLease } from './execution-backend-lease'

describe('delegated execution backend lease', () => {
  it('keeps one secret backend owner across batch claims and releases it exactly once', async () => {
    const release = vi.fn(async () => undefined)
    const backend: ResolvedAgentBackend = {
      framework: opencodeFramework,
      executablePath: '/fake-opencode',
      env: { OPENAI_API_KEY: 'process-memory-only' },
      providerTransportLease: { setTarget: () => true, release }
    }
    const admission = createDelegateExecutionBackendLease(backend)
    const first = admission.claim()
    const second = admission.claim()

    expect(first.backend.env.OPENAI_API_KEY).toBe('process-memory-only')
    expect(first.backend.providerTransportLease).toBeUndefined()
    await admission.release()
    await admission.release()
    await first.release()
    expect(release).not.toHaveBeenCalled()
    await second.release()
    await second.release()
    expect(release).toHaveBeenCalledOnce()
  })
})
