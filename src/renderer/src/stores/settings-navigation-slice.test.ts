import { createStore, type StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createInitialSettingsNavigationState,
  createSettingsNavigationSlice,
  type SettingsNavigationActions,
  type SettingsNavigationState
} from './settings-navigation-slice'

type TestStore = SettingsNavigationState & SettingsNavigationActions

const createHarness = (): StoreApi<TestStore> =>
  createStore<TestStore>((set, get) => ({
    ...createInitialSettingsNavigationState(),
    ...createSettingsNavigationSlice({
      getState: get,
      setState: (patch) => set(patch)
    })
  }))

describe('settings navigation slice', () => {
  let store: StoreApi<TestStore>

  beforeEach(() => {
    store = createHarness()
  })

  it('opens normally without replacing a pending landing intent', () => {
    store.getState().openSettingsToPanel('storage')
    const intent = store.getState().pendingSettingsIntent
    store.setState({ isSettingsOpen: false })

    store.getState().openSettings()

    expect(store.getState()).toMatchObject({
      isSettingsOpen: true,
      pendingSettingsIntent: intent
    })
  })

  it.each([
    ['panel', () => store.getState().openSettingsToPanel('storage'), { panel: 'storage' }],
    [
      'Skill',
      () => store.getState().openSettingsToSkill('skill-1'),
      { panel: 'skills', view: { kind: 'detail', id: 'skill-1' } }
    ],
    [
      'Specialist',
      () => store.getState().openSettingsToSpecialist('specialist-1'),
      { panel: 'specialists', view: { kind: 'edit', id: 'specialist-1' } }
    ],
    [
      'Compute',
      () => store.getState().openSettingsToCompute(),
      { panel: 'compute', view: { kind: 'list' } }
    ]
  ] as const)('opens the exact %s route as one intent', (_label, open, route) => {
    store.getState().openSettingsToSkill('stale-skill')

    open()

    expect(store.getState().isSettingsOpen).toBe(true)
    expect(store.getState().pendingSettingsIntent?.route).toEqual(route)
  })

  it('consumes one landing intent without closing the dialog', () => {
    store.getState().openSettingsToSkill('skill-1')
    const requestId = store.getState().pendingSettingsIntent!.requestId

    store.getState().consumePendingSettingsIntent(requestId)

    expect(store.getState()).toMatchObject({
      isSettingsOpen: true,
      pendingSettingsIntent: undefined
    })
  })

  it('does not consume a newer intent when an older effect completes', () => {
    store.getState().openSettingsToSkill('skill-1')
    const staleRequestId = store.getState().pendingSettingsIntent!.requestId
    store.getState().openSettingsToSpecialist('specialist-1')
    const latestIntent = store.getState().pendingSettingsIntent

    store.getState().consumePendingSettingsIntent(staleRequestId)

    expect(store.getState().pendingSettingsIntent).toEqual(latestIntent)
  })

  it('clears a stale intent on close so a normal reopen starts fresh', () => {
    store.getState().openSettingsToSpecialist('specialist-1')

    store.getState().closeSettings()
    store.getState().openSettings()

    expect(store.getState()).toMatchObject({
      isSettingsOpen: true,
      pendingSettingsIntent: undefined
    })
  })

  it('opens the exact Compute Host authentication recovery route', () => {
    store.getState().openSettingsToComputeAuthentication('ssh:biowulf', 'authentication_failed')

    const intent = store.getState().pendingSettingsIntent!
    expect(store.getState().isSettingsOpen).toBe(true)
    expect(intent.route).toEqual({
      panel: 'compute',
      view: {
        kind: 'detail',
        providerId: 'ssh:biowulf',
        authenticationFocus: 'authentication_failed',
        authenticationRequestId: intent.requestId
      }
    })

    store.getState().consumePendingSettingsIntent(intent.requestId)
    expect(store.getState().pendingSettingsIntent).toBeUndefined()

    store.getState().openSettingsToComputeAuthentication('ssh:biowulf', 'authentication_failed')
    expect(store.getState().pendingSettingsIntent?.requestId).toBeGreaterThan(intent.requestId)
  })

  it('opens the exact Compute Host detail route', () => {
    store.getState().openSettingsToComputeHost('ssh:biowulf')

    const intent = store.getState().pendingSettingsIntent!
    expect(intent.route).toEqual({
      panel: 'compute',
      view: { kind: 'detail', providerId: 'ssh:biowulf' }
    })

    store.getState().consumePendingSettingsIntent(intent.requestId)
    expect(store.getState().pendingSettingsIntent).toBeUndefined()
  })
})
