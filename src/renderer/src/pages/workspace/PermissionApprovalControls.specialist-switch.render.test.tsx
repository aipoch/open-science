// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import type { SpecialistProfileView } from '../../../../shared/specialist'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useSettingsStore } from '@/stores/settings-store'

import { PermissionApprovalControls } from './PermissionApprovalControls'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const researchProfile: SpecialistProfileView = {
  id: 'spc-1',
  name: 'RESEARCHER',
  displayName: 'Researcher',
  description: 'Conducts systematic literature reviews and synthesizes evidence.',
  systemPrompt: 'You are a literature review specialist.',
  iconKey: 'search',
  colorKey: 'blue',
  enabled: true,
  capabilityMode: 'full',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
  revision: 1
}

const switchRequest: AcpPermissionRequest = {
  requestId: 'switch-1',
  sessionId: 'session-1',
  toolCallId: 'tool-switch',
  title: 'Switch to RESEARCHER?',
  rawInput: {
    specialistApproval: {
      kind: 'switch',
      currentName: null,
      targetName: 'RESEARCHER',
      takesEffectAfterCurrentTool: true
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

const statisticianProfile: SpecialistProfileView = {
  id: 'spc-2',
  name: 'STATISTICIAN',
  displayName: 'Statistician',
  description: 'Designs analysis plans and runs statistical models.',
  systemPrompt: 'You are a statistics specialist.',
  iconKey: 'flask-conical',
  colorKey: 'purple',
  enabled: true,
  capabilityMode: 'selected',
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
  selectedCapabilities: {
    skillIds: ['skill-1', 'skill-2'],
    connectorIds: ['conn-1'],
    connectorTools: []
  },
  revision: 1
}

const mainSwitchRequest: AcpPermissionRequest = {
  ...switchRequest,
  title: 'Switch to Main Agent?',
  rawInput: {
    specialistApproval: {
      kind: 'switch',
      currentName: 'STATISTICIAN',
      targetName: null,
      takesEffectAfterCurrentTool: true
    }
  }
}

describe('PermissionApprovalControls specialist switch card', () => {
  it('deep-links to the specialist config page when the detail block is clicked', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...researchProfile }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[switchRequest]} onRespond={vi.fn()} />)
    })

    const detail = container.querySelector<HTMLElement>('[data-testid="specialist-detail"]')
    expect(detail).not.toBeNull()
    act(() => detail!.click())

    // The stable profile id (never the renameable public name) reaches the settings dialog.
    expect(useSettingsStore.getState().isSettingsOpen).toBe(true)
    expect(useSettingsStore.getState().pendingSettingsIntent?.route).toEqual({
      panel: 'specialists',
      view: { kind: 'edit', id: 'spc-1' }
    })
  })

  it('carries a Configure affordance on the clickable detail block', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...researchProfile }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[switchRequest]} onRespond={vi.fn()} />)
    })

    // The affordance lives inside the clickable block so hover reveals it on the same surface.
    const detail = container.querySelector<HTMLElement>('[data-testid="specialist-detail"]')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('Configure')
  })

  it('shows a neutral Main Agent fallback with the switch direction when reverting to Main Agent', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...statisticianProfile }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[mainSwitchRequest]} onRespond={vi.fn()} />)
    })

    // No profile exists for Main Agent: a neutral statement, never fabricated details.
    expect(container.textContent).toContain('Reverts to the default agent')
    // The direction line names both sides of the switch.
    expect(container.textContent).toContain('Statistician')
    expect(container.textContent).toContain('Main Agent')
  })

  it('degrades to a stale warning when the target cannot be resolved by name (renamed or removed)', () => {
    // The catalog no longer contains RESEARCHER — it was renamed or removed after the
    // switch request started. Per PRD #19 the approval will fail main-side validation.
    act(() => {
      root.render(<PermissionApprovalControls requests={[switchRequest]} onRespond={vi.fn()} />)
    })

    expect(container.textContent).toContain('can no longer be resolved by name')
    expect(container.textContent).toContain('Approving will be rejected')
  })

  it('marks a disabled target and warns that approval will be rejected', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...researchProfile, enabled: false }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[switchRequest]} onRespond={vi.fn()} />)
    })

    // The profile still resolves, so details show — with an explicit Disabled marker.
    expect(container.textContent).toContain('Researcher')
    expect(container.textContent).toContain('Disabled')
    expect(container.textContent).toContain('Approving will be rejected')
  })

  it('reflects catalog changes live while the request stays pending (edits made in Settings)', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...researchProfile }],
      isLoaded: true
    })
    act(() => {
      root.render(<PermissionApprovalControls requests={[switchRequest]} onRespond={vi.fn()} />)
    })
    expect(container.textContent).toContain('Researcher')

    // The user renamed/removed the target in Settings; the still-pending card must refresh
    // itself from the catalog without a new request or re-render.
    act(() => {
      useSpecialistStore.setState({ items: [], isLoaded: true })
    })
    expect(container.textContent).toContain('can no longer be resolved by name')
  })

  it('shows a friendly specialist detail block instead of the raw approval JSON', () => {
    useSpecialistStore.setState({
      items: [{ kind: 'custom', ...researchProfile }],
      isLoaded: true
    })

    act(() => {
      root.render(<PermissionApprovalControls requests={[switchRequest]} onRespond={vi.fn()} />)
    })

    // The redacted approval payload must never surface as raw JSON.
    expect(container.textContent).not.toContain('takesEffectAfterCurrentTool')
    expect(container.textContent).not.toContain('specialistApproval')

    // The detail block shows the resolved specialist identity and capabilities.
    expect(container.textContent).toContain('Researcher')
    expect(container.textContent).toContain(
      'Conducts systematic literature reviews and synthesizes evidence.'
    )
    expect(container.textContent).toContain('Full access')
  })
})
