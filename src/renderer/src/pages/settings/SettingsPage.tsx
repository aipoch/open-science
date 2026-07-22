import {
  ArrowLeft,
  ArrowRight,
  Cloud,
  Globe,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  TerminalSquare,
  X
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import type {
  AgentFrameworkId,
  ClaudeInstallSource,
  ClaudeInstallSourceInfo,
  ProviderView,
  UpsertProviderRequest
} from '../../../../shared/settings'
import {
  getClaudeInstallSources,
  getCodexInstallSources,
  getOpencodeInstallSources
} from '../../../../shared/settings'
// Import the bare Mono/Color components straight from their modules: each icon's entry point
// eagerly attaches its Avatar/Combine companions, which drag in @lobehub/ui (antd-style + an
// emoji-mart JSON import vitest can't parse). The Mono/Color components are self-contained.
import ClaudeColor from '@lobehub/icons/es/Claude/components/Color'
import Codex from '@lobehub/icons/es/Codex/components/Mono'
import OpenCode from '@lobehub/icons/es/OpenCode/components/Mono'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { ModelFrameworkCompatibilityAlert } from './ModelFrameworkCompatibilityAlert'
import { AgentFrameworkCard } from './AgentFrameworkCard'
import { GeneralPanel } from './GeneralPanel'
import { NetworkPanel } from './NetworkPanel'
import { StoragePanel } from './StoragePanel'
import { RuntimesPanel } from './RuntimesPanel'
import { SkillsPanel, type SkillsView } from './SkillsPanel'
import { ConnectorsPanel, type ConnectorsView } from './ConnectorsPanel'
import { ConnectorDetailView } from './ConnectorDetailView'
import { ConnectorAddForm } from './ConnectorAddForm'
import { ConnectorsNavIcon } from './connector-icons'
import { resolveVendorModelsUrl } from '../../../../shared/provider-registry'
import { ActiveModelSelect } from './ActiveModelSelect'
import { ProviderForm } from './ProviderForm'
import {
  createEmptyProviderFormValue,
  getProviderFormErrors,
  hasProviderFormErrors,
  type ProviderFormValue
} from './provider-form-value'
import { ProviderList } from './ProviderList'
import { SettingsSection } from './SettingsLayout'
import { UninstallRuntimeDialog } from './UninstallRuntimeDialog'
import { SwitchFrameworkDialog } from './SwitchFrameworkDialog'

type SettingsPageProps = {
  open: boolean
  onClose: () => void
}

// The model panel sub-view, driven by the settings navigation history so add/edit is a breadcrumb page.
type ModelView = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; providerId: string }

// Builds a form value from an existing provider (never carrying the plaintext key).
const toFormValue = (provider: ProviderView): ProviderFormValue =>
  createEmptyProviderFormValue({
    type: provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
    model: provider.model ?? '',
    apiEndpoint: provider.apiEndpoints?.[0] ?? 'anthropic',
    supportsImageInput: provider.supportsImageInput,
    vendorId: provider.vendorId,
    region: provider.region
  })

const toUpsertRequest = (
  value: ProviderFormValue,
  id: string | undefined
): UpsertProviderRequest => ({
  id,
  type: value.type,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  apiEndpoints: [value.apiEndpoint],
  supportsImageInput: value.supportsImageInput,
  vendorId: value.vendorId,
  region: value.region,
  key: value.key || undefined
})

// Left-nav panels, grouped in the sidebar. "Capabilities" holds agent extensions (Skills); "Workspace"
// holds environment/config (Model manages providers, its Agent sub-panel manages agent frameworks,
// General holds app settings incl. logs).
type SettingsPanelId =
  'model' | 'agent' | 'skills' | 'connectors' | 'general' | 'storage' | 'network' | 'runtimes'

type SettingsPanel = {
  id: SettingsPanelId
  label: string
  // Top-level entries carry a nav icon; sub-items (see `parent`) render indented without one.
  Icon?: React.ComponentType<{ className?: string }>
  // Marks this panel as a sub-item of another panel in the nav (e.g. Agent under Model). Sub-items
  // are still full panels in the location/history model — `parent` only affects nav presentation.
  parent?: SettingsPanelId
}

const SETTINGS_GROUPS: ReadonlyArray<{ label: string; panels: ReadonlyArray<SettingsPanel> }> = [
  {
    label: 'Capabilities',
    panels: [
      { id: 'skills', label: 'Skills', Icon: ScrollText },
      { id: 'connectors', label: 'Connectors', Icon: ConnectorsNavIcon },
      { id: 'network', label: 'Network', Icon: Globe }
    ]
  },
  {
    label: 'Workspace',
    panels: [
      { id: 'model', label: 'Model', Icon: SlidersHorizontal },
      { id: 'agent', label: 'Agent', parent: 'model' },
      { id: 'runtimes', label: 'Runtimes', Icon: TerminalSquare },
      { id: 'storage', label: 'Storage', Icon: Cloud },
      { id: 'general', label: 'General', Icon: Settings2 }
    ]
  }
]

