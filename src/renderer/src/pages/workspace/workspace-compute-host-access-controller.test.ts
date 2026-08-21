import { describe, expect, it } from 'vitest'

import { createWorkspaceComputeHostAccessController } from './workspace-compute-host-access-controller'

describe('workspace Compute Host access controller', () => {
  it('moves a new-Session host through Hidden, Available and multi-Selected states', () => {
    let enabledProviderIds: string[] = []
    let selectedProviderIds: string[] = []
    const controller = (): ReturnType<typeof createWorkspaceComputeHostAccessController> =>
      createWorkspaceComputeHostAccessController({
        activeSession: undefined,
        newConversationEnabledComputeHosts: enabledProviderIds,
        newConversationSelectedComputeHosts: selectedProviderIds,
        setNewConversationEnabledComputeHosts: (update) => {
          enabledProviderIds = update(enabledProviderIds)
        },
        setNewConversationSelectedComputeHosts: (update) => {
          selectedProviderIds = update(selectedProviderIds)
        },
        setError: () => undefined
      })

    controller().setHostEnabled('ssh:alpha', true)
    controller().setHostEnabled('ssh:beta', true)
    expect(enabledProviderIds).toEqual(['ssh:alpha', 'ssh:beta'])
    expect(selectedProviderIds).toEqual([])

    controller().setHostSelected('ssh:alpha', true)
    controller().setHostSelected('ssh:beta', true)
    expect(selectedProviderIds).toEqual(['ssh:alpha', 'ssh:beta'])

    controller().setHostEnabled('ssh:alpha', false)
    expect(enabledProviderIds).toEqual(['ssh:beta'])
    expect(selectedProviderIds).toEqual(['ssh:beta'])

    controller().setHostEnabled('ssh:alpha', true)
    expect(enabledProviderIds).toEqual(['ssh:beta', 'ssh:alpha'])
    expect(selectedProviderIds).toEqual(['ssh:beta'])

    controller().setHostSelected('ssh:gamma', true)
    expect(enabledProviderIds).toEqual(['ssh:beta', 'ssh:alpha', 'ssh:gamma'])
    expect(selectedProviderIds).toEqual(['ssh:beta', 'ssh:gamma'])
  })
})
