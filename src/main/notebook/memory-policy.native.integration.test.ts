import { createRequire } from 'node:module'
import { readlink } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MemoryPolicyService } from './memory-policy'
import { createPlatformMemoryPolicyAdapter } from './memory-policy-platform'

const requireNative = createRequire(import.meta.url)

describe('real Notebook platform memory sampling', () => {
  it.skipIf(!['darwin', 'win32'].includes(process.platform))(
    'reads the current native host signal through the policy service',
    async () => {
      // The local package entry ensures source-candidate native builds are tested rather than
      // an unrelated workspace node_modules symlink or a previously published binary.
      const native = requireNative('../../../packages/process-tree-native')
      const service = new MemoryPolicyService({
        adapter: createPlatformMemoryPolicyAdapter({ native })
      })
      try {
        const observation = await service.getState()
        expect(['healthy', 'pressured']).toContain(observation.status)
        expect(observation.executionScope).toBe(
          process.platform === 'darwin' ? 'darwin:host' : 'windows:host'
        )
        expect(observation.sampleAgeMs).toBeGreaterThanOrEqual(0)
        expect(observation.sampleAgeMs).toBeLessThanOrEqual(2000)
        expect(service.currentState().status).toBe(observation.status)
      } finally {
        service.dispose()
      }
    }
  )

  it.skipIf(process.platform !== 'linux')(
    'authenticates a real initial cgroup namespace or refuses hidden ancestors',
    async () => {
      const initialNamespace = (await readlink('/proc/self/ns/cgroup')) === 'cgroup:[4026531835]'
      const service = new MemoryPolicyService({ adapter: createPlatformMemoryPolicyAdapter() })
      try {
        const observation = await service.getState()
        if (initialNamespace) {
          expect(['healthy', 'pressured']).toContain(observation.status)
          expect(observation.source).toMatch(/^linux-proc/)
        } else {
          expect(observation).toMatchObject({
            status: 'unavailable',
            reason: { code: 'linux-memory-unavailable' }
          })
        }
      } finally {
        service.dispose()
      }
    }
  )
})
