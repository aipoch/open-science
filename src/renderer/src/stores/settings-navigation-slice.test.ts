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
  createStore<TestStore>((set) => ({
    ...createInitialSettingsNavigationState(),
    ...createSettingsNavigationSlice({ setState: (patch) => set(patch) })
  }))

describe('settings navigation slice', () => {
  let store: StoreApi<TestStore>

  beforeEach(() => {
    store = createHarness()
  })

  it('opens normally without replacing a pending landing target', () => {
    store.setState({ pendingSettingsPanel: 'storage' })

    store.getState().openSettings()

    expect(store.getState()).toMatchObject({
      isSettingsOpen: true,
      pendingSettingsPanel: 'storage'
    })
  })

  it.each([
    [
      'panel',
      () => store.getState().openSettingsToPanel('storage'),
      'storage',
      undefined,
      undefined
    ],
    [
      'Skill',
      () => store.getState().openSettingsToSkill('skill-1'),
      undefined,
      'skill-1',
      undefined
    ],
    [
      'Specialist',
      () => store.getState().openSettingsToSpecialist('specialist-1'),
      undefined,
      undefined,
      'specialist-1'
    ],
    ['Compute', () => store.getState().openSettingsToCompute(), 'compute', undefined, undefined]
  ] as const)(
    'opens the %s target and clears every competing target',
    (_label, open, panel, skillId, specialistId) => {
      store.setState({
        pendingSettingsPanel: 'agent',
        pendingSkillId: 'stale-skill',
        pendingSpecialistId: 'stale-specialist'
      })

      open()

      expect(store.getState()).toMatchObject({
        isSettingsOpen: true,
        pendingSettingsPanel: panel,
        pendingSkillId: skillId,
        pendingSpecialistId: specialistId
      })
    }
  )

  it('consumes each landing target exactly once without closing the dialog', () => {
    store.setState({
      isSettingsOpen: true,
      pendingSettingsPanel: 'storage',
      pendingSkillId: 'skill-1',
      pendingSpecialistId: 'specialist-1'
    })

    store.getState().consumePendingSettingsPanel()
    store.getState().consumePendingSkill()
    store.getState().consumePendingSpecialist()

    expect(store.getState()).toMatchObject({
      isSettingsOpen: true,
      pendingSettingsPanel: undefined,
      pendingSkillId: undefined,
      pendingSpecialistId: undefined
    })
  })

  it('clears stale targets on close so a normal reopen starts fresh', () => {
    store.getState().openSettingsToSpecialist('specialist-1')

    store.getState().closeSettings()
    store.getState().openSettings()

    expect(store.getState()).toMatchObject({
      isSettingsOpen: true,
      pendingSettingsPanel: undefined,
      pendingSkillId: undefined,
      pendingSpecialistId: undefined
    })
  })
})
