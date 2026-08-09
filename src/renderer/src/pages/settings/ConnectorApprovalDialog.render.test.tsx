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

  it('keeps approvals for the open Side chat parent queued without showing its dialog', () => {
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          sessionId: 'session-side',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{}'
        },
        {
          id: 'r2',
          sessionId: 'session-side-2',
          connector: 'biomart',
          method: 'get_more_data',
          argsPreview: '{}'
        }
      ]
    })

    act(() =>
      root.render(
        <ConnectorApprovalDialog blockedSessionIds={new Set(['session-side', 'session-side-2'])} />
      )
    )

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useSettingsStore.getState().pendingApprovals).toHaveLength(2)
  })

  it('shows the oldest request with the resolved connector name and tool', () => {
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{"x":1}',
          availableScopes: ['once', 'session', 'project', 'global']
        }
      ]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    expect(document.body.textContent).toContain('BioMart')
    expect(document.body.textContent).toContain('get_data')
    expect(document.body.textContent).toContain('{"x":1}')
    expect(button('Deny')?.getAttribute('data-slot')).toBe('button')
    expect(button('Deny')?.getAttribute('data-variant')).toBe('destructive')
    expect(button('This session')?.getAttribute('data-variant')).toBe('outline')
    expect(button('This project')?.getAttribute('data-variant')).toBe('outline')
    expect(button('Global')?.getAttribute('data-variant')).toBe('outline')
    expect(button('Allow once')?.getAttribute('data-variant')).toBe('default')
    expect(document.body.querySelector('[role="dialog"]')?.className).toContain(
      'overscroll-contain'
    )
  })

  it('Allow once responds with one-call scope without changing Connector policy', () => {
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{}',
          availableScopes: ['once']
        }
      ]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button('Allow once')?.click())
    expect(useSettingsStore.getState().respondApproval).toHaveBeenCalledWith('r1', 'once')
    expect(useSettingsStore.getState().setConnectorAutoAllow).not.toHaveBeenCalled()
  })

  it.each([['This session', 'session']] as const)(
    '%s returns the remembered Broker scope without changing Connector policy',
    (label, scope) => {
      useSettingsStore.setState({
        pendingApprovals: [
          {
            id: 'r1',
            connector: 'biomart',
            method: 'get_data',
            argsPreview: '{}',
            availableScopes: ['once', 'session', 'project', 'global']
          }
        ]
      })
      act(() => root.render(<ConnectorApprovalDialog />))

      act(() => button(label)?.click())
      expect(useSettingsStore.getState().respondApproval).toHaveBeenCalledWith('r1', scope)
      expect(useSettingsStore.getState().setConnectorAutoAllow).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['This project', 'project', 'for this project'],
    ['Global', 'global', 'globally']
  ] as const)('requires confirmation before %s is remembered', (label, scope, scopePhrase) => {
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{}',
          availableScopes: ['once', 'session', 'project', 'global']
        }
      ]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button(label)?.click())

    expect(useSettingsStore.getState().respondApproval).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(scopePhrase)

    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="permission-scope-confirm"]')
        ?.click()
    )

    expect(useSettingsStore.getState().respondApproval).toHaveBeenCalledWith('r1', scope)
    expect(useSettingsStore.getState().setConnectorAutoAllow).not.toHaveBeenCalled()
  })

  it('Deny responds deny', () => {
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{}',
          availableScopes: ['once']
        }
      ]
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button('Deny')?.click())
    expect(useSettingsStore.getState().respondApproval).toHaveBeenCalledWith('r1', 'deny')
  })
})
