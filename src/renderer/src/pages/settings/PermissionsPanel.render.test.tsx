// @vitest-environment jsdom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  PermissionGrantRecord,
  PermissionGrantSnapshot
} from '../../../../shared/permission-grants'
import { projectPermissionGrantSnapshot } from '../../../../main/permission-grants/catalog'
import { createPermissionGrantRegistry } from '../../../../main/permission-grants/registry'
import {
  createProjectDbClient,
  migrateApplicationDatabase
} from '../../../../main/projects/prisma-client'
import { DEFAULT_GLOBAL_PERMISSION_CAPABILITIES } from '../../../../main/permission-grants/defaults'
import {
  capabilityFromLegacyCategory,
  commandPrefixPermissionCategory
} from '../../../../main/permission-grants/capability'
import { i18next } from '@/i18n'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { useSettingsStore } from '@/stores/settings-store'
import { PermissionsPanel } from './PermissionsPanel'

let container: HTMLDivElement
let root: Root
let setDefaultPermissionProfile: ReturnType<typeof vi.fn>

const snapshot: PermissionGrantSnapshot = {
  version: 1,
  incompleteStores: [],
  missingDefaultGlobalGrantCount: 1,
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
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  usePermissionGrantsStore.setState({
    version: 0,
    grants: [],
    counts: { all: 0, global: 0, project: 0, session: 0 },
    incompleteStores: [],
    missingDefaultGlobalGrantCount: undefined,
    status: 'idle',
    error: undefined,
    undo: undefined,
    undoQueue: [],
    isRestoring: false,
    restoreDefaultsState: 'idle',
    loadedAt: null
  })
  useSettingsStore.setState({ defaultPermissionProfile: 'ask', settingsWriteError: undefined })
  setDefaultPermissionProfile = vi.fn(({ profile }: { profile: 'ask' | 'auto' | 'full' }) =>
    Promise.resolve({ defaultPermissionProfile: profile })
  )
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  await i18next.changeLanguage('en')
})

const setPermissionApi = (api: Partial<Window['api']['permissions']>): void => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { permissions: api, settings: { setDefaultPermissionProfile } }
  })
}

