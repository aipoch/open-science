import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ApplicationRuntimeInterfaces } from './ipc'

const { installAcpIpcHandlers, installComputeIpcHandlers, order } = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    installAcpIpcHandlers: vi.fn(() => {
      order.push('acp')
    }),
    installComputeIpcHandlers: vi.fn(() => {
      order.push('compute')
    })
  }
})

vi.mock('./acp/ipc', () => ({ installAcpIpcHandlers }))
vi.mock('./compute/ipc', () => ({ installComputeIpcHandlers }))

import { installElectronRuntimeAdapters } from './runtime-electron-wiring'

describe('production Electron runtime wiring', () => {
  it('exports only the named Session deletion capability to application startup', () => {
    expectTypeOf<
      keyof ApplicationRuntimeInterfaces['sessionDeletionCapability']
    >().toEqualTypeOf<'setSessionDeletionHandlers'>()
  })

  it('installs the constructed Compute and ACP modules before remaining surfaces', async () => {
    const compute = { handlers: {}, enabledComputeHostsRegistry: {} } as never
    const runtime = {} as never
    const taskNotifications = {} as never

    await installElectronRuntimeAdapters({
      compute,
      beforeCompute: [
        {
          name: 'notifications',
          install: () => {
            order.push('notifications')
          }
        }
      ],
      beforeAcp: [
        {
          name: 'connectors',
          install: () => {
            order.push('connectors')
          }
        }
      ],
      acp: { runtime, taskNotifications },
      afterAcp: [
        {
          name: 'settings',
          install: () => {
            order.push('settings')
          }
        }
      ]
    })

    expect(installComputeIpcHandlers).toHaveBeenCalledWith(compute)
    expect(installAcpIpcHandlers).toHaveBeenCalledWith(runtime, taskNotifications)
    expect(order).toEqual(['notifications', 'compute', 'connectors', 'acp', 'settings'])
  })
})
