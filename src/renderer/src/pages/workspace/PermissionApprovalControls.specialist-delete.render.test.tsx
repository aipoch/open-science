// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { SpecialistView } from '../../../../shared/specialist'
import { useSpecialistStore } from '@/stores/specialist-store'

import { PermissionApprovalControls } from './PermissionApprovalControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sqlProfile: SpecialistView = {
  id: 'spc-sql',
  name: 'SQL_WRANGLER',
  displayName: 'SQL Wrangler',
  description: 'Executes read-only SQL and builds small data pipelines.',
  systemPrompt: 'You are an SQL specialist.',
  iconKey: 'database',
  colorKey: 'teal',
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: ['sql-1'], connectorIds: ['db-1'], connectorTools: [] },
  revision: 2
}

const deleteRequest: AcpPermissionRequest = {
  requestId: 'delete-1',
  sessionId: 'session-1',
  toolCallId: 'tool-delete',
  title: 'Delete SQL_WRANGLER?',
  rawInput: {
    specialistApproval: {
      kind: 'delete',
      name: 'SQL_WRANGLER',
      boundConversationsUnavailable: true
    }
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }
  ]
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSpecialistStore.setState({ items: [], isLoaded: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PermissionApprovalControls specialist delete card', () => {
  it('shows a friendly specialist detail block instead of the raw approval JSON', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...sqlProfile }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[deleteRequest]} onRespond={vi.fn()} />)
    })

    // The redacted approval payload must never surface as raw JSON.
    expect(container.textContent).not.toContain('boundConversationsUnavailable')
    expect(container.textContent).not.toContain('specialistApproval')

    // The detail block shows the resolved specialist identity and capabilities.
    expect(container.textContent).toContain('SQL Wrangler')
    expect(container.textContent).toContain(
      'Executes read-only SQL and builds small data pipelines.'
    )
    expect(container.textContent).toContain('Selected capabilities')
    expect(container.textContent).toContain('will be permanently removed')
  })

  it('states the fail-closed binding behavior: bound conversations become unavailable', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...sqlProfile }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[deleteRequest]} onRespond={vi.fn()} />)
    })

    expect(container.textContent).toContain('Conversations still bound to')
    expect(container.textContent).toContain('unavailable')
    expect(container.textContent).toContain('not')
    expect(container.textContent).toContain('Main Agent')
  })

  it('renders the primary action as a destructive Delete', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...sqlProfile }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[deleteRequest]} onRespond={vi.fn()} />)
    })

    const primary = container.querySelector<HTMLElement>('[data-testid="allow-primary"]')
    expect(primary).not.toBeNull()
    expect(primary!.textContent).toContain('Delete')
    expect(primary!.textContent).not.toContain('Allow')
    expect(primary!.className).toContain('bg-destructive')
  })

  it('denies through the same onRespond path as any other request', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...sqlProfile }],
      isLoaded: true
    })
    const onRespond = vi.fn()

    act(() => {
      root.render(<PermissionApprovalControls requests={[deleteRequest]} onRespond={onRespond} />)
    })

    act(() => {
      container.querySelector<HTMLElement>('[data-testid="deny-button"]')!.click()
    })
    expect(onRespond).toHaveBeenCalledWith('delete-1', 'reject-once')
  })

  it('degrades to a stale warning when the target cannot be resolved by name (renamed or removed)', () => {
    // The catalog no longer contains SQL_WRANGLER — it was renamed or removed after the
    // delete request started. Approval will fail main-side name validation.
    act(() => {
      root.render(<PermissionApprovalControls requests={[deleteRequest]} onRespond={vi.fn()} />)
    })

    expect(container.textContent).toContain('can no longer be resolved by name')
    expect(container.textContent).toContain('Approving will be rejected')
  })

  it('marks a disabled target without claiming approval will fail', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...sqlProfile, enabled: false }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[deleteRequest]} onRespond={vi.fn()} />)
    })

    // The profile still resolves, so details show — with an explicit Disabled marker. Delete is
    // not gated on the enabled flag (unlike switch), so no rejection warning is fabricated.
    expect(container.textContent).toContain('SQL Wrangler')
    expect(container.textContent).toContain('Disabled')
    expect(container.textContent).not.toContain('Approving will be rejected')
  })

  it('reflects catalog changes live while the request stays pending (edits made in Settings)', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...sqlProfile }],
      isLoaded: true
    })
    act(() => {
      root.render(<PermissionApprovalControls requests={[deleteRequest]} onRespond={vi.fn()} />)
    })
    expect(container.textContent).toContain('SQL Wrangler')

    // The user renamed/removed the target in Settings; the still-pending card must refresh
    // itself from the catalog without a new request or re-render.
    act(() => {
      useSpecialistStore.setState({ items: [], isLoaded: true })
    })
    expect(container.textContent).toContain('can no longer be resolved by name')
  })
})
