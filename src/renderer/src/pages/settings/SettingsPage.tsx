import {
  ArrowLeft,
  ArrowRight,
  Maximize2,
  Minimize2,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  X
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import type { ProviderView, UpsertProviderRequest } from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { ClaudeInstallCard } from './ClaudeInstallCard'
import { ClaudeStatusCard } from './ClaudeStatusCard'
import { GeneralPanel } from './GeneralPanel'
import { SkillsPanel, type SkillsView } from './SkillsPanel'
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

type SettingsPageProps = {
  open: boolean
  onClose: () => void
}

// Form target: a brand-new provider or an existing one being edited.
type FormTarget = { mode: 'create' } | { mode: 'edit'; provider: ProviderView }

// Builds a form value from an existing provider (never carrying the plaintext key).
const toFormValue = (provider: ProviderView): ProviderFormValue =>
  createEmptyProviderFormValue({
    type: provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl ?? '',
    model: provider.model ?? '',
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
  vendorId: value.vendorId,
  region: value.region,
  key: value.key || undefined
})

// Left-nav panels, grouped in the sidebar. "Capabilities" holds agent extensions (Skills); "Workspace"
// holds environment/config (Model manages Claude + providers, General holds app settings incl. logs).
type SettingsPanelId = 'model' | 'skills' | 'general'

type SettingsPanel = {
  id: SettingsPanelId
  label: string
  Icon: typeof SlidersHorizontal
}

const SETTINGS_GROUPS: ReadonlyArray<{ label: string; panels: ReadonlyArray<SettingsPanel> }> = [
  {
    label: 'Capabilities',
    panels: [{ id: 'skills', label: 'Skills', Icon: ScrollText }]
  },
  {
    label: 'Workspace',
    panels: [
      { id: 'model', label: 'Model', Icon: SlidersHorizontal },
      { id: 'general', label: 'General', Icon: Settings2 }
    ]
  }
]

// Flattened panel list for lookups (header title, etc.).
const SETTINGS_PANELS: ReadonlyArray<SettingsPanel> = SETTINGS_GROUPS.flatMap(
  (group) => group.panels
)

// One entry in the settings back/forward history: the active panel plus, for the skills panel, its
// current sub-view (list / detail / create / edit / import).
type NavLocation = { panel: SettingsPanelId; skills: SkillsView }

const INITIAL_LOCATION: NavLocation = { panel: 'model', skills: { kind: 'list' } }

// App-level model settings surface. Reuses the onboarding cards/form; manages providers (CRUD +
// activate + test). Opened from the Home/Workspace gear entry.
const SettingsPage = ({ open, onClose }: SettingsPageProps): React.JSX.Element => {
  const claude = useSettingsStore((state) => state.claude)
  const preflight = useSettingsStore((state) => state.preflight)
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const isDetectingClaude = useSettingsStore((state) => state.isDetectingClaude)
  const isInstalling = useSettingsStore((state) => state.isInstalling)
  const installLogs = useSettingsStore((state) => state.installLogs)
  const npmAvailable = useSettingsStore((state) => state.npmAvailable)
  const load = useSettingsStore((state) => state.load)
  const detectClaude = useSettingsStore((state) => state.detectClaude)
  const installClaude = useSettingsStore((state) => state.installClaude)
  const persistProvider = useSettingsStore((state) => state.persistProvider)
  const deleteProvider = useSettingsStore((state) => state.deleteProvider)
  const validateProvider = useSettingsStore((state) => state.validateProvider)
  const refreshProviderModels = useSettingsStore((state) => state.refreshProviderModels)

  const [formTarget, setFormTarget] = useState<FormTarget | null>(null)
  // Settings navigation history (browser-like back/forward). Panel switches and skill drill-downs push a
  // new location; the active panel and open skill detail are derived from the current entry.
  const [history, setHistory] = useState<NavLocation[]>([INITIAL_LOCATION])
  const [historyIndex, setHistoryIndex] = useState(0)
  // Whether the dialog is enlarged to near-fullscreen via the maximize control.
  const [isExpanded, setIsExpanded] = useState(false)
  const skills = useSettingsStore((state) => state.skills)
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined)
  const [statusOk, setStatusOk] = useState(false)
  const [busyProviderId, setBusyProviderId] = useState<string | undefined>(undefined)

  // Refresh settings whenever the dialog opens so external changes are reflected.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const currentLocation = history[historyIndex]
  const activePanel = currentLocation.panel
  const skillsView = currentLocation.skills
  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1

  // Pushes a new location, dropping any forward entries and closing a transient provider form.
  const navigate = (location: NavLocation): void => {
    if (
      location.panel === activePanel &&
      location.skills.kind === skillsView.kind &&
      ('id' in location.skills ? location.skills.id : undefined) ===
        ('id' in skillsView ? skillsView.id : undefined)
    ) {
      return
    }
    setFormTarget(null)
    setHistory((entries) => [...entries.slice(0, historyIndex + 1), location])
    setHistoryIndex((index) => index + 1)
  }

  // Navigates within the skills panel (list/detail/create/edit/import) as a history entry.
  const navigateSkills = (skills: SkillsView): void => navigate({ panel: 'skills', skills })

  // Breadcrumb label for a skills sub-view (null when on the list, so the plain panel title shows).
  const skillsBreadcrumbLabel = ((): string | null => {
    if (activePanel !== 'skills' || skillsView.kind === 'list') return null
    if (skillsView.kind === 'create') return 'New skill'
    if (skillsView.kind === 'upload') return 'Upload a skill'
    if (skillsView.kind === 'import') return 'Import from GitHub'
    const name = skills.find((skill) => skill.id === skillsView.id)?.name ?? ''
    return skillsView.kind === 'edit' ? `Edit ${name}`.trim() : name
  })()

  const goBack = (): void => {
    if (!canGoBack) return
    setFormTarget(null)
    setHistoryIndex((index) => index - 1)
  }

  const goForward = (): void => {
    if (!canGoForward) return
    setFormTarget(null)
    setHistoryIndex((index) => index + 1)
  }

  // Resolve the edited provider from the live store so a model refresh (which updates the cache) is
  // reflected in the form; fall back to the captured target if it's mid-delete.
  const editingProvider =
    formTarget?.mode === 'edit'
      ? (providers.find((provider) => provider.id === formTarget.provider.id) ??
        formTarget.provider)
      : undefined
  // Required-field errors for the open draft; a custom provider must be complete before it can save.
  const formErrors = getProviderFormErrors(formValue, { hasStoredKey: editingProvider?.hasKey })
  const canSave = !isSaving && !hasProviderFormErrors(formErrors)

  const openCreate = (): void => {
    setFormTarget({ mode: 'create' })
    setFormValue(createEmptyProviderFormValue())
    setStatusMessage(undefined)
  }

  const openEdit = (provider: ProviderView): void => {
    setFormTarget({ mode: 'edit', provider })
    setFormValue(toFormValue(provider))
    setStatusMessage(undefined)
  }

  const closeForm = (): void => {
    setFormTarget(null)
    setStatusMessage(undefined)
  }

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    setStatusMessage(undefined)

    try {
      // Persist first and return to the provider list immediately — don't hold the form open waiting
      // for the connection test. The test then runs in the background and its result (green check or
      // warning) lands on the provider's card.
      const providerId = await persistProvider(toUpsertRequest(formValue, editingProvider?.id))

      setFormTarget(null)

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
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          // Don't let a click/focus outside the dialog dismiss it. A Radix Select inside the panel
          // (provider type, active model, install source) portals its listbox outside the dialog's
          // DOM, so an outside-click meant only to close the open dropdown would otherwise also close
          // the whole panel. The dropdown's own dismiss still closes just the dropdown; the panel is
          // closed intentionally via the ✕ button or Escape.
          onInteractOutside={(event) => event.preventDefault()}
          className={`fixed left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-dialog data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 ${
            isExpanded
              ? 'h-[80vh] w-[80vw]'
              : 'h-[min(640px,calc(100vh-2rem))] w-[min(920px,calc(100vw-2rem))]'
          }`}
        >
          {/* Radix requires a Title/Description for a11y; the visible panel title lives in the header. */}
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <Dialog.Description className="sr-only">
            Manage your Claude installation and model providers.
          </Dialog.Description>

          {/* Left navigation: grouped settings panels (Capabilities, Workspace). */}
          <nav
            aria-label="Settings"
            className="flex w-52 shrink-0 flex-col gap-3 border-r border-border bg-muted/40 p-3"
          >
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-0.5">
                <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </div>
                <ul className="flex flex-col gap-0.5">
                  {group.panels.map(({ id, label, Icon }) => {
                    const isActive = activePanel === id

                    return (
                      <li key={id}>
                        <button
                          type="button"
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => navigate({ panel: id, skills: { kind: 'list' } })}
                          className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors ${
                            isActive
                              ? 'bg-muted font-medium text-foreground'
                              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                          }`}
                        >
                          <Icon
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate">{label}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>

          {/* Right column: header bar + scrollable panel content. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
              <div className="flex min-w-0 items-center gap-1">
                {/* Browser-like history controls for the settings navigation. */}
                <button
                  type="button"
                  onClick={goBack}
                  disabled={!canGoBack}
                  aria-label="Back"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={goForward}
                  disabled={!canGoForward}
                  aria-label="Forward"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                  <ArrowRight className="size-4" aria-hidden="true" />
                </button>
                <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
                {skillsBreadcrumbLabel !== null ? (
                  <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                    <button
                      type="button"
                      onClick={() => navigateSkills({ kind: 'list' })}
                      aria-label="Back to skills"
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Skills
                    </button>
                    <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                      ›
                    </span>
                    <span className="truncate text-foreground">{skillsBreadcrumbLabel}</span>
                  </div>
                ) : (
                  <h2 className="truncate text-sm font-semibold text-foreground">
                    {SETTINGS_PANELS.find((panel) => panel.id === activePanel)?.label}
                  </h2>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setIsExpanded((value) => !value)}
                  aria-label={isExpanded ? 'Restore' : 'Maximize'}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {isExpanded ? (
                    <Minimize2 className="size-4" aria-hidden="true" />
                  ) : (
                    <Maximize2 className="size-4" aria-hidden="true" />
                  )}
                </button>
                <Dialog.Close
                  aria-label="Close settings"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" aria-hidden="true" />
                </Dialog.Close>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activePanel === 'skills' ? (
                <SkillsPanel view={skillsView} onNavigate={navigateSkills} />
              ) : activePanel === 'general' ? (
                <GeneralPanel />
              ) : formTarget ? (
                // Add/edit provider is a secondary page: a back arrow returns to the provider list.
                <div className="p-5">
                  <div className="mb-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={closeForm}
                      disabled={isSaving}
                      aria-label="Back to providers"
                      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <ArrowLeft className="size-4" aria-hidden="true" />
                    </button>
                    <h3 className="text-sm font-semibold text-foreground">
                      {editingProvider ? 'Edit provider' : 'Add provider'}
                    </h3>
                  </div>

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
                    <button
                      type="button"
                      onClick={closeForm}
                      disabled={isSaving}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSave()}
                      disabled={!canSave}
                      className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {isSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-6 p-5">
                  <section aria-label="Claude">
                    <h3 className="mb-3 text-sm font-semibold text-foreground">Claude</h3>
                    <div className="space-y-3">
                      <ClaudeStatusCard
                        claude={claude}
                        claudeReady={preflight.claudeReady}
                        isDetecting={isDetectingClaude}
                        onDetect={() => void detectClaude()}
                      />
                      {!preflight.claudeReady ? (
                        <ClaudeInstallCard
                          isInstalling={isInstalling}
                          installLogs={installLogs}
                          npmAvailable={npmAvailable}
                          onInstall={(source) => void installClaude(source)}
                        />
                      ) : null}
                    </div>
                  </section>

                  <section aria-label="Providers" className="border-t border-border pt-6">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-foreground">Providers</h3>
                      <button
                        type="button"
                        onClick={openCreate}
                        className="rounded-lg border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
                      >
                        Add provider
                      </button>
                    </div>

                    {providers.length > 0 ? (
                      <div className="mb-4 space-y-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Active model
                        </span>
                        <ActiveModelSelect />
                      </div>
                    ) : null}

                    <ProviderList
                      providers={providers}
                      activeProviderId={activeProviderId}
                      busyProviderId={busyProviderId}
                      onEdit={openEdit}
                      onDelete={(provider) => void deleteProvider(provider.id)}
                      onTest={(provider) => void handleTest(provider)}
                    />
                  </section>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { SettingsPage }
