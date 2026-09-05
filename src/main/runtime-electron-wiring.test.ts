import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ApplicationRuntimeInterfaces } from './ipc'

const { installAcpIpcHandlers, installComputeIpcHandlers, order } = vi.hoisted(() => {
  const order: string[] = []
  return {
    order,
    installAcpIpcHandlers: vi.fn(() => {
      order.push('acp')
      return { uninstall: vi.fn() }
    }),
    installComputeIpcHandlers: vi.fn(() => {
      order.push('compute')
      return { uninstall: vi.fn() }
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
    const compute = { handlers: {}, enabledHosts: {} } as never
    const runtime = {} as never
    const workflows = {} as never
    const sessionAdmission = {} as never

    await installElectronRuntimeAdapters({
      compute,
      beforeCompute: [
        {
          name: 'notifications',
          install: () => {
            order.push('notifications')
            return { uninstall: vi.fn() }
          }
        }
      ],
      beforeAcp: [
        {
          name: 'connectors',
          install: () => {
            order.push('connectors')
            return { uninstall: vi.fn() }
          }
        }
      ],
      acp: { runtime, workflows, sessionAdmission },
      afterAcp: [
        {
          name: 'settings',
          install: () => {
            order.push('settings')
            return { uninstall: vi.fn() }
          }
        }
      ]
    })

    expect(installComputeIpcHandlers).toHaveBeenCalledWith(compute)
    expect(installAcpIpcHandlers).toHaveBeenCalledWith(
      runtime,
      workflows,
      sessionAdmission,
      undefined
    )
    expect(order).toEqual(['notifications', 'compute', 'connectors', 'acp', 'settings'])
  })

  it('rolls back every installed adapter in reverse order when a later install fails', async () => {
    const rollbackOrder: string[] = []
    const compute = { handlers: {}, enabledHosts: {} } as never
    const runtime = {} as never
    const workflows = {} as never
    const sessionAdmission = {} as never
    installComputeIpcHandlers.mockReturnValueOnce({
      uninstall: vi.fn(() => {
        rollbackOrder.push('compute')
      })
    })

    await expect(
      installElectronRuntimeAdapters({
        compute,
        beforeCompute: [
          {
            name: 'first',
            install: () => ({
              uninstall: () => {
                rollbackOrder.push('first')
              }
            })
          }
        ],
        beforeAcp: [
          {
            name: 'failing',
            install: () => {
              throw new Error('adapter install failed')
            }
          }
        ],
        acp: { runtime, workflows, sessionAdmission },
        afterAcp: []
      })
    ).rejects.toThrow('adapter install failed')

    expect(rollbackOrder).toEqual(['compute', 'first'])
  })
})
