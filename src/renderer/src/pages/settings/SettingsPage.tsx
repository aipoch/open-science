/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: settings side rail · genre: modern-minimal · theme: existing Open Science tokens · slop: pass */
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Bot,
  Brain,
  BrainCircuit,
  ChartNoAxesCombined,
  Cloud,
  Globe,
  KeyRound,
  LockKeyhole,
  Maximize2,
  Menu,
  MessageSquare,
  Minimize2,
  MonitorSmartphone,
  ScrollText,
  Settings2,
  TerminalSquare,
  Tags as TagsIcon,
  Users,
  X,
  Zap
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { FocusScope } from '@radix-ui/react-focus-scope'
import {
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  resolveCodexSubscriptionType,
  type ProviderView,
  type UpsertProviderRequest
} from '../../../../shared/settings'
import { APP } from '../../../../shared/app-config'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/utils'
import type { SessionCatalogRecovery } from '@/lib/session-persistence/session-persistence'
import { preloadComputeHosts, useComputeStore } from '@/stores/compute-store'
import { useMemoryStore } from '@/stores/memory-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import {
  INITIAL_SETTINGS_ROUTE,
  settingsPanelRoute,
  type ModelView,
  type NetworkView,
  type SettingsPanelId,
  type SettingsRoute
} from './settings-navigation'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useTagStore } from '@/stores/tag-store'
import { ProvidersPanel } from './ProvidersPanel'
import type { SkillsView } from './SkillsPanel'
import type { ConnectorsView } from './ConnectorsPanel'
import type { SpecialistsView } from './SpecialistsPanel'
import { ResourceTagSummary } from './ResourceTagControls'
import { ConnectorsNavIcon } from './connector-icons'
import type { ComputeView } from './ComputePanel'
import type { ArchivedView } from './ArchivedPanel'
import type { MemoryView } from './MemoryPanel'
import type { TagsView } from './TagsPanel'
import type { CredentialsView } from './CredentialsPanel'
import { resolveVendorModelsUrl } from '../../../../shared/provider-registry'
import { ProviderForm } from './ProviderForm'
import {
  createEmptyProviderFormValue,
  defaultCustomApiEndpoint,
  defaultProviderKindKey,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerFormApiEndpoints,
  providerFormTokenLimits,
  providerKindPatch,
  type ProviderFormValue
} from './provider-form-value'
import { SettingsPanelLoadingBoundary } from './SettingsPanelLoadingBoundary'
import { localizeProviderResourceMessage } from './validation-message'
import { loadSettingsPanel } from './settings-panel-loader'

const AgentPanel = lazy(async () => ({ default: (await import('./AgentPanel')).AgentPanel }))
const GeneralPanel = lazy(async () => ({ default: (await import('./GeneralPanel')).GeneralPanel }))
const NetworkPanel = lazy(async () => ({ default: (await import('./NetworkPanel')).NetworkPanel }))
const StoragePanel = lazy(async () => {
  const module = await loadSettingsPanel(
    () => import('./StoragePanel'),
    () =>
      import('@/stores/storage-info-store').then(({ useStorageInfoStore }) =>
        useStorageInfoStore.getState().loadStatus()
      )
  )
  return { default: module.StoragePanel }
})
const RuntimesPanel = lazy(async () => {
  const module = await loadSettingsPanel(
    () => import('./RuntimesPanel'),
    () =>
      import('@/stores/runtime-settings-store').then(({ useRuntimeSettingsStore }) =>
        useRuntimeSettingsStore.getState().load()
      )
  )
  return { default: module.RuntimesPanel }
})
const RemoteControlPanel = lazy(async () => {
  const module = await import('./RemoteControlPanel')
  await module.RemoteControlPanel.preload().catch(() => undefined)
  return { default: module.RemoteControlPanel }
})
const SkillsPanel = lazy(async () => {
  const module = await loadSettingsPanel(
    () => import('./SkillsPanel'),
    () => useSettingsStore.getState().loadSkills()
  )
  return { default: module.SkillsPanel }
})
const ConnectorsPanel = lazy(async () => {
  const module = await loadSettingsPanel(
    () => import('./ConnectorsPanel'),
    () => useSettingsStore.getState().loadConnectors()
  )
  return { default: module.ConnectorsPanel }
})
const SpecialistsPanel = lazy(async () => {
  const module = await loadSettingsPanel(
    () => import('./SpecialistsPanel'),
    () => useSpecialistStore.getState().load()
  )
  return { default: module.SpecialistsPanel }
})
const MemoryPanel = lazy(async () => {
  const module = await import('./MemoryPanel')
  return { default: module.MemoryPanel }
})
const TagsPanel = lazy(async () => {
  const tagState = useTagStore.getState()
  const module = await loadSettingsPanel(
    () => import('./TagsPanel'),
    () =>
      Promise.all([
        tagState.status === 'idle' ? tagState.load() : Promise.resolve(),
        useSettingsStore.getState().loadSkills(),
        useSettingsStore.getState().loadConnectors(),
        useSpecialistStore.getState().load()
      ])
  )
  return { default: module.TagsPanel }
})
const ConnectorDetailView = lazy(async () => ({
  default: (await import('./ConnectorDetailView')).ConnectorDetailView
}))
const ConnectorAddForm = lazy(async () => ({
  default: (await import('./ConnectorAddForm')).ConnectorAddForm
}))
const ConnectorExportView = lazy(async () => ({
  default: (await import('./ConnectorExportView')).ConnectorExportView
}))
const ConnectorImportView = lazy(async () => ({
  default: (await import('./ConnectorImportView')).ConnectorImportView
}))
const ComputePanel = lazy(async () => {
  const module = await loadSettingsPanel(
    () => import('./ComputePanel'),
    () => preloadComputeHosts()
  )
  return { default: module.ComputePanel }
})
const ComputeAddForm = lazy(async () => ({
  default: (await import('./ComputeAddForm')).ComputeAddForm
}))
const ComputeHostDetail = lazy(async () => ({
  default: (await import('./ComputeHostDetail')).ComputeHostDetail
}))
const PermissionsPanel = lazy(async () => {
  const module = await loadSettingsPanel(
    () => import('./PermissionsPanel'),
    () =>
      import('@/stores/permission-grants-store').then(({ usePermissionGrantsStore }) =>
        usePermissionGrantsStore.getState().load()
      )
  )
  return { default: module.PermissionsPanel }
})
const CredentialsPanel = lazy(async () => ({
  default: (await import('./CredentialsPanel')).CredentialsPanel
}))
const ArchivedPanel = lazy(async () => ({
  default: (await import('./ArchivedPanel')).ArchivedPanel
}))
const TokenUsagePanel = lazy(async () => ({
  default: (await import('./TokenUsagePanel')).TokenUsagePanel
}))

type SettingsPageProps = {
  open: boolean
  onClose: () => void
  onOpenSession?: (sessionId: string) => void
  canDeleteProjects?: boolean
  hasCompleteSessionCatalog?: boolean
  catalogRecovery?: SessionCatalogRecovery
  onRetryCatalogRecovery?: () => void
}

type SettingsPageHandle = {
  closeActivePane: () => boolean
}

