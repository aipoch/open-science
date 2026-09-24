import { describe, expect, it, vi } from 'vitest'
import { diagnoseKernelExit } from './kernel-exit-diagnostics'

describe('kernel exit diagnosis', () => {
  const exit = { pid: 55572, signal: 'SIGKILL', platform: 'darwin' as const }
  it('requires an OS memory kill record for this exact PID, not merely memory pressure', async () => {
    for (const log of [
      'memorystatus: triggering no paging space action',
      'memorystatus: killing largest compressed process python3.12 [155572] 86587 MB',
      'someone printed SIGKILL 55572'
    ]) {
      expect(await diagnoseKernelExit(exit, async () => log)).toBe('unknown')
    }
    expect(
      await diagnoseKernelExit(
        exit,
        async () => 'memorystatus: killing largest compressed process python3.12 [55572] 86587 MB'
      )
    ).toBe('os-memory-pressure')
  })
  it('keeps an honest unknown cause when logs are inaccessible or the signal/platform differs', async () => {
    expect(
      await diagnoseKernelExit(exit, async () => {
        throw new Error('permission denied')
      })
    ).toBe('unknown')
    const read = vi.fn()
    expect(await diagnoseKernelExit({ ...exit, signal: 'SIGTERM' }, read)).toBe('unknown')
    expect(await diagnoseKernelExit({ ...exit, platform: 'linux' }, read)).toBe('unknown')
    expect(read).not.toHaveBeenCalled()
  })
})
