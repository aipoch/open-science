import { afterEach, describe, expect, it, vi } from 'vitest'
import { processBirthIdentity } from '../process-birth-identity'

afterEach(() => vi.unstubAllEnvs())

describe.runIf(process.platform === 'win32')(
  'Windows recovery identity without system PATH',
  () => {
    it('reads the kernel boot identity before admitting an update', async () => {
      vi.stubEnv('PATH', '')
      vi.resetModules()
      const { prefetchSystemBootIdentity, systemBootIdentity } =
        await import('../system-boot-identity')
      const identity = await prefetchSystemBootIdentity()
      expect(identity).toMatch(/^windows-boot:[a-f0-9-]{36}$/)
      expect(systemBootIdentity()).toBe(identity)
    }, 15_000)

    it('reads a live process creation identity without granting ownership to an unknown PID', () => {
      vi.stubEnv('PATH', '')
      expect(processBirthIdentity(process.pid)).toMatch(/^windows-creation-time:\d+$/)
      expect(processBirthIdentity(-1)).toBeUndefined()
    })
  }
)