// Builds a form value from an existing provider (never carrying the plaintext key).
const toFormValue = (provider: ProviderView): ProviderFormValue =>
  createEmptyProviderFormValue({
    type:
      provider.type === 'codex-shared' || provider.type === 'codex-isolated'
        ? resolveCodexSubscriptionType(provider)
        : provider.type,
    codexTransport: provider.codexTransport ?? 'auto',
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
    model: provider.model ?? '',
    contextWindow: provider.contextWindow?.toString() ?? '',
    maxInputTokens: provider.maxInputTokens?.toString() ?? '',
    maxOutputTokens: provider.maxOutputTokens?.toString() ?? '',
    apiEndpoint: provider.apiEndpoints?.[0] ?? 'anthropic',
    supportsImageInput: provider.supportsImageInput,
    reasoningEffortPreset: provider.reasoningEffortPreset ?? 'standard-5',
    reasoningEffortTransport: provider.reasoningEffortTransport ?? 'reasoning-effort',
    vendorId: provider.vendorId,
    region: provider.region
  })

const toUpsertRequest = (
  value: ProviderFormValue,
  id: string | undefined
): UpsertProviderRequest => ({
  id,
  type: value.type,
  codexTransport: value.codexTransport,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  ...providerFormTokenLimits(value),
  apiEndpoints: providerFormApiEndpoints(value),
  supportsImageInput: value.supportsImageInput,
  reasoningEffortPreset: value.type === 'custom' ? value.reasoningEffortPreset : undefined,
  reasoningEffortTransport: value.type === 'custom' ? value.reasoningEffortTransport : undefined,
  vendorId: value.vendorId,
  region: value.region,
  key: value.key || undefined
})

type SettingsPanel = {
  id: SettingsPanelId
  // A catalog key, not finished copy: this table is module-level, so a resolved string would freeze the
  // language at import time and never re-render on a language change. Callers resolve it through t().
  labelKey: string
  Icon: React.ComponentType<{ className?: string }>
}

// The panels that can host a drilled-in sub-view, mapped from the capitalized name the breadcrumb
// button shows to the lowercase form mid-sentence copy needs ("Back to skills"). English distinguishes
// the two, Chinese does not, so they are separate catalog entries that resolve to the same translation.
// Keyed rather than derived: the old code sliced a prefix off the key and cast the result, which hid
// that one panel had no lowercase entry at all and rendered a raw key path to screen readers.
const PANEL_NAME_LOWER = {
  Skills: 'skills',
  Model: 'model',
  Network: 'network',
  Connectors: 'connectors',
  Compute: 'compute',
  Specialists: 'specialists',
  Memory: 'memory',
  Tags: 'tags',
  Credentials: 'credentials',
  Archived: 'archived'
} as const

type DrillablePanelName = keyof typeof PANEL_NAME_LOWER

type SettingsGroup = {
  // The union rather than `string` is deliberate: a group added later cannot compile until its
  // heading is a known catalog key, so it can never reach the nav as a raw untranslated label.
  labelKey: 'Capabilities' | 'Workspace'
  panels: ReadonlyArray<SettingsPanel>
}

const SETTINGS_GROUPS: ReadonlyArray<SettingsGroup> = [
  {
    labelKey: 'Capabilities',
    panels: [
      { id: 'skills', labelKey: 'Skills', Icon: ScrollText },
      { id: 'connectors', labelKey: 'Connectors', Icon: ConnectorsNavIcon },
      { id: 'specialists', labelKey: 'Specialists', Icon: Users },
      { id: 'memory', labelKey: 'Memory', Icon: BrainCircuit },
      { id: 'compute', labelKey: 'Compute', Icon: Zap },
      { id: 'network', labelKey: 'Network', Icon: Globe }
    ]
  },
  {
    labelKey: 'Workspace',
    panels: [
      { id: 'model', labelKey: 'Model', Icon: Brain },
      { id: 'agent', labelKey: 'Agent', Icon: Bot },
      { id: 'tags', labelKey: 'Tags', Icon: TagsIcon },
      { id: 'permissions', labelKey: 'Permissions', Icon: LockKeyhole },
      { id: 'credentials', labelKey: 'Credentials', Icon: KeyRound },
      { id: 'runtimes', labelKey: 'Runtimes', Icon: TerminalSquare },
      { id: 'storage', labelKey: 'Storage', Icon: Cloud },
      { id: 'remote-control', labelKey: 'Remote', Icon: MonitorSmartphone },
      { id: 'usage', labelKey: 'Usage', Icon: ChartNoAxesCombined },
      { id: 'general', labelKey: 'General', Icon: Settings2 },
      { id: 'archived', labelKey: 'Archived', Icon: Archive }
    ]
  }
]

// Flattened panel list for lookups (header title, etc.).
const SETTINGS_PANELS: ReadonlyArray<SettingsPanel> = SETTINGS_GROUPS.flatMap(
  (group) => group.panels
)
const EMPTY_USAGE_SESSIONS = [] as const
const EMPTY_USAGE_PROJECTS = [] as const

