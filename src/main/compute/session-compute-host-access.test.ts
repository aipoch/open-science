import { describe, expect, it } from 'vitest'

import { transitionSessionComputeHostAccess } from './session-compute-host-access'

describe('transitionSessionComputeHostAccess', () => {
  it('enables a host as Available without selecting it', () => {
    expect(
      transitionSessionComputeHostAccess(
        { enabledProviderIds: [], selectedProviderIds: [] },
        { kind: 'set-host-enabled', providerId: 'ssh:gpu', enabled: true }
      )
    ).toEqual({ enabledProviderIds: ['ssh:gpu'], selectedProviderIds: [] })
  })

  it('disabling a Selected host atomically removes it from both sets', () => {
    expect(
      transitionSessionComputeHostAccess(
        {
          enabledProviderIds: ['ssh:gpu', 'ssh:cluster'],
          selectedProviderIds: ['ssh:gpu', 'ssh:cluster']
        },
        { kind: 'set-host-enabled', providerId: 'ssh:gpu', enabled: false }
      )
    ).toEqual({
      enabledProviderIds: ['ssh:cluster'],
      selectedProviderIds: ['ssh:cluster']
    })
  })

  it('selects multiple enabled hosts independently', () => {
    const initial = {
      enabledProviderIds: ['ssh:gpu', 'ssh:cluster'],
      selectedProviderIds: ['ssh:gpu']
    }

    expect(
      transitionSessionComputeHostAccess(initial, {
        kind: 'set-host-selected',
        providerId: 'ssh:cluster',
        selected: true
      })
    ).toEqual({
      enabledProviderIds: ['ssh:gpu', 'ssh:cluster'],
      selectedProviderIds: ['ssh:gpu', 'ssh:cluster']
    })
  })

  it('enables a host when it is selected as an execution target', () => {
    expect(
      transitionSessionComputeHostAccess(
        { enabledProviderIds: [], selectedProviderIds: [] },
        { kind: 'set-host-selected', providerId: 'ssh:gpu', selected: true }
      )
    ).toEqual({ enabledProviderIds: ['ssh:gpu'], selectedProviderIds: ['ssh:gpu'] })
  })

  it('explicit selection enables new targets while preserving other Available hosts', () => {
    expect(
      transitionSessionComputeHostAccess(
        {
          enabledProviderIds: ['ssh:available', 'ssh:old-target'],
          selectedProviderIds: ['ssh:old-target']
        },
        {
          kind: 'select-explicit',
          providerIds: ['ssh:new-target', 'ssh:new-target']
        }
      )
    ).toEqual({
      enabledProviderIds: ['ssh:available', 'ssh:old-target', 'ssh:new-target'],
      selectedProviderIds: ['ssh:new-target']
    })
  })

  it('re-enables a disabled target as Available without restoring selection', () => {
    const disabled = transitionSessionComputeHostAccess(
      { enabledProviderIds: ['ssh:gpu'], selectedProviderIds: ['ssh:gpu'] },
      { kind: 'set-host-enabled', providerId: 'ssh:gpu', enabled: false }
    )

    expect(
      transitionSessionComputeHostAccess(disabled, {
        kind: 'set-host-enabled',
        providerId: 'ssh:gpu',
        enabled: true
      })
    ).toEqual({ enabledProviderIds: ['ssh:gpu'], selectedProviderIds: [] })
  })

  it('an explicit empty selection leaves enabled hosts Available', () => {
    expect(
      transitionSessionComputeHostAccess(
        {
          enabledProviderIds: ['ssh:available', 'ssh:selected'],
          selectedProviderIds: ['ssh:selected']
        },
        { kind: 'select-explicit', providerIds: [] }
      )
    ).toEqual({
      enabledProviderIds: ['ssh:available', 'ssh:selected'],
      selectedProviderIds: []
    })
  })
})