describe('PermissionsPanel', () => {
  it('PG01 distinguishes active same-name tools and opens each owning Connector', async () => {
    const servers = [
      { id: 'chemistry', name: 'chemistry-tools', displayName: 'Chemistry lab', enabled: true },
      { id: 'biology', name: 'biology-tools', displayName: 'Biology lab', enabled: true }
    ]
    const records: PermissionGrantRecord[] = servers.map((server) => ({
      id: `grant-${server.id}`,
      revision: 1,
      capability: { kind: 'mcp_tool', key: `mcp:${server.id}/search` },
      scope: { kind: 'global' }
    }))
    const projected = projectPermissionGrantSnapshot(records, {
      connectorPolicy: {
        customMcpServers: servers,
        askToolIds: servers.map((server) => `${server.name}/search`)
      }
    })
    expect(projected.grants.map((grant) => grant.effectiveState)).toEqual(['active', 'active'])
    const onOpenConnector = vi.fn()
    setPermissionApi({ list: vi.fn().mockResolvedValue(projected) })
    await act(async () => root.render(<PermissionsPanel onOpenConnector={onOpenConnector} />))

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="permission-row"]'))
    expect(rows).toHaveLength(2)
    for (const record of records) expect(container.textContent).not.toContain(record.id)
    expect.soft(new Set(rows.map((row) => row.textContent)).size).toBe(2)
    const revokeNames = rows.map((row) =>
      row.querySelector('[aria-label^="Revoke "]')?.getAttribute('aria-label')
    )
    expect.soft(new Set(revokeNames).size).toBe(2)
    for (const [index, server] of servers.entries()) {
      const row = rows[index]
      expect.soft(row.textContent).toContain(server.displayName)
      const details = Array.from(row.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => !button.getAttribute('aria-label')?.startsWith('Revoke ')
      )
      expect.soft(details).toBeDefined()
      await act(async () => details?.click())
      expect.soft(onOpenConnector).toHaveBeenCalledWith(server.id)
    }
  })

  it('PG01 distinguishes real command groups without exposing their digests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'permission-row-'))
    const client = createProjectDbClient(directory)
    try {
      await migrateApplicationDatabase(client)
      const registry = await createPermissionGrantRegistry({
        getClient: async () => client,
        now: () => new Date('2026-09-07T00:00:00Z')
      })
      const records: PermissionGrantRecord[] = []
      for (const prefix of [
        ['git', 'status'],
        ['git', 'diff']
      ]) {
        const capability = capabilityFromLegacyCategory(commandPrefixPermissionCategory(prefix)!)!
        records.push(await registry.remember({ capability, scope: { kind: 'global' } }))
      }
      const projected = projectPermissionGrantSnapshot(records)
      expect(records[0].capability).not.toEqual(records[1].capability)
      expect(JSON.stringify(projected)).not.toContain('sha256')
      setPermissionApi({ list: vi.fn().mockResolvedValue(projected) })
      await act(async () => root.render(<PermissionsPanel />))

      const rows = Array.from(
        container.querySelectorAll<HTMLElement>('[data-slot="permission-row"]')
      )
      expect(rows).toHaveLength(2)
      expect.soft(new Set(rows.map((row) => row.textContent)).size).toBe(2)
      expect
        .soft(
          new Set(
            rows.map((row) =>
              row.querySelector('[aria-label^="Revoke "]')?.getAttribute('aria-label')
            )
          ).size
        )
        .toBe(2)
      expect(rows.map((row) => row.textContent).join(' ')).toContain('Git: working tree status')
      expect(rows.map((row) => row.textContent).join(' ')).toContain('Git: changes')
      for (const record of records) expect(container.textContent).not.toContain(record.id)
      expect(projected.grants.map((grant) => grant.approvalSummary)).toEqual([
        'Git: working tree status',
        'Git: changes'
      ])
    } finally {
      await client.$disconnect()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('PG03 offers Restore defaults again after revoking a restored default', async () => {
    const records: PermissionGrantRecord[] = DEFAULT_GLOBAL_PERMISSION_CAPABILITIES.map(
      (capability, index) => ({
        id: `default-${index}`,
        revision: 1,
        capability,
        scope: { kind: 'global' }
      })
    )
    const missing = projectPermissionGrantSnapshot(
      records.slice(1),
      {},
      { version: 1, incompleteStores: [] }
    )
    const complete = projectPermissionGrantSnapshot(
      records,
      {},
      { version: 2, incompleteStores: [] }
    )
    const missingAgain = { ...missing, version: 3 }
    setPermissionApi({
      list: vi.fn().mockResolvedValue(missing),
      restoreDefaults: vi.fn().mockResolvedValue({ ...complete, restoredCount: 1 }),
      revoke: vi.fn().mockResolvedValue({
        ...missingAgain,
        conflicts: [],
        receipt: { undoToken: 'pg03', expiresAt: Date.now() + 8000, revokedCount: 1 }
      })
    })
    await act(async () => root.render(<PermissionsPanel />))
    const restore = container.querySelector<HTMLButtonElement>('[aria-label="Restore defaults"]')
    expect(restore).not.toBeNull()
    await act(async () => restore!.click())
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Defaults restored"]')?.disabled
    ).toBe(true)
    const revoke = container.querySelector<HTMLButtonElement>(
      `[aria-label^="Revoke ${complete.grants[0].capabilityLabel}"]`
    )
    expect(revoke).not.toBeNull()
    await act(async () => revoke!.click())

    expect(usePermissionGrantsStore.getState().missingDefaultGlobalGrantCount).toBe(1)
    expect.soft(container.querySelector('[aria-label="Defaults restored"]')).toBeNull()
    const restoreAgain = container.querySelector<HTMLButtonElement>(
      '[aria-label="Restore defaults"]'
    )
    expect(restoreAgain).not.toBeNull()
    expect(restoreAgain!.disabled).toBe(false)
  })

  it('keeps historical command groups explicit without claiming to know their commands', async () => {
    const projected = projectPermissionGrantSnapshot([
      {
        id: 'historical',
        revision: 1,
        createdAt: Date.UTC(2026, 8, 7),
        capability: capabilityFromLegacyCategory(
          commandPrefixPermissionCategory(['git', 'status'])!
        )!,
        scope: { kind: 'global' }
      }
    ])
    setPermissionApi({ list: vi.fn().mockResolvedValue(projected) })
    await act(async () => root.render(<PermissionsPanel />))
    const row = container.querySelector('[data-slot="permission-row"]')!
    expect(row.textContent).toContain('Command details unavailable for this permission')
    expect(row.textContent).toContain('Approved ')
    expect(row.textContent).not.toContain('Git: working tree status')
    expect(row.textContent).not.toContain('historical')
  })

  it.each(['zh-Hans', 'zh-Hant'] as const)(
    'PG04 localizes projected row details in %s while preserving user names',
    async (locale) => {
      const projected = projectPermissionGrantSnapshot(
        [
          {
            id: 'localized',
            revision: 1,
            capability: {
              kind: 'mcp_tool',
              key: 'mcp:chemistry/search',
              qualifier: { mode: 'any' }
            },
            scope: { kind: 'project', projectId: 'research' }
          }
        ],
        {
          projects: new Map([['research', '研究项目']]),
          connectorPolicy: {
            customMcpServers: [
              {
                id: 'chemistry',
                name: 'chemistry-tools',
                displayName: 'Chemistry lab',
                enabled: true
              }
            ]
          }
        }
      )
      await i18next.changeLanguage(locale)
      setPermissionApi({ list: vi.fn().mockResolvedValue(projected) })
      await act(async () => root.render(<PermissionsPanel onOpenConnector={vi.fn()} />))

      const row = container.querySelector<HTMLElement>('[data-slot="permission-row"]')!
      expect(row).not.toBeNull()
      expect(row.textContent).toContain('研究项目')
      expect
        .soft(row.textContent)
        .toContain(locale === 'zh-Hans' ? '项目：研究项目' : '專案：研究项目')
      expect.soft(row.textContent).not.toContain('Any call')
      expect.soft(row.textContent).not.toContain('Project:')
      expect
        .soft(row.textContent)
        .not.toContain('Allowed by Connector policy even without this permission')
      expect.soft(row.querySelector('[title]')?.getAttribute('title')).not.toContain('Project:')
    }
  )

  it('separates the new-conversation default from remembered permissions', async () => {
    setPermissionApi({
      list: vi.fn().mockResolvedValue({
        version: 1,
        incompleteStores: [],
        grants: [],
        counts: { all: 0, global: 0, project: 0, session: 0 }
      })
    })

    await act(async () => root.render(<PermissionsPanel />))

    expect(document.body.textContent).toContain('New conversations')
    expect(document.body.textContent).toContain('Remembered permissions')
    expect(
      document.body.querySelector('[aria-label="Default permission mode"]')?.textContent
    ).toContain('Ask for approval')
    expect(document.body.textContent).toContain('Applied only to new conversations')
  })

  it('saves Auto directly and confirms before making Full access the default', async () => {
    setPermissionApi({
      list: vi.fn().mockResolvedValue({
        version: 1,
        incompleteStores: [],
        grants: [],
        counts: { all: 0, global: 0, project: 0, session: 0 }
      })
    })
    await act(async () => root.render(<PermissionsPanel />))

    const openDefaultSelect = (): void => {
      const trigger = document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Default permission mode"]'
      )
      act(() => {
        trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }
    const choose = async (label: string): Promise<void> => {
      const option = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="option"]')
      ).find((candidate) => candidate.textContent?.includes(label))
      await act(async () => {
        option?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
        option?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    }

    openDefaultSelect()
    await choose('Auto-approve edits')
    expect(setDefaultPermissionProfile).toHaveBeenLastCalledWith({ profile: 'auto' })

    openDefaultSelect()
    await choose('Full access')
    expect(setDefaultPermissionProfile).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Use Full access by default?')
    const dialog = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]')
    ).find((candidate) => candidate.textContent?.includes('Use Full access by default?'))
    expect(dialog?.className).toContain('p-0')

    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Use Full access'
    )
    await act(async () => confirm?.click())

    expect(setDefaultPermissionProfile).toHaveBeenLastCalledWith({ profile: 'full' })
  })

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

  it('restores missing defaults without hiding other remembered permissions', async () => {
    const defaultGrant: PermissionGrantSnapshot['grants'][number] = {
      id: 'default-grant',
      revision: 1,
      family: 'skills',
      capabilityKind: 'skill_operation',
      capabilityLabel: 'Use Skills',
      scopeKind: 'global',
      scopeLabel: 'Global'
    }
    const restoreDefaults = vi.fn().mockResolvedValue({
      ...snapshot,
      version: 2,
      grants: [...snapshot.grants, defaultGrant],
      counts: { all: 2, global: 1, project: 0, session: 1 },
      missingDefaultGlobalGrantCount: 0,
      restoredCount: 1
    })
    setPermissionApi({
      list: vi.fn().mockResolvedValue(snapshot),
      restoreDefaults
    })

    await act(async () => root.render(<PermissionsPanel />))
    expect(document.body.textContent).toContain(
      'Restore missing default Global permissions without changing other remembered permissions.'
    )

    const restore = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Restore defaults"]'
    )
    await act(async () => restore?.click())

    await vi.waitFor(() => {
      expect(restoreDefaults).toHaveBeenCalledOnce()
      expect(
        document.body.querySelector<HTMLButtonElement>('[aria-label="Defaults restored"]')?.disabled
      ).toBe(true)
      expect(document.body.textContent).toContain('Shell')
      expect(document.body.textContent).toContain('Use Skills')
    })
  })

  it('disables restore when every default Global permission is already present', async () => {
    const restoreDefaults = vi.fn()
    setPermissionApi({
      list: vi.fn().mockResolvedValue({ ...snapshot, missingDefaultGlobalGrantCount: 0 }),
      restoreDefaults
    })

    await act(async () => root.render(<PermissionsPanel />))

    const restore = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Defaults restored"]'
    )
    expect(restore?.disabled).toBe(true)
    restore?.click()
    expect(restoreDefaults).not.toHaveBeenCalled()
  })

  it('uses the shared inline recovery notice for load failures', async () => {
    setPermissionApi({ list: vi.fn().mockRejectedValue(new Error('Permission load failed')) })

    await act(async () => root.render(<PermissionsPanel />))

    await vi.waitFor(() => {
      const alert = document.body.querySelector<HTMLElement>('[role="alert"]')
      expect(alert?.textContent).toContain('Permission load failed')
      expect(alert?.closest('section')?.className).toContain('border-border')
      expect(alert?.closest('section')?.className).toContain('bg-card')
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
    expect(
      document.body.querySelector('[aria-label="Revoke python · Project: Example project"]')
    ).not.toBeNull()
    expect(document.body.querySelector('h3')?.className).toContain('text-base')
    const permissionRow = document.body.querySelector<HTMLElement>('[data-slot="permission-row"]')
    expect(permissionRow?.className).toContain('min-h-11')
    expect(permissionRow?.className).toContain('py-1.5')
    const filterTrigger = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter permissions by scope"]'
    )
    expect(filterTrigger?.parentElement?.className).toContain('mb-2')
  })

  it('shows approval time for ordinary grants and leaves legacy time unknown', async () => {
    setPermissionApi({
      list: vi.fn().mockResolvedValue({
        ...snapshot,
        grants: [
          { ...snapshot.grants[0], createdAt: Date.UTC(2026, 8, 10) },
          { ...snapshot.grants[0], id: 'legacy' }
        ]
      })
    })
    await act(async () => root.render(<PermissionsPanel />))
    const rows = container.querySelectorAll('[data-slot="permission-row"]')
    expect(rows[0].textContent).toContain('Approved ')
    expect(rows[1].textContent).toContain('Approval time unknown')
  })

  it('renders grouped grants with a scope filter and per-row revoke control', async () => {
    setPermissionApi({ list: vi.fn().mockResolvedValue(snapshot) })

    await act(async () => root.render(<PermissionsPanel />))

    expect(document.body.textContent).toContain('All (1)')
    expect(document.body.textContent).toContain('Local compute')
    expect(document.body.textContent).toContain('Shell')
    expect(document.body.textContent).toContain('Session: Analyze samples')
    expect(document.body.textContent).toContain('Also allowed for this project')
    expect(
      document.body.querySelector('[aria-label="Revoke Shell · Session: Analyze samples"]')
    ).not.toBeNull()
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
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Revoke Shell · Session: Analyze samples"]')
        ?.click()
    })

    expect(revoke).toHaveBeenCalledWith({ grants: [{ id: 'grant-1', revision: 1 }] })
    expect(usePermissionGrantsStore.getState().undo).toMatchObject({
      token: 'undo-1',
      messageKey: 'Revoked {{family}} · {{capability}}',
      messageParams: { family: 'Local compute', capability: 'Shell' }
    })
  })

  it('keeps the restored permission list visible when revoke persistence fails', async () => {
    setPermissionApi({
      list: vi.fn().mockResolvedValue(snapshot),
      revoke: vi.fn().mockRejectedValue(new Error('database locked'))
    })
    await act(async () => root.render(<PermissionsPanel />))

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Revoke Shell · Session: Analyze samples"]')
        ?.click()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('database locked')
    expect(document.body.textContent).toContain('Shell')
    expect(
      document.body.querySelector('[aria-label="Revoke Shell · Session: Analyze samples"]')
    ).not.toBeNull()
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
      'The following permission details could not be loaded: Session names, Connector policy'
    )
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label*="Revoke all"]')?.disabled
    ).toBe(true)
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="Revoke Shell · Session: Analyze samples"]'
      )?.disabled
    ).toBeFalsy()
  })
})
