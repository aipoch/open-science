// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { ConnectorAuthToast } from './ConnectorAuthToast'

describe('ConnectorAuthToast', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      connectorAuthNotice: { id: 'oauth-mcp', displayName: 'OAuth MCP' },
      loadConnectors: vi.fn().mockResolvedValue(undefined),
      dismissConnectorAuthNotice: vi.fn(),
      openSettingsToPanel: vi.fn()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('loads the runtime projection and opens Connector settings from the notice', async () => {
    await act(async () => root.render(<ConnectorAuthToast />))

    expect(useSettingsStore.getState().loadConnectors).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('OAuth MCP needs sign-in')
    const open = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open Connectors'
    )
    act(() => open?.click())

    expect(useSettingsStore.getState().dismissConnectorAuthNotice).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().openSettingsToPanel).toHaveBeenCalledWith('connectors')
  })
})
