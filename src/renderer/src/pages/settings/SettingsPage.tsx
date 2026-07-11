import { Settings2, SlidersHorizontal, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import type { ProviderView, UpsertProviderRequest } from '../../../../shared/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { ClaudeInstallCard } from './ClaudeInstallCard'
import { ClaudeStatusCard } from './ClaudeStatusCard'
import { GeneralPanel } from './GeneralPanel'
import { ProviderForm } from './ProviderForm'
import {
  createEmptyProviderFormValue,
  getProviderFormErrors,
  hasProviderFormErrors,
  type ProviderFormValue
} from './provider-form-value'
import { ProviderList } from './ProviderList'
import { describeValidation } from './validation-message'

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
    model: provider.model ?? ''
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
  key: value.key || undefined
})

// Left-nav panels. "Model" manages Claude + providers; "General" holds app settings incl. the log file.
type SettingsPanelId = 'model' | 'general'

const SETTINGS_PANELS: ReadonlyArray<{
  id: SettingsPanelId
  label: string
  Icon: typeof SlidersHorizontal
}> = [
  { id: 'model', label: 'Model', Icon: SlidersHorizontal },
  { id: 'general', label: 'General', Icon: Settings2 }
]

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
  const saveProvider = useSettingsStore((state) => state.saveProvider)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)
  const deleteProvider = useSettingsStore((state) => state.deleteProvider)
  const validateProvider = useSettingsStore((state) => state.validateProvider)

  const [formTarget, setFormTarget] = useState<FormTarget | null>(null)
  const [activePanel, setActivePanel] = useState<SettingsPanelId>('model')
  const [formValue, setFormValue] = useState<ProviderFormValue>(() =>
    createEmptyProviderFormValue()
  )
  const [isSaving, setIsSaving] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined)
  const [statusOk, setStatusOk] = useState(false)
  const [busyProviderId, setBusyProviderId] = useState<string | undefined>(undefined)

  // Refresh settings whenever the dialog opens so external changes are reflected.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const editingProvider = formTarget?.mode === 'edit' ? formTarget.provider : undefined
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
      const { validation } = await saveProvider(toUpsertRequest(formValue, editingProvider?.id))

      setStatusOk(validation.ok)
      setStatusMessage(describeValidation(validation))

      if (validation.ok) setFormTarget(null)
    } catch (error) {
      setStatusOk(false)
      setStatusMessage(error instanceof Error ? error.message : 'Could not save provider.')
    } finally {
      setIsSaving(false)
    }
  }

  const handleTest = async (provider: ProviderView): Promise<void> => {
    setBusyProviderId(provider.id)
    setStatusMessage(undefined)

    try {
      const validation = await validateProvider({ providerId: provider.id })

      setStatusOk(validation.ok)
      setStatusMessage(`${provider.name}: ${describeValidation(validation)}`)
    } finally {
      setBusyProviderId(undefined)
    }
  }

  // Switches the active provider. This never interrupts a running turn: the runtime applies the change
  // on the next idle reconnect and keeps the conversation's context (shared config dir), so no
  // confirmation is needed.
  const handleSetActive = async (provider: ProviderView): Promise<void> => {
    setBusyProviderId(provider.id)

    try {
      await setActiveProvider(provider.id)
    } finally {
      setBusyProviderId(undefined)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(640px,calc(100vh-2rem))] w-[min(920px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-dialog data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95">
          {/* Radix requires a Title/Description for a11y; the visible panel title lives in the header. */}
          <Dialog.Title className="sr-only">Settings</Dialog.Title>
          <Dialog.Description className="sr-only">
            Manage your Claude installation and model providers.
          </Dialog.Description>

          {/* Left navigation: switch between the Model and General panels. */}
          <nav
            aria-label="Settings"
            className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-muted/40 p-3"
          >
            <div className="px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">Settings</div>
            <ul className="flex flex-col gap-0.5">
              {SETTINGS_PANELS.map(({ id, label, Icon }) => {
                const isActive = activePanel === id

                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setActivePanel(id)}
                      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors ${
                        isActive
                          ? 'bg-muted font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                      }`}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {/* Right column: header bar + scrollable panel content. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-5">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {SETTINGS_PANELS.find((panel) => panel.id === activePanel)?.label}
              </h2>
              <Dialog.Close
                aria-label="Close settings"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {activePanel === 'general' ? (
                <GeneralPanel />
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
                      {!formTarget ? (
                        <button
                          type="button"
                          onClick={openCreate}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
                        >
                          Add provider
                        </button>
                      ) : null}
                    </div>

                    {formTarget ? (
                      <div className="rounded-xl border border-border p-4">
                        <ProviderForm
                          value={formValue}
                          onChange={(patch) =>
                            setFormValue((current) => ({ ...current, ...patch }))
                          }
                          hasStoredKey={editingProvider?.hasKey}
                          maskedKey={editingProvider?.maskedKey}
                          needsKey={editingProvider?.needsKey}
                          errors={formErrors}
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
                        <div className="mt-4 flex justify-end gap-2">
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
                            {isSaving ? 'Saving…' : 'Save & Test'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {statusMessage ? (
                          <p
                            className={`mb-3 text-sm ${statusOk ? 'text-primary' : 'text-destructive'}`}
                            role="alert"
                          >
                            {statusMessage}
                          </p>
                        ) : null}
                        <ProviderList
                          providers={providers}
                          activeProviderId={activeProviderId}
                          busyProviderId={busyProviderId}
                          onEdit={openEdit}
                          onDelete={(provider) => void deleteProvider(provider.id)}
                          onSetActive={(provider) => void handleSetActive(provider)}
                          onTest={(provider) => void handleTest(provider)}
                        />
                      </>
                    )}
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
