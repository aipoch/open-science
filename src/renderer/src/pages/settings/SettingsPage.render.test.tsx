// @vitest-environment jsdom
import { act, createRef, Profiler, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor } from '@testing-library/react'
import { Dialog } from 'radix-ui'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { LinkSafetyModal } from '@/components/streamdown/LinkSafetyModal'
import { APP } from '../../../../shared/app-config'
import type { ProviderView } from '../../../../shared/settings'
import type { SpecialistView } from '../../../../shared/specialist'
import { i18next } from '@/i18n'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { createInitialMemoryState, useMemoryStore } from '@/stores/memory-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { usePermissionGrantsStore } from '@/stores/permission-grants-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useRuntimeSettingsStore } from '@/stores/runtime-settings-store'
import { useStorageInfoStore } from '@/stores/storage-info-store'
import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { SettingsPage, type SettingsPageHandle } from './SettingsPage'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

let container: HTMLDivElement
let root: Root
const originalSettingsActions = (() => {
  const state = useSettingsStore.getState()
  return {
    persistProvider: state.persistProvider,
    validateProvider: state.validateProvider,
    addCustomServer: state.addCustomServer,
    updateCustomServer: state.updateCustomServer
  }
})()

// Settings feature modules are lazy in production. Pre-resolve their chunks for this broad legacy
// interaction suite so existing assertions remain focused on panel behavior rather than the shared
// Suspense boundary; lazy-loading itself has separate architecture coverage.
beforeAll(async () => {
  await Promise.all([
    import('./AgentPanel'),
    import('./ArchivedPanel'),
    import('./ComputeAddForm'),
    import('./ComputeHostDetail'),
    import('./ComputePanel'),
    import('./ConnectorAddForm'),
    import('./ConnectorDetailView'),
    import('./ConnectorExportView'),
    import('./ConnectorImportView'),
    import('./ConnectorsPanel'),
    import('./GeneralPanel'),
    import('./MemoryPanel'),
    import('./NetworkPanel'),
    import('./PermissionsPanel'),
    import('./RemoteControlPanel'),
    import('./RuntimesPanel'),
    import('./SkillsPanel'),
    import('./SpecialistsPanel'),
    import('./StoragePanel'),
    import('./TagsPanel'),
    import('./TokenUsagePanel')
  ])
})

// Minimal window.api surface the settings store touches when the dialog opens. Attached onto the
// real jsdom window so DOM globals radix relies on (getComputedStyle, etc.) stay intact.
const installApi = (): void => {
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getSettings: vi.fn().mockResolvedValue({
        claude: {},
        opencode: {},
        codex: {},
        codebuddy: {},
        providers: [],
        agentFrameworkId: 'claude-code',
        agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }]
      }),
      detectOpencode: vi.fn().mockResolvedValue({
        claude: {},
        opencode: {},
        codex: {},
        codebuddy: {},
        providers: [],
        agentFrameworkId: 'claude-code',
        agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }]
      }),
      detectCodex: vi.fn().mockResolvedValue({
        claude: {},
        opencode: {},
        codex: {},
        codebuddy: {},
        providers: [],
        agentFrameworkId: 'claude-code',
        agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }]
      }),
      detectCodeBuddy: vi.fn(() =>
        (
          window as unknown as { api: { settings: { getSettings: () => Promise<unknown> } } }
        ).api.settings.getSettings()
      ),
      getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
      isEncryptionAvailable: vi.fn().mockResolvedValue(true),
      isNpmAvailable: vi.fn().mockResolvedValue(true),
      listAppIcons: vi.fn().mockResolvedValue([]),
      setAppIconVariant: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
      listSkills: vi.fn().mockResolvedValue([
        {
          id: 'alpha',
          name: 'Alpha',
          displayName: 'Alpha',
          description: 'First',
          source: 'featured',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true
        }
      ]),
      onSkillCatalogChanged: vi.fn(() => vi.fn()),
      getSkillDetail: vi.fn().mockResolvedValue({
        id: 'alpha',
        name: 'Alpha',
        displayName: 'Alpha',
        description: 'First',
        source: 'featured',
        updatedAt: '2026-07-08T00:00:00.000Z',
        enabled: true,
        author: 'Test Author',
        license: 'Test License',
        body: '# Alpha body'
      }),
      listConnectors: vi.fn().mockResolvedValue({
        connectors: [
          {
            id: 'chemistry',
            displayName: 'Chemistry',
            description: 'Small-molecule chemistry via PubChem.',
            sources: ['PubChem'],
            requiresNcbi: false,
            enabled: true,
            autoAllow: false
          }
        ],
        customServers: [],
        ncbi: { hasApiKey: false }
      }),
      onConnectorRuntimeChanged: vi.fn().mockReturnValue(() => undefined),
      getPackageMirror: vi.fn().mockResolvedValue({}),
      setPackageMirror: vi.fn().mockResolvedValue({})
    },
    acp: {
      getState: vi.fn().mockResolvedValue({ promptInFlight: false, promptInFlightSessionIds: [] }),
      // AgentPanel subscribes to live prompt-in-flight state; the mock returns a no-op unsubscribe.
      onState: vi.fn().mockReturnValue(() => {}),
      cancel: vi.fn()
    },
    permissions: {
      list: vi.fn().mockResolvedValue({
        grants: [
          {
            id: 'grant-1',
            revision: 1,
            family: 'connectors',
            capabilityKind: 'mcp_tool',
            capabilityLabel: 'Search articles',
            scopeKind: 'project',
            scopeLabel: 'Project: Oncology review',
            projectId: 'project-1'
          }
        ],
        counts: { all: 1, global: 0, project: 1, session: 0 }
      }),
      onChanged: vi.fn().mockReturnValue(() => undefined)
    },
    logs: {
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        path: '/Users/x/Library/Logs/Open Science/main.log',
        existing: true,
        lastWriteSucceeded: true,
        lastFailureCategory: null
      }),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn().mockResolvedValue({ revealed: true })
    },
    notifications: {},
    storage: {
      getStatus: vi.fn().mockResolvedValue({
        dataRoot: '/Users/x/.open-science',
        isDefault: true,
        defaultDataRoot: '/Users/x/.open-science',
        defaultParent: '/Users/x',
        dataRootMissing: false,
        legacyDataMovePrompt: false
      }),
      getInfo: vi.fn().mockResolvedValue({
        dataRoot: '/Users/x/.open-science',
        isDefault: true,
        defaultDataRoot: '/Users/x/.open-science',
        defaultParent: '/Users/x',
        dataRootMissing: false,
        legacyDataMovePrompt: false,
        usage: { categories: [], totalBytes: 0 },
        availableBytes: 1_000_000_000
      })
    },
    sessions: {
      openRecoveryFolder: vi.fn().mockResolvedValue(undefined)
    },
    cli: {
      getStatus: vi.fn().mockResolvedValue({
        installed: false,
        target: '/Users/x/.local/bin/open-science',
        onPath: false
      }),
      install: vi.fn(),
      uninstall: vi.fn()
    },
    remoteAccess: {
      getSnapshot: vi.fn().mockResolvedValue({
        canManage: true,
        canManagePairing: true,
        mode: 'off',
        enabled: false,
        lifecycle: 'disabled',
        remoteIt: { installed: false, loggedIn: false, registered: false },
        pendingRequests: [],
        trustedBrowsers: []
      }),
      probe: vi.fn().mockResolvedValue({
        canManage: true,
        canManagePairing: true,
        mode: 'off',
        enabled: false,
        lifecycle: 'disabled',
        remoteIt: { installed: false, loggedIn: false, registered: false },
        pendingRequests: [],
        trustedBrowsers: []
      }),
      detect: vi.fn().mockResolvedValue({
        canManage: true,
        canManagePairing: true,
        mode: 'off',
        enabled: false,
        lifecycle: 'disabled',
        remoteIt: { installed: false, loggedIn: false, registered: false },
        pendingRequests: [],
        trustedBrowsers: []
      }),
      disable: vi.fn(),
      setMode: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      revokeBrowser: vi.fn(),
      onChanged: vi.fn(() => () => undefined)
    },
    specialist: {
      list: vi.fn().mockResolvedValue({
        items: [{ kind: 'reviewer', id: 'reviewer' }],
        integrity: { status: 'ok' }
      }),
      create: vi.fn(),
      setEnabled: vi.fn(),
      onCatalogChanged: vi.fn(() => vi.fn())
    },
    compute: {
      list: vi.fn().mockResolvedValue([])
    },
    memory: {
      snapshot: vi.fn().mockResolvedValue({
        revision: 1,
        enabled: false,
        categories: [
          {
            id: 'memory-category-about-you',
            systemKey: 'about-you',
            autoRecall: true,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            entries: []
          }
        ],
        projects: []
      }),
      setEnabled: vi.fn(),
      createCategory: vi.fn(),
      updateCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createEntry: vi.fn(),
      updateEntry: vi.fn(),
      deleteEntry: vi.fn(),
      clearAll: vi.fn(),
      onChanged: vi.fn(() => vi.fn())
    },
    tags: {
      snapshot: vi.fn().mockResolvedValue({
        revision: 1,
        tags: [{ id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 }],
        assignments: []
      }),
      onChanged: vi.fn(() => vi.fn())
    }
  }
}

beforeEach(() => {
  installApi()
  useSettingsStore.setState(createInitialSettingsState())
  useProjectStore.setState(createInitialProjectState())
  useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
  useSessionStore.setState(createInitialSessionState())
  useComputeStore.setState(createInitialComputeState())
  useMemoryStore.setState(createInitialMemoryState())
  useTagStore.setState(createInitialTagState())
  useRuntimeSettingsStore.setState({
    envs: null,
    enablement: {},
    loaded: false,
    checkedAt: null,
    busy: false,
    error: null,
    packageCounts: {},
    packageCountsLoaded: {}
  })
  useStorageInfoStore.setState({
    status: null,
    info: null,
    scannedAt: null,
    isLoading: false,
    isRefreshing: false,
    loadError: undefined
  })
  usePermissionGrantsStore.setState({
    version: 0,
    incompleteStores: [],
    grants: [],
    counts: { all: 0, global: 0, project: 0, session: 0 },
    status: 'idle',
    error: undefined,
    undo: undefined,
    undoQueue: [],
    isRestoring: false,
    loadedAt: null
  })
  // Editor drafts persist across mounts by design; keep tests independent of each other.
  useSpecialistStore.setState({
    items: [],
    isLoaded: false,
    loadError: undefined,
    integrity: { status: 'ok' },
    editorDrafts: {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  useSettingsStore.setState(originalSettingsActions)
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
  vi.unstubAllGlobals()
})

// Opens the Agent sub-panel via the left nav (the agent framework lives there; the Model panel
// itself shows providers).
const openAgentPanel = async (): Promise<void> => {
  const item = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings"] button')
  ).find((candidate) => candidate.textContent?.trim() === 'Agent')
  await act(async () => item?.click())
}

// Finds a left-nav button by its exact label.
const navButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings"] button')
  ).find((candidate) => candidate.textContent?.trim() === label)

const openCustomServerEditor = async (displayName: string): Promise<void> => {
  openRadixMenu(
    document.body.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${displayName}"]`)
  )
  const edit = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.trim() === 'Edit'
  )
  await act(async () => {
    clickRadixMenuItem(edit)
    await Promise.resolve()
  })
}

const selectSettingsOption = (label: string, option: string): void => {
  const trigger = document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (candidate) => candidate.textContent?.includes(option)
  )
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const settingsSection = (title: string): HTMLElement | undefined =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-slot="settings-section"]')).find(
    (section) => section.querySelector('h3')?.textContent?.trim() === title
  )

const installCustomProviderSnapshot = (): ProviderView => {
  const provider: ProviderView = {
    id: 'custom-messages',
    type: 'custom',
    name: 'Messages gateway',
    baseUrl: 'https://gateway.example',
    model: 'model-a',
    models: ['model-a'],
    apiEndpoints: ['anthropic'],
    supportsImageInput: false,
    hasKey: true,
    maskedKey: 'sk-…test',
    needsKey: false
  }
  window.api.settings.getSettings = vi.fn().mockResolvedValue({
    claude: {},
    opencode: { resolvedPath: '/x/opencode' },
    codex: {},
    providers: [provider],
    activeProviderId: provider.id,
    activeModel: provider.model,
    agentFrameworkId: 'opencode',
    agentFrameworks: [
      {
        id: 'opencode',
        displayName: 'OpenCode',
        supportedApiTypes: ['anthropic', 'openai'],
        supportsSkills: true
      }
    ]
  })
  return provider
}