// App-level model settings surface. Reuses the onboarding cards/form; manages providers (CRUD +
// activate + test). Opened from the Home/Workspace gear entry.
const SettingsPage = forwardRef<SettingsPageHandle, SettingsPageProps>(function SettingsPage(
  {
    open,
    onClose,
    onOpenSession,
    canDeleteProjects = true,
    hasCompleteSessionCatalog = true,
    catalogRecovery = { kind: 'ready' },
    onRetryCatalogRecovery
  },
  ref
): React.JSX.Element {
  const { t } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const customApiEndpoint = defaultCustomApiEndpoint(frameworkEndpoints)
  const opencode = useSettingsStore((state) => state.opencode)
  const isDetectingOpencode = useSettingsStore((state) => state.isDetectingOpencode)
  const detectOpencode = useSettingsStore((state) => state.detectOpencode)
  const codex = useSettingsStore((state) => state.codex)
  const isDetectingCodex = useSettingsStore((state) => state.isDetectingCodex)
  const detectCodex = useSettingsStore((state) => state.detectCodex)
  const codebuddy = useSettingsStore((state) => state.codebuddy)
  const isDetectingCodeBuddy = useSettingsStore((state) => state.isDetectingCodeBuddy)
  const detectCodeBuddy = useSettingsStore((state) => state.detectCodeBuddy)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const load = useSettingsStore((state) => state.load)
  const persistProvider = useSettingsStore((state) => state.persistProvider)
  const validateProvider = useSettingsStore((state) => state.validateProvider)
  const refreshProviderModels = useSettingsStore((state) => state.refreshProviderModels)
  const pendingSettingsIntent = useSettingsStore((state) => state.pendingSettingsIntent)
  const consumePendingSettingsIntent = useSettingsStore(
    (state) => state.consumePendingSettingsIntent
  )
  const settingsWriteError = useSettingsStore((state) => state.settingsWriteError)
  const clearSettingsWriteError = useSettingsStore((state) => state.clearSettingsWriteError)
  const canImportInstalledSkills =
    typeof window.api.settings.listAgentHomeSkills === 'function' &&
    typeof window.api.settings.importAgentHomeSkills === 'function'

  // Settings navigation history (browser-like back/forward). Each entry contains only its active
  // panel route, so unrelated panel views cannot form impossible combinations.
  const [history, setHistory] = useState<SettingsRoute[]>([INITIAL_SETTINGS_ROUTE])
  const [historyIndex, setHistoryIndex] = useState(0)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  // Whether the dialog is enlarged to near-fullscreen via the maximize control.
  const [isExpanded, setIsExpanded] = useState(false)
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false)
  const mobileNavRef = useRef<HTMLElement | null>(null)
  const mobileNavTriggerRef = useRef<HTMLButtonElement | null>(null)
  const mobileNavWasOpenRef = useRef(false)
  const codebuddyAutoDetectAttempted = useRef(false)
  const skills = useSettingsStore((state) => state.skills)
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const deviceCredentials = useSettingsStore((state) => state.deviceCredentials)
  const computeHosts = useComputeStore((state) => state.hosts)
  const specialistItems = useSpecialistStore((state) => state.items)
  const loadTags = useTagStore((state) => state.load)
  const listenForTagChanges = useTagStore((state) => state.listen)
  const loadMemory = useMemoryStore((state) => state.load)
  const listenForMemoryChanges = useMemoryStore((state) => state.listen)
  const browserSelectedTagId = useTagStore((state) => state.browserSelectedId)
  const setSelectedTagId = useTagStore((state) => state.setBrowserSelectedId)
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined)
  const [statusOk, setStatusOk] = useState(false)
  // Shared with ProvidersPanel: the post-save validation and the list's manual test both mark the
  // provider busy so its card shows "Testing…".
  const [busyProviderId, setBusyProviderId] = useState<string | undefined>(undefined)
  const [postSaveValidationFailed, setPostSaveValidationFailed] = useState(false)
  const postSaveValidationGeneration = useRef(0)
  const postSaveValidationProviderId = useRef<string | undefined>(undefined)

  useEffect(() => {
    const providerId = postSaveValidationProviderId.current
    if (!providerId || providers.some((provider) => provider.id === providerId)) return

    postSaveValidationGeneration.current += 1
    postSaveValidationProviderId.current = undefined
    setBusyProviderId(undefined)
    setPostSaveValidationFailed(false)
  }, [providers])

  // Refresh settings whenever the dialog opens so external changes are reflected.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    void loadTags()
    return listenForTagChanges()
  }, [listenForTagChanges, loadTags, open])

  useEffect(() => {
    if (!open) return
    return listenForMemoryChanges()
  }, [listenForMemoryChanges, open])

  useEffect(() => {
    if (isMobile && isMobileNavOpen) {
      mobileNavWasOpenRef.current = true
      const activeItem = mobileNavRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
      const firstItem = mobileNavRef.current?.querySelector<HTMLElement>('button')
      ;(activeItem ?? firstItem)?.focus()
      return
    }
    if (!mobileNavWasOpenRef.current) return
    mobileNavWasOpenRef.current = false
    mobileNavTriggerRef.current?.focus()
  }, [isMobile, isMobileNavOpen])

  // External entry points publish one route intent with an event identity. Guard by request rather
  // than target value so two separate requests for the same route are both honored.
  const [seededIntentId, setSeededIntentId] = useState<number | undefined>()
  if (
    open &&
    pendingSettingsIntent !== undefined &&
    pendingSettingsIntent.requestId !== seededIntentId
  ) {
    setSeededIntentId(pendingSettingsIntent.requestId)
    setHistory([pendingSettingsIntent.route])
    setHistoryIndex(0)
  }
  if (!open && seededIntentId !== undefined) {
    setSeededIntentId(undefined)
  }

  // Consume only the request applied above. A newer intent that arrives before this effect runs must
  // remain pending for the next render.
  useEffect(() => {
    if (open && pendingSettingsIntent !== undefined) {
      consumePendingSettingsIntent(pendingSettingsIntent.requestId)
    }
  }, [consumePendingSettingsIntent, open, pendingSettingsIntent])

  const currentRoute = history[historyIndex]
  const activePanel = currentRoute.panel

  useEffect(() => {
    if (open && activePanel === 'memory') void loadMemory()
  }, [activePanel, loadMemory, open])

  // Auto-detect opencode the first time its detection card is shown without a known path, so the card
  // reflects reality without a manual re-detect. Guarded on path + in-flight to run at most once.
  useEffect(() => {
    if (
      open &&
      activePanel === 'agent' &&
      agentFrameworkId === 'opencode' &&
      !opencode?.resolvedPath &&
      !isDetectingOpencode
    ) {
      void detectOpencode()
    }
  }, [
    open,
    activePanel,
    agentFrameworkId,
    opencode?.resolvedPath,
    isDetectingOpencode,
    detectOpencode
  ])

  // Codex detection probes the ACP adapter and its paired native runtime. Keep it lazy so opening
  // settings for another framework does not spawn an unnecessary process.
  useEffect(() => {
    if (
      open &&
      activePanel === 'agent' &&
      agentFrameworkId === 'codex' &&
      !codex?.resolvedPath &&
      !isDetectingCodex
    ) {
      void detectCodex()
    }
  }, [open, activePanel, agentFrameworkId, codex?.resolvedPath, isDetectingCodex, detectCodex])

  useEffect(() => {
    if (!open) {
      codebuddyAutoDetectAttempted.current = false
      return
    }

    if (
      activePanel === 'agent' &&
      !codebuddyAutoDetectAttempted.current &&
      !codebuddy?.resolvedPath &&
      !isDetectingCodeBuddy
    ) {
      codebuddyAutoDetectAttempted.current = true
      void detectCodeBuddy()
    }
  }, [open, activePanel, codebuddy?.resolvedPath, isDetectingCodeBuddy, detectCodeBuddy])

  const isUsageVisible = open && activePanel === 'usage'
  const sessions = useSessionStore((state) =>
    isUsageVisible ? state.sessions : EMPTY_USAGE_SESSIONS
  )
  const projects = useProjectStore((state) =>
    isUsageVisible ? state.projects : EMPTY_USAGE_PROJECTS
  )
  const skillsView: SkillsView =
    currentRoute.panel === 'skills' ? currentRoute.view : { kind: 'list' }
  const modelView: ModelView = currentRoute.panel === 'model' ? currentRoute.view : { kind: 'list' }
  const connectorsView: ConnectorsView =
    currentRoute.panel === 'connectors' ? currentRoute.view : { kind: 'list' }
  const notebookNetworkAvailable =
    typeof window.api.settings.getNotebookNetworkStatus === 'function' &&
    !document.documentElement.hasAttribute('data-open-science-notebook-network-unavailable')
  const networkView: NetworkView =
    currentRoute.panel === 'network' &&
    (currentRoute.view.kind !== 'domains' || notebookNetworkAvailable)
      ? currentRoute.view
      : { kind: 'list' }
  const computeView: ComputeView =
    currentRoute.panel === 'compute' ? currentRoute.view : { kind: 'list' }
  const specialistsView: SpecialistsView =
    currentRoute.panel === 'specialists' ? currentRoute.view : { kind: 'list' }
  const archivedView: ArchivedView =
    currentRoute.panel === 'archived' ? currentRoute.view : { kind: 'list' }
  const memoryView: MemoryView =
    currentRoute.panel === 'memory' ? currentRoute.view : { kind: 'list' }
  const tagsView: TagsView = currentRoute.panel === 'tags' ? currentRoute.view : { kind: 'list' }
  const credentialsView: CredentialsView =
    currentRoute.panel === 'credentials' ? currentRoute.view : { kind: 'list' }
  const activeTagId =
    tagsView.kind === 'list'
      ? tagsView.tagId
      : tagsView.kind === 'edit'
        ? tagsView.tagId
        : undefined
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1

  useEffect(() => {
    if (activeTagId) setSelectedTagId(activeTagId)
  }, [activeTagId, setSelectedTagId])

  // Pushes a complete active route, dropping any forward entries. Routes contain only serializable
  // navigation values, so comparing the whole route automatically covers fields added later.
  const navigate = (route: SettingsRoute): void => {
    if (JSON.stringify(route) === JSON.stringify(currentRoute)) return
    setHistory((entries) => [...entries.slice(0, historyIndex + 1), route])
    setHistoryIndex((index) => index + 1)
  }

  // Internal panel transitions must use this dialog's history instead of reseeding an external
  // entry point, so Back returns to the recovery panel the user just completed.
  const navigatePanel = (panel: SettingsPanelId): void => {
    if (panel === 'tags') {
      navigate({ panel, view: { kind: 'list', tagId: browserSelectedTagId } })
      return
    }
    navigate(settingsPanelRoute(panel))
  }

  const navigateTag = (tagId: string): void => {
    setSelectedTagId(tagId)
    navigate({ panel: 'tags', view: { kind: 'list', tagId } })
  }

  const recordSelectedTag = useCallback(
    (tagId: string): void => {
      setHistory((entries) => {
        const entry = entries[historyIndex]
        if (entry?.panel !== 'tags' || entry.view.kind !== 'list' || entry.view.tagId === tagId) {
          return entries
        }
        return entries.map((candidate, index) =>
          index === historyIndex && candidate.panel === 'tags' && candidate.view.kind === 'list'
            ? { ...candidate, view: { ...candidate.view, tagId } }
            : candidate
        )
      })
    },
    [historyIndex]
  )

  // Navigates within the skills panel (list/detail/create/edit/import) as a history entry.
  const navigateSkills = (skills: SkillsView): void => navigate({ panel: 'skills', view: skills })

  // Navigates within the connectors panel (list/detail/add/edit) as a history entry.
  const navigateConnectors = (connectors: ConnectorsView): void =>
    navigate({ panel: 'connectors', view: connectors })

  // Navigates within the specialists panel (list/create) as a history entry.
  const navigateSpecialists = (specialists: SpecialistsView): void =>
    navigate({ panel: 'specialists', view: specialists })

  // Navigates within the network panel (package-mirror list vs. configure) as a history entry, so the
  // configure form gets a proper "Network / Package mirror" breadcrumb + back/forward.
  const navigateNetwork = (network: NetworkView): void =>
    navigate({ panel: 'network', view: network })

  // Navigates within the compute panel (list/add/detail) as a history entry.
  const navigateCompute = (compute: ComputeView): void =>
    navigate({ panel: 'compute', view: compute })

  const navigateArchived = (archived: ArchivedView): void =>
    navigate({ panel: 'archived', view: archived })

  const navigateMemory = (memory: MemoryView): void => navigate({ panel: 'memory', view: memory })

  const navigateTags = (tags: TagsView): void => navigate({ panel: 'tags', view: tags })

  const navigateCredentials = (credentials: CredentialsView): void =>
    navigate({ panel: 'credentials', view: credentials })

  // Shared header breadcrumb for a drilled-in sub-view (null when on a panel's list, so the plain
  // panel title shows). Covers both the skills and model panels.
  const breadcrumb = ((): {
    rootLabelKey: DrillablePanelName
    rootTo: SettingsRoute
    parents?: ReadonlyArray<{
      label: string
      to: SettingsRoute
      ariaLabel: string
      onClick?: () => void
    }>
    leaf: string
  } | null => {
    if (activePanel === 'skills' && skillsView.kind !== 'list') {
      const leaf =
        skillsView.kind === 'create'
          ? t('New skill')
          : skillsView.kind === 'manage'
            ? t('Manage skills')
            : skillsView.kind === 'upload'
              ? t('Upload skills')
              : skillsView.kind === 'import'
                ? t('Import from GitHub')
                : skillsView.kind === 'import-agent-home'
                  ? t('Import installed skills')
                  : (() => {
                      const name = skills.find((skill) => skill.id === skillsView.id)?.name ?? ''
                      return skillsView.kind === 'edit' ? t('Edit {{name}}', { name }).trim() : name
                    })()
      return {
        rootLabelKey: 'Skills',
        rootTo: { panel: 'skills', view: { kind: 'list' } },
        leaf
      }
    }
    if (activePanel === 'model' && modelView.kind !== 'list') {
      const name =
        modelView.kind === 'edit'
          ? (providers.find((provider) => provider.id === modelView.providerId)?.name ?? '')
          : ''
      return {
        rootLabelKey: 'Model',
        rootTo: { panel: 'model', view: { kind: 'list' } },
        leaf: modelView.kind === 'create' ? t('Add provider') : t('Edit {{name}}', { name }).trim()
      }
    }
    if (activePanel === 'network' && networkView.kind !== 'list') {
      return {
        rootLabelKey: 'Network',
        rootTo: { panel: 'network', view: { kind: 'list' } },
        leaf:
          networkView.kind === 'proxy'
            ? t('Proxy')
            : networkView.kind === 'domains'
              ? t('Notebook network access')
              : t('Package mirror')
      }
    }
    if (activePanel === 'connectors' && connectorsView.kind !== 'list') {
      if (connectorsView.kind === 'add' && connectorsView.credentialView === 'create') {
        const addConnectorRoute: SettingsRoute = {
          panel: 'connectors',
          view: {
            kind: 'add',
            transport: connectorsView.transport,
            ...(connectorsView.template ? { template: connectorsView.template } : {})
          }
        }
        return {
          rootLabelKey: 'Connectors',
          rootTo: { panel: 'connectors', view: { kind: 'list' } },
          parents: [
            {
              label: t('Add connector'),
              to: addConnectorRoute,
              ariaLabel: t('Back to {{panel}}', { panel: t('Add connector') }),
              onClick: () => setHistoryIndex((index) => Math.max(0, index - 1))
            }
          ],
          leaf: t('New credential')
        }
      }
      if (connectorsView.kind === 'edit' && connectorsView.credentialView === 'create') {
        const connectorName =
          customServers.find((server) => server.id === connectorsView.id)?.name ?? t('connector')
        const editConnectorLabel = t('Edit {{name}}', { name: connectorName }).trim()
        return {
          rootLabelKey: 'Connectors',
          rootTo: { panel: 'connectors', view: { kind: 'list' } },
          parents: [
            {
              label: editConnectorLabel,
              to: { panel: 'connectors', view: { kind: 'edit', id: connectorsView.id } },
              ariaLabel: t('Back to {{panel}}', { panel: editConnectorLabel }),
              onClick: () => setHistoryIndex((index) => Math.max(0, index - 1))
            }
          ],
          leaf: t('New credential')
        }
      }
      const leaf =
        connectorsView.kind === 'add'
          ? t('Add connector')
          : connectorsView.kind === 'import'
            ? t('Import Connector or MCP configuration')
            : connectorsView.kind === 'export'
              ? t('Export {{name}}', {
                  name:
                    customServers.find((s) => s.id === connectorsView.id)?.name ?? t('connector')
                }).trim()
              : connectorsView.kind === 'edit'
                ? t('Edit {{name}}', {
                    name:
                      customServers.find((s) => s.id === connectorsView.id)?.name ?? t('connector')
                  }).trim()
                : (connectors.find((c) => c.id === connectorsView.id)?.displayName ?? '')
      return {
        rootLabelKey: 'Connectors',
        rootTo: { panel: 'connectors', view: { kind: 'list' } },
        leaf
      }
    }
    if (activePanel === 'compute' && computeView.kind !== 'list') {
      const leaf =
        computeView.kind === 'add'
          ? t('Add SSH host')
          : (computeHosts.find((host) => host.providerId === computeView.providerId)?.displayName ??
            computeView.providerId)
      return {
        rootLabelKey: 'Compute',
        rootTo: { panel: 'compute', view: { kind: 'list' } },
        leaf
      }
    }
    if (activePanel === 'specialists' && specialistsView.kind !== 'list') {
      const rootTo: SettingsRoute = {
        panel: 'specialists',
        view: { kind: 'list' }
      }
      if (
        specialistsView.kind === 'marketplace-sources' ||
        specialistsView.kind === 'marketplace-release'
      ) {
        return {
          rootLabelKey: 'Specialists',
          rootTo,
          parents: [
            {
              label: t('Marketplace'),
              to: { panel: 'specialists', view: { kind: 'marketplace' } },
              ariaLabel: t('Back to Marketplace')
            }
          ],
          leaf:
            specialistsView.kind === 'marketplace-sources'
              ? t('Marketplace sources')
              : specialistsView.id
        }
      }
      const editingSpecialist =
        specialistsView.kind === 'edit'
          ? specialistItems.find(
              (item): item is Extract<SpecialistListItem, { kind: 'custom' }> =>
                item.kind === 'custom' && item.id === specialistsView.id
            )
          : undefined
      const leaf =
        specialistsView.kind === 'create'
          ? t('New specialist')
          : specialistsView.kind === 'marketplace'
            ? t('Marketplace')
            : (editingSpecialist?.name ?? t('Edit specialist'))
      return {
        rootLabelKey: 'Specialists',
        rootTo,
        leaf
      }
    }
    if (activePanel === 'memory' && memoryView.kind !== 'list') {
      return {
        rootLabelKey: 'Memory',
        rootTo: { panel: 'memory', view: { kind: 'list' } },
        leaf: memoryView.kind === 'create' ? t('New category') : t('Edit category')
      }
    }
    if (activePanel === 'tags' && tagsView.kind !== 'list') {
      return {
        rootLabelKey: 'Tags',
        rootTo: {
          panel: 'tags',
          view: {
            kind: 'list',
            tagId: tagsView.kind === 'edit' ? tagsView.tagId : browserSelectedTagId
          }
        },
        leaf: tagsView.kind === 'create' ? t('New Tag') : t('Edit Tag')
      }
    }
    if (activePanel === 'credentials' && credentialsView.kind !== 'list') {
      const leaf =
        credentialsView.kind === 'create'
          ? t('New credential')
          : credentialsView.kind === 'credential'
            ? (deviceCredentials.find(({ id }) => id === credentialsView.id)?.displayName ??
              t('Credential'))
            : credentialsView.serviceId === 'github'
              ? t('GitHub')
              : credentialsView.serviceId === 'openalex'
                ? t('OpenAlex')
                : t('Literature access')
      return {
        rootLabelKey: 'Credentials',
        rootTo: { panel: 'credentials', view: { kind: 'list' } },
        leaf
      }
    }
    if (activePanel === 'archived' && archivedView.kind === 'project') {
      return {
        rootLabelKey: 'Archived',
        rootTo: { panel: 'archived', view: { kind: 'list' } },
        leaf:
          projects.find((project) => project.id === archivedView.projectId)?.name ??
          t('Archived project')
      }
    }
    return null
  })()

  const goBack = (): void => {
    if (!canGoBack) return
    setHistoryIndex((index) => index - 1)
  }

  const goForward = (): void => {
    if (!canGoForward) return
    setHistoryIndex((index) => index + 1)
  }

  useImperativeHandle(ref, () => ({
    closeActivePane: () => {
      if (!open) return false
      const activeDialog = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
        )
      )
        .filter((dialog) => dialog.dataset.slot !== 'settings-surface')
        .at(-1)
      if (activeDialog) {
        activeDialog.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        )
        return true
      }
      if (isMobileNavOpen) {
        setIsMobileNavOpen(false)
        return true
      }
      if (breadcrumb) {
        if (canGoBack) setHistoryIndex((index) => index - 1)
        else {
          setHistory((entries) =>
            entries.map((entry, index) => (index === historyIndex ? breadcrumb.rootTo : entry))
          )
        }
      } else {
        setIsMobileNavOpen(false)
        onClose()
      }
      return true
    }
  }))

  // Only create/edit locations open a provider form.
  const isProviderFormOpen =
    activePanel === 'model' && (modelView.kind === 'create' || modelView.kind === 'edit')
  // Resolve the edited provider from the live store so a model refresh (which updates the cache) is
  // reflected in the form; undefined until the provider is found (or when creating).
  const editingProvider =
    modelView.kind === 'edit'
      ? providers.find((provider) => provider.id === modelView.providerId)
      : undefined
  const providerEditTargetMissing = modelView.kind === 'edit' && editingProvider === undefined
  // Required-field errors for the open draft; a custom provider must be complete before it can save.
  const formErrors = getProviderFormErrors(formValue, { hasStoredKey: editingProvider?.hasKey })
  const canSave = !isSaving && !providerEditTargetMissing && !hasProviderFormErrors(formErrors)

  // Seed the form value when entering a create/edit sub-view (adjust-state-during-render, keyed on the
  // sub-view so typing isn't clobbered by background store updates; edit guards until the provider
  // loads). A create pre-selects the official vendor matching the active agent framework. Also
  // clears any stale status message on entry.
  const modelViewKey = modelView.kind === 'edit' ? `edit:${modelView.providerId}` : modelView.kind
  const [seededModelView, setSeededModelView] = useState(modelViewKey)
  if (modelViewKey !== seededModelView) {
    setSeededModelView(modelViewKey)
    if (modelView.kind === 'create') {
      setFormValue(
        createEmptyProviderFormValue(providerKindPatch(defaultProviderKindKey(agentFrameworkId)))
      )
    } else if (modelView.kind === 'edit') {
      const provider = providers.find((entry) => entry.id === modelView.providerId)
      if (provider) setFormValue(toFormValue(provider))
    }
    setStatusMessage(undefined)
  }

  const openCreate = (): void => {
    postSaveValidationGeneration.current += 1
    postSaveValidationProviderId.current = undefined
    setBusyProviderId(undefined)
    setPostSaveValidationFailed(false)
    navigate({ panel: 'model', view: { kind: 'create' } })
  }

  const openEdit = (provider: ProviderView): void => {
    postSaveValidationGeneration.current += 1
    postSaveValidationProviderId.current = undefined
    setBusyProviderId(undefined)
    setPostSaveValidationFailed(false)
    navigate({
      panel: 'model',
      view: { kind: 'edit', providerId: provider.id }
    })
  }

  const closeForm = (): void => navigate({ panel: 'model', view: { kind: 'list' } })

  const handleSave = async (): Promise<void> => {
    if (providerEditTargetMissing) return
    postSaveValidationGeneration.current += 1
    postSaveValidationProviderId.current = undefined
    setBusyProviderId(undefined)
    setIsSaving(true)
    setStatusMessage(undefined)
    setPostSaveValidationFailed(false)

    try {
      // Persist first and return to the provider list immediately — don't hold the form open waiting
      // for the connection test. The test then runs in the background and its result (green check or
      // warning) lands on the provider's card.
      const providerId = await persistProvider({
        ...toUpsertRequest(formValue, editingProvider?.id),
        ...(modelView.kind === 'edit' ? { requireExisting: true } : {})
      })

      navigate({ panel: 'model', view: { kind: 'list' } })

      if (providerId) {
        const validationGeneration = ++postSaveValidationGeneration.current
        postSaveValidationProviderId.current = providerId
        setBusyProviderId(providerId)
        void validateProvider({ providerId })
          .then(() => {
            if (postSaveValidationGeneration.current === validationGeneration) {
              postSaveValidationProviderId.current = undefined
              setPostSaveValidationFailed(false)
            }
          })
          .catch(() => {
            if (postSaveValidationGeneration.current === validationGeneration) {
              setPostSaveValidationFailed(true)
            }
          })
          .finally(() => {
            if (postSaveValidationGeneration.current === validationGeneration) {
              setBusyProviderId(undefined)
            }
          })
      }
    } catch (error) {
      setStatusOk(false)
      setStatusMessage(
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, t)
          : t('Could not save provider.')
      )
    } finally {
      setIsSaving(false)
    }
  }

  // Pulls the vendor's live model list for the provider being edited; on success the form's tags and
  // the model selectors reflect it. On failure the bundled catalog stays in place.
  const handleRefreshModels = async (providerId: string): Promise<void> => {
    setIsRefreshingModels(true)
    setStatusMessage(undefined)

    try {
      const result = await refreshProviderModels(providerId)

      setStatusOk(result.ok)
      setStatusMessage(
        result.ok
          ? t('Loaded {{count}} models from the vendor.', {
              defaultValue_one: 'Loaded {{count}} model from the vendor.',
              count: result.models?.length ?? 0
            })
          : t("Couldn't fetch models: {{reason}}. Using the bundled list.", {
              reason: result.message
                ? localizeProviderResourceMessage(result.message, t)
                : t('request failed')
            })
      )
    } finally {
      setIsRefreshingModels(false)
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return
        setIsMobileNavOpen(false)
        onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none" />
        <Dialog.Content
          data-slot="settings-surface"
          onOpenAutoFocus={() => {
            returnFocusRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
          onCloseAutoFocus={(event) => {
            const returnFocus = returnFocusRef.current
            returnFocusRef.current = null
            if (!returnFocus?.isConnected) return
            event.preventDefault()
            returnFocus.focus()
          }}
          // Don't let a click/focus outside the dialog dismiss it. A Radix Select inside the panel
          // (provider type, active model, install source) portals its listbox outside the dialog's
          // DOM, so an outside-click meant only to close the open dropdown would otherwise also close
          // the whole panel. The dropdown's own dismiss still closes just the dropdown; the panel is
          // closed intentionally via the ✕ button or Escape.
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (!isMobileNavOpen) return
            event.preventDefault()
            setIsMobileNavOpen(false)
          }}
          className={cn(
            'fixed z-50 flex overflow-hidden overscroll-contain rounded-xl border border-border bg-card text-foreground shadow-dialog outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none',
            isExpanded
              ? 'inset-0 rounded-none md:inset-4 md:rounded-xl'
              : 'inset-0 h-[100dvh] w-screen rounded-none md:bottom-auto md:left-1/2 md:right-auto md:top-1/2 md:h-[min(688px,calc(100vh-2rem))] md:w-[min(960px,calc(100vw-2rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl'
          )}
        >
          {/* Radix requires a Title/Description for a11y; the visible panel title lives in the header. */}
          <Dialog.Title className="sr-only">{t('Settings')}</Dialog.Title>
          <Dialog.Description className="sr-only">
            {t('Manage your agent runtime and model providers.')}
          </Dialog.Description>

          {isMobileNavOpen ? (
            <button
              type="button"
              className="fixed inset-0 z-[65] bg-black/45 md:hidden"
              aria-label={t('Close settings navigation')}
              tabIndex={-1}
              onClick={() => setIsMobileNavOpen(false)}
            />
          ) : null}

          {/* Left navigation becomes an off-canvas drawer on narrow browser screens. */}
          <FocusScope
            asChild
            loop={isMobile && isMobileNavOpen}
            trapped={isMobile && isMobileNavOpen}
          >
            <div
              data-slot="mobile-settings-navigation"
              role={isMobile && isMobileNavOpen ? 'dialog' : undefined}
              aria-modal={isMobile && isMobileNavOpen ? true : undefined}
              aria-label={isMobile && isMobileNavOpen ? t('Settings navigation') : undefined}
              className="contents"
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || !isMobileNavOpen) return
                event.preventDefault()
                event.stopPropagation()
                setIsMobileNavOpen(false)
              }}
            >
              <nav
                ref={mobileNavRef}
                aria-label={t('Settings')}
                aria-hidden={isMobile && !isMobileNavOpen ? true : undefined}
                inert={isMobile && !isMobileNavOpen ? true : undefined}
                className={cn(
                  'fixed inset-y-0 left-0 z-[70] flex min-h-0 w-[min(86vw,320px)] shrink-0 flex-col overflow-hidden border-r border-border bg-background transition-transform duration-200 ease-out md:static md:z-auto md:w-48 md:translate-x-0',
                  isMobileNavOpen ? 'translate-x-0' : '-translate-x-full'
                )}
              >
                <div
                  data-slot="settings-navigation-scroll"
                  className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-3"
                >
                  {SETTINGS_GROUPS.map((group) => (
                    <div key={group.labelKey} className="flex flex-col gap-0.5">
                      <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
                        {t(group.labelKey)}
                      </div>
                      <ul className="flex flex-col gap-0.5">
                        {group.panels.map(({ id, labelKey, Icon }) => {
                          const isActive = activePanel === id
                          return (
                            <li key={id}>
                              <button
                                type="button"
                                aria-current={isActive ? 'page' : undefined}
                                onClick={() => {
                                  setIsMobileNavOpen(false)
                                  navigatePanel(id)
                                }}
                                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-150 motion-reduce:transition-none ${
                                  isActive
                                    ? 'bg-muted font-medium text-foreground'
                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                                }`}
                              >
                                <Icon
                                  className="size-4 shrink-0 text-muted-foreground"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate">{t(labelKey)}</span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
                <div
                  data-slot="settings-navigation-footer"
                  className="shrink-0 border-t border-border px-3 py-2"
                >
                  <a
                    href={APP.links.githubFeedback}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted hover:text-foreground"
                  >
                    <MessageSquare
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{t('Feedback')}</span>
                  </a>
                </div>
              </nav>
            </div>
          </FocusScope>

          {/* Right column: header bar + scrollable panel content. */}
          <div
            data-slot="settings-main"
            aria-hidden={isMobile && isMobileNavOpen ? true : undefined}
            inert={isMobile && isMobileNavOpen ? true : undefined}
            className="flex min-h-0 min-w-0 flex-1 flex-col bg-card"
          >
            <TooltipProvider delayDuration={300}>
              <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 md:px-3">
                <div className="flex min-w-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        ref={mobileNavTriggerRef}
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setIsMobileNavOpen(true)}
                        aria-label={t('Open settings navigation')}
                        className="shrink-0 rounded-lg text-muted-foreground md:hidden"
                      >
                        <Menu className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Navigation')}</TooltipContent>
                  </Tooltip>
                  {/* Browser-like history controls for the settings navigation. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={goBack}
                        disabled={!canGoBack}
                        aria-label={t('Back', { context: 'step' })}
                        className="shrink-0 rounded-lg text-muted-foreground disabled:opacity-40"
                      >
                        <ArrowLeft className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Back', { context: 'step' })}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={goForward}
                        disabled={!canGoForward}
                        aria-label={t('Forward')}
                        className="shrink-0 rounded-lg text-muted-foreground disabled:opacity-40"
                      >
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Forward')}</TooltipContent>
                  </Tooltip>
                  <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
                  {breadcrumb !== null ? (
                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                      <button
                        type="button"
                        onClick={() => navigate(breadcrumb.rootTo)}
                        aria-label={t('Back to {{panel}}', {
                          panel: t(PANEL_NAME_LOWER[breadcrumb.rootLabelKey])
                        })}
                        className="shrink-0 text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground"
                      >
                        {t(breadcrumb.rootLabelKey)}
                      </button>
                      {breadcrumb.parents?.map((parent) => (
                        <span key={parent.label} className="contents">
                          <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                            ›
                          </span>
                          <button
                            type="button"
                            onClick={parent.onClick ?? (() => navigate(parent.to))}
                            aria-label={parent.ariaLabel}
                            className="shrink-0 text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground"
                          >
                            {parent.label}
                          </button>
                        </span>
                      ))}
                      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                        ›
                      </span>
                      <span className="truncate text-foreground">{breadcrumb.leaf}</span>
                    </div>
                  ) : (
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      {(() => {
                        const panel = SETTINGS_PANELS.find((item) => item.id === activePanel)
                        return panel ? t(panel.labelKey) : null
                      })()}
                    </h2>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setIsExpanded((value) => !value)}
                        aria-label={isExpanded ? t('Restore') : t('Maximize')}
                        className="rounded-lg text-muted-foreground"
                      >
                        {isExpanded ? (
                          <Minimize2 className="size-4" aria-hidden="true" />
                        ) : (
                          <Maximize2 className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{isExpanded ? t('Restore') : t('Maximize')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <Dialog.Close asChild>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('Close settings')}
                          className="rounded-lg text-muted-foreground"
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                    </Dialog.Close>
                    <TooltipContent>{t('Close settings')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>

              {settingsWriteError ? (
                <div
                  data-slot="settings-write-error"
                  role="alert"
                  className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <p className="min-w-0 flex-1 break-words py-0.5">
                    {settingsWriteError ===
                    'Could not save Vision model. Refresh the model catalog and try again.'
                      ? t('Could not save Vision model. Refresh the model catalog and try again.')
                      : settingsWriteError}
                  </p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('Dismiss settings error')}
                        className="-my-1 -mr-1 shrink-0 rounded-md text-danger-000 hover:bg-danger-000/10 hover:text-danger-000"
                        onClick={clearSettingsWriteError}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Close')}</TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </TooltipProvider>

            <div data-slot="settings-content-scroll" className="min-h-0 flex-1 overflow-y-auto">
              <div
                className={cn(
                  'mx-auto w-full max-w-[880px]',
                  activePanel === 'memory' || activePanel === 'tags' ? 'h-full' : 'min-h-full'
                )}
              >
                <SettingsPanelLoadingBoundary
                  panelKey={
                    activePanel === 'connectors' &&
                    (connectorsView.kind === 'add' || connectorsView.kind === 'edit') &&
                    connectorsView.credentialView === 'create'
                      ? `${activePanel}:${Math.max(0, historyIndex - 1)}`
                      : `${activePanel}:${historyIndex}`
                  }
                  onClose={onClose}
                >
                  {activePanel === 'skills' ? (
                    <SkillsPanel
                      view={skillsView}
                      onNavigate={navigateSkills}
                      onOpenGitHubCredential={() =>
                        navigate({
                          panel: 'credentials',
                          view: { kind: 'service', serviceId: 'github' }
                        })
                      }
                      onOpenTag={navigateTag}
                      onOpenSpecialist={(usage) =>
                        navigate({
                          panel: 'specialists',
                          view:
                            usage.kind === 'builtin'
                              ? { kind: 'builtin', id: usage.id }
                              : { kind: 'edit', id: usage.id }
                        })
                      }
                      canImportInstalledSkills={canImportInstalledSkills}
                    />
                  ) : activePanel === 'specialists' ? (
                    <SpecialistsPanel
                      view={specialistsView}
                      onNavigate={navigateSpecialists}
                      onOpenTag={navigateTag}
                      onOpenSkillDetail={(skillId) =>
                        navigate({
                          panel: 'skills',
                          view: { kind: 'detail', id: skillId }
                        })
                      }
                      onOpenConnectorDetail={(connectorId) =>
                        navigate({
                          panel: 'connectors',
                          view: customServers.some((server) => server.id === connectorId)
                            ? { kind: 'edit', id: connectorId }
                            : { kind: 'detail', id: connectorId }
                        })
                      }
                    />
                  ) : activePanel === 'tags' ? (
                    <TagsPanel
                      view={tagsView}
                      onNavigate={navigateTags}
                      onSelectedTagChange={recordSelectedTag}
                      onOpenResource={(reference) => {
                        if (reference.resourceType === 'catalog.skill') {
                          navigate({
                            panel: 'skills',
                            view: { kind: 'detail', id: reference.resourceId }
                          })
                          return
                        }
                        if (reference.resourceType === 'catalog.connector') {
                          navigate({
                            panel: 'connectors',
                            view: customServers.some((server) => server.id === reference.resourceId)
                              ? { kind: 'edit', id: reference.resourceId }
                              : { kind: 'detail', id: reference.resourceId }
                          })
                          return
                        }
                        const specialist = specialistItems.find(
                          (item) => item.id === reference.resourceId
                        )
                        navigate({
                          panel: 'specialists',
                          view:
                            specialist?.kind === 'builtin'
                              ? { kind: 'builtin', id: reference.resourceId }
                              : { kind: 'edit', id: reference.resourceId }
                        })
                      }}
                    />
                  ) : activePanel === 'memory' ? (
                    <MemoryPanel
                      view={memoryView}
                      onNavigate={navigateMemory}
                      onOpenProject={(projectId) => {
                        useNavigationStore.getState().openProject(projectId, 'user', onClose)
                      }}
                    />
                  ) : activePanel === 'connectors' ? (
                    connectorsView.kind === 'detail' ? (
                      <div>
                        <ResourceTagSummary
                          reference={{
                            resourceType: 'catalog.connector',
                            resourceId: connectorsView.id
                          }}
                          className="px-5 pt-5"
                          onOpenTag={navigateTag}
                        />
                        <ConnectorDetailView
                          key={connectorsView.id}
                          id={connectorsView.id}
                          onManagePermissions={() => navigatePanel('permissions')}
                          onManageCredentials={() =>
                            navigate({
                              panel: 'credentials',
                              view: { kind: 'service', serviceId: 'openalex' }
                            })
                          }
                        />
                      </div>
                    ) : connectorsView.kind === 'add' ? (
                      <ConnectorAddForm
                        initialTransport={connectorsView.transport}
                        initialTemplate={connectorsView.template}
                        credentialViewOpen={connectorsView.credentialView === 'create'}
                        onCredentialViewChange={(open) => {
                          if (open) {
                            navigateConnectors({ ...connectorsView, credentialView: 'create' })
                          } else {
                            goBack()
                          }
                        }}
                        onDone={() => navigateConnectors({ kind: 'list' })}
                        onCancel={() => navigateConnectors({ kind: 'list' })}
                      />
                    ) : connectorsView.kind === 'import' ? (
                      <ConnectorImportView
                        onUse={(template) =>
                          navigateConnectors({
                            kind: 'add',
                            transport: template.transport === 'stdio' ? 'local' : 'remote',
                            template
                          })
                        }
                        onCancel={() => navigateConnectors({ kind: 'list' })}
                      />
                    ) : connectorsView.kind === 'export' ? (
                      <ConnectorExportView
                        key={connectorsView.id}
                        id={connectorsView.id}
                        onDone={() => navigateConnectors({ kind: 'list' })}
                      />
                    ) : connectorsView.kind === 'edit' ? (
                      <div>
                        {connectorsView.credentialView !== 'create' ? (
                          <ResourceTagSummary
                            reference={{
                              resourceType: 'catalog.connector',
                              resourceId: connectorsView.id
                            }}
                            className="px-5 pt-5"
                            onOpenTag={navigateTag}
                          />
                        ) : null}
                        <ConnectorAddForm
                          editServer={customServers.find((s) => s.id === connectorsView.id)}
                          editServerId={connectorsView.id}
                          credentialViewOpen={connectorsView.credentialView === 'create'}
                          onCredentialViewChange={(open) => {
                            if (open) {
                              navigateConnectors({ ...connectorsView, credentialView: 'create' })
                            } else {
                              goBack()
                            }
                          }}
                          onDone={() => navigateConnectors({ kind: 'list' })}
                          onCancel={() => navigateConnectors({ kind: 'list' })}
                        />
                      </div>
                    ) : (
                      <ConnectorsPanel
                        onNavigate={navigateConnectors}
                        onOpenCredentials={() =>
                          navigate({
                            panel: 'credentials',
                            view: { kind: 'service', serviceId: 'literature' }
                          })
                        }
                        onOpenTag={navigateTag}
                        onOpenSpecialist={(usage) =>
                          navigate({
                            panel: 'specialists',
                            view:
                              usage.kind === 'builtin'
                                ? { kind: 'builtin', id: usage.id }
                                : { kind: 'edit', id: usage.id }
                          })
                        }
                      />
                    )
                  ) : activePanel === 'compute' ? (
                    computeView.kind === 'add' ? (
                      <ComputeAddForm
                        onCreated={(providerId) => navigateCompute({ kind: 'detail', providerId })}
                        onCancel={() => navigateCompute({ kind: 'list' })}
                      />
                    ) : computeView.kind === 'detail' ? (
                      <ComputeHostDetail
                        providerId={computeView.providerId}
                        authenticationFocus={computeView.authenticationFocus}
                        authenticationRequestId={computeView.authenticationRequestId}
                      />
                    ) : (
                      <ComputePanel onNavigate={navigateCompute} />
                    )
                  ) : activePanel === 'credentials' ? (
                    <CredentialsPanel
                      view={credentialsView}
                      onNavigate={navigateCredentials}
                      onOpenConnector={(id) =>
                        navigate({ panel: 'connectors', view: { kind: 'edit', id } })
                      }
                      onOpenProvider={(provider) => openEdit(provider)}
                    />
                  ) : activePanel === 'storage' ? (
                    <StoragePanel
                      onContinueToAgent={() => {
                        navigatePanel('agent')
                      }}
                    />
                  ) : activePanel === 'permissions' ? (
                    <PermissionsPanel
                      onOpenSession={onOpenSession}
                      onOpenConnector={(id) =>
                        navigateConnectors(
                          customServers.some((server) => server.id === id)
                            ? { kind: 'edit', id }
                            : { kind: 'detail', id }
                        )
                      }
                    />
                  ) : activePanel === 'archived' ? (
                    <ArchivedPanel
                      view={archivedView}
                      onNavigate={navigateArchived}
                      canDeleteProjects={canDeleteProjects}
                      hasCompleteSessionCatalog={hasCompleteSessionCatalog}
                      catalogRecovery={catalogRecovery}
                      onRetryCatalogRecovery={onRetryCatalogRecovery}
                    />
                  ) : activePanel === 'runtimes' ? (
                    <RuntimesPanel
                      title={t('Notebook runtimes')}
                      description={t(
                        'Choose which Python and R environments notebooks and the Agent can use. App-managed environments are enabled by default.'
                      )}
                      onOpenNetworkProtection={
                        notebookNetworkAvailable
                          ? () => navigateNetwork({ kind: 'domains' })
                          : undefined
                      }
                    />
                  ) : activePanel === 'network' ? (
                    <NetworkPanel
                      view={networkView}
                      onNavigate={navigateNetwork}
                      notebookNetworkAvailable={notebookNetworkAvailable}
                    />
                  ) : activePanel === 'usage' ? (
                    <TokenUsagePanel sessions={sessions} projects={projects} />
                  ) : activePanel === 'general' ? (
                    <GeneralPanel />
                  ) : activePanel === 'remote-control' ? (
                    <RemoteControlPanel />
                  ) : activePanel === 'agent' ? (
                    <AgentPanel
                      title={t('Agent framework')}
                      description={t(
                        "Choose which coding-agent backend drives your sessions. Select a card to switch; switching starts a fresh agent session, and open conversations have their transcript replayed to the new backend. The active runtime can't be uninstalled — switch to the other one first."
                      )}
                    />
                  ) : isProviderFormOpen ? (
                    // Add/edit provider is a secondary page reached via the shared back/forward arrows.
                    <div className="p-5">
                      {/* Secret writes fail closed when the OS keychain is unavailable. */}
                      {!encryptionAvailable ? (
                        <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                          {t(
                            'Secure key storage is unavailable. API keys cannot be saved until the system keychain is unlocked or authorized.'
                          )}
                        </p>
                      ) : null}
                      {providerEditTargetMissing ? (
                        <p
                          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                          role="alert"
                        >
                          {t('This Provider no longer exists. Your draft has not been saved.')}
                        </p>
                      ) : null}
                      <ProviderForm
                        value={formValue}
                        onChange={(patch) => setFormValue((current) => ({ ...current, ...patch }))}
                        hasStoredKey={editingProvider?.hasKey}
                        maskedKey={editingProvider?.maskedKey}
                        needsKey={editingProvider?.needsKey}
                        errors={formErrors}
                        supportedModels={editingProvider?.models}
                        onRefreshModels={
                          editingProvider?.type === 'official' &&
                          editingProvider.hasKey &&
                          editingProvider.vendorId &&
                          resolveVendorModelsUrl(editingProvider.vendorId, editingProvider.region)
                            ? () => void handleRefreshModels(editingProvider.id)
                            : undefined
                        }
                        isRefreshingModels={isRefreshingModels}
                        disabled={isSaving}
                        encryptionAvailable={encryptionAvailable}
                        showCodexSubscriptions={
                          agentFrameworkId === 'codex' && modelView.kind === 'create'
                        }
                        showClaudeIsolated={
                          agentFrameworkId === 'claude-code' && modelView.kind === 'create'
                        }
                        defaultCustomApiEndpoint={customApiEndpoint}
                      />
                      {statusMessage ? (
                        <p
                          className={`mt-3 text-sm ${statusOk ? 'text-primary' : 'text-destructive'}`}
                          role="alert"
                        >
                          {statusMessage}
                        </p>
                      ) : null}
                      <div className="mt-6 flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={closeForm}
                          disabled={isSaving}
                        >
                          {t('Cancel')}
                        </Button>
                        <Button type="button" onClick={() => void handleSave()} disabled={!canSave}>
                          {isSaving ? t('Saving…') : t('Save')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {postSaveValidationFailed ? (
                        <p className="mx-5 mt-5 text-sm text-destructive" role="alert">
                          {t('Could not test the provider connection.')}
                        </p>
                      ) : null}
                      <ProvidersPanel
                        onCreateProvider={openCreate}
                        onEditProvider={openEdit}
                        busyProviderId={busyProviderId}
                        onBusyProviderChange={(providerId) => {
                          setBusyProviderId(providerId)
                          if (providerId) {
                            postSaveValidationGeneration.current += 1
                            postSaveValidationProviderId.current = undefined
                            setPostSaveValidationFailed(false)
                          }
                        }}
                      />
                    </>
                  )}
                </SettingsPanelLoadingBoundary>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
})

export { SettingsPage, type SettingsPageHandle }
