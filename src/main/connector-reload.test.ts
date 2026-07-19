import { describe, expect, it, vi } from 'vitest'

import { wireConnectorReload } from './connector-reload'

// Exercises the REAL wiring used by ipc.ts's onConnectorsChanged (not a reimplementation): the skills
// reload must run on BOTH settle paths, so if the source ever regressed `.finally` to `.then` these
// tests would fail.
describe('wireConnectorReload', () => {
  it('reloads skills after a successful connector doc re-sync', async () => {
    const reload = vi.fn()
    const refresh = vi.fn().mockResolvedValue(undefined)

    await wireConnectorReload(refresh, reload)

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('still reloads skills when the connector doc re-sync rejects', async () => {
    const reload = vi.fn()
    const refresh = vi.fn().mockRejectedValue(new Error('sync failed'))

    // The composed promise rejects (the caller `void`s it), but the reload in .finally must have run —
    // the behavior a `.then` chain would drop, which is why the source uses `.finally`.
    await expect(wireConnectorReload(refresh, reload)).rejects.toThrow('sync failed')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