describe('SettingsPage layout', () => {
  it('gives Memory a definite-height owner so its note list scrolls internally', async () => {
    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Memory')?.click())

    const panel = document.body.querySelector<HTMLElement>('[data-slot="memory-panel"]')
    expect(panel).not.toBeNull()
    expect(panel?.parentElement?.className.split(/\s+/)).toContain('h-full')
  })

  it('refreshes Memory from the backend every time its navigation option opens', async () => {
    const readMemory = vi.mocked(window.api.memory.snapshot)
    readMemory.mockResolvedValue({
      revision: 2,
      enabled: true,
      categories: [
        {
          id: 'memory-category-about-you',
          systemKey: 'about-you',
          autoRecall: true,
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
          entries: [
            {
              id: 'memory-entry-first',
              categoryId: 'memory-category-about-you',
              categoryName: null,
              projectId: 'project-a',
              projectName: 'Project A',
              content: 'First server memory',
              origin: 'agent',
              revision: 1,
              createdAt: 2,
              updatedAt: 2
            }
          ]
        }
      ],
      projects: []
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Memory')?.click())
    await waitFor(() => expect(document.body.textContent).toContain('First server memory'))
    await act(async () => navButton('General')?.click())

    readMemory.mockResolvedValue({
      revision: 3,
      enabled: true,
      categories: [
        {
          id: 'memory-category-about-you',
          systemKey: 'about-you',
          autoRecall: true,
          revision: 3,
          createdAt: 1,
          updatedAt: 3,
          entries: [
            {
              id: 'memory-entry-latest',
              categoryId: 'memory-category-about-you',
              categoryName: null,
              projectId: 'project-a',
              projectName: 'Project A',
              content: 'Latest agent-created memory',
              origin: 'agent',
              revision: 1,
              createdAt: 3,
              updatedAt: 3
            }
          ]
        }
      ],
      projects: []
    })
    await act(async () => navButton('Memory')?.click())

    await waitFor(() => expect(document.body.textContent).toContain('Latest agent-created memory'))
  })

  it('switches to a project from its Memory container and closes Settings', async () => {
    const onClose = vi.fn()
    useProjectStore.setState({
      projects: [
        {
          id: 'project-a',
          name: 'Project A',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 2
        }
      ],
      isLoaded: true
    })
    vi.mocked(window.api.memory.snapshot).mockResolvedValue({
      revision: 2,
      enabled: true,
      categories: [
        {
          id: 'memory-category-about-you',
          systemKey: 'about-you',
          autoRecall: true,
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
          entries: []
        }
      ],
      projects: [
        {
          projectId: 'project-a',
          name: 'Project A',
          archived: false,
          entries: [
            {
              id: 'project-memory',
              categoryId: null,
              categoryName: null,
              projectId: 'project-a',
              projectName: 'Project A',
              content: 'Project memory',
              origin: 'agent',
              revision: 1,
              createdAt: 2,
              updatedAt: 2
            }
          ]
        }
      ]
    })

    await act(async () => root.render(<SettingsPage open onClose={onClose} />))
    await act(async () => navButton('Memory')?.click())
    await waitFor(() => expect(document.body.textContent).toContain('Project A'))
    await act(async () =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Project A'))
        ?.click()
    )
    await act(async () =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Open project')
        ?.click()
    )

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: 'project-a'
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('opens a resource Tag through Settings history and returns to the catalog with Back', async () => {
    vi.mocked(window.api.tags.snapshot).mockResolvedValue({
      revision: 2,
      tags: [{ id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 }],
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.skill',
          resourceId: 'alpha',
          createdAt: 1
        }
      ]
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Skills')?.click())

    const tag = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Favorites'
    )
    expect(tag).toBeDefined()
    expect(document.body.querySelector('button button')).toBeNull()
    await act(async () => tag?.click())

    expect(document.body.querySelector('nav [aria-current="page"]')?.textContent?.trim()).toBe(
      'Tags'
    )
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(
      false
    )

    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )
    expect(document.body.querySelector('nav [aria-current="page"]')?.textContent?.trim()).toBe(
      'Skills'
    )
  })

  it('opens Tag creation as a breadcrumb-backed Settings sub-view', async () => {
    vi.mocked(window.api.tags.snapshot).mockResolvedValue({
      revision: 1,
      tags: [{ id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 }],
      assignments: []
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Tags')?.click())
    await waitFor(() =>
      expect(document.body.querySelector('[data-slot="tags-panel"]')).not.toBeNull()
    )

    const panel = document.body.querySelector<HTMLElement>('[data-slot="tags-panel"]')
    expect(panel?.parentElement?.className.split(/\s+/)).toContain('h-full')

    const newTag = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'New Tag'
    )
    await act(async () => newTag?.click())

    expect(document.body.querySelector('[data-slot="tag-form"]')).not.toBeNull()
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back to tags"]')
    ).not.toBeNull()
    expect(document.body.textContent).toContain('New Tag')

    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )
    expect(document.body.querySelector('[data-slot="tags-panel"]')).not.toBeNull()
    expect(document.body.querySelector('[data-slot="tag-form"]')).toBeNull()
  })

  it('restores the Tag selected by a Settings history entry', async () => {
    vi.mocked(window.api.tags.snapshot).mockResolvedValue({
      revision: 2,
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-research',
          name: 'Research',
          iconKey: 'book-open',
          colorKey: 'purple',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.skill',
          resourceId: 'alpha',
          createdAt: 1
        },
        {
          tagId: 'tag-research',
          resourceType: 'catalog.skill',
          resourceId: 'alpha',
          createdAt: 2
        }
      ]
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Skills')?.click())

    const favorite = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Favorites'
    )
    await act(async () => favorite?.click())
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )
    act(() => useTagStore.getState().setBrowserSelectedId('tag-research'))
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Forward"]')?.click()
    )

    const selectedTag = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('aside button')
    ).find((button) => button.getAttribute('aria-current') === 'page')
    expect(selectedTag?.textContent).toContain('Favorites')
  })

  it('preserves an in-panel Tag selection when returning from a resource', async () => {
    vi.mocked(window.api.tags.snapshot).mockResolvedValue({
      revision: 2,
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-research',
          name: 'Research',
          iconKey: 'book-open',
          colorKey: 'purple',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.skill',
          resourceId: 'alpha',
          createdAt: 1
        },
        {
          tagId: 'tag-research',
          resourceType: 'catalog.skill',
          resourceId: 'alpha',
          createdAt: 2
        }
      ]
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Skills')?.click())

    const favorite = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Favorites'
    )
    await act(async () => favorite?.click())

    const research = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('aside button')
    ).find((button) => button.textContent?.includes('Research'))
    await act(async () => research?.click())

    const resource = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('aside + section button')
    ).find((button) => button.textContent?.includes('Alpha'))
    await act(async () => resource?.click())
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )

    const selectedTag = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('aside button')
    ).find((button) => button.getAttribute('aria-current') === 'page')
    expect(selectedTag?.textContent).toContain('Research')
  })

  it('records the default Tag in history before navigating through a resource', async () => {
    vi.mocked(window.api.tags.snapshot).mockResolvedValue({
      revision: 2,
      tags: [
        { id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 },
        {
          id: 'tag-research',
          name: 'Research',
          iconKey: 'book-open',
          colorKey: 'purple',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.skill',
          resourceId: 'alpha',
          createdAt: 1
        },
        {
          tagId: 'tag-research',
          resourceType: 'catalog.skill',
          resourceId: 'alpha',
          createdAt: 2
        }
      ]
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Tags')?.click())

    const selectedDefault = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('aside button')
    ).find((button) => button.getAttribute('aria-current') === 'page')
    expect(selectedDefault?.textContent).toContain('Favorites')

    const resource = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('aside + section button')
    ).find((button) => button.textContent?.includes('Alpha'))
    await act(async () => resource?.click())

    const research = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Research'
    )
    await act(async () => research?.click())
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )

    const restoredDefault = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('aside button')
    ).find((button) => button.getAttribute('aria-current') === 'page')
    expect(restoredDefault?.textContent).toContain('Favorites')
  })

  it('renders the model-dependent reasoning effort explanation naturally in Japanese', async () => {
    await i18next.changeLanguage('ja')
    try {
      act(() => {
        root.render(<SettingsPage open onClose={vi.fn()} />)
      })

      expect(document.body.textContent).toContain(
        '選択肢は選択したモデルによって異なり、モデルを変更しても相対的な強度は維持されます。'
      )
    } finally {
      await i18next.changeLanguage('en')
    }
  })

  it('uses the header breadcrumb for archived project details', async () => {
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [
        {
          id: 'project-1',
          name: 'Archived project',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1,
          archivedAt: 2
        }
      ],
      isLoaded: true
    })
    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Archived')?.click())

    const manage = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Manage')
    )
    await act(async () => manage?.click())

    const backToArchived = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Back to archived"]'
    )
    expect(backToArchived?.textContent).toBe('Archived')
    expect(document.body.textContent).toContain('Archived project')
    expect(document.body.textContent).not.toContain('Archived projects')

    await act(async () => backToArchived?.click())
    expect(document.body.querySelector('[aria-label="Back to archived"]')).toBeNull()
  })

  it('keeps Feedback in a fixed footer and Archived in the scrollable Workspace group', async () => {
    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))

    const archived = navButton('Archived')
    const feedback = document.body.querySelector<HTMLAnchorElement>(
      `nav[aria-label="Settings"] a[href="${APP.links.githubFeedback}"]`
    )
    const scroll = document.body.querySelector<HTMLElement>(
      '[data-slot="settings-navigation-scroll"]'
    )
    const footer = document.body.querySelector<HTMLElement>(
      '[data-slot="settings-navigation-footer"]'
    )
    const workspaceGroup = Array.from(
      scroll?.querySelectorAll<HTMLElement>(':scope > div') ?? []
    ).find((group) => group.firstElementChild?.textContent?.trim() === 'Workspace')

    expect(scroll?.className).toContain('min-h-0')
    expect(scroll?.className).toContain('overflow-y-auto')
    expect(workspaceGroup?.contains(archived ?? null)).toBe(true)
    expect(feedback?.textContent?.trim()).toBe('Feedback')
    expect(feedback?.target).toBe('_blank')
    expect(footer?.className).toContain('shrink-0')
    expect(footer?.className).toContain('border-t')
    expect(footer?.contains(feedback ?? null)).toBe(true)
    expect(scroll?.nextElementSibling).toBe(footer)
  })

  it('shows and dismisses a settings write failure above the scrolling content', async () => {
    useSettingsStore.setState({
      settingsWriteError: 'Could not save notification preference. Try again.'
    })

    act(() => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const alert = document.body.querySelector<HTMLElement>('[data-slot="settings-write-error"]')
    const scroll = document.body.querySelector<HTMLElement>('[data-slot="settings-content-scroll"]')
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toContain('Could not save notification preference. Try again.')
    expect(alert?.className).toContain('border-danger-000/30')
    expect(alert?.className).toContain('bg-danger-000/10')
    expect(alert?.className).toContain('text-danger-000')
    expect(alert?.nextElementSibling).toBe(scroll)

    const dismiss = alert?.querySelector<HTMLButtonElement>('[aria-label="Dismiss settings error"]')
    await act(async () => dismiss?.focus())
    expect(document.body.textContent).toContain('Close')

    act(() => {
      dismiss?.click()
    })

    expect(useSettingsStore.getState().settingsWriteError).toBeUndefined()
    expect(document.body.querySelector('[data-slot="settings-write-error"]')).toBeNull()
  })

  it('mounts the sidebar + content with grouped nav items and a close control', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'p1',
          type: 'custom',
          name: 'Gateway',
          baseUrl: 'https://gateway.test/v1',
          model: 'test-model',
          models: ['test-model'],
          supportsImageInput: false,
          maskedKey: 'sk-a…wxyz',
          hasKey: true,
          needsKey: false,
          lastValidatedAt: 1
        }
      ],
      activeProviderId: 'p1',
      activeModel: 'test-model'
    })

    act(() => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    // Dialog content is portaled to the document body.
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-slot')).toBe('settings-surface')
    expect(dialog?.className).toContain('overscroll-contain')

    // Left navigation grouped as Capabilities (Skills, Connectors, Specialists, Memory, Compute, Network)
    // and Workspace (Model, Agent, Tags, Permissions, Credentials, Runtimes, Storage, Remote,
    // Usage, General, Archived). Feedback remains a separate fixed footer action.
    const nav = document.body.querySelector('nav[aria-label="Settings"]')
    expect(nav).not.toBeNull()
    expect(nav?.className).toContain('bg-background')
    expect(nav?.className).toContain('md:w-48')
    expect(nav?.className).toContain('w-[min(86vw,320px)]')
    expect(nav?.className).toContain('min-h-0')
    expect(nav?.className).toContain('overflow-hidden')
    const navScroll = nav?.querySelector<HTMLElement>('[data-slot="settings-navigation-scroll"]')
    const navFooter = nav?.querySelector<HTMLElement>('[data-slot="settings-navigation-footer"]')
    expect(navScroll?.className).toContain('overflow-y-auto')
    expect(navFooter?.className).toContain('border-t')
    expect(nav?.parentElement?.nextElementSibling?.className).toContain('bg-card')
    expect(nav?.textContent).toContain('Capabilities')
    expect(nav?.textContent).toContain('Workspace')
    expect(nav?.textContent).not.toContain('Remote access')
    const navItems = navScroll?.querySelectorAll('li') ?? []
    expect(navItems).toHaveLength(17)
    expect(navItems[0]?.textContent).toContain('Skills')
    expect(navItems[1]?.textContent).toContain('Connectors')
    expect(navItems[2]?.textContent).toContain('Specialists')
    expect(navItems[3]?.textContent).toContain('Memory')
    expect(navItems[4]?.textContent).toContain('Compute')
    expect(navItems[5]?.textContent).toContain('Network')
    expect(navItems[6]?.textContent).toContain('Model')
    expect(navItems[7]?.textContent).toContain('Agent')
    expect(navItems[8]?.textContent).toContain('Tags')
    expect(navItems[9]?.textContent).toContain('Permissions')
    expect(navItems[10]?.textContent).toContain('Credentials')
    expect(navItems[11]?.textContent).toContain('Runtimes')
    expect(navItems[12]?.textContent).toContain('Storage')
    expect(navItems[13]?.textContent?.trim()).toBe('Remote')
    expect(navItems[14]?.textContent).toContain('Usage')
    expect(navItems[15]?.textContent).toContain('General')
    expect(navItems[16]?.textContent).toContain('Archived')
    expect(navFooter?.textContent).toContain('Feedback')
    const modelNavButton = navButton('Model')
    const agentNavButton = navButton('Agent')
    expect(modelNavButton?.querySelector('.lucide-brain')).not.toBeNull()
    expect(agentNavButton?.querySelector('.lucide-bot')).not.toBeNull()
    expect(modelNavButton?.className).toContain('h-8')
    expect(agentNavButton?.className).toContain('h-8')
    expect(agentNavButton?.className).toContain('text-sm')
    expect(agentNavButton?.parentElement?.tagName).toBe('LI')
    // Model is the default active panel.
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toContain('Model')

    // The header shows the panel title and a close control.
    expect(document.body.querySelector('[aria-label="Close settings"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Back"]')?.getAttribute('data-slot')).toBe(
      'button'
    )
    expect(document.body.querySelector('[aria-label="Maximize"]')?.getAttribute('data-slot')).toBe(
      'button'
    )

    // The Model panel splits the Main model section (model + reasoning effort on one row),
    // the Scenario models accordion card (Subagent / Reviewer / Vision), and provider management;
    // agent framework moved to the Agent sub-panel.
    expect(document.body.textContent).toContain('Main model')
    expect(document.body.textContent).toContain('Reasoning effort')
    expect(document.body.textContent).toContain('preserve relative strength when models change')
    expect(document.body.textContent).toContain('may approximate unsupported levels')
    expect(document.body.textContent).toContain('Providers')
    expect(document.body.textContent).not.toContain('Agent framework')
    expect(document.body.querySelectorAll('[data-slot="settings-section"]')).toHaveLength(3)
    expect(
      Array.from(document.body.querySelectorAll('[data-slot="settings-section"]')).map((section) =>
        section.getAttribute('aria-label')
      )
    ).toEqual(['Main model', 'Scenario models', 'Providers'])
    const mainModel = Array.from(
      document.body.querySelectorAll('[data-slot="settings-section"]')
    ).find((section) => section.getAttribute('aria-label') === 'Main model')
    expect(mainModel?.querySelector('[aria-label="Reasoning effort"]')).not.toBeNull()
    expect(mainModel?.querySelector('[data-slot="settings-row"]')?.className).toContain(
      'grid-cols-1'
    )
    expect(mainModel?.querySelector('[data-slot="settings-row"]')?.className).toContain(
      'lg:grid-cols-[minmax(0,1fr)_auto]'
    )
    expect(document.body.textContent).toContain(
      'Models for session details, subagents, review, and image understanding.'
    )
    // The add action lives with the list as a dashed ghost row, not a section-header button.
    const addRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Add provider'
    )
    expect(addRow?.className).toContain('border-dashed')
  })

  it('uses the Compute preload once, then refreshes hosts on a later entry', async () => {
    const listHosts = vi.mocked(window.api.compute.list)

    await act(async () =>
      root.render(
        <StrictMode>
          <SettingsPage open onClose={vi.fn()} />
        </StrictMode>
      )
    )
    await act(async () => navButton('Compute')?.click())

    expect(listHosts).toHaveBeenCalledOnce()

    await act(async () => navButton('Model')?.click())
    await act(async () => navButton('Compute')?.click())

    expect(listHosts).toHaveBeenCalledTimes(2)
  })

  it('opens the Permissions panel from Workspace navigation', async () => {
    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Permissions')?.click())

    expect(document.body.querySelector('h2:not(.sr-only)')?.textContent).toBe('Permissions')
    expect(
      document.body.querySelector<HTMLButtonElement>('[aria-label="Filter permissions by scope"]')
        ?.textContent
    ).toContain('All (1)')
    expect(document.body.textContent).toContain('Search articles')
    expect(document.body.textContent).toContain('Project: Oncology review')
    expect(
      document.body.querySelector<HTMLElement>('[data-slot="settings-content-scroll"]')?.className
    ).toContain('overflow-y-auto')
    expect(
      document.body.querySelector<HTMLElement>('[aria-label="Filter permissions by scope"]')
        ?.parentElement?.className
    ).toContain('sticky')
  })

  it('forwards session scope navigation from the Permissions panel', async () => {
    const onOpenSession = vi.fn()
    vi.mocked(window.api.permissions.list).mockResolvedValue({
      version: 1,
      incompleteStores: [],
      grants: [
        {
          id: 'session-grant',
          revision: 1,
          family: 'file_operations',
          capabilityKind: 'file_operation',
          capabilityLabel: 'Edit',
          scopeKind: 'session',
          scopeLabel: 'Session: Analyze samples',
          projectId: 'project-1',
          sessionId: 'session-1'
        }
      ],
      counts: { all: 1, global: 0, project: 0, session: 1 }
    })

    await act(async () =>
      root.render(<SettingsPage open onClose={vi.fn()} onOpenSession={onOpenSession} />)
    )
    await act(async () => navButton('Permissions')?.click())
    await waitFor(() =>
      expect(
        document.body.querySelector<HTMLButtonElement>(
          '[aria-label="Open Session: Analyze samples"]'
        )
      ).not.toBeNull()
    )
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Open Session: Analyze samples"]')
        ?.click()
    )

    expect(onOpenSession).toHaveBeenCalledWith('session-1')
  })

  it('shows the agent framework on the Agent sub-panel', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    await openAgentPanel()

    expect(document.body.textContent).toContain('Agent framework')
    expect(document.body.textContent).not.toContain('Add provider')
    expect(document.body.querySelector('nav [aria-current="page"]')?.textContent?.trim()).toBe(
      'Agent'
    )
  })

  it('shows Repair for the failed selected runtime even when it has no detected path', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: false,
      opencodeReady: false,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: false,
      activeProviderReady: false
    })
    useSettingsStore.setState({
      environmentCheck: {
        checkedAt: 1,
        platform: 'darwin',
        architecture: 'arm64',
        ready: false,
        canAutoInstall: false,
        agentFrameworkId: 'claude-code',
        runtime: { found: false },
        checks: [
          {
            id: 'agent',
            label: 'Claude runtime',
            status: 'failed',
            summary: 'Claude is missing.',
            detail: 'No executable was found on PATH.'
          }
        ]
      }
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    expect(document.body.querySelector('[aria-label="Repair Claude Agent"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Repair OpenCode"]')).toBeNull()
    const repairNotice = document.body.querySelector('[aria-label="Agent runtime repair issues"]')
    expect(repairNotice?.textContent).toContain('Claude Code cannot be accessed.')
    expect(repairNotice?.textContent).toContain('Repair the selected agent before using it.')
    expect(repairNotice?.textContent).toContain('Claude runtime')
    expect(repairNotice?.textContent).toContain('Claude is missing.')
    expect(repairNotice?.textContent).not.toContain('No executable was found on PATH.')
  })

  it('opens repair from a failed Agent card and removes the notice after repair succeeds', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: false,
      opencodeReady: false,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: false,
      activeProviderReady: false
    })
    const failedEnvironment = {
      checkedAt: 1,
      platform: 'darwin' as const,
      architecture: 'arm64',
      ready: false,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code' as const,
      runtime: { found: false },
      checks: [
        {
          id: 'agent' as const,
          label: 'Claude runtime',
          status: 'failed' as const,
          summary: 'Claude is missing.'
        }
      ]
    }
    const repairedEnvironment = {
      ...failedEnvironment,
      checkedAt: 2,
      ready: true,
      runtime: { found: true, path: '/data/claude' },
      checks: []
    }
    const installClaude = vi.fn().mockResolvedValue({ installId: 'claude-test', ok: true })
    const checkEnvironment = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({ environmentCheck: repairedEnvironment })
      return repairedEnvironment
    })
    useSettingsStore.setState({
      environmentCheck: failedEnvironment,
      installClaude,
      checkEnvironment
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[aria-label="Repair required for Claude Agent"]')
        ?.click()
    })

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Claude Agent needs repair')
    const cancelButton = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent === 'Cancel')
    const repairButton = dialog?.querySelector<HTMLButtonElement>(
      '[aria-label="Repair Claude Agent"]'
    )
    expect(cancelButton?.dataset.size).toBe('default')
    expect(repairButton?.dataset.size).toBe(cancelButton?.dataset.size)

    openRadixMenu(repairButton)
    const managed = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('App-managed download (recommended)'))
    await act(async () => {
      clickRadixMenuItem(managed)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(installClaude).toHaveBeenCalledWith('managed', undefined)
    expect(checkEnvironment).toHaveBeenCalledWith({ force: true })
    expect(document.body.querySelector('[aria-label="Agent runtime repair issues"]')).toBeNull()
  })

  it('shows every failed Codex component in the Agent repair notice', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/usr/local/bin/codex-acp' },
      providers: [],
      agentFrameworkId: 'codex',
      agentFrameworks: [{ id: 'codex', displayName: 'Codex', supportsSkills: false }]
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: false,
      opencodeReady: false,
      codexReady: false,
      agentFrameworkId: 'codex',
      agentReady: false,
      activeProviderReady: false
    })
    useSettingsStore.setState({
      agentFrameworkId: 'codex',
      environmentCheck: {
        checkedAt: 1,
        platform: 'darwin',
        architecture: 'arm64',
        ready: false,
        canAutoInstall: false,
        agentFrameworkId: 'codex',
        runtime: { found: false },
        checks: [
          {
            id: 'agent',
            label: 'Codex native CLI',
            status: 'failed',
            summary: 'Native Codex CLI is not installed.'
          },
          {
            id: 'agent',
            label: 'Codex ACP adapter',
            status: 'failed',
            summary: 'Codex ACP adapter is not installed.'
          }
        ]
      }
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const repairNotice = document.body.querySelector('[aria-label="Agent runtime repair issues"]')
    expect(repairNotice?.textContent).toContain('Codex cannot be accessed.')
    expect(repairNotice?.textContent).toContain('Repair the selected agent before using it.')
    expect(repairNotice?.textContent).toContain('Codex native CLI')
    expect(repairNotice?.textContent).toContain('Native Codex CLI is not installed.')
    expect(repairNotice?.textContent).toContain('Codex ACP adapter')
    expect(repairNotice?.textContent).toContain('Codex ACP adapter is not installed.')
  })

  it('shows system and installation-network blockers above the Agent cards', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: false,
      opencodeReady: false,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: false,
      activeProviderReady: false
    })
    useSettingsStore.setState({
      environmentCheck: {
        checkedAt: 1,
        platform: 'darwin',
        architecture: 'arm64',
        ready: false,
        canAutoInstall: false,
        agentFrameworkId: 'claude-code',
        runtime: { found: false },
        checks: [
          {
            id: 'system',
            label: 'System compatibility',
            status: 'failed',
            summary: 'This host has no app-managed runtime package.'
          },
          {
            id: 'install-network',
            label: 'Installation network',
            status: 'failed',
            summary: 'Neither trusted registry is reachable.'
          }
        ]
      }
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const blocker = document.body.querySelector('[aria-label="Agent installation blockers"]')
    expect(blocker?.textContent).toContain('System compatibility')
    expect(blocker?.textContent).toContain('This host has no app-managed runtime package.')
    expect(blocker?.textContent).toContain('Installation network')
    expect(blocker?.textContent).toContain('Neither trusted registry is reachable.')

    const claudeInstallTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Install Claude Agent"]'
    )
    expect(claudeInstallTrigger).not.toBeNull()
    openRadixMenu(claudeInstallTrigger)
    const claudeManaged = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('App-managed download'))
    expect(claudeManaged?.getAttribute('data-disabled')).toBe('')

    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    openRadixMenu(document.body.querySelector<HTMLButtonElement>('[aria-label="Install OpenCode"]'))
    const opencodeManaged = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('App-managed download'))
    expect(opencodeManaged?.getAttribute('data-disabled')).toBeNull()
  })

  it('keeps Model and Agent as first-level tabs while navigating settings', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    expect(navButton('Model')?.parentElement?.tagName).toBe('LI')
    expect(navButton('Agent')?.parentElement?.tagName).toBe('LI')
    await act(async () => navButton('General')?.click())
    expect(navButton('Agent')).not.toBeUndefined()
    expect(navButton('Agent')?.tabIndex).toBe(0)
  })

  it('keeps Agent available when a skill mention deep-links into settings', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    await act(async () => {
      useSettingsStore.getState().openSettingsToSkill('alpha')
    })

    expect(navButton('Agent')?.parentElement?.tagName).toBe('LI')
    expect(navButton('Agent')?.tabIndex).toBe(0)
  })

  it('uses an off-canvas settings navigation on a narrow browser viewport', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(max-width: 767px)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      }))
    )

    const onClose = vi.fn()
    const settingsRef = createRef<SettingsPageHandle>()
    await act(async () => {
      root.render(<SettingsPage ref={settingsRef} open onClose={onClose} />)
    })
    const nav = document.body.querySelector<HTMLElement>('nav[aria-label="Settings"]')
    expect(nav?.getAttribute('aria-hidden')).toBe('true')
    expect(document.body.querySelector('[data-slot="settings-surface"]')?.className).toContain(
      'h-[100dvh]'
    )

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Open settings navigation"]')
        ?.click()
    })
    expect(nav?.getAttribute('aria-hidden')).toBeNull()
    const drawer = document.body.querySelector<HTMLElement>(
      '[data-slot="mobile-settings-navigation"]'
    )
    const content = document.body.querySelector<HTMLElement>('[data-slot="settings-main"]')
    expect(drawer?.getAttribute('role')).toBe('dialog')
    expect(drawer?.getAttribute('aria-modal')).toBe('true')
    expect(content?.hasAttribute('inert')).toBe(true)
    expect(content?.getAttribute('aria-hidden')).toBe('true')
    expect(nav?.contains(document.activeElement)).toBe(true)

    const generalTab = Array.from(nav?.querySelectorAll('button') ?? []).find((button) =>
      /general/i.test(button.textContent ?? '')
    )
    await act(async () => generalTab?.click())
    expect(nav?.getAttribute('aria-hidden')).toBe('true')
    expect(
      Array.from(document.body.querySelectorAll('h2')).some((heading) =>
        heading.textContent?.includes('General')
      )
    ).toBe(true)

    await act(async () => navButton('Model')?.click())
    const addProvider = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Add provider')
    act(() => addProvider?.click())
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Open settings navigation"]')
        ?.click()
    })
    act(() => {
      expect(settingsRef.current?.closeActivePane()).toBe(true)
    })
    expect(nav?.getAttribute('aria-hidden')).toBe('true')
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens Add provider as a history-driven sub-page and returns via the back arrow', () => {
    act(() => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const clickByText = (text: string): void => {
      const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent?.trim() === text
      )
      act(() => button?.click())
    }

    clickByText('Add provider')

    // The sub-page shows a "Model › Add provider" breadcrumb and the provider-type dropdown, hiding
    // the Claude section. There is no standalone in-content back arrow. With Claude Code as the
    // active framework, the type defaults to Anthropic.
    const crumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to model"]')
    expect(crumb).not.toBeNull()
    expect(document.body.textContent).toContain('Add provider')
    expect(document.body.querySelector('[aria-label="Back to providers"]')).toBeNull()
    const typeTrigger = document.body.querySelector('[aria-label="Provider type"]')
    expect(typeTrigger).not.toBeNull()
    expect(typeTrigger?.textContent).toContain('Anthropic')
    expect(document.body.querySelector('section[aria-label="Claude"]')).toBeNull()

    // The shared top back arrow exits the form back to the provider list.
    const back = document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')
    act(() => back?.click())
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Provider type"]')).toBeNull()

    // Forward re-enters the form as a history location.
    const forward = document.body.querySelector<HTMLButtonElement>('[aria-label="Forward"]')
    act(() => forward?.click())
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()

    // The breadcrumb root crumb returns to the provider list too.
    const rootCrumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to model"]')
    act(() => rootCrumb?.click())
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()
  })

  it('opens Usage as a standalone history-driven settings panel', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const usageEntry = navButton('Usage')
    expect(usageEntry).not.toBeNull()
    await act(async () => usageEntry?.click())
    await waitFor(() =>
      expect(document.body.querySelector('[data-slot="token-usage-panel"]')).not.toBeNull()
    )

    expect(document.body.querySelector('[data-slot="token-usage-panel"]')).not.toBeNull()
    expect(
      document.body.querySelector('nav[aria-label="Settings"] [aria-current="page"]')?.textContent
    ).toContain('Usage')
    expect(document.body.querySelector('[aria-label="Back to model"]')).toBeNull()

    const back = document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')
    act(() => back?.click())
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()

    const forward = document.body.querySelector<HTMLButtonElement>('[aria-label="Forward"]')
    act(() => forward?.click())
    expect(document.body.querySelector('[data-slot="token-usage-panel"]')).not.toBeNull()
  })

  it('closes a nested dialog, then a breadcrumb, then Settings with the close-pane shortcut', () => {
    const onClose = vi.fn()
    const settingsRef = createRef<SettingsPageHandle>()
    act(() => {
      root.render(<SettingsPage ref={settingsRef} open onClose={onClose} />)
    })

    const addProvider = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Add provider')
    act(() => addProvider?.click())
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()

    act(() => {
      root.render(
        <>
          <SettingsPage ref={settingsRef} open onClose={onClose} />
          <Dialog.Root defaultOpen>
            <Dialog.Portal>
              <Dialog.Content>
                <Dialog.Title>Nested Settings dialog</Dialog.Title>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </>
      )
    })
    expect(document.body.textContent).toContain('Nested Settings dialog')

    act(() => {
      expect(settingsRef.current?.closeActivePane()).toBe(true)
    })
    expect(document.body.textContent).not.toContain('Nested Settings dialog')
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    const inlineDialog = document.createElement('div')
    inlineDialog.setAttribute('role', 'dialog')
    inlineDialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(inlineDialog)
    act(() => {
      expect(settingsRef.current?.closeActivePane()).toBe(true)
    })
    inlineDialog.remove()
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()
    expect(document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(
      true
    )
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      expect(settingsRef.current?.closeActivePane()).toBe(true)
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('dispatches the close-pane Escape to an active link-safety dialog', () => {
    const settingsRef = createRef<SettingsPageHandle>()
    const onLinkClose = vi.fn()
    act(() => {
      root.render(
        <>
          <SettingsPage ref={settingsRef} open onClose={vi.fn()} />
          <LinkSafetyModal
            url="https://example.com/paper"
            isOpen
            onClose={onLinkClose}
            onConfirm={vi.fn()}
          />
        </>
      )
    })

    act(() => {
      expect(settingsRef.current?.closeActivePane()).toBe(true)
    })

    expect(onLinkClose).toHaveBeenCalledOnce()
  })

  it('defaults the Add provider type to the framework vendor (Codex → OpenAI, OpenCode → DeepSeek)', async () => {
    // Claude Code → Anthropic is covered by the history-navigation test above.
    const scenarios = [
      { framework: 'codex', runtime: { codex: { resolvedPath: '/x/codex' } }, label: 'OpenAI' },
      {
        framework: 'opencode',
        runtime: { opencode: { resolvedPath: '/x/opencode' } },
        label: 'DeepSeek'
      }
    ] as const

    for (const { framework, runtime, label } of scenarios) {
      await act(async () => {
        root.render(<SettingsPage open onClose={vi.fn()} />)
      })
      // Set the framework after the initial load() settles, and give the runtime a resolved path
      // so the detect-on-view effect doesn't overwrite it.
      useSettingsStore.setState({ agentFrameworkId: framework, ...runtime })

      const addProvider = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button')
      ).find((button) => button.textContent?.trim() === 'Add provider')
      act(() => addProvider?.click())

      expect(document.body.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
        label
      )

      act(() => root.unmount())
      container.remove()
      document.body.innerHTML = ''
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    }
  })

  it('defaults a custom gateway to the active framework API format', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    useSettingsStore.setState({
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['anthropic', 'openai'],
          supportsSkills: true
        }
      ],
      opencode: { resolvedPath: '/x/opencode' }
    })

    const addProvider = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Add provider')
    act(() => addProvider?.click())

    openRadixMenu(document.body.querySelector<HTMLElement>('[aria-label="Provider type"]'))
    const customGateway = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((option) => option.textContent?.includes('Custom Gateway'))
    clickRadixMenuItem(customGateway)

    expect(document.body.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/chat/completions'
    )
  })

  it('preserves the saved API format when editing a custom gateway', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'custom-messages',
      type: 'custom',
      name: 'Messages gateway',
      baseUrl: 'https://gateway.example',
      model: 'model-a',
      models: ['model-a'],
      apiEndpoints: ['anthropic'],
      supportsImageInput: false,
      hasKey: true,
      maskedKey: 'sk-…test',
      needsKey: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: { resolvedPath: '/x/opencode' },
      codex: {},
      providers: [provider],
      activeProviderId: provider.id,
      activeModel: provider.model,
      agentFrameworkId: 'opencode',
      agentFrameworks: [
        {
          id: 'opencode',
          displayName: 'OpenCode',
          supportedApiTypes: ['anthropic', 'openai'],
          supportsSkills: true
        }
      ]
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      opencodeReady: true,
      agentFrameworkId: 'opencode',
      agentReady: true,
      activeProviderReady: true
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.click()
    })

    expect(document.body.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
      'Custom Gateway'
    )
    expect(document.body.querySelector('[aria-label="API format"]')?.textContent).toContain(
      '/v1/messages'
    )
  })

  it('blocks Provider save and preserves the draft when a live refresh removes the target', async () => {
    const provider = installCustomProviderSnapshot()
    const persistProvider = vi.fn().mockResolvedValue(provider.id)
    useSettingsStore.setState({
      persistProvider,
      validateProvider: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.click()
    })

    fireEvent.change(document.body.querySelector<HTMLInputElement>('[aria-label="API key"]')!, {
      target: { value: 'replacement-key' }
    })
    act(() => useSettingsStore.setState({ providers: [] }))

    const save = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    expect(document.body.textContent).toContain(
      'This Provider no longer exists. Your draft has not been saved.'
    )
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="API key"]')?.value).toBe(
      'replacement-key'
    )
    expect(save?.disabled).toBe(true)
    expect(persistProvider).not.toHaveBeenCalled()
  })

  it('marks a Provider edit save as requiring the existing target', async () => {
    const provider = installCustomProviderSnapshot()
    const persistProvider = vi.fn().mockResolvedValue(provider.id)
    useSettingsStore.setState({
      persistProvider,
      validateProvider: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.click()
    )
    await act(async () =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Save')
        ?.click()
    )

    expect(persistProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: provider.id, requireExisting: true })
    )
  })

  it('reports when post-save Provider validation does not complete', async () => {
    installCustomProviderSnapshot()
    const validateProvider = vi.fn().mockRejectedValue(new Error('settings IPC unavailable'))
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('custom-messages'),
      validateProvider
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.click()
    )
    await act(async () =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Save')
        ?.click()
    )

    await waitFor(() => {
      expect(validateProvider).toHaveBeenCalledWith({ providerId: 'custom-messages' })
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not test the provider connection.'
      )
    })
  })

  it('ignores an older post-save Provider validation failure', async () => {
    installCustomProviderSnapshot()
    let rejectFirstValidation: ((error: Error) => void) | undefined
    let resolveSecondValidation: (() => void) | undefined
    const validateProvider = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirstValidation = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecondValidation = resolve
          })
      )
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('custom-messages'),
      validateProvider
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.click()
    )
    await act(async () =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Save')
        ?.click()
    )
    await waitFor(() => expect(validateProvider).toHaveBeenCalledTimes(1))

    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.click()
    )
    await act(async () =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Save')
        ?.click()
    )
    await waitFor(() => expect(validateProvider).toHaveBeenCalledTimes(2))

    await act(async () => rejectFirstValidation?.(new Error('stale settings IPC failure')))

    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').not.toContain(
      'Could not test the provider connection.'
    )
    expect(document.body.textContent).toContain('Testing…')

    await act(async () => resolveSecondValidation?.())
    await waitFor(() => expect(document.body.textContent).not.toContain('Testing…'))
  })

  it('ignores post-save Provider validation after the provider disappears', async () => {
    installCustomProviderSnapshot()
    let rejectValidation: ((error: Error) => void) | undefined
    const validateProvider = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectValidation = reject
        })
    )
    useSettingsStore.setState({
      persistProvider: vi.fn().mockResolvedValue('custom-messages'),
      validateProvider
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Edit"]')?.click()
    )
    await act(async () =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'Save')
        ?.click()
    )
    await waitFor(() => expect(validateProvider).toHaveBeenCalledOnce())

    act(() => useSettingsStore.setState({ providers: [] }))
    await act(async () => rejectValidation?.(new Error('deleted provider validation failure')))

    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').not.toContain(
      'Could not test the provider connection.'
    )
  })

  it('switches to the General panel and shows the diagnostic log file', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const generalTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /general/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    expect(generalTab).not.toBeUndefined()

    await act(async () => {
      generalTab?.click()
    })

    // Appearance, AppVersion, Notifications, App icon, Diagnostics, Command line tool, Community.
    expect(document.body.querySelectorAll('[data-slot="settings-section"]')).toHaveLength(7)
    expect(document.body.querySelector('[data-slot="settings-row"]')).not.toBeNull()

    // The Diagnostics panel surfaces the log file path plus Open and Reveal controls.
    expect(document.body.textContent).toContain('main.log')
    const buttons = Array.from(document.body.querySelectorAll('button'))
    const openButton = buttons.find((button) => /^open$/i.test((button.textContent ?? '').trim()))
    const revealButton = buttons.find((button) =>
      /^reveal$/i.test((button.textContent ?? '').trim())
    )
    expect(openButton).not.toBeUndefined()
    expect(revealButton).not.toBeUndefined()

    await act(async () => {
      openButton?.click()
    })

    expect(
      (window as unknown as { api: { logs: { openFile: ReturnType<typeof vi.fn> } } }).api.logs
        .openFile
    ).toHaveBeenCalledTimes(1)

    await act(async () => {
      revealButton?.click()
    })

    expect(
      (window as unknown as { api: { logs: { revealInFolder: ReturnType<typeof vi.fn> } } }).api
        .logs.revealInFolder
    ).toHaveBeenCalledTimes(1)
  })

  it('does not enable log actions for a configured path whose file does not exist', async () => {
    const logs = (
      window as unknown as {
        api: {
          logs: {
            getStatus: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.logs
    logs.getStatus.mockResolvedValueOnce({
      configured: true,
      path: '/Users/x/Library/Logs/Open Science/main.log',
      existing: false,
      lastWriteSucceeded: null,
      lastFailureCategory: null
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('General')?.click())

    const buttons = Array.from(document.body.querySelectorAll('button'))
    const openButton = buttons.find((button) => /^open$/i.test((button.textContent ?? '').trim()))
    const revealButton = buttons.find((button) =>
      /^reveal$/i.test((button.textContent ?? '').trim())
    )
    expect(openButton?.disabled).toBe(true)
    expect(revealButton?.disabled).toBe(true)
  })

  it('opens the Remote panel with three scenario-based access modes', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const remoteTab = navButton('Remote')
    expect(remoteTab).not.toBeUndefined()

    await act(async () => remoteTab?.click())
    expect(document.body.textContent).toContain('Remote browser access')
    expect(document.body.textContent).toContain('Off')
    expect(document.body.textContent).toContain('App access')
    expect(document.body.textContent).toContain('Browser access')
    const remoteItDownload = document.body.querySelector<HTMLAnchorElement>(
      'a[href="https://www.remote.it/download/"]'
    )
    expect(remoteItDownload?.textContent).toBe('Download Remote.It App')
    expect(remoteItDownload?.className).toContain('underline')
    expect(remoteItDownload?.className).toContain('bg-primary/10')
    expect(remoteItDownload?.querySelector('svg')).not.toBeNull()
    expect(remoteItDownload?.closest('[data-slot="settings-section"]')).toBe(
      settingsSection('Remote browser access')
    )
    expect(remoteItDownload?.closest('button')).toBeNull()
    expect(settingsSection('Remote App Access')).toBeUndefined()
    expect(settingsSection('Remote Browser Access')).toBeUndefined()
    expect(document.body.textContent).not.toContain('Trusted browsers')
    expect(document.body.textContent).not.toContain('Pairing requests')
    const status = document.body.querySelector('[data-testid="remote-access-status"]')
    expect(status?.textContent).toBe('Remote access is off')
    expect(status?.className).toContain('sm:absolute')
    expect(status?.className).toContain('sm:right-0')
    expect(status?.className).toContain('sm:top-0')
    expect(status?.parentElement?.className).toContain('w-full')
    expect(status?.parentElement?.className).toContain('sm:w-auto')
    expect(document.body.textContent).not.toContain('Recommended')
    expect(status?.closest('[data-slot="settings-section"]')).toBe(
      settingsSection('Remote browser access')
    )
    expect(
      document.body.querySelector('[data-testid="remote-control-panel"]')?.className
    ).toContain('space-y-5')
    expect(settingsSection('Remote browser access')?.lastElementChild?.className).toContain(
      'space-y-3'
    )
    const modeGrid = document.body.querySelector(
      '[role="radiogroup"][aria-label="Remote access mode"]'
    )
    expect(modeGrid?.className).toContain('grid-cols-1')
    expect(modeGrid?.className).toContain('sm:grid-cols-3')
    expect(document.body.textContent).not.toContain('route on exit')
    expect(document.body.textContent).not.toContain('service on exit')
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            probe: ReturnType<typeof vi.fn>
            detect: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    expect(remoteAccess.probe).toHaveBeenCalledOnce()
    expect(remoteAccess.detect).not.toHaveBeenCalled()
  })

  it('shows retained trusted-browser expiry and revocation controls while access is off', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const snapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      remoteIt: { installed: true, loggedIn: true, registered: true },
      pendingRequests: [],
      trustedBrowsers: [
        {
          id: 'trusted-browser',
          browser: 'Safari',
          platform: 'macOS',
          createdAt: Date.now() - 1_000,
          lastSeenAt: Date.now(),
          expiresAt: Date.now() + 180 * 24 * 60 * 60 * 1_000
        }
      ]
    }
    remoteAccess.getSnapshot.mockResolvedValue(snapshot)
    remoteAccess.probe.mockResolvedValue(snapshot)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    expect(document.body.textContent).toContain('Trusted browsers')
    expect(document.body.textContent).toContain('Safari · macOS')
    expect(document.body.textContent).toContain('Expires')
    expect(document.body.textContent).toContain(
      'Remote access is paused. Provider setup and trusted browsers are kept for reuse.'
    )
    expect(document.body.textContent).not.toContain('permanent access')
    expect(document.body.querySelector('button[aria-label="Revoke Safari"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Pairing requests')
  })

  it('exits loading when the initial remote access snapshot fails', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const retrySnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      remoteIt: { installed: false, loggedIn: false, registered: false },
      pendingRequests: [],
      trustedBrowsers: []
    }
    let finishRetry!: (snapshot: typeof retrySnapshot) => void
    remoteAccess.getSnapshot
      .mockRejectedValueOnce(new Error('Remote access is unavailable.'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve
          })
      )

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    expect(document.body.textContent).not.toContain('Loading remote access')
    expect(document.body.textContent).toContain('Remote access is unavailable.')
    const retryButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Try again')
    )
    expect(retryButton).not.toBeUndefined()

    act(() => {
      retryButton?.click()
      retryButton?.click()
    })

    expect(remoteAccess.getSnapshot).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Loading remote access')
    expect(document.body.textContent).not.toContain('Try again')

    await act(async () => {
      finishRetry(retrySnapshot)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.textContent).not.toContain('Remote access is unavailable.')
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Remote access is off'
    )
  })

  it('does not probe after leaving the Remote panel during the initial snapshot load', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const manageableSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      remoteIt: { installed: false, loggedIn: false, registered: false },
      pendingRequests: [],
      trustedBrowsers: []
    }
    let finishInitialLoad!: (snapshot: typeof manageableSnapshot) => void
    remoteAccess.getSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitialLoad = resolve
        })
    )

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Remote')?.click())
    expect(document.body.textContent).toContain('Loading remote access')

    act(() => navButton('Model')?.click())
    await act(async () => {
      finishInitialLoad(manageableSnapshot)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(remoteAccess.probe).not.toHaveBeenCalled()
  })

  it('does not probe after leaving the Remote panel during an initial-load retry', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const manageableSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      remoteIt: { installed: false, loggedIn: false, registered: false },
      pendingRequests: [],
      trustedBrowsers: []
    }
    let finishRetry!: (snapshot: typeof manageableSnapshot) => void
    remoteAccess.getSnapshot
      .mockRejectedValueOnce(new Error('Remote access is unavailable.'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve
          })
      )

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Remote')?.click())
    const retryButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Try again')
    )
    act(() => retryButton?.click())

    act(() => navButton('Model')?.click())
    await act(async () => {
      finishRetry(manageableSnapshot)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(remoteAccess.probe).not.toHaveBeenCalled()
  })

  it('reuses the remote access snapshot when the panel is reopened within 60 seconds', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const manageableSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      remoteIt: { installed: false, loggedIn: false, registered: false },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(manageableSnapshot)
    remoteAccess.probe.mockResolvedValue(manageableSnapshot)

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Remote')?.click())
    await act(async () => navButton('Model')?.click())
    await act(async () => navButton('Remote')?.click())

    expect(remoteAccess.getSnapshot).toHaveBeenCalledOnce()
    expect(remoteAccess.probe).toHaveBeenCalledOnce()
  })

  it('invalidates the remote access cache when a pairing request arrives while the panel is closed', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            onChanged: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const initialSnapshot = {
      canManage: false,
      canManagePairing: true,
      mode: 'remoteit' as const,
      enabled: true,
      lifecycle: 'running' as const,
      remoteIt: { installed: true, loggedIn: true, registered: true },
      pendingRequests: [],
      trustedBrowsers: []
    }
    const updatedSnapshot = {
      ...initialSnapshot,
      pendingRequests: [
        {
          id: 'pending-after-close',
          code: '654321',
          browser: 'Safari',
          platform: 'macOS',
          requestedAt: Date.now(),
          expiresAt: Date.now() + 60_000
        }
      ]
    }
    remoteAccess.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(updatedSnapshot)

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Remote')?.click())
    await act(async () => navButton('Model')?.click())

    const lifecycleListener = remoteAccess.onChanged.mock.calls[0]?.[0] as (() => void) | undefined
    act(() => lifecycleListener?.())
    await act(async () => navButton('Remote')?.click())

    expect(remoteAccess.getSnapshot).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('Safari · macOS')
    expect(document.body.textContent).toContain('654321')
  })

  it('does not let an older initial probe overwrite a newer lifecycle snapshot', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
            onChanged: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const initialSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'disabled',
      remoteIt: { installed: false, loggedIn: false, registered: false },
      pendingRequests: [],
      trustedBrowsers: []
    }
    const eventSnapshot = {
      ...initialSnapshot,
      mode: 'remoteit-public',
      enabled: true,
      lifecycle: 'running',
      remoteIt: { installed: true, loggedIn: true, registered: true }
    }
    let finishInitialProbe!: (snapshot: typeof initialSnapshot) => void
    remoteAccess.getSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(eventSnapshot)
    remoteAccess.probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishInitialProbe = resolve
        })
    )

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Remote')?.click())
    expect(remoteAccess.probe).toHaveBeenCalledOnce()

    const lifecycleListener = remoteAccess.onChanged.mock.calls[0]?.[0] as (() => void) | undefined
    await act(async () => {
      lifecycleListener?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Browser access is on'
    )

    await act(async () => {
      finishInitialProbe(initialSnapshot)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Browser access is on'
    )
  })

  it('covers the whole app while a remote mode system command is still running', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            setMode: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
            detect: ReturnType<typeof vi.fn>
            onChanged: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const enabledSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit',
      enabled: true,
      lifecycle: 'running',
      remoteIt: {
        installed: true,
        loggedIn: true,
        registered: true,
        service: {
          id: 'service-1',
          host: '127.0.0.1',
          port: 44100,
          enabled: true,
          ready: true
        }
      },
      pendingRequests: [],
      trustedBrowsers: []
    }
    let finishModeChange!: (snapshot: typeof enabledSnapshot) => void
    remoteAccess.setMode.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishModeChange = resolve
        })
    )

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())
    const remoteItMode = document.body.querySelector<HTMLInputElement>(
      'input[name="remote-access-mode"][aria-label="App access"]'
    )

    act(() => remoteItMode?.click())

    expect(remoteAccess.setMode).toHaveBeenCalledTimes(1)
    const overlay = document.body.querySelector('[data-testid="remote-access-operation-overlay"]')
    const scrim = document.body.querySelector('[data-testid="remote-access-operation-scrim"]')
    expect(scrim).not.toBeNull()

    expect(overlay).not.toBeNull()
    expect(overlay?.textContent).toContain('Applying remote access settings')
    expect(scrim?.className).toContain('fixed')
    expect(scrim?.className).toContain('inset-0')
    expect(overlay?.getAttribute('role')).toBe('dialog')
    expect(overlay?.getAttribute('aria-modal')).toBe('true')
    expect(overlay?.contains(document.activeElement)).toBe(true)
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Changing access mode…'
    )

    // The main process broadcasts lifecycle progress before the provider command has finished.
    // Refreshing that progress must not dismiss the global operation overlay.
    remoteAccess.getSnapshot.mockResolvedValue({
      ...enabledSnapshot,
      enabled: false,
      lifecycle: 'starting'
    })
    const lifecycleListener = remoteAccess.onChanged.mock.calls[0]?.[0] as (() => void) | undefined
    await act(async () => {
      lifecycleListener?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      document.body.querySelector('[data-testid="remote-access-operation-overlay"]')
    ).not.toBeNull()
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Changing access mode…'
    )

    await act(async () => {
      finishModeChange(enabledSnapshot)
      await Promise.resolve()
    })
    expect(
      document.body.querySelector('[data-testid="remote-access-operation-overlay"]')
    ).toBeNull()
    expect(document.activeElement).toBe(remoteItMode)
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'App access is on'
    )

    let finishDetection!: (snapshot: typeof enabledSnapshot) => void
    remoteAccess.detect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDetection = resolve
        })
    )
    const detectButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Detect again')
    )
    act(() => detectButton?.click())
    const detectOverlay = document.body.querySelector(
      '[data-testid="remote-access-operation-overlay"]'
    )
    expect(detectOverlay?.textContent).toContain('Checking and setting up remote access')
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Checking access…'
    )

    await act(async () => {
      finishDetection(enabledSnapshot)
      await Promise.resolve()
    })
    expect(
      document.body.querySelector('[data-testid="remote-access-operation-overlay"]')
    ).toBeNull()
  })

  it('surfaces a provider detection error while access is Off', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const staleOffSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'off',
      enabled: false,
      lifecycle: 'error',
      error: 'The remote access app is not connected.',
      remoteIt: { installed: true, loggedIn: true, registered: true },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(staleOffSnapshot)
    remoteAccess.probe.mockResolvedValue(staleOffSnapshot)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    expect(document.body.textContent).toContain('The remote access app is not connected')
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Remote access is off'
    )
  })

  it('keeps a failed provider selected and shows only that mode error', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const appErrorSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'error',
      error: 'The remote access app is installed but not signed in.',
      remoteIt: { installed: true, loggedIn: false, registered: false },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(appErrorSnapshot)
    remoteAccess.probe.mockResolvedValue(appErrorSnapshot)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[name="remote-access-mode"][aria-label="App access"]'
      )?.checked
    ).toBe(true)
    expect(document.body.textContent).toContain(
      'The remote access app is installed but not signed in'
    )
    expect(document.body.querySelector('[data-testid="remote-access-status"]')?.textContent).toBe(
      'Needs attention'
    )
    expect(settingsSection('Remote App Access')).not.toBeUndefined()
    expect(settingsSection('Remote Browser Access')).toBeUndefined()
  })

  it.each([
    {
      mode: 'remoteit',
      accessUrl: undefined,
      currentSection: 'Remote App Access',
      otherSection: 'Remote Browser Access'
    },
    {
      mode: 'remoteit-public',
      accessUrl: 'https://open-science.connect.remote.it/',
      currentSection: 'Remote Browser Access',
      otherSection: 'Remote App Access'
    }
  ] as const)(
    'lets an approved Web session manage two-step verification without desktop controls in $mode mode',
    async ({ mode, accessUrl, currentSection, otherSection }) => {
      const remoteAccess = (
        window as unknown as {
          api: {
            remoteAccess: {
              getSnapshot: ReturnType<typeof vi.fn>
              probe: ReturnType<typeof vi.fn>
            }
          }
        }
      ).api.remoteAccess
      remoteAccess.getSnapshot.mockResolvedValue({
        canManage: false,
        canManagePairing: true,
        mode,
        enabled: true,
        lifecycle: 'running',
        accessUrl,
        remoteIt: { installed: true, loggedIn: true, registered: true },
        pendingRequests: [
          {
            id: 'pending-1',
            code: '123456',
            browser: 'Google Chrome',
            platform: 'Windows',
            requestedAt: Date.now(),
            expiresAt: Date.now() + 60_000
          }
        ],
        trustedBrowsers: [
          {
            id: 'trusted-1',
            browser: 'Chrome on iOS',
            platform: 'iOS/iPadOS',
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
            expiresAt: Date.now() + 180 * 24 * 60 * 60 * 1_000
          }
        ]
      })

      await act(async () => {
        root.render(<SettingsPage open onClose={vi.fn()} />)
      })
      await act(async () => navButton('Remote')?.click())

      expect(document.body.textContent).toContain('Chrome on iOS · iOS/iPadOS')
      expect(document.body.textContent).toContain('Google Chrome · Windows')
      expect(document.body.textContent).toContain('123456')
      expect(document.body.textContent).toContain('Allow for up to 12 hours')
      expect(document.body.textContent).not.toContain('Allow once')
      expect(document.body.textContent).not.toContain('Invalid Date')
      expect(document.body.textContent).toContain(
        'Two-step verification requests and trusted browsers can be managed below'
      )
      expect(
        document.body.querySelector<HTMLInputElement>('input[name="remote-access-mode"]:checked')
          ?.disabled
      ).toBe(true)
      expect(settingsSection(currentSection)).not.toBeUndefined()
      expect(settingsSection(otherSection)).toBeUndefined()
      expect(remoteAccess.probe).not.toHaveBeenCalled()
    }
  )

  it('shows the app-only Remote.It flow without asking for an IP address or port', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const remoteItSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit',
      enabled: true,
      lifecycle: 'running',
      remoteIt: {
        installed: true,
        loggedIn: true,
        registered: true,
        account: 'person@example.com',
        service: {
          id: 'service-1',
          host: '127.0.0.1',
          port: 44100,
          enabled: true,
          ready: true
        }
      },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(remoteItSnapshot)
    remoteAccess.probe.mockResolvedValue(remoteItSnapshot)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    expect(document.body.textContent).toContain('Remote App Access')
    expect(document.body.textContent).not.toContain('127.0.0.1:44100')
    expect(
      document.body.querySelector<HTMLAnchorElement>('a[href="https://www.remote.it/download/"]')
    ).not.toBeNull()
    expect(document.body.textContent).toContain('six-digit code')
    expect(document.body.textContent).toContain('Trusted browsers')
    expect(document.body.textContent).toContain('Pairing requests')
    expect(settingsSection('Remote App Access')).not.toBeUndefined()
    expect(settingsSection('Remote Browser Access')).toBeUndefined()
    const connectedBadge = Array.from(
      settingsSection('Remote App Access')?.querySelectorAll('[data-slot="badge"]') ?? []
    ).find((badge) => badge.textContent === 'Connected')
    expect(connectedBadge?.className).toContain('bg-primary/10')
    expect(connectedBadge?.className).toContain('text-primary')
    expect(connectedBadge?.className).toContain('border-0')
    const guide = document.body.querySelector('[data-testid="remoteit-access-guide"]')
    expect(guide?.textContent).toContain('1.')
    expect(guide?.textContent).toContain('2.')
    expect(guide?.textContent).toContain('3.')
    const phoneIcon = guide?.querySelector('[data-testid="remoteit-guide-phone-icon"]')
    expect(phoneIcon?.getAttribute('class')).toContain('size-5')
    expect(phoneIcon?.getAttribute('class')).toContain('mt-0.5')
    expect(phoneIcon?.parentElement?.className).not.toContain('bg-')
  })

  it('keeps the intermediate Ready provider status neutral', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const readySnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'starting',
      remoteIt: {
        installed: true,
        loggedIn: true,
        registered: true,
        service: {
          id: 'service-1',
          host: '127.0.0.1',
          port: 44100,
          enabled: true,
          ready: true
        }
      },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(readySnapshot)
    remoteAccess.probe.mockResolvedValue(readySnapshot)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    const readyBadge = Array.from(
      settingsSection('Remote App Access')?.querySelectorAll('[data-slot="badge"]') ?? []
    ).find((badge) => badge.textContent === 'Ready')
    expect(readyBadge).not.toBeUndefined()
    expect(readyBadge?.className).not.toContain('bg-primary/10')
    expect(readyBadge?.className).not.toContain('text-primary')
    expect(readyBadge?.className).not.toContain('border-0')
  })

  it('shows a paired Remote.It public browser URL with a scannable QR code', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const publicSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit-public',
      enabled: true,
      lifecycle: 'running',
      accessUrl: 'https://open-science.connect.remote.it/',
      remoteItPublicUrl: 'https://open-science.connect.remote.it/',
      remoteIt: {
        installed: true,
        loggedIn: true,
        registered: true,
        account: 'person@example.com',
        service: {
          id: 'service-1',
          host: '127.0.0.1',
          port: 44100,
          enabled: true,
          ready: true
        }
      },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(publicSnapshot)
    remoteAccess.probe.mockResolvedValue(publicSnapshot)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    expect(document.body.textContent).toContain('Browser access is on')
    expect(document.body.textContent).toContain('Remote Browser Access')
    expect(document.body.textContent).toContain('Download Remote.It App')
    expect(document.body.textContent).toContain('Browser link is ready')
    expect(document.body.textContent).toContain('Scan to open')
    expect(document.body.textContent).toContain('two-step verification')
    expect(document.body.textContent).toContain('six-digit code')
    expect(document.body.textContent).toContain('Trusted browsers')
    expect(document.body.textContent).toContain('Pairing requests')
    const guide = document.body.querySelector('[data-testid="remoteit-public-access-guide"]')
    const qr = guide?.querySelector('[data-testid="remoteit-public-qr"]')
    const steps = guide?.querySelector('ol')
    expect(qr?.querySelector('svg')).not.toBeNull()
    expect(steps?.parentElement?.className).toContain('border-t')
    expect(guide?.firstElementChild?.className).toContain('sm:grid-cols-[minmax(0,1fr)_auto]')
    expect(guide?.firstElementChild?.firstElementChild?.contains(steps ?? null)).toBe(true)
    expect(guide?.firstElementChild?.lastElementChild).toBe(qr)
    expect(
      document.body.querySelector('input[aria-label="Remote.It Persistent Public URL"]')
    ).toBeNull()
    expect(settingsSection('Remote Browser Access')).not.toBeUndefined()
    expect(settingsSection('Remote App Access')).toBeUndefined()
  })

  it('reports and announces a rejected browser-link copy attempt', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const publicSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit-public',
      enabled: true,
      lifecycle: 'running',
      accessUrl: 'https://open-science.connect.remote.it/',
      remoteItPublicUrl: 'https://open-science.connect.remote.it/',
      remoteIt: {
        installed: true,
        loggedIn: true,
        registered: true,
        service: { id: 'service-1', host: '127.0.0.1', port: 44100, enabled: true, ready: true }
      },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(publicSnapshot)
    remoteAccess.probe.mockResolvedValue(publicSnapshot)
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard permission denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())
    const copyButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Copy'
    )

    await act(async () => {
      copyButton?.click()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith(publicSnapshot.accessUrl)
    const copyError = document.body.querySelector('[data-testid="remote-link-copy-error"]')
    expect(copyError?.getAttribute('role')).toBe('alert')
    expect(copyError?.textContent).toContain('Could not copy the browser link')
  })

  it('explains Remote.It Device setup after a pre-install selection failed', async () => {
    const remoteAccess = (
      window as unknown as {
        api: {
          remoteAccess: {
            getSnapshot: ReturnType<typeof vi.fn>
            probe: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.remoteAccess
    const setupSnapshot = {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit',
      enabled: false,
      lifecycle: 'error',
      error: 'Remote.It device setup is not complete.',
      remoteIt: {
        installed: true,
        loggedIn: false,
        registered: false,
        version: '4.1.0'
      },
      pendingRequests: [],
      trustedBrowsers: []
    }
    remoteAccess.getSnapshot.mockResolvedValue(setupSnapshot)
    remoteAccess.probe.mockResolvedValue(setupSnapshot)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Remote')?.click())

    expect(document.body.textContent).toContain('Detect again')
    expect(document.body.textContent).toContain('added once')
    const setupBadge = Array.from(
      settingsSection('Remote App Access')?.querySelectorAll('[data-slot="badge"]') ?? []
    ).find((badge) => badge.textContent === 'Device setup required')
    expect(setupBadge?.className).not.toContain('bg-primary/10')
    expect(document.body.textContent).not.toContain('Sign-in required')
  })

  it('switches to the Connectors panel and lists bundled connectors', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const connectorsTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /connectors/i.test(button.textContent ?? '')) as
      HTMLButtonElement | undefined
    expect(connectorsTab).not.toBeUndefined()

    await act(async () => {
      connectorsTab?.click()
    })

    // The Connectors panel loads and renders the bundled connector rows + contact-email section.
    expect(
      (window as unknown as { api: { settings: { listConnectors: ReturnType<typeof vi.fn> } } }).api
        .settings.listConnectors
    ).toHaveBeenCalled()
    expect(document.body.textContent).toContain('Chemistry')
    expect(document.body.textContent).toContain('Contact email')
  })

  it('keeps a Connector draft when device credential creation uses Settings history', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Connectors')?.click())

    const addConnector = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Add connector'))
    openRadixMenu(addConnector)
    const localCommand = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Local command'))
    await act(async () => {
      clickRadixMenuItem(localCommand)
      await Promise.resolve()
    })

    const displayName = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Display name"]'
    )!
    fireEvent.change(displayName, { target: { value: 'Draft research server' } })
    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-controls="connector-advanced-settings"]')
        ?.click()
    )
    fireEvent.change(document.body.querySelector('[aria-label="Variable name"]')!, {
      target: { value: 'API_TOKEN' }
    })
    selectSettingsOption('Credential for API_TOKEN', 'New credential')

    expect(document.body.textContent).toContain('Stored on this device')
    expect(document.body.textContent).toContain('Add connector')
    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )

    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Display name"]')?.value
    ).toBe('Draft research server')
  })

  it('keeps edit-time credential creation in the Connector flow without Connector Tags', async () => {
    const customServer = {
      id: 'notion-connector-id',
      name: 'notion2',
      displayName: 'Notion2',
      transport: 'stdio' as const,
      enabled: true,
      command: 'npx',
      hasEnv: true,
      environmentNames: ['API_TOKEN']
    }
    vi.mocked(window.api.settings.listConnectors).mockResolvedValue({
      connectors: [],
      customServers: [customServer],
      ncbi: { hasApiKey: false }
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => navButton('Connectors')?.click())
    await openCustomServerEditor('Notion2')
    expect(document.body.querySelector('[aria-label="Manage Tags"]')).not.toBeNull()

    act(() =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-controls="connector-advanced-settings"]')
        ?.click()
    )
    selectSettingsOption('Environment variable action', 'Replace saved variables')
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.change(document.body.querySelector('[aria-label="Variable name"]')!, {
      target: { value: 'API_TOKEN' }
    })
    expect(document.body.querySelector('[aria-label="Credential for API_TOKEN"]')).not.toBeNull()
    selectSettingsOption('Credential for API_TOKEN', 'New credential')

    expect(navButton('Connectors')?.getAttribute('aria-current')).toBe('page')
    expect(document.body.querySelector('[aria-label="Manage Tags"]')).toBeNull()
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).some(
        (button) => button.textContent?.trim() === 'Edit notion2'
      )
    ).toBe(true)
    expect(document.body.textContent).toContain('New credential')

    await act(async () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    )
    expect(document.body.querySelector('[aria-label="Manage Tags"]')).not.toBeNull()
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Variable name"]')?.value
    ).toBe('API_TOKEN')
  })

  it('blocks Connector save and preserves the draft when a live refresh removes the target', async () => {
    const customServer = {
      id: 'custom-server-uuid',
      name: 'my-mcp',
      displayName: 'My MCP',
      description: 'A custom MCP server.',
      transport: 'stdio' as const,
      enabled: true,
      command: 'npx',
      args: ['-y', '@example/my-mcp']
    }
    vi.mocked(window.api.settings.listConnectors).mockResolvedValue({
      connectors: [],
      customServers: [customServer],
      ncbi: { hasApiKey: false }
    })
    const updateCustomServer = vi.fn().mockResolvedValue(undefined)
    const addCustomServer = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ updateCustomServer, addCustomServer })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Connectors')?.click())
    await openCustomServerEditor('My MCP')

    act(() => useSettingsStore.setState({ customServers: [] }))

    const submit = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => ['Save changes', 'Add connector'].includes(button.textContent?.trim() ?? '')
    )
    expect(submit?.textContent?.trim()).toBe('Save changes')
    expect(document.body.textContent).toContain(
      'This Connector no longer exists. Your draft has not been saved.'
    )
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Display name"]')?.value
    ).toBe('My MCP')
    expect(submit?.disabled).toBe(true)
    expect(updateCustomServer).not.toHaveBeenCalled()
    expect(addCustomServer).not.toHaveBeenCalled()
  })

  it('keeps the Connector editor and draft open when an update loses a deletion race', async () => {
    const customServer = {
      id: 'custom-server-uuid',
      name: 'my-mcp',
      displayName: 'My MCP',
      description: 'A custom MCP server.',
      transport: 'stdio' as const,
      enabled: true,
      command: 'npx',
      args: ['-y', '@example/my-mcp']
    }
    vi.mocked(window.api.settings.listConnectors).mockResolvedValue({
      connectors: [],
      customServers: [customServer],
      ncbi: { hasApiKey: false }
    })
    const updateCustomServer = vi
      .fn()
      .mockRejectedValue(new Error('Unknown custom connector: custom-server-uuid'))
    useSettingsStore.setState({ updateCustomServer })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => navButton('Connectors')?.click())
    await openCustomServerEditor('My MCP')

    const displayName = document.body.querySelector<HTMLInputElement>(
      '[aria-label="Display name"]'
    )!
    fireEvent.change(displayName, { target: { value: 'Unsaved draft' } })
    const submit = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save changes'
    )
    await act(async () => submit?.click())

    expect(updateCustomServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: customServer.id, displayName: 'Unsaved draft' })
    )
    expect(document.body.textContent).toContain('Unknown custom connector: custom-server-uuid')
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Display name"]')?.value
    ).toBe('Unsaved draft')
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).some(
        (button) => button.textContent?.trim() === 'Save changes'
      )
    ).toBe(true)
  })

  it('switches to the Network panel, configures a mirror, and saves it', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const networkTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /network/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    expect(networkTab).not.toBeUndefined()

    await act(async () => {
      networkTab?.click()
    })

    // Unconfigured by default (the mocked getSettings snapshot has no packageMirror).
    expect(document.body.textContent).toContain('Not configured')

    const configureButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Configure')
    await act(async () => {
      configureButton?.click()
    })

    const condaInput = document.body.querySelector<HTMLInputElement>('#mirror-conda-channel')
    expect(condaInput).not.toBeNull()
    await act(async () => {
      condaInput?.dispatchEvent(new Event('focus'))
      Object.defineProperty(condaInput, 'value', {
        value: 'https://mirror.example/conda',
        writable: true
      })
      condaInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      saveButton?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(
      (window as unknown as { api: { settings: { setPackageMirror: ReturnType<typeof vi.fn> } } })
        .api.settings.setPackageMirror
    ).toHaveBeenCalledWith(
      expect.objectContaining({ condaChannel: 'https://mirror.example/conda' })
    )
  })

  it('shows a breadcrumb in the header when a skill detail is open, and returns on breadcrumb click', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    // Navigate to the Skills panel.
    const skillsTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /skills/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    await act(async () => {
      skillsTab?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Open the skill's detail view by clicking its row.
    const alphaRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Alpha')
    )
    await act(async () => {
      alphaRow?.click()
    })

    // The header now shows a "Skills › Alpha" breadcrumb with a clickable "Skills" crumb.
    const crumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to skills"]')
    expect(crumb).not.toBeNull()
    expect(document.body.textContent).toContain('Alpha')

    // Clicking the breadcrumb returns to the list (the crumb collapses back to the panel title).
    await act(async () => {
      crumb?.click()
    })
    expect(document.body.querySelector('[aria-label="Back to skills"]')).toBeNull()
  })

  it('opens bulk Skill management as a breadcrumb sub-page without Featured Skills', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    await act(async () => navButton('Skills')?.click())
    await act(async () => {
      await Promise.resolve()
    })
    const manage = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Manage'
    )
    await act(async () => manage?.click())

    const crumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to skills"]')
    expect(crumb).not.toBeNull()
    expect(document.body.textContent).toContain('Manage skills')
    expect(document.body.textContent).toContain('Featured Skills are not changed.')
    expect(document.body.textContent).not.toContain('Alpha')

    await act(async () => crumb?.click())
    expect(document.body.querySelector('[aria-label="Back to skills"]')).toBeNull()
    expect(document.body.textContent).toContain('Alpha')
  })

  it('opens directly on a skill detail when the store has a pending skill', async () => {
    // A skill mention publishes a landing intent before the dialog opens.
    useSettingsStore.getState().openSettingsToSkill('alpha')

    const settingsRef = createRef<SettingsPageHandle>()
    await act(async () => {
      root.render(<SettingsPage ref={settingsRef} open onClose={vi.fn()} />)
    })
    // Flush the seeding effect, the skills-list load, and the skill-detail fetch.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Landed on the skill's detail page (breadcrumb + detail), not the default Model panel.
    expect(document.body.querySelector('[aria-label="Back to skills"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.querySelector('section[aria-label="Providers"]')).toBeNull()
    // The intent is consumed so a later normal open won't jump back to it.
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()

    act(() => {
      expect(settingsRef.current?.closeActivePane()).toBe(true)
    })
    expect(document.body.querySelector('[aria-label="Back to skills"]')).toBeNull()
    expect(document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(
      true
    )
  })

  it('honors a repeated external intent for the same skill while Settings stays open', async () => {
    useSettingsStore.getState().openSettingsToSkill('alpha')

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(document.body.querySelector('[aria-label="Back to skills"]')).not.toBeNull()
    )

    await act(async () => navButton('Model')?.click())
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()

    act(() => useSettingsStore.getState().openSettingsToSkill('alpha'))
    await waitFor(() =>
      expect(document.body.querySelector('[aria-label="Back to skills"]')).not.toBeNull()
    )
  })

  it('keeps an external intent pending until Settings is visible', async () => {
    useSettingsStore.getState().openSettingsToSkill('alpha')

    await act(async () => {
      root.render(<SettingsPage open={false} onClose={vi.fn()} />)
      await Promise.resolve()
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(document.body.querySelector('[aria-label="Back to skills"]')).not.toBeNull()
    )
  })

  it('opens directly on a requested settings panel and consumes the target', async () => {
    useSettingsStore.getState().openSettingsToPanel('storage')

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(navButton('Storage')?.getAttribute('aria-current')).toBe('page')
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()
  })

  it('opens directly on a specialist editor when the store has a pending specialist', async () => {
    // The switch approval card deep-links to one specialist's editor: the intent is published
    // before the dialog opens, and the catalog resolves that profile.
    const researcher: SpecialistView = {
      id: 'spc-1',
      name: 'RESEARCHER',
      displayName: 'Researcher',
      description: 'Conducts systematic literature reviews.',
      systemPrompt: 'You are a literature review specialist.',
      iconKey: 'search',
      colorKey: 'blue',
      enabled: true,
      capabilityMode: 'full',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
      revision: 1
    }
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ kind: 'custom', ...researcher }],
      integrity: { status: 'ok' }
    })
    useSpecialistStore.setState({ items: [{ kind: 'custom', ...researcher }], isLoaded: true })
    useSettingsStore.getState().openSettingsToSpecialist(researcher.id)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    // Flush the seeding effect, the specialists-list load, and the editor mount.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Landed on the specialist's editor (display name prefilled), not the
    // default Model panel.
    const name = document.body.querySelector<HTMLInputElement>('#sp-name')
    expect(name?.value).toBe('Researcher')
    expect(document.body.querySelector('section[aria-label="Providers"]')).toBeNull()
    // The intent is consumed so a later normal open won't jump back to it.
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()
  })

  it('navigates from a specialist capability row to the skill detail and back', async () => {
    const researcher: SpecialistView = {
      id: 'spc-1',
      name: 'RESEARCHER',
      displayName: 'Researcher',
      description: 'Conducts systematic literature reviews.',
      systemPrompt: 'You are a literature review specialist.',
      iconKey: 'search',
      colorKey: 'blue',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['alpha'], connectorIds: [], connectorTools: [] },
      revision: 1
    }
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ kind: 'custom', ...researcher }],
      integrity: { status: 'ok' }
    })
    useSpecialistStore.setState({ items: [{ kind: 'custom', ...researcher }], isLoaded: true })
    useSettingsStore.getState().openSettingsToSpecialist(researcher.id)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // The capabilities whitelist lists Alpha; clicking the row navigates.
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Alpha details"]')!
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Landed on Skills › Alpha: the mocked detail metadata renders.
    expect(navButton('Skills')?.getAttribute('aria-current')).toBe('page')
    expect(document.body.textContent).toContain('Test Author')

    // Back returns to the specialist editor.
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    })
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe('Researcher')
  })

  it('navigates from a Skill usage popover to Specialist Settings and back', async () => {
    const researcher: SpecialistView = {
      id: 'spc-usage',
      name: 'RESEARCHER',
      displayName: 'Researcher',
      description: 'Conducts systematic literature reviews.',
      systemPrompt: 'You are a literature review specialist.',
      iconKey: 'search',
      colorKey: 'blue',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['alpha'], connectorIds: [], connectorTools: [] },
      revision: 1
    }
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ kind: 'custom', ...researcher }],
      integrity: { status: 'ok' }
    })
    useSpecialistStore.setState({ items: [{ kind: 'custom', ...researcher }], isLoaded: true })
    useSettingsStore.getState().openSettingsToSkill('alpha')

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      fireEvent.focus(
        document.body.querySelector<HTMLElement>('[data-slot="skill-usage-agents-trigger"]')!
      )
    })
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>(
          '[aria-label="Open Researcher in Specialist Settings"]'
        )!
      )
    })

    expect(navButton('Specialists')?.getAttribute('aria-current')).toBe('page')
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe('Researcher')

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    })
    expect(navButton('Skills')?.getAttribute('aria-current')).toBe('page')
    expect(document.body.textContent).toContain('Test Author')
  })

  it('navigates from a Connector usage popover to Specialist Settings and back', async () => {
    const researcher: SpecialistView = {
      id: 'spc-connector-usage',
      name: 'RESEARCHER',
      displayName: 'Researcher',
      description: 'Conducts systematic literature reviews.',
      systemPrompt: 'You are a literature review specialist.',
      iconKey: 'search',
      colorKey: 'blue',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: [], connectorIds: ['chemistry'], connectorTools: [] },
      revision: 1
    }
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ kind: 'custom', ...researcher }],
      integrity: { status: 'ok' }
    })
    useSpecialistStore.setState({ items: [{ kind: 'custom', ...researcher }], isLoaded: true })
    useSettingsStore.getState().openSettingsToPanel('connectors')

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      fireEvent.focus(document.body.querySelector<HTMLElement>('[data-resource-kind="connector"]')!)
    })
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>(
          '[aria-label="Open Researcher in Specialist Settings"]'
        )!
      )
    })

    expect(navButton('Specialists')?.getAttribute('aria-current')).toBe('page')
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')?.value).toBe('Researcher')

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    })
    expect(navButton('Connectors')?.getAttribute('aria-current')).toBe('page')
    expect(document.body.textContent).toContain('Chemistry')
  })

  it('routes connector capability rows to detail or edit by server kind', async () => {
    const researcher: SpecialistView = {
      id: 'spc-2',
      name: 'RESEARCHER',
      displayName: 'Researcher',
      description: '',
      systemPrompt: '',
      iconKey: 'search',
      colorKey: 'blue',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: {
        skillIds: [],
        connectorIds: ['chemistry', 'route-uuid'],
        connectorTools: []
      },
      revision: 1
    }
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ kind: 'custom', ...researcher }],
      integrity: { status: 'ok' }
    })
    ;(window.api.settings.listConnectors as ReturnType<typeof vi.fn>).mockResolvedValue({
      connectors: [
        {
          id: 'chemistry',
          displayName: 'Chemistry',
          description: 'Small-molecule chemistry via PubChem.',
          sources: ['PubChem'],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false
        }
      ],
      customServers: [
        {
          id: 'route-uuid',
          name: 'route',
          displayName: 'Public Route',
          transport: 'stdio',
          enabled: true
        }
      ],
      ncbi: { hasApiKey: false }
    })
    ;(
      window.api.settings as unknown as Record<string, ReturnType<typeof vi.fn>>
    ).getConnectorDetail = vi.fn().mockResolvedValue({
      id: 'chemistry',
      name: 'chemistry',
      displayName: 'Chemistry',
      description: 'Small-molecule chemistry via PubChem.',
      sources: ['PubChem'],
      requiresNcbi: false,
      enabled: true,
      autoAllow: false,
      tools: []
    })
    useSpecialistStore.setState({ items: [{ kind: 'custom', ...researcher }], isLoaded: true })
    useSettingsStore.getState().openSettingsToSpecialist(researcher.id)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Open the Connectors capability tab.
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) =>
          tab.textContent?.includes('Connectors')
        )!
      )
    })

    const crumb = (): string =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.closest('div')
        ?.textContent ?? ''

    // A bundled connector lands on its detail page.
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Chemistry details"]')!
      )
    })
    expect(navButton('Connectors')?.getAttribute('aria-current')).toBe('page')
    expect(crumb()).toContain('Connectors›Chemistry')
    await act(async () => {
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Specialists')
    expect(document.body.textContent).toContain('Researcher')
    expect(document.body.querySelector('[data-slot="skill-usage-agents-trigger"]')).toBeNull()

    // Back to the editor (capability tabs reset to Skills on remount), then a
    // custom server lands on its edit page.
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    })
    await act(async () => {
      fireEvent.click(
        Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) =>
          tab.textContent?.includes('Connectors')
        )!
      )
    })
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Public Route details"]')!
      )
    })
    expect(navButton('Connectors')?.getAttribute('aria-current')).toBe('page')
    expect(crumb()).toContain('Connectors›Edit route')
  })

  it('keeps unsaved specialist edits across a capability detail round trip', async () => {
    const researcher: SpecialistView = {
      id: 'spc-3',
      name: 'RESEARCHER',
      displayName: 'Researcher',
      description: 'Conducts systematic literature reviews.',
      systemPrompt: 'You are a literature review specialist.',
      iconKey: 'search',
      colorKey: 'blue',
      enabled: true,
      capabilityMode: 'selected',
      fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
      selectedCapabilities: { skillIds: ['alpha'], connectorIds: [], connectorTools: [] },
      revision: 1
    }
    ;(window.api.specialist.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [{ kind: 'custom', ...researcher }],
      integrity: { status: 'ok' }
    })
    useSpecialistStore.setState({ items: [{ kind: 'custom', ...researcher }], isLoaded: true })
    useSettingsStore.getState().openSettingsToSpecialist(researcher.id)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // An unsaved edit in the specialist editor.
    await act(async () => {
      fireEvent.change(document.body.querySelector<HTMLInputElement>('#sp-description')!, {
        target: { value: 'My unsaved edit' }
      })
    })

    // Round trip through the skill detail page.
    await act(async () => {
      fireEvent.click(
        document.body.querySelector<HTMLElement>('[aria-label="View Alpha details"]')!
      )
    })
    expect(document.body.textContent).toContain('Test Author')
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click()
    })

    // Back on the editor, the unsaved edit survived the trip.
    expect(document.body.querySelector<HTMLInputElement>('#sp-description')?.value).toBe(
      'My unsaved edit'
    )
  })

  it('opens the specialist creation form from Write from scratch', async () => {
    useSettingsStore.getState().openSettingsToPanel('specialists')

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    openRadixMenu(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
        button.textContent?.includes('Add specialist')
      )
    )
    const writeFromScratch = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('Write from scratch'))
    await act(async () => {
      clickRadixMenuItem(writeFromScratch)
      await Promise.resolve()
    })

    expect(document.body.querySelector('h3')?.textContent).toBe('Identity')
    expect(document.body.querySelector<HTMLInputElement>('#sp-name')).not.toBeNull()
  })

  it('uses a multi-level header breadcrumb for Marketplace Specialist details', async () => {
    useSettingsStore.getState().openSettingsToPanel('specialists')
    Object.assign(window.api.specialist, {
      listMarketplace: vi.fn().mockResolvedValue({
        sources: [
          {
            id: 'official',
            kind: 'official',
            name: 'OpenScience Marketplace',
            repositoryUrl: 'https://github.com/aipoch/marketplace',
            ref: 'published',
            trust: 'official',
            keyId: 'key-1',
            keyFingerprint: 'a'.repeat(64),
            removable: false
          }
        ],
        specialists: [
          {
            sourceId: 'official',
            sourceName: 'OpenScience Marketplace',
            sourceTrust: 'official',
            id: 'example-specialist',
            displayName: 'Example Specialist',
            summary: 'Focused research workflows.',
            publisher: { id: 'aipoch', name: 'Aipoch' },
            version: '1.0.0'
          }
        ],
        failures: []
      }),
      getMarketplaceRelease: vi.fn().mockResolvedValue({
        sourceId: 'official',
        specialistId: 'example-specialist',
        displayName: 'Example Specialist',
        summary: 'Focused research workflows.',
        publisher: { id: 'aipoch', name: 'Aipoch' },
        version: '1.0.0',
        repository: 'https://github.com/aipoch/example',
        commit: 'a'.repeat(40),
        license: 'MIT',
        compressedBytes: 100,
        uncompressedBytes: 200,
        fileCount: 2,
        defaultSkillIds: [],
        defaultConnectorIds: [],
        skills: [],
        connectors: []
      })
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      const marketplaceEntry = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button')
      ).find((button) => button.textContent?.trim() === 'Browse Marketplace')
      marketplaceEntry?.click()
      await Promise.resolve()
    })
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('Example Specialist'))
        ?.click()
      await Promise.resolve()
    })

    const marketplaceCrumb = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Back to Marketplace"]'
    )
    expect(marketplaceCrumb).not.toBeNull()
    expect(marketplaceCrumb?.closest('div')?.textContent).toContain(
      'Specialists›Marketplace›example-specialist'
    )
    expect(document.body.textContent).not.toContain('Back to Marketplace')

    await act(async () => marketplaceCrumb?.click())
    expect(document.body.querySelector('[aria-label="Search Marketplace"]')).not.toBeNull()
  })

  it('pushes Agent after storage recovery so Back returns to Storage', async () => {
    const failedStorage = {
      checkedAt: 1,
      platform: 'darwin',
      architecture: 'arm64',
      checks: [
        {
          id: 'storage' as const,
          label: 'App storage permission',
          status: 'failed' as const,
          summary: 'Open Science cannot write to its private data folder.'
        }
      ],
      ready: false,
      canAutoInstall: false,
      agentFrameworkId: 'claude-code' as const,
      runtime: { found: false }
    }
    const repairedStorage = {
      ...failedStorage,
      checkedAt: 2,
      checks: [
        {
          id: 'storage' as const,
          label: 'App storage permission',
          status: 'passed' as const,
          summary: 'Open Science can write to its private data folder.'
        },
        {
          id: 'agent' as const,
          label: 'Claude runtime',
          status: 'failed' as const,
          summary: 'Claude is missing.'
        }
      ]
    }
    const checkEnvironment = vi.fn().mockImplementation(async () => {
      useSettingsStore.setState({ environmentCheck: repairedStorage })
      return repairedStorage
    })
    useSettingsStore.getState().openSettingsToPanel('storage')
    useSettingsStore.setState({
      environmentCheck: failedStorage,
      checkEnvironment
    })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await act(async () => {
      await Promise.resolve()
    })
    const checkAgain = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Check again'
    )
    await act(async () => checkAgain?.click())
    const continueToAgent = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Continue to repair Agent')
    await act(async () => continueToAgent?.click())

    expect(navButton('Agent')?.getAttribute('aria-current')).toBe('page')
    const back = document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')
    expect(back?.disabled).toBe(false)
    await act(async () => back?.click())
    expect(navButton('Storage')?.getAttribute('aria-current')).toBe('page')
  })

  it('blocks key storage in the provider form when encryption is unavailable', async () => {
    // The store loads encryptionAvailable from this call when the dialog opens.
    ;(
      window as unknown as {
        api: { settings: { isEncryptionAvailable: ReturnType<typeof vi.fn> } }
      }
    ).api.settings.isEncryptionAvailable.mockResolvedValue(false)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    // No secure-storage error appears on the provider list itself.
    expect(document.body.textContent).not.toContain('Secure key storage is unavailable')

    const addProvider = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Add provider')
    await act(async () => {
      addProvider?.click()
    })

    // The Add provider sub-page explains that secret writes fail closed.
    expect(document.body.textContent).toContain('Secure key storage is unavailable')
    expect(document.body.textContent).toContain('API keys cannot be saved')
  })

  it('does not render when closed', () => {
    act(() => {
      root.render(<SettingsPage open={false} onClose={vi.fn()} />)
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not rerender the closed settings surface when sessions stream updates', () => {
    let commits = 0
    act(() => {
      root.render(
        <Profiler id="settings" onRender={() => (commits += 1)}>
          <SettingsPage open={false} onClose={vi.fn()} />
        </Profiler>
      )
    })
    const commitsBeforeSessionUpdate = commits

    act(() => {
      useSessionStore.setState({
        sessions: [
          {
            id: 'streaming-session',
            projectId: 'project-1',
            title: 'Streaming session',
            cwd: '/workspace',
            status: 'idle',
            createdAt: 1,
            updatedAt: 1,
            messages: []
          }
        ]
      })
    })

    expect(commits).toBe(commitsBeforeSessionUpdate)
  })

  it('navigates settings history with the back/forward controls', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const back = (): HTMLButtonElement | null =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')
    const forward = (): HTMLButtonElement | null =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Forward"]')

    // Start on Model: back and forward are both disabled.
    expect(back()?.disabled).toBe(true)
    expect(forward()?.disabled).toBe(true)

    // Navigate Model -> General enables Back.
    const generalTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /general/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    await act(async () => {
      generalTab?.click()
    })
    expect(back()?.disabled).toBe(false)

    // Back returns to Model (its nav item is the current page) and enables Forward.
    await act(async () => {
      back()?.click()
    })
    const modelNav = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /model/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    expect(modelNav?.getAttribute('aria-current')).toBe('page')
    expect(forward()?.disabled).toBe(false)
  })

  it('toggles the dialog size with the maximize control', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const maximize = document.body.querySelector<HTMLButtonElement>('[aria-label="Maximize"]')
    expect(maximize).not.toBeNull()

    await act(async () => {
      maximize?.click()
    })

    // After maximizing, the control flips to Restore.
    expect(document.body.querySelector('[aria-label="Restore"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Maximize"]')).toBeNull()
    const dialog = document.body.querySelector<HTMLElement>('[data-slot="settings-surface"]')
    expect(dialog?.className).toContain('inset-4')
    expect(dialog?.className).not.toContain('h-[80vh]')
    expect(dialog?.className).not.toContain('w-[80vw]')
  })
})

