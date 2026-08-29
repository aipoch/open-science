// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useStorageInfoStore } from '@/stores/storage-info-store'
import { StorageCleanupToast } from './StorageCleanupToast'

describe('StorageCleanupToast', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      openSettingsToPanel: vi.fn()
    })
    useStorageInfoStore.setState({
      status: {
        dataRoot: '/new-root',
        isDefault: false,
        defaultDataRoot: '/default-root',
        defaultParent: '/',
        dataRootMissing: false,
        legacyDataMovePrompt: false,
        cleanupPending: true
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    useStorageInfoStore.setState({ status: null })
  })

  it('notifies the user and opens Storage settings while old-root cleanup is pending', () => {
    act(() => root.render(<StorageCleanupToast />))

    expect(container.textContent).toContain('Old data location needs cleanup')
    const open = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open Storage'
    )
    act(() => open?.click())

    expect(useSettingsStore.getState().openSettingsToPanel).toHaveBeenCalledWith('storage')
    expect(container.querySelector('[data-testid="storage-cleanup-toast"]')).toBeNull()
  })
})
