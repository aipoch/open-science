// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorApprovalRequest } from '../../../../shared/settings'

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
        name: 'biomart',
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

  it('keeps a covered approval queued while suppressing its presentation', () => {
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{}'
        }
      ]
    })

    act(() => root.render(<ConnectorApprovalDialog active={false} />))

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(useSettingsStore.getState().pendingApprovals).toHaveLength(1)
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
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-b border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLElement>('div')).some((element) =>
        element.className.includes('border-t border-border-300/90 px-5 py-3.5')
      )
    ).toBe(true)
    expect(document.body.querySelector('[role="dialog"]')?.className).toContain('overflow-hidden')
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

  it('disambiguates a custom Connector target and exposes its full arguments', () => {
    const argsJson = JSON.stringify({ query: 'x'.repeat(400) })
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r-custom',
          connector: 'Duplicate label',
          connectorId: 'server-id',
          connectorName: 'stable-server',
          displayName: 'Duplicate label',
          transport: 'streamable_http',
          target: 'https://mcp.example.test',
          method: 'lookup',
          argsPreview: `${argsJson.slice(0, 300)}…`,
          argsJson,
          availableScopes: ['once', 'project', 'global']
        } as never
      ]
    })

    act(() => root.render(<ConnectorApprovalDialog />))

    expect(document.body.textContent).toContain('stable-server')
    expect(document.body.textContent).toContain('server-id')
    expect(document.body.textContent).toContain('Streamable HTTP')
    expect(document.body.textContent).toContain('https://mcp.example.test')
    expect(document.body.textContent).toContain('Show full arguments')
    act(() => button('Show full arguments')?.click())
    expect(document.body.textContent).toContain(argsJson)
  })

  it('keeps oversized expanded arguments scrollable without displacing approval actions', () => {
    const argsJson = JSON.stringify({ query: 'x'.repeat(64_000) })
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r-large-args',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: `${argsJson.slice(0, 300)}…`,
          argsJson,
          argsJsonTruncated: true,
          availableScopes: ['once']
        } as never
      ]
    })

    act(() => root.render(<ConnectorApprovalDialog />))
    act(() => button('Show full arguments')?.click())

    const args = Array.from(document.body.querySelectorAll<HTMLElement>('span')).find(
      (element) => element.textContent === argsJson
    )
    expect(args?.className).toContain('max-h-48')
    expect(args?.className).toContain('overflow-y-auto')
    expect(document.body.textContent).toContain('Arguments were truncated for display.')
    expect(button('Deny')).toBeDefined()
    expect(button('Allow once')).toBeDefined()
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

  it('drops a broad-scope confirmation when its approval settles', () => {
    const first: ConnectorApprovalRequest = {
      id: 'r1',
      connector: 'biomart',
      method: 'get_data',
      argsPreview: '{}',
      availableScopes: ['once', 'project']
    }
    const second = { ...first, id: 'r2' }
    useSettingsStore.setState({ pendingApprovals: [first] })
    act(() => root.render(<ConnectorApprovalDialog />))
    act(() => button('This project')?.click())

    act(() => useSettingsStore.setState({ pendingApprovals: [second] }))

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(useSettingsStore.getState().respondApproval).not.toHaveBeenCalled()
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

  it('disables decisions while submitting and keeps a failed response retryable', async () => {
    let rejectResponse!: (error: Error) => void
    const respondApproval = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((_, reject) => {
          rejectResponse = reject
        })
      )
      .mockResolvedValueOnce(undefined)
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{}',
          availableScopes: ['once', 'session']
        }
      ],
      respondApproval
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button('Allow once')?.click())

    expect(button('Deny')?.disabled).toBe(true)
    expect(button('This session')?.disabled).toBe(true)
    expect(button('Allow once')?.disabled).toBe(true)
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      rejectResponse(new Error('IPC unavailable'))
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not submit this approval. Try again.'
    )
    expect(button('Allow once')?.disabled).toBe(false)

    act(() => button('Allow once')?.click())
    expect(respondApproval).toHaveBeenCalledTimes(2)
  })

  it('does not carry a response failure to the next queued approval', async () => {
    let rejectResponse!: (error: Error) => void
    const respondApproval = vi.fn().mockReturnValue(
      new Promise<void>((_, reject) => {
        rejectResponse = reject
      })
    )
    const nextRequest: ConnectorApprovalRequest = {
      id: 'r2',
      connector: 'pubmed',
      method: 'search',
      argsPreview: '{}',
      availableScopes: ['once']
    }
    useSettingsStore.setState({
      pendingApprovals: [
        {
          id: 'r1',
          connector: 'biomart',
          method: 'get_data',
          argsPreview: '{}',
          availableScopes: ['once']
        }
      ],
      respondApproval
    })
    act(() => root.render(<ConnectorApprovalDialog />))

    act(() => button('Allow once')?.click())
    await act(async () => {
      rejectResponse(new Error('IPC unavailable'))
      await Promise.resolve()
    })
    expect(document.body.querySelector('[role="alert"]')).not.toBeNull()

    act(() => useSettingsStore.setState({ pendingApprovals: [nextRequest] }))
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
  })
})
