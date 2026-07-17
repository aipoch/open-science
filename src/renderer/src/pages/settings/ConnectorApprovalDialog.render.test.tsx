// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorApprovalDialog } from './ConnectorApprovalDialog'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    connectors: [
      {
        id: 'biomart',
        displayName: 'BioMart',
        description: '',
        sources: [],
        requiresNcbi: false,
        enabled: true,
        autoAllow: false,
        group: 'featured'
      }
    ],
    respondApproval: vi.fn().mockResolvedValue(undefined),
    setConnectorAutoAllow: vi.fn().mockResolvedValue(undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const button = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text
  )

describe('ConnectorApprovalDialog', () => {
  it('renders nothing when there are no pending approvals', () => {
    act(() => root.render(<ConnectorApprovalDialog />))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the oldest request with the resolved connector name and tool', () => {
    useSettingsStore.setState({
      pendingApprovals: [
        { id: 'r1', connector: 'biomart', method: 'get_data', argsPreview: '{"x":1}' }
      ]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    expect(document.body.textContent).toContain('BioMart')
    expect(document.body.textContent).toContain('get_data')
    expect(document.body.textContent).toContain('{"x":1}')
    expect(button('Deny')?.getAttribute('data-slot')).toBe('button')
    expect(button('Deny')?.getAttribute('data-variant')).toBe('destructive')
    expect(button('Always allow')?.getAttribute('data-variant')).toBe('outline')
    expect(button('Allow once')?.getAttribute('data-variant')).toBe('default')
    expect(document.body.querySelector('[role="dialog"]')?.className).toContain(
      'overscroll-contain'
    )
  })

  it('Allow once responds allow without pre-trusting the connector', () => {
    useSettingsStore.setState({
      pendingApprovals: [{ id: 'r1', connector: 'biomart', method: 'get_data', argsPreview: '{}' }]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button('Allow once')?.click())
    expect(useSettingsStore.getState().respondApproval).toHaveBeenCalledWith('r1', 'allow')
    expect(useSettingsStore.getState().setConnectorAutoAllow).not.toHaveBeenCalled()
  })

  it('Always allow pre-trusts the connector then allows', () => {
    useSettingsStore.setState({
      pendingApprovals: [{ id: 'r1', connector: 'biomart', method: 'get_data', argsPreview: '{}' }]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button('Always allow')?.click())
    expect(useSettingsStore.getState().setConnectorAutoAllow).toHaveBeenCalledWith('biomart', true)
  })

  it('Deny responds deny', () => {
    useSettingsStore.setState({
      pendingApprovals: [{ id: 'r1', connector: 'biomart', method: 'get_data', argsPreview: '{}' }]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button('Deny')?.click())
    expect(useSettingsStore.getState().respondApproval).toHaveBeenCalledWith('r1', 'deny')
  })
})
