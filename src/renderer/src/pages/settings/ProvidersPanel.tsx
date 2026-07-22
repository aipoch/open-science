import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'

import { useSettingsStore } from '@/stores/settings-store'
import type { ProviderView } from '../../../../shared/settings'
import { isCodexSubscriptionProvider } from '../../../../shared/settings'
import { ActiveModelSelect } from './ActiveModelSelect'
import { ProviderList } from './ProviderList'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'
import { SettingsSection } from './SettingsLayout'

type ProvidersPanelProps = {
  // Navigation callbacks into the page-level history: the add/edit provider form is a breadcrumb
  // sub-view owned by SettingsPage, not by this panel.
  onCreateProvider: () => void
  onEditProvider: (provider: ProviderView) => void
  // Shared with the page: the add/edit form's post-save validation also marks the provider busy, so
  // the owner lives in SettingsPage and is passed down.
  busyProviderId?: string
  onBusyProviderChange: (providerId: string | undefined) => void
}

// The Model settings panel: active-model selection, reasoning effort, and the provider list with
// its connection tests and Codex subscription sign-in/out. Store-driven; only the form navigation
// and the shared busy flag come in as props.
const ProvidersPanel = ({
  onCreateProvider,
  onEditProvider,
  busyProviderId,
  onBusyProviderChange
}: ProvidersPanelProps): React.JSX.Element => {
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const deleteProvider = useSettingsStore((state) => state.deleteProvider)
  const validateProvider = useSettingsStore((state) => state.validateProvider)
  const cancelCodexLogin = useSettingsStore((state) => state.cancelCodexLogin)
  const loginIsolatedCodex = useSettingsStore((state) => state.loginIsolatedCodex)
  const logoutIsolatedCodex = useSettingsStore((state) => state.logoutIsolatedCodex)

  // The last connection-test/sign-in failure, shown as an error line under the list.
  const [providerTestError, setProviderTestError] = useState<string | undefined>(undefined)
  // True while the explicit isolated Codex sign-in is open in the browser; drives the cancel action.
  const [isCodexLoginPending, setIsCodexLoginPending] = useState(false)

  // A pending sign-in lives in the main process for up to five minutes. This panel unmounts when
  // Settings closes (or the user switches panels), and an orphaned flow would have no cancel
  // affordance on reopen — so tear it down on unmount. Slightly broader than the pre-split
  // close-only cancel: navigating away mid-flow cancels too.
  const isCodexLoginPendingRef = useRef(isCodexLoginPending)
  useEffect(() => {
    isCodexLoginPendingRef.current = isCodexLoginPending
  }, [isCodexLoginPending])
  useEffect(() => {
    return () => {
      if (isCodexLoginPendingRef.current) void cancelCodexLogin()
    }
  }, [cancelCodexLogin])

  // Codex subscription pseudo-providers only make sense while Codex is the active framework.
  const visibleProviders = providers.filter(
    (provider) => agentFrameworkId === 'codex' || !isCodexSubscriptionProvider(provider.type)
  )

  const handleTest = async (provider: ProviderView): Promise<void> => {
    onBusyProviderChange(provider.id)
    setProviderTestError(undefined)

    try {
      // The pass/fail result is reflected on the provider's card (green check or warning), not as a
      // separate status line.
      await validateProvider({ providerId: provider.id })
    } catch (error) {
      setProviderTestError(
        error instanceof Error ? error.message : 'Could not test the provider connection.'
      )
    } finally {
      onBusyProviderChange(undefined)
    }
  }

  // The explicit isolated sign-in: opens the browser login and records the outcome on the provider,
  // so the card flips to verified (or shows the failure reason) when the flow settles. Infrastructure
  // failures (adapter spawn, IPC) surface through the same error line a failed test uses.
  const handleCodexLogin = async (): Promise<void> => {
    setIsCodexLoginPending(true)
    setProviderTestError(undefined)

    try {
      await loginIsolatedCodex()
    } catch (error) {
      setProviderTestError(error instanceof Error ? error.message : 'Could not sign in to Codex.')
    } finally {
      setIsCodexLoginPending(false)
    }
  }

  const handleCodexLogout = async (): Promise<void> => {
    setProviderTestError(undefined)

    try {
      const result = await logoutIsolatedCodex()
      // A timeout or other failure leaves the credential in place; surface the reason so the user
      // knows to retry rather than assuming they are signed out.
      if (!result.ok) {
        setProviderTestError(result.message ?? 'Codex sign-out did not complete. Try again.')
      }
    } catch (error) {
      setProviderTestError(error instanceof Error ? error.message : 'Could not sign out of Codex.')
    }
  }

  return (
    <div className="space-y-5 p-5">
      {/* Active model is its own section so the current selection reads separately from provider
          management. */}
      {visibleProviders.length > 0 ? (
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

      {/* Model-level generation tuning; always visible, unlike the Active model section above
          which needs at least one provider. */}
      <SettingsSection
        title="Reasoning effort"
        aria-label="Reasoning effort"
        description="Higher levels think longer, lower levels respond faster. Applies to subsequent requests."
        separated={visibleProviders.length > 0}
      >
        <div className="max-w-md">
          <ReasoningEffortSelect />
        </div>
      </SettingsSection>

      <SettingsSection title="Providers" aria-label="Providers" separated>
        <ProviderList
          providers={visibleProviders}
          activeProviderId={activeProviderId}
          busyProviderId={busyProviderId}
          onEdit={onEditProvider}
          onDelete={(provider) => void deleteProvider(provider.id)}
          onTest={(provider) => void handleTest(provider)}
          isCodexLoginPending={isCodexLoginPending}
          onCancelCodexLogin={() => void cancelCodexLogin()}
          onLoginIsolatedCodex={() => void handleCodexLogin()}
          onLogoutIsolatedCodex={() => void handleCodexLogout()}
        />
        {providerTestError ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {providerTestError}
          </p>
        ) : null}
        {/* The add action lives with the list: a dashed ghost row appended after the last provider,
            matching the Available-group placeholder treatment. */}
        <button
          type="button"
          onClick={onCreateProvider}
          className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/60 hover:text-foreground"
        >
          <Plus className="size-4" aria-hidden="true" />
          Add provider
        </button>
      </SettingsSection>
    </div>
  )
}

export { ProvidersPanel }
