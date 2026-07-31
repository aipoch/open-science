// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PermissionGrantSnapshot } from '../../../../shared/permission-grants'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { PermissionsPanel } from './PermissionsPanel'

let container: HTMLDivElement
let root: Root

const snapshot: PermissionGrantSnapshot = {
  version: 1,
  incompleteStores: [],
  grants: [
    {
      id: 'grant-1',
      revision: 1,
      family: 'local_compute',
      capabilityKind: 'execution',
      capabilityLabel: 'Shell',
      qualifierLabel: 'Specific input',
      scopeKind: 'session',
      scopeLabel: 'Session: Analyze samples',
      coveredBy: 'project',
      projectId: 'project-1',
      sessionId: 'session-1'
    }
  ],
  counts: { all: 1, global: 0, project: 0, session: 1 }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  usePermissionGrantsStore.setState({
    grants: [],
    counts: { all: 0, global: 0, project: 0, session: 0 },
    incompleteStores: [],
    status: 'idle',
    error: undefined,
    undo: undefined,
    undoQueue: [],
    isRestoring: false
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const setPermissionApi = (api: Partial<Window['api']['permissions']>): void => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { permissions: api }
  })
}

describe('PermissionsPanel', () => {
  it('keeps the default empty state visually quiet while exposing all scope counts', async () => {
    setPermissionApi({
      list: vi.fn().mockResolvedValue({
        version: 1,
        incompleteStores: [],
        grants: [],
        counts: { all: 0, global: 0, project: 0, session: 0 }
      })
    })

    await act(async () => root.render(<PermissionsPanel />))

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Filter permissions by scope"]'
    )
    expect(trigger?.textContent).toContain('All (0)')
    const emptyStatus = document.body.querySelector<HTMLElement>('[role="status"]')
    expect(emptyStatus?.textContent).toContain('No remembered permissions for this scope.')
    expect(emptyStatus?.classList.contains('sr-only')).toBe(true)
    expect(document.body.querySelector('.border-dashed')).toBeNull()
  })

  it('uses the shared Settings danger banner for load failures', async () => {
    setPermissionApi({ list: vi.fn().mockRejectedValue(new Error('Permission load failed')) })

    await act(async () => root.render(<PermissionsPanel />))

    await vi.waitFor(() => {
      const alert = document.body.querySelector<HTMLElement>('[role="alert"]')
      expect(alert?.textContent).toContain('Permission load failed')
      expect(alert?.className).toContain('border-danger-000/30')
      expect(alert?.className).toContain('bg-danger-000/10')
      expect(alert?.className).toContain('text-danger-000')
    })
  })

  it('renders a Project grant with its project label and compact family description', async () => {
    const projectSnapshot: PermissionGrantSnapshot = {
      version: 1,
      incompleteStores: [],
      grants: [
        {
          id: 'project-grant',
          revision: 1,
          family: 'local_compute',
          capabilityKind: 'execution',
          capabilityLabel: 'python',
          qualifierLabel: 'any call',
          scopeKind: 'project',
          scopeLabel: 'Project: Example project',
          projectId: 'project-1'
        }
      ],
      counts: { all: 1, global: 0, project: 1, session: 0 }
    }
    setPermissionApi({ list: vi.fn().mockResolvedValue(projectSnapshot) })

    await act(async () => root.render(<PermissionsPanel />))

    expect(document.body.textContent).toContain('Local compute')
    expect(document.body.textContent).toContain('Sandbox tools that run without preview')
    expect(document.body.textContent).toContain('python')
    expect(document.body.textContent).toContain('any call')
    expect(document.body.textContent).toContain('Project: Example project')
    expect(document.body.querySelector('[aria-label="Revoke python"]')).not.toBeNull()
    expect(document.body.querySelector('h3')?.className).toContain('text-base')
    const permissionRow = document.body.querySelector<HTMLElement>('[data-slot="permission-row"]')
    expect(permissionRow?.className).toContain('min-h-11')
    expect(permissionRow?.className).toContain('py-1.5')
    const filterTrigger = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter permissions by scope"]'
    )
    expect(filterTrigger?.parentElement?.className).toContain('mb-2')
  })

  it('renders grouped grants with a scope filter and per-row revoke control', async () => {
    setPermissionApi({ list: vi.fn().mockResolvedValue(snapshot) })

    await act(async () => root.render(<PermissionsPanel />))

    expect(document.body.textContent).toContain('All (1)')
    expect(document.body.textContent).toContain('Local compute')
    expect(document.body.textContent).toContain('Shell')
    expect(document.body.textContent).toContain('Session: Analyze samples')
    expect(document.body.textContent).toContain('Also allowed for this project')
    expect(document.body.querySelector('[aria-label="Revoke Shell"]')).not.toBeNull()
  })

  it('opens the owning session from a session scope chip', async () => {
    const onOpenSession = vi.fn()
    setPermissionApi({ list: vi.fn().mockResolvedValue(snapshot) })

    await act(async () => root.render(<PermissionsPanel onOpenSession={onOpenSession} />))

    const sessionButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Open Session: Analyze samples"]'
    )
    expect(sessionButton).not.toBeNull()
    expect(sessionButton?.className).toContain('hover:bg-accent')
    expect(sessionButton?.className).toContain('focus-visible:ring-3')

    await act(async () => sessionButton?.click())

    expect(onOpenSession).toHaveBeenCalledOnce()
    expect(onOpenSession).toHaveBeenCalledWith('session-1')
  })

  it('revokes one exact revision and retains an app-root Undo receipt', async () => {
    const revoke = vi.fn().mockResolvedValue({
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      conflicts: [],
      receipt: { undoToken: 'undo-1', expiresAt: Date.now() + 8_000, revokedCount: 1 }
    })
    setPermissionApi({ list: vi.fn().mockResolvedValue(snapshot), revoke })
    await act(async () => root.render(<PermissionsPanel />))

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Revoke Shell"]')?.click()
    })

    expect(revoke).toHaveBeenCalledWith({ grants: [{ id: 'grant-1', revision: 1 }] })
    expect(usePermissionGrantsStore.getState().undo).toMatchObject({
      token: 'undo-1',
      message: 'Revoked Local compute · Shell'
    })
  })

  it('keeps the restored permission list visible when revoke persistence fails', async () => {
    setPermissionApi({
      list: vi.fn().mockResolvedValue(snapshot),
      revoke: vi.fn().mockRejectedValue(new Error('database locked'))
    })
    await act(async () => root.render(<PermissionsPanel />))

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Revoke Shell"]')?.click()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('database locked')
    expect(document.body.textContent).toContain('Shell')
    expect(document.body.querySelector('[aria-label="Revoke Shell"]')).not.toBeNull()
  })

  it('shows Connector policy coverage and links to the owning Connector', async () => {
    const onOpenConnector = vi.fn()
    const connectorSnapshot: PermissionGrantSnapshot = {
      version: 1,
      incompleteStores: [],
      grants: [
        {
          id: 'connector-grant',
          revision: 1,
          family: 'connectors',
          capabilityKind: 'mcp_tool',
          capabilityLabel: 'Search',
          scopeKind: 'global',
          scopeLabel: 'Global',
          connectorServerId: 'chemistry',
          connectorToolName: 'search',
          effectiveState: 'covered_by_policy',
          policyHint: 'Allowed by Connector policy even without this permission'
        }
      ],
      counts: { all: 1, global: 1, project: 0, session: 0 }
    }
    setPermissionApi({ list: vi.fn().mockResolvedValue(connectorSnapshot) })
    await act(async () => root.render(<PermissionsPanel onOpenConnector={onOpenConnector} />))

    const policyLink = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Allowed by Connector policy')
    )
    expect(policyLink?.className).toContain('focus-visible:ring-3')
    await act(async () => policyLink?.click())
    expect(onOpenConnector).toHaveBeenCalledWith('chemistry')
  })

  it('names incomplete stores and disables bulk revoke while retaining row revoke', async () => {
    setPermissionApi({
      list: vi.fn().mockResolvedValue({
        ...snapshot,
        incompleteStores: ['sessions', 'connector_policy']
      })
    })
    await act(async () => root.render(<PermissionsPanel />))

    expect(document.body.textContent).toContain(
      'Session names, Connector policy could not be loaded'
    )
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label*="Revoke all"]')?.disabled
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Revoke Shell"]')?.disabled
    ).toBeFalsy()
  })
})