describe('SettingsPage uninstall confirmation', () => {
  const findButton = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === text
    )

  const bothFrameworks = [
    { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
    { id: 'opencode', displayName: 'OpenCode', supportsSkills: true }
  ]

  it('gates the uninstall call behind the confirmation dialog', async () => {
    // Claude is managed but NOT the active framework (OpenCode is), so its Uninstall is enabled.
    // OpenCode carries a path so the "auto-detect when active + missing" effect doesn't run.
    const snapshot = {
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      providers: [],
      agentFrameworkId: 'opencode',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    }
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    const uninstallClaude = vi
      .fn()
      .mockResolvedValue({ ...snapshot, claude: {}, claudeManaged: false })
    api.settings.uninstallClaude = uninstallClaude

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // The inactive managed Claude card exposes an Uninstall action, and no confirmation is open yet.
    const cardUninstall = findButton(document.body, 'Uninstall')
    expect(cardUninstall).toBeDefined()
    expect(cardUninstall?.disabled).toBe(false)
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()

    // Clicking it only opens the confirmation — the uninstall must not fire yet.
    await act(async () => {
      cardUninstall?.click()
    })
    const confirmDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(confirmDialog).not.toBeNull()
    expect(uninstallClaude).not.toHaveBeenCalled()

    // Only confirming in the dialog performs the uninstall.
    const confirm = findButton(confirmDialog!, 'Uninstall')
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm?.click()
    })
    expect(uninstallClaude).toHaveBeenCalledTimes(1)
  })

  it('disables uninstall on the active runtime card', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    // Claude is both managed and the active framework — its Uninstall must be disabled.
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: {},
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const cardUninstall = findButton(document.body, 'Uninstall')
    expect(cardUninstall).toBeDefined()
    // The active managed runtime is greyed via aria-disabled (kept hoverable for its explainer tooltip),
    // not the native disabled attribute.
    expect(cardUninstall?.getAttribute('aria-disabled')).toBe('true')
  })

  it('gates a framework switch behind the confirmation dialog', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    // OpenCode must be ready (preflight passed) to be selectable as the framework.
    api.settings.getPreflight = vi
      .fn()
      .mockResolvedValue({ claudeReady: true, opencodeReady: true, activeProviderReady: true })
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    })
    const setAgentFramework = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      providers: [],
      agentFrameworkId: 'opencode',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    })
    api.settings.setAgentFramework = setAgentFramework

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // Selecting the inactive OpenCode card opens the switch confirmation without switching yet.
    const opencodeRadio = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Use OpenCode"]'
    )
    expect(opencodeRadio).not.toBeNull()
    await act(async () => {
      opencodeRadio?.click()
    })
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Switch to OpenCode?')
    expect(setAgentFramework).not.toHaveBeenCalled()

    // Confirming performs the switch.
    await act(async () => {
      findButton(dialog!, 'Switch')?.click()
    })
    expect(setAgentFramework).toHaveBeenCalledWith({ id: 'opencode' })
  })

  it('locks every framework card until a confirmed Settings switch finishes', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getPreflight = vi
      .fn()
      .mockResolvedValue({ claudeReady: true, opencodeReady: true, activeProviderReady: true })
    const readySnapshot = {
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(readySnapshot)
    let resolveSwitch: ((snapshot: typeof readySnapshot) => void) | undefined
    api.settings.setAgentFramework = vi.fn().mockImplementation(
      () =>
        new Promise<typeof readySnapshot>((resolve) => {
          resolveSwitch = resolve
        })
    )
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ checkEnvironment })

    await act(async () => root.render(<SettingsPage open onClose={vi.fn()} />))
    await openAgentPanel()
    const opencodeRadio = document.body.querySelector<HTMLElement>('[aria-label="Use OpenCode"]')
    await act(async () => opencodeRadio?.click())
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    await act(async () => findButton(dialog!, 'Switch')?.click())

    expect(
      document.body.querySelector('[aria-label="Use Claude Agent"]')?.getAttribute('aria-disabled')
    ).toBe('true')
    expect(
      document.body.querySelector('[aria-label="Use OpenCode"]')?.getAttribute('aria-disabled')
    ).toBe('true')
    expect(checkEnvironment).not.toHaveBeenCalled()

    await act(async () =>
      resolveSwitch?.({
        ...readySnapshot,
        agentFrameworkId: 'opencode'
      })
    )

    expect(checkEnvironment).toHaveBeenCalledWith({ force: true })
  })

  // An inactive but managed Claude (OpenCode active) whose Uninstall would otherwise be enabled.
  const inactiveManagedClaudeSnapshot = {
    claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
    opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
    providers: [],
    agentFrameworkId: 'opencode',
    agentFrameworks: bothFrameworks,
    claudeManaged: true,
    opencodeManaged: false
  }

  it('disables uninstall while a prompt is in flight and blocks confirming a dialog opened before it', async () => {
    const api = (
      window as unknown as {
        api: { settings: Record<string, unknown>; acp: Record<string, unknown> }
      }
    ).api
    api.settings.getSettings = vi.fn().mockResolvedValue(inactiveManagedClaudeSnapshot)
    const uninstallClaude = vi.fn().mockResolvedValue(inactiveManagedClaudeSnapshot)
    api.settings.uninstallClaude = uninstallClaude

    // Capture the live listener; start idle so the dialog can be opened.
    let emitAcp:
      ((s: { promptInFlight: boolean; promptInFlightSessionIds: string[] }) => void) | undefined
    api.acp.getState = vi
      .fn()
      .mockResolvedValue({ promptInFlight: false, promptInFlightSessionIds: [] })
    api.acp.onState = vi.fn().mockImplementation((cb: typeof emitAcp) => {
      emitAcp = cb
      return () => {}
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // Idle → the card Uninstall is enabled and opens the confirmation.
    const cardUninstall = findButton(document.body, 'Uninstall')
    expect(cardUninstall?.disabled).toBe(false)
    await act(async () => {
      cardUninstall?.click()
    })
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull()

    // A prompt starts while the dialog is open — the card control disables live, but confirming must
    // also be intercepted so the busy runtime isn't torn down out from under the task.
    await act(async () => {
      emitAcp?.({ promptInFlight: true, promptInFlightSessionIds: ['s1'] })
    })
    const confirmDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const confirm = confirmDialog ? findButton(confirmDialog, 'Uninstall') : undefined
    await act(async () => {
      confirm?.click()
    })
    expect(uninstallClaude).not.toHaveBeenCalled()
    // Revalidation closes the dialog instead of proceeding.
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('lets a live in-flight event win the race against a later idle initial snapshot', async () => {
    const api = (
      window as unknown as {
        api: { settings: Record<string, unknown>; acp: Record<string, unknown> }
      }
    ).api
    api.settings.getSettings = vi.fn().mockResolvedValue(inactiveManagedClaudeSnapshot)

    // getState resolves LATE with a stale idle snapshot; a live in-flight event fires first. The
    // effect must keep the button disabled — the stale snapshot must not clobber the live state.
    let resolveGetState:
      ((s: { promptInFlight: boolean; promptInFlightSessionIds: string[] }) => void) | undefined
    api.acp.getState = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveGetState = resolve
      })
    )
    let emitAcp:
      ((s: { promptInFlight: boolean; promptInFlightSessionIds: string[] }) => void) | undefined
    api.acp.onState = vi.fn().mockImplementation((cb: typeof emitAcp) => {
      emitAcp = cb
      return () => {}
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // Live event arrives first (prompt in flight), then the stale idle getState resolves last.
    await act(async () => {
      emitAcp?.({ promptInFlight: true, promptInFlightSessionIds: ['s1'] })
      resolveGetState?.({ promptInFlight: false, promptInFlightSessionIds: [] })
    })

    const cardUninstall = findButton(document.body, 'Uninstall')
    expect(cardUninstall?.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('SettingsPage Codex framework', () => {
  const frameworks = [
    { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
    { id: 'opencode', displayName: 'OpenCode', supportsSkills: true },
    {
      id: 'codex',
      displayName: 'Codex',
      supportsSkills: true,
      supportedApiTypes: ['responses']
    },
    {
      id: 'codebuddy',
      displayName: 'CodeBuddy',
      supportsSkills: false,
      supportedApiTypes: ['openai']
    }
  ]

  it('offers Codex as a selectable framework behind the switch confirmation', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const snapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: {
        resolvedPath: '/data/codex-managed/adapter/dist/index.js',
        version: '1.6.2',
        nativeVersion: '0.144.6'
      },
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: true
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: true,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    })
    const setAgentFramework = vi.fn().mockResolvedValue({
      ...snapshot,
      agentFrameworkId: 'codex'
    })
    api.settings.setAgentFramework = setAgentFramework
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ checkEnvironment })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const codexRadio = document.body.querySelector<HTMLButtonElement>('[aria-label="Use Codex"]')
    expect(codexRadio).not.toBeNull()
    // The adapter version shows as a muted v-tag after the name; the repo link points at the ACP adapter.
    expect(document.body.textContent).toContain('v1.6.2')
    expect(document.body.textContent).toContain('agentclientprotocol/codex-acp')

    await act(async () => codexRadio?.click())
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Switch to Codex?')

    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Switch'
    )
    await act(async () => confirm?.click())
    expect(setAgentFramework).toHaveBeenCalledWith({ id: 'codex' })
    expect(checkEnvironment).toHaveBeenCalledWith({ force: true })
  })

  it('switches to a ready CodeBuddy framework after confirmation', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const snapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      codebuddy: { resolvedPath: '/opt/homebrew/bin/codebuddy', version: '2.138.0' },
      providers: [],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: true,
      codebuddyManaged: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: true,
      codebuddyReady: true,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: false
    })
    const setAgentFramework = vi.fn().mockResolvedValue({
      ...snapshot,
      agentFrameworkId: 'codebuddy'
    })
    api.settings.setAgentFramework = setAgentFramework
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ checkEnvironment })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const codeBuddyRadio = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Use CodeBuddy"]'
    )
    expect(codeBuddyRadio).not.toBeNull()
    await act(async () => codeBuddyRadio?.click())

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Switch to CodeBuddy?')
    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Switch'
    )
    await act(async () => confirm?.click())

    expect(setAgentFramework).toHaveBeenCalledWith({ id: 'codebuddy' })
    expect(checkEnvironment).toHaveBeenCalledWith({ force: true })
  })

  it('does not show the obsolete Skill limitation for active CodeBuddy', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const snapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      codebuddy: { resolvedPath: '/opt/homebrew/bin/codebuddy', version: '2.138.0' },
      providers: [],
      agentFrameworkId: 'codebuddy',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: true,
      codebuddyManaged: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: true,
      codebuddyReady: true,
      agentFrameworkId: 'codebuddy',
      agentReady: true,
      activeProviderReady: false
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    expect(document.body.textContent).not.toContain(
      "Skills aren't available with CodeBuddy; use Claude Code for skill-based workflows."
    )
  })

  it('routes the default app-managed install action to installCodex', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      codex: {},
      codebuddy: {},
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: false,
      codebuddyManaged: false
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: true,
      codexReady: false,
      codebuddyReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    })
    const installCodex = vi.fn().mockResolvedValue({ installId: 'codex-test', ok: true })
    api.settings.installCodex = installCodex
    api.settings.onInstallLog = vi.fn().mockReturnValue(() => undefined)
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ checkEnvironment })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const installTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Install Codex"]'
    )
    expect(installTrigger).not.toBeNull()
    openRadixMenu(installTrigger)

    // The Install button opens a source menu; the app-managed source is the recommended default.
    const managedItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('App-managed download (recommended)'))
    expect(managedItem).toBeDefined()
    clickRadixMenuItem(managedItem)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(installCodex).toHaveBeenCalledWith({ source: 'managed' })
    expect(checkEnvironment).toHaveBeenCalledWith({ force: true })
  })

  it('groups cards by install state and re-detects every framework from the section action', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const snapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      codex: {},
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: true,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    })
    const detectClaude = vi.fn().mockResolvedValue(snapshot)
    const detectOpencode = vi.fn().mockResolvedValue(snapshot)
    const detectCodex = vi.fn().mockResolvedValue(snapshot)
    const detectCodeBuddy = vi.fn().mockResolvedValue(snapshot)
    api.settings.detectClaude = detectClaude
    api.settings.detectOpencode = detectOpencode
    api.settings.detectCodex = detectCodex
    api.settings.detectCodeBuddy = detectCodeBuddy
    const checkEnvironment = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({ checkEnvironment })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // Two ready runtimes land in the Installed group; Codex/CodeBuddy (not ready) in Available.
    expect(document.body.textContent).toContain('Installed · 2')
    expect(document.body.textContent).toContain('Available · 2')
    // Claude is renamed in this panel only.
    expect(document.body.textContent).toContain('Claude Agent')

    // The section-level Re-detect re-scans every framework at once.
    const redetect = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Re-detect'
    )
    expect(redetect).toBeDefined()
    expect(redetect?.parentElement?.className).toContain('ml-auto')
    await act(async () => redetect?.click())

    expect(detectClaude).toHaveBeenCalledTimes(1)
    expect(detectOpencode).toHaveBeenCalledTimes(1)
    expect(detectCodex).toHaveBeenCalledTimes(1)
    expect(detectCodeBuddy).toHaveBeenCalledTimes(2)
    expect(checkEnvironment).toHaveBeenCalledTimes(1)
  })

  it('keeps detected CodeBuddy in Installed even while preflight still needs repair', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: {},
      codebuddy: {
        resolvedPath: '/Users/x/.open-science/codebuddy-managed/bin/codebuddy',
        version: '2.138.0'
      },
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: false,
      codebuddyManaged: true
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: false,
      codebuddyReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    expect(document.body.textContent).toContain('Installed · 2')
    expect(document.body.textContent).toContain('Available · 2')
    expect(document.body.textContent).toContain('CodeBuddy')
    expect(document.body.textContent).toContain('v2.138.0')
    expect(document.body.textContent).toContain(
      '/Users/x/.open-science/codebuddy-managed/bin/codebuddy'
    )
    expect(document.body.querySelector('[aria-label="Repair CodeBuddy"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Install CodeBuddy"]')).toBeNull()
  })

  it('auto-detects a user-installed CodeBuddy when the Agent panel is shown', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const initialSnapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      codebuddy: {},
      providers: [],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: true,
      codebuddyManaged: false
    }
    const detectedSnapshot = {
      ...initialSnapshot,
      codebuddy: { resolvedPath: '/opt/homebrew/bin/codebuddy', version: '2.138.0' }
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(initialSnapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: true,
      codebuddyReady: false,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: false
    })
    const detectCodeBuddy = vi.fn().mockResolvedValue(detectedSnapshot)
    api.settings.detectCodeBuddy = detectCodeBuddy

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    await waitFor(() => expect(detectCodeBuddy).toHaveBeenCalledOnce())
    await waitFor(() => {
      expect(document.body.textContent).toContain('/opt/homebrew/bin/codebuddy')
    })

    expect(document.body.textContent).toContain('v2.138.0')
    expect(document.body.querySelector('[aria-label="Repair CodeBuddy"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Install CodeBuddy"]')).toBeNull()
  })

  it('re-detects CodeBuddy after Settings is reopened', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const initialSnapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      codebuddy: {},
      providers: [],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: true,
      codebuddyManaged: false
    }
    const detectedSnapshot = {
      ...initialSnapshot,
      codebuddy: { resolvedPath: '/opt/homebrew/bin/codebuddy', version: '2.138.0' }
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(initialSnapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: true,
      codebuddyReady: false,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: false
    })
    const detectCodeBuddy = vi
      .fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValue(detectedSnapshot)
    api.settings.detectCodeBuddy = detectCodeBuddy

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()
    await waitFor(() => expect(detectCodeBuddy).toHaveBeenCalledOnce())
    expect(document.body.querySelector('[aria-label="Install CodeBuddy"]')).not.toBeNull()

    await act(async () => {
      root.render(<SettingsPage open={false} onClose={vi.fn()} />)
    })
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    await waitFor(() => expect(detectCodeBuddy).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(document.body.textContent).toContain('/opt/homebrew/bin/codebuddy')
    })
    expect(document.body.querySelector('[aria-label="Repair CodeBuddy"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Install CodeBuddy"]')).toBeNull()
  })

  it('keeps an outdated Codex ACP install in Installed and offers an update', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.1.4' },
      codebuddy: {},
      providers: [],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: true,
      codebuddyManaged: false
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: false,
      codebuddyReady: false,
      agentFrameworkId: 'codex',
      agentReady: false,
      activeProviderReady: false
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    expect(document.body.textContent).toContain('Installed · 2')
    expect(document.body.textContent).toContain('Available · 2')
    expect(document.body.textContent).toContain('Update required')
    expect(document.body.querySelector('[aria-label="Update Codex"]')).not.toBeNull()
    const frameworkRadios = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="radio"][aria-label^="Use "]')
    )
    expect(frameworkRadios).toHaveLength(1)
    expect(frameworkRadios[0]?.getAttribute('aria-label')).toBe('Use Claude Agent')
    expect(frameworkRadios[0]?.tabIndex).toBe(0)
  })

  it('routes isolated subscription sign-out from the provider list', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: ['gpt-5.6-sol'],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false,
      lastValidatedAt: 1
    }
    const snapshot = {
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      providers: [provider],
      activeProviderId: provider.id,
      activeModel: 'gpt-5.6-sol',
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      codexReady: true,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: true
    })
    const logoutIsolatedCodex = vi.fn().mockResolvedValue({ ok: true, category: 'ok' })
    api.settings.logoutIsolatedCodex = logoutIsolatedCodex

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signOut = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign out"]')
    await act(async () => signOut?.click())

    expect(logoutIsolatedCodex).toHaveBeenCalledOnce()
    const errorAlert = document.body.querySelector('[role="alert"]')
    expect(errorAlert).toBeNull()
  })

  it('surfaces a Codex sign-out timeout through the provider error alert', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: ['gpt-5.6-sol'],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false,
      verified: true,
      lastValidatedAt: Date.now()
    }
    const snapshot = {
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      providers: [provider],
      activeProviderId: provider.id,
      activeModel: 'gpt-5.6-sol',
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      codexReady: true,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: true
    })
    const logoutIsolatedCodex = vi
      .fn()
      .mockResolvedValue({ ok: false, category: 'timeout', message: 'Codex sign-out timed out.' })
    api.settings.logoutIsolatedCodex = logoutIsolatedCodex

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signOut = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign out"]')
    await act(async () => signOut?.click())

    expect(logoutIsolatedCodex).toHaveBeenCalledOnce()
    const errorAlert = document.body.querySelector('[role="alert"]')
    expect(errorAlert?.textContent).toBe('Codex sign-out timed out.')
  })

  it('summarizes Codex login-check IPC failures and keeps their diagnostics available', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-shared',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: ['gpt-5.6-sol'],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      providers: [provider],
      activeProviderId: provider.id,
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      codexReady: true,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: false
    })
    api.settings.validateProvider = vi
      .fn()
      .mockRejectedValue(new Error('The Codex adapter does not support authentication status.'))

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const testLogin = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Check Codex login"]'
    )
    await act(async () => testLogin?.click())

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not test the provider connection.'
    )
    const details = document.body.querySelector('details')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain(
      'The Codex adapter does not support authentication status.'
    )
  })

  it('cancels a pending isolated sign-in when the dialog closes mid-flow', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: [],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      providers: [provider],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    })
    // The browser flow never settles on its own; closing the dialog is what cancels it.
    api.settings.loginIsolatedCodex = vi.fn(() => new Promise(() => undefined))
    api.settings.cancelCodexLogin = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signIn = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign in"]')
    await act(async () => signIn?.click())
    expect(document.body.querySelector('[aria-label="Cancel sign-in"]')).not.toBeNull()

    await act(async () => {
      root.render(<SettingsPage open={false} onClose={vi.fn()} />)
    })

    expect(api.settings.cancelCodexLogin).toHaveBeenCalledOnce()
  })

  it('summarizes isolated sign-in failures and keeps their diagnostics available', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: [],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.6.2' },
      providers: [provider],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    })
    api.settings.loginIsolatedCodex = vi
      .fn()
      .mockRejectedValue(new Error('The Codex adapter failed to spawn.'))

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signIn = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign in"]')
    await act(async () => signIn?.click())

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not sign in to Codex.'
    )
    const details = document.body.querySelector('details')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('The Codex adapter failed to spawn.')
  })
})