// Flattened panel list for lookups (header title, etc.).
const SETTINGS_PANELS: ReadonlyArray<SettingsPanel> = SETTINGS_GROUPS.flatMap(
  (group) => group.panels
)

// One entry in the settings back/forward history: the active panel plus each panel's current sub-view
// (skills: list / detail / create / edit / import; model: list / create / edit; connectors: list /
// detail / add / edit). `connectors` is optional so panel switches that don't touch it stay terse.
// Network panel sub-view: the package-mirror list vs. the configure form (a breadcrumb drill-in).
type NetworkView = { kind: 'list' | 'configure' }

type NavLocation = {
  panel: SettingsPanelId
  skills: SkillsView
  model: ModelView
  connectors?: ConnectorsView
  network?: NetworkView
}

const INITIAL_LOCATION: NavLocation = {
  panel: 'model',
  skills: { kind: 'list' },
  model: { kind: 'list' },
  connectors: { kind: 'list' },
  network: { kind: 'list' }
}

// App-level model settings surface. Reuses the onboarding cards/form; manages providers (CRUD +
// activate + test). Opened from the Home/Workspace gear entry.
const SettingsPage = ({ open, onClose }: SettingsPageProps): React.JSX.Element => {
  const claude = useSettingsStore((state) => state.claude)
  const preflight = useSettingsStore((state) => state.preflight)
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const isDetectingClaude = useSettingsStore((state) => state.isDetectingClaude)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
  const setAgentFramework = useSettingsStore((state) => state.setAgentFramework)
  const opencode = useSettingsStore((state) => state.opencode)
  const isDetectingOpencode = useSettingsStore((state) => state.isDetectingOpencode)
  const detectOpencode = useSettingsStore((state) => state.detectOpencode)
  const installOpencode = useSettingsStore((state) => state.installOpencode)
  const codex = useSettingsStore((state) => state.codex)
  const isDetectingCodex = useSettingsStore((state) => state.isDetectingCodex)
  const detectCodex = useSettingsStore((state) => state.detectCodex)
  const installCodex = useSettingsStore((state) => state.installCodex)
  const isInstalling = useSettingsStore((state) => state.isInstalling)
  const installLogs = useSettingsStore((state) => state.installLogs)
  const installProgress = useSettingsStore((state) => state.installProgress)
  const installError = useSettingsStore((state) => state.installError)
  const npmAvailable = useSettingsStore((state) => state.npmAvailable)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const claudeManaged = useSettingsStore((state) => state.claudeManaged)
  const opencodeManaged = useSettingsStore((state) => state.opencodeManaged)
  const codexManaged = useSettingsStore((state) => state.codexManaged)
  const uninstallClaude = useSettingsStore((state) => state.uninstallClaude)
  const uninstallOpencode = useSettingsStore((state) => state.uninstallOpencode)
  const uninstallCodex = useSettingsStore((state) => state.uninstallCodex)
  const load = useSettingsStore((state) => state.load)
  const detectClaude = useSettingsStore((state) => state.detectClaude)
  const installClaude = useSettingsStore((state) => state.installClaude)
  const persistProvider = useSettingsStore((state) => state.persistProvider)
  const deleteProvider = useSettingsStore((state) => state.deleteProvider)
  const validateProvider = useSettingsStore((state) => state.validateProvider)
  const refreshProviderModels = useSettingsStore((state) => state.refreshProviderModels)
  const pendingSkillId = useSettingsStore((state) => state.pendingSkillId)
  const consumePendingSkill = useSettingsStore((state) => state.consumePendingSkill)

  // Settings navigation history (browser-like back/forward). Panel switches and drill-downs push a
  // new location; the active panel and open sub-views are derived from the current entry.
  const [history, setHistory] = useState<NavLocation[]>([INITIAL_LOCATION])
  const [historyIndex, setHistoryIndex] = useState(0)
  // Whether the dialog is enlarged to near-fullscreen via the maximize control.
  const [isExpanded, setIsExpanded] = useState(false)
  const skills = useSettingsStore((state) => state.skills)
  const connectors = useSettingsStore((state) => state.connectors)
  const customServers = useSettingsStore((state) => state.customServers)
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  // The app-managed runtime pending an uninstall confirmation (null = dialog closed), plus the in-flight
  // flag so the dialog and status cards can show progress and stay locked during removal.
  const [pendingUninstall, setPendingUninstall] = useState<'claude' | 'opencode' | 'codex' | null>(
    null
  )
  const [isUninstalling, setIsUninstalling] = useState(false)
  // The framework the user picked (via a card) but hasn't confirmed switching to yet.
  const [pendingSwitch, setPendingSwitch] = useState<AgentFrameworkId | null>(null)
  // The framework whose Install menu started the current/last install run. The store's install
  // state is global (one install at a time), so this local tag routes the progress bar, logs, and
  // errors to the card that initiated them.
  const [installTarget, setInstallTarget] = useState<'claude' | 'opencode' | 'codex' | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined)
  const [statusOk, setStatusOk] = useState(false)
  const [busyProviderId, setBusyProviderId] = useState<string | undefined>(undefined)
  // The Model branch's sub-item (Agent) starts expanded (settings lands on Model by default) and
  // stays expanded once the user opens the branch — other panels never collapse it. Deep-linking
  // elsewhere (e.g. a skill mention) collapses it: that case arrives AFTER mount (this component
  // stays mounted while closed), so it is handled in the seeding block below, not the initializer.
  const [agentMenuExpanded, setAgentMenuExpanded] = useState(true)

  // Refresh settings whenever the dialog opens so external changes are reflected.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // When opened from a skill mention, seed the history straight to that skill's detail page. This is
  // the derive-state-during-render pattern (guarded so it runs once per request); the guard resets on
  // close so reopening the same skill re-seeds. The Skills panel loads its list on mount, so the
  // breadcrumb name resolves once that arrives.
  const [seededSkillId, setSeededSkillId] = useState<string | undefined>(undefined)
  if (open && pendingSkillId !== undefined && pendingSkillId !== seededSkillId) {
    setSeededSkillId(pendingSkillId)
    // Landing outside the Model branch starts the Agent sub-item collapsed; clicking Model
    // re-expands it (sticky from then on).
    setAgentMenuExpanded(false)
    setHistory([
      {
        panel: 'skills',
        skills: { kind: 'detail', id: pendingSkillId },
        model: { kind: 'list' },
        connectors: { kind: 'list' }
      }
    ])
    setHistoryIndex(0)
  }
  if (!open && seededSkillId !== undefined) {
    setSeededSkillId(undefined)
  }

  // Clear the store's pending flag after it has been applied, so a later normal open starts fresh.
  useEffect(() => {
    if (pendingSkillId !== undefined) consumePendingSkill()
  }, [pendingSkillId, consumePendingSkill])

  // Auto-detect opencode the first time its detection card is shown without a known path, so the card
  // reflects reality without a manual re-detect. Guarded on path + in-flight to run at most once.
  useEffect(() => {
    if (
      open &&
      agentFrameworkId === 'opencode' &&
      !opencode?.resolvedPath &&
      !isDetectingOpencode
    ) {
      void detectOpencode()
    }
  }, [open, agentFrameworkId, opencode?.resolvedPath, isDetectingOpencode, detectOpencode])

  // Codex detection probes the ACP adapter and its paired native runtime. Keep it lazy so opening
  // settings for another framework does not spawn an unnecessary process.
  useEffect(() => {
    if (open && agentFrameworkId === 'codex' && !codex?.resolvedPath && !isDetectingCodex) {
      void detectCodex()
    }
  }, [open, agentFrameworkId, codex?.resolvedPath, isDetectingCodex, detectCodex])

  const currentLocation = history[historyIndex]
  const activePanel = currentLocation.panel
  const skillsView = currentLocation.skills
  const modelView = currentLocation.model
  const connectorsView: ConnectorsView = currentLocation.connectors ?? { kind: 'list' }
  const networkView: NetworkView = currentLocation.network ?? { kind: 'list' }
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1

  // Pushes a new location, dropping any forward entries.
  const navigate = (location: NavLocation): void => {
    const nextConnectors = location.connectors ?? { kind: 'list' }
    const nextNetwork = location.network ?? { kind: 'list' }
    if (
      location.panel === activePanel &&
      location.skills.kind === skillsView.kind &&
      ('id' in location.skills ? location.skills.id : undefined) ===
        ('id' in skillsView ? skillsView.id : undefined) &&
      location.model.kind === modelView.kind &&
      ('providerId' in location.model ? location.model.providerId : undefined) ===
        ('providerId' in modelView ? modelView.providerId : undefined) &&
      nextConnectors.kind === connectorsView.kind &&
      ('id' in nextConnectors ? nextConnectors.id : undefined) ===
        ('id' in connectorsView ? connectorsView.id : undefined) &&
      nextNetwork.kind === networkView.kind
    ) {
      return
    }
    setHistory((entries) => [...entries.slice(0, historyIndex + 1), location])
    setHistoryIndex((index) => index + 1)
  }

  // Navigates within the skills panel (list/detail/create/edit/import) as a history entry.
  const navigateSkills = (skills: SkillsView): void =>
    navigate({ panel: 'skills', skills, model: modelView, connectors: connectorsView })

  // Navigates within the connectors panel (list/detail/add/edit) as a history entry.
  const navigateConnectors = (connectors: ConnectorsView): void =>
    navigate({ panel: 'connectors', skills: skillsView, model: modelView, connectors })

  // Navigates within the network panel (package-mirror list vs. configure) as a history entry, so the
  // configure form gets a proper "Network / Package mirror" breadcrumb + back/forward.
  const navigateNetwork = (network: NetworkView): void =>
    navigate({
      panel: 'network',
      skills: skillsView,
      model: modelView,
      connectors: connectorsView,
      network
    })

  // Shared header breadcrumb for a drilled-in sub-view (null when on a panel's list, so the plain
  // panel title shows). Covers both the skills and model panels.
  const breadcrumb = ((): {
    rootLabel: string
    rootTo: NavLocation
    leaf: string
  } | null => {
    if (activePanel === 'skills' && skillsView.kind !== 'list') {
      const leaf =
        skillsView.kind === 'create'
          ? 'New skill'
          : skillsView.kind === 'upload'
            ? 'Upload skills'
            : skillsView.kind === 'import'
              ? 'Import from GitHub'
              : (() => {
                  const name = skills.find((skill) => skill.id === skillsView.id)?.name ?? ''
                  return skillsView.kind === 'edit' ? `Edit ${name}`.trim() : name
                })()
      return {
        rootLabel: 'Skills',
        rootTo: { panel: 'skills', skills: { kind: 'list' }, model: currentLocation.model },
        leaf
      }
    }
    if (activePanel === 'model' && modelView.kind !== 'list') {
      const name =
        modelView.kind === 'edit'
          ? (providers.find((provider) => provider.id === modelView.providerId)?.name ?? '')
          : ''
      return {
        rootLabel: 'Model',
        rootTo: { panel: 'model', skills: currentLocation.skills, model: { kind: 'list' } },
        leaf: modelView.kind === 'create' ? 'Add provider' : `Edit ${name}`.trim()
      }
    }
    if (activePanel === 'network' && networkView.kind !== 'list') {
      return {
        rootLabel: 'Network',
        rootTo: {
          panel: 'network',
          skills: currentLocation.skills,
          model: currentLocation.model,
          network: { kind: 'list' }
        },
        leaf: 'Package mirror'
      }
    }
    if (activePanel === 'connectors' && connectorsView.kind !== 'list') {
      const leaf =
        connectorsView.kind === 'add'
          ? 'Add connector'
          : connectorsView.kind === 'edit'
            ? `Edit ${customServers.find((s) => s.id === connectorsView.id)?.name ?? 'connector'}`.trim()
            : (connectors.find((c) => c.id === connectorsView.id)?.displayName ?? '')
      return {
        rootLabel: 'Connectors',
        rootTo: {
          panel: 'connectors',
          skills: currentLocation.skills,
          model: currentLocation.model,
          connectors: { kind: 'list' }
        },
        leaf
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

  // A provider form (add/edit) is open when the model panel is on a non-list sub-view.
  const isProviderFormOpen = activePanel === 'model' && modelView.kind !== 'list'
  // Resolve the edited provider from the live store so a model refresh (which updates the cache) is
  // reflected in the form; undefined until the provider is found (or when creating).
  const editingProvider =
    modelView.kind === 'edit'
      ? providers.find((provider) => provider.id === modelView.providerId)
      : undefined
  // Required-field errors for the open draft; a custom provider must be complete before it can save.
  const formErrors = getProviderFormErrors(formValue, { hasStoredKey: editingProvider?.hasKey })
  const canSave = !isSaving && !hasProviderFormErrors(formErrors)

  // Seed the form value when entering a create/edit sub-view (adjust-state-during-render, keyed on the
  // sub-view so typing isn't clobbered by background store updates; edit guards until the provider
  // loads). Also clears any stale status message on entry.
  const modelViewKey = modelView.kind === 'edit' ? `edit:${modelView.providerId}` : modelView.kind
  const [seededModelView, setSeededModelView] = useState(modelViewKey)
  if (modelViewKey !== seededModelView) {
    setSeededModelView(modelViewKey)
    if (modelView.kind === 'create') {
      setFormValue(createEmptyProviderFormValue())
    } else if (modelView.kind === 'edit') {
      const provider = providers.find((entry) => entry.id === modelView.providerId)
      if (provider) setFormValue(toFormValue(provider))
    }
    setStatusMessage(undefined)
  }

  const openCreate = (): void =>
    navigate({ panel: 'model', skills: currentLocation.skills, model: { kind: 'create' } })

  const openEdit = (provider: ProviderView): void =>
    navigate({
      panel: 'model',
      skills: currentLocation.skills,
      model: { kind: 'edit', providerId: provider.id }
    })

  const closeForm = (): void =>
    navigate({ panel: 'model', skills: currentLocation.skills, model: { kind: 'list' } })

  // Removes the app-managed runtime for the framework awaiting confirmation, then closes the dialog.
  // The store applies the refreshed snapshot (which may auto-switch the active framework) and main
  // reconnects the agent, so the cards and readiness gate update without a manual re-detect.
  const handleConfirmUninstall = async (): Promise<void> => {
    if (!pendingUninstall) return

    setIsUninstalling(true)

    try {
      if (pendingUninstall === 'claude') await uninstallClaude()
      else if (pendingUninstall === 'opencode') await uninstallOpencode()
      else await uninstallCodex()

      setPendingUninstall(null)
    } finally {
      setIsUninstalling(false)
    }
  }

  // Selecting a card requests a framework switch; a no-op when it's already the active one. The actual
  // switch is deferred to the confirmation, since it starts a fresh agent session.
  const requestSwitch = (target: AgentFrameworkId): void => {
    if (target !== agentFrameworkId) setPendingSwitch(target)
  }

  const confirmSwitch = (): void => {
    if (pendingSwitch) void setAgentFramework(pendingSwitch)
    setPendingSwitch(null)
  }

  const activeFramework = agentFrameworks.find((framework) => framework.id === agentFrameworkId)
  const pendingSwitchName = agentFrameworks.find(
    (framework) => framework.id === pendingSwitch
  )?.displayName

  // The section-level Re-detect re-scans all three frameworks at once; the per-card detect buttons
  // were removed in favor of this single action.
  const isDetectingAnyFramework = isDetectingClaude || isDetectingOpencode || isDetectingCodex
  const handleDetectAllFrameworks = (): void => {
    void detectClaude()
    void detectOpencode()
    void detectCodex()
  }

  // One descriptor per agent framework, in canonical display order. Cards are grouped by install
  // state (Installed / Available) below, preserving this order within each group. The source link
  // points at each agent's own repository — for Codex that is the ACP adapter repo, since the app
  // talks to Codex through the agentclientprotocol/codex-acp bridge.
  type FrameworkCardModel = {
    key: 'claude' | 'opencode' | 'codex'
    frameworkId: AgentFrameworkId
    name: string
    icon: React.ReactNode
    description: string
    ready: boolean
    version?: string
    path?: string
    sourceLabel: string
    sourceUrl: string
    notReadyHint: React.ReactNode
    uninstallCommand: string
    managed: boolean
    installSources: ClaudeInstallSourceInfo[]
    onInstall: (source: ClaudeInstallSource) => void
  }

  const frameworkCards: FrameworkCardModel[] = [
    {
      key: 'claude',
      frameworkId: 'claude-code',
      name: 'Claude Agent',
      icon: <ClaudeColor size={24} />,
      description: "Anthropic's agentic coding tool for the terminal.",
      ready: preflight.claudeReady,
      version: claude.version,
      path: claude.resolvedPath,
      sourceLabel: 'anthropics/claude-code',
      sourceUrl: 'https://github.com/anthropics/claude-code',
      notReadyHint: 'Install Claude Agent below, or install it manually and re-detect.',
      uninstallCommand: 'npm uninstall -g @anthropic-ai/claude-code',
      managed: claudeManaged,
      installSources: getClaudeInstallSources(window.api?.platform),
      onInstall: (source) => void installClaude(source)
    },
    {
      key: 'opencode',
      frameworkId: 'opencode',
      name: 'OpenCode',
      icon: <OpenCode size={24} className="text-foreground" />,
      description: 'Open-source coding agent for the terminal.',
      ready: preflight.opencodeReady,
      version: opencode.version,
      path: opencode.resolvedPath,
      sourceLabel: 'anomalyco/opencode',
      sourceUrl: 'https://github.com/anomalyco/opencode',
      notReadyHint: (
        <>
          OpenCode is required for this framework. Install it below, or install it manually (see{' '}
          <ExternalTextLink href="https://opencode.ai/docs">opencode.ai/docs</ExternalTextLink>) and
          re-detect.
        </>
      ),
      uninstallCommand: 'npm uninstall -g opencode-ai',
      managed: opencodeManaged,
      installSources: getOpencodeInstallSources(window.api?.platform),
      onInstall: (source) => void installOpencode(source)
    },
    {
      key: 'codex',
      frameworkId: 'codex',
      name: 'Codex',
      icon: <Codex size={24} className="text-foreground" />,
      description: "OpenAI's coding agent, connected through the Codex ACP adapter.",
      ready: preflight.codexReady,
      version: codex.version,
      path: codex.resolvedPath,
      sourceLabel: 'agentclientprotocol/codex-acp',
      sourceUrl: 'https://github.com/agentclientprotocol/codex-acp',
      notReadyHint: codex.resolvedPath
        ? 'The adapter or its paired native Codex runtime did not pass detection. Reinstall the managed pair below, or repair your manual installation and re-detect.'
        : 'Codex ACP is required for this framework. Install it below, or install it manually and re-detect.',
      uninstallCommand: 'npm uninstall -g @agentclientprotocol/codex-acp',
      managed: codexManaged,
      installSources: getCodexInstallSources(),
      // Codex has no official-script source; the guard keeps the shared install-source type happy.
      onInstall: (source) => {
        if (source !== 'official-script') void installCodex(source)
      }
    }
  ]

  const installedFrameworks = frameworkCards.filter((card) => card.ready)
  const availableFrameworks = frameworkCards.filter((card) => !card.ready)

  // Maps one framework descriptor to its card, wiring in the page-level concerns: radio selection
  // (via the switch confirmation), the uninstall dialog, and routing the global install state to
  // only the card that started the install (installTarget).
  const renderFrameworkCard = (card: FrameworkCardModel): React.JSX.Element => (
    <AgentFrameworkCard
      key={card.key}
      icon={card.icon}
      name={card.name}
      description={card.description}
      ready={card.ready}
      version={card.version}
      path={card.path}
      sourceLabel={card.sourceLabel}
      sourceUrl={card.sourceUrl}
      notReadyHint={card.notReadyHint}
      active={agentFrameworkId === card.frameworkId}
      onSelect={() => requestSwitch(card.frameworkId)}
      selectDisabled={isInstalling || isUninstalling}
      uninstallCommand={card.uninstallCommand}
      managed={card.managed}
      isUninstalling={isUninstalling && pendingUninstall === card.key}
      isDetecting={isDetectingAnyFramework}
      onUninstall={() => setPendingUninstall(card.key)}
      installSources={card.installSources}
      installing={isInstalling && installTarget === card.key}
      installRunning={isInstalling}
      installDisabled={isInstalling || isUninstalling}
      installLogs={installTarget === card.key ? installLogs : []}
      installProgress={installTarget === card.key ? installProgress : null}
      installError={installTarget === card.key ? installError : undefined}
      npmAvailable={npmAvailable}
      onInstall={(source) => {
        setInstallTarget(card.key)
        card.onInstall(source)
      }}
    />
  )

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    setStatusMessage(undefined)

    try {
      // Persist first and return to the provider list immediately — don't hold the form open waiting
      // for the connection test. The test then runs in the background and its result (green check or
      // warning) lands on the provider's card.
      const providerId = await persistProvider(toUpsertRequest(formValue, editingProvider?.id))

      navigate({ panel: 'model', skills: currentLocation.skills, model: { kind: 'list' } })

      if (providerId) {
        setBusyProviderId(providerId)
        void validateProvider({ providerId }).finally(() => setBusyProviderId(undefined))
      }
    } catch (error) {
      setStatusOk(false)
      setStatusMessage(error instanceof Error ? error.message : 'Could not save provider.')
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
          ? `Loaded ${result.models?.length ?? 0} models from the vendor.`
          : `Couldn't fetch models: ${result.message ?? 'request failed'}. Using the bundled list.`
      )
    } finally {
      setIsRefreshingModels(false)
    }
  }

  const handleTest = async (provider: ProviderView): Promise<void> => {
    setBusyProviderId(provider.id)

    try {
      // The pass/fail result is reflected on the provider's card (green check or warning), not as a
      // separate status line.
      await validateProvider({ providerId: provider.id })
    } finally {
      setBusyProviderId(undefined)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none" />
        <Dialog.Content
          data-slot="settings-surface"
          // Don't let a click/focus outside the dialog dismiss it. A Radix Select inside the panel
          // (provider type, active model, install source) portals its listbox outside the dialog's
          // DOM, so an outside-click meant only to close the open dropdown would otherwise also close
          // the whole panel. The dropdown's own dismiss still closes just the dropdown; the panel is
          // closed intentionally via the ✕ button or Escape.
          onInteractOutside={(event) => event.preventDefault()}
          className={cn(
            'fixed z-50 flex overflow-hidden overscroll-contain rounded-xl border border-border bg-card text-foreground shadow-dialog outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none',
            isExpanded
              ? 'inset-4'
              : 'left-1/2 top-1/2 h-[min(688px,calc(100vh-2rem))] w-[min(960px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2'
          )}
        >
          {/* Radix requires a Title/Description for a11y; the visible panel title lives in the header. */}
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <Dialog.Description className="sr-only">
            Manage your agent runtime and model providers.
          </Dialog.Description>

          {/* Left navigation: grouped settings panels (Capabilities, Workspace). */}
          <nav
            aria-label="Settings"
            className="flex w-52 shrink-0 flex-col gap-4 border-r border-border bg-background p-3"
          >
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {group.panels.map(({ id, label, Icon, parent }) => {
                    const isActive = activePanel === id
                    // A sub-item (Agent under Model) expands once the user enters the Model branch
                    // and then stays expanded — selecting other panels never collapses it.
                    const branchActive = parent === undefined || agentMenuExpanded

                    const button = (
                      <button
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        // A collapsed sub-item is height-0/opacity-0 — keep it out of the tab order too.
                        tabIndex={parent && !branchActive ? -1 : undefined}
                        onClick={() => {
                          // Entering the Model branch expands its sub-item (sticky — see above).
                          if (id === 'model' || id === 'agent') setAgentMenuExpanded(true)
                          navigate({
                            panel: id,
                            skills: { kind: 'list' },
                            model: { kind: 'list' }
                          })
                        }}
                        className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors duration-150 motion-reduce:transition-none ${
                          parent ? 'h-7 text-[13px] ' : ''
                        }${
                          isActive
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {Icon ? (
                          <Icon
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        ) : null}
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                      </button>
                    )

                    // Sub-items render inside a height-animated wrapper (0fr → 1fr) with a tree
                    // guide line dropped from the parent's icon gutter, marking the relationship.
                    if (parent) {
                      return (
                        <li
                          key={id}
                          className={cn(
                            'grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none',
                            branchActive
                              ? 'grid-rows-[1fr] opacity-100'
                              : 'grid-rows-[0fr] opacity-0'
                          )}
                        >
                          <div className="ml-[15px] min-h-0 overflow-hidden border-l border-border pl-[9px]">
                            {button}
                          </div>
                        </li>
                      )
                    }

                    return <li key={id}>{button}</li>
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {/* Right column: header bar + scrollable panel content. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
            <TooltipProvider delayDuration={300}>
              <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3">
                <div className="flex min-w-0 items-center gap-1">
                  {/* Browser-like history controls for the settings navigation. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={goBack}
                        disabled={!canGoBack}
                        aria-label="Back"
                        className="shrink-0 rounded-lg text-muted-foreground disabled:opacity-40"
                      >
                        <ArrowLeft className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Back</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={goForward}
                        disabled={!canGoForward}
                        aria-label="Forward"
                        className="shrink-0 rounded-lg text-muted-foreground disabled:opacity-40"
                      >
                        <ArrowRight className="size-4" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Forward</TooltipContent>
                  </Tooltip>
                  <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
                  {breadcrumb !== null ? (
                    <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                      <button
                        type="button"
                        onClick={() => navigate(breadcrumb.rootTo)}
                        aria-label={`Back to ${breadcrumb.rootLabel.toLowerCase()}`}
                        className="shrink-0 text-muted-foreground transition-colors motion-reduce:transition-none hover:text-foreground"
                      >
                        {breadcrumb.rootLabel}
                      </button>
                      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                        ›
                      </span>
                      <span className="truncate text-foreground">{breadcrumb.leaf}</span>
                    </div>
                  ) : (
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      {SETTINGS_PANELS.find((panel) => panel.id === activePanel)?.label}
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
                        aria-label={isExpanded ? 'Restore' : 'Maximize'}
                        className="rounded-lg text-muted-foreground"
                      >
                        {isExpanded ? (
                          <Minimize2 className="size-4" aria-hidden="true" />
                        ) : (
                          <Maximize2 className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{isExpanded ? 'Restore' : 'Maximize'}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <Dialog.Close asChild>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Close settings"
                          className="rounded-lg text-muted-foreground"
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                    </Dialog.Close>
                    <TooltipContent>Close settings</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </TooltipProvider>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto min-h-full w-full max-w-[880px]">
                {activePanel === 'skills' ? (
                  <SkillsPanel view={skillsView} onNavigate={navigateSkills} />
                ) : activePanel === 'connectors' ? (
                  connectorsView.kind === 'detail' ? (
                    <ConnectorDetailView id={connectorsView.id} />
                  ) : connectorsView.kind === 'add' ? (
                    <ConnectorAddForm
                      initialTransport={connectorsView.transport}
                      onDone={() => navigateConnectors({ kind: 'list' })}
                      onCancel={() => navigateConnectors({ kind: 'list' })}
                    />
                  ) : connectorsView.kind === 'edit' ? (
                    <ConnectorAddForm
                      editServer={customServers.find((s) => s.id === connectorsView.id)}
                      onDone={() => navigateConnectors({ kind: 'list' })}
                      onCancel={() => navigateConnectors({ kind: 'list' })}
                    />
                  ) : (
                    <ConnectorsPanel onNavigate={navigateConnectors} />
                  )
                ) : activePanel === 'storage' ? (
                  <StoragePanel />
                ) : activePanel === 'runtimes' ? (
                  <RuntimesPanel />
                ) : activePanel === 'network' ? (
                  <NetworkPanel view={networkView} onNavigate={navigateNetwork} />
                ) : activePanel === 'general' ? (
                  <GeneralPanel />
                ) : activePanel === 'agent' ? (
                  <div className="space-y-5 p-5">
                    <ModelFrameworkCompatibilityAlert />

                    {/* The runtime cards double as the framework selector: pick a card to make it
                        the active backend (confirmed, since it starts a fresh session). Cards are
                        grouped by install state so management (Installed) and acquisition
                        (Available) don't compete for attention — but the active runtime can't be
                        uninstalled (switch to the other one first). */}
                    <SettingsSection
                      title="Agent framework"
                      aria-label="Agent framework"
                      description={
                        <>
                          Choose which coding-agent backend drives your sessions. Select a card to
                          switch; switching starts a fresh agent session, and open conversations
                          have their transcript replayed to the new backend. The active runtime
                          can&apos;t be uninstalled — switch to the other one first.
                        </>
                      }
                      action={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={handleDetectAllFrameworks}
                          disabled={isDetectingAnyFramework || isInstalling || isUninstalling}
                        >
                          <RefreshCw
                            className={isDetectingAnyFramework ? 'animate-spin' : ''}
                            aria-hidden="true"
                          />
                          {isDetectingAnyFramework ? 'Detecting…' : 'Re-detect'}
                        </Button>
                      }
                    >
                      <div className="space-y-5">
                        {installedFrameworks.length > 0 ? (
                          <div className="space-y-2">
                            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                              Installed · {installedFrameworks.length}
                            </p>
                            <div className="space-y-3">
                              {installedFrameworks.map(renderFrameworkCard)}
                            </div>
                          </div>
                        ) : null}
                        {availableFrameworks.length > 0 ? (
                          <div className="space-y-2">
                            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                              Available · {availableFrameworks.length}
                            </p>
                            <div className="space-y-3">
                              {availableFrameworks.map(renderFrameworkCard)}
                            </div>
                          </div>
                        ) : null}
                        {activeFramework && !activeFramework.supportsSkills ? (
                          <p className="text-xs text-muted-foreground">
                            Skills aren&apos;t available with {activeFramework.displayName}; use
                            Claude Code for skill-based workflows.
                          </p>
                        ) : null}
                      </div>
                    </SettingsSection>
                  </div>
                ) : isProviderFormOpen ? (
                  // Add/edit provider is a secondary page reached via the shared back/forward arrows.
                  <div className="p-5">
                    {/* Secret writes fail closed when the OS keychain is unavailable. */}
                    {!encryptionAvailable ? (
                      <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        Secure key storage is unavailable. API keys cannot be saved until the system
                        keychain is unlocked or authorized.
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
                      <Button type="button" variant="ghost" onClick={closeForm} disabled={isSaving}>
                        Cancel
                      </Button>
                      <Button type="button" onClick={() => void handleSave()} disabled={!canSave}>
                        {isSaving ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-5 p-5">
                    {/* Active model is its own section so the current selection reads separately
                        from provider management. */}
                    {providers.length > 0 ? (
                      <SettingsSection
                        title="Active model"
                        aria-label="Active model"
                        description="The model that drives new agent sessions."
                      >
                        <div className="max-w-md">
                          <ActiveModelSelect />
                        </div>
                      </SettingsSection>
                    ) : null}

                    {/* The add action lives with the list: a dashed ghost row appended after the
                        last provider, matching the Available-group placeholder treatment. */}
                    <SettingsSection
                      title="Providers"
                      aria-label="Providers"
                      separated={providers.length > 0}
                    >
                      <ProviderList
                        providers={providers}
                        activeProviderId={activeProviderId}
                        busyProviderId={busyProviderId}
                        onEdit={openEdit}
                        onDelete={(provider) => void deleteProvider(provider.id)}
                        onTest={(provider) => void handleTest(provider)}
                      />
                      <button
                        type="button"
                        onClick={openCreate}
                        className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/60 hover:text-foreground"
                      >
                        <Plus className="size-4" aria-hidden="true" />
                        Add provider
                      </button>
                    </SettingsSection>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <UninstallRuntimeDialog
        framework={pendingUninstall}
        isUninstalling={isUninstalling}
        onCancel={() => setPendingUninstall(null)}
        onConfirm={() => void handleConfirmUninstall()}
      />
      <SwitchFrameworkDialog
        targetName={pendingSwitchName ?? null}
        onCancel={() => setPendingSwitch(null)}
        onConfirm={confirmSwitch}
      />
    </Dialog.Root>
  )
}

export { SettingsPage }
