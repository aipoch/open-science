import type { TFunction } from 'i18next'
import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useSettingsStore } from '@/stores/settings-store'
import type {
  ProviderView,
  ValidateProviderResult,
  XaiOAuthDeviceAuthorization
} from '../../../../shared/settings'
import { isCodexSubscriptionProvider } from '../../../../shared/settings'
import { DiagnosticDetails } from '@/components/diagnostic-details'
import { errorDetail } from '@/lib/error-detail'
import { ActiveModelSelect } from './ActiveModelSelect'
import { ProviderList } from './ProviderList'
import { ReasoningEffortSelect } from './ReasoningEffortSelect'
import { ScenarioModelList } from './ScenarioModelList'
import { SettingsField, SettingsRow, SettingsSection } from './SettingsLayout'
import { ClaudeIsolatedSignInModal } from './ClaudeIsolatedSignInModal'
import { XaiOAuthSignInDialog } from './XaiOAuthSignInDialog'
import { localizeProviderResourceMessage } from './validation-message'

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

type ProviderActionError = {
  action:
    | 'test'
    | 'delete'
    | 'codex-sign-in'
    | 'codex-sign-out'
    | 'codex-reimport'
    | 'claude-token-save'
    | 'claude-sign-in'
    | 'claude-sign-out'
    | 'claude-disconnect'
    | 'xai-sign-in'
    | 'xai-sign-out'
  detail?: string
}

type ProviderPanelError = string | ProviderActionError

const providerErrorCopy = (error: ProviderPanelError, t: TFunction): string => {
  if (typeof error === 'string') return localizeProviderResourceMessage(error, t)

  switch (error.action) {
    case 'test':
      return t('Could not test the provider connection.')
    case 'delete':
      return t('Could not delete the provider.')
    case 'codex-sign-in':
      return t('Could not sign in to Codex.')
    case 'codex-sign-out':
      return t('Could not sign out of Codex.')
    case 'codex-reimport':
      return t('Could not re-import the Codex login.')
    case 'claude-token-save':
      return t('Could not save the Claude token.')
    case 'claude-sign-in':
      return t('Could not sign in to Claude.')
    case 'claude-sign-out':
      return t('Could not sign out of Claude.')
    case 'claude-disconnect':
      return t('Could not disconnect Claude from Open Science.')
    case 'xai-sign-in':
      return t('Could not sign in to xAI.')
    case 'xai-sign-out':
      return t('Could not sign out of xAI.')
  }
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
  const { t } = useTranslation()
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const claudeSubscriptionProviderId = useSettingsStore(
    (state) => state.claudeSubscriptionProviderId
  )
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const deleteProvider = useSettingsStore((state) => state.deleteProvider)
  const saveProvider = useSettingsStore((state) => state.saveProvider)
  const validateProvider = useSettingsStore((state) => state.validateProvider)
  const cancelCodexLogin = useSettingsStore((state) => state.cancelCodexLogin)
  const loginIsolatedCodex = useSettingsStore((state) => state.loginIsolatedCodex)
  const logoutIsolatedCodex = useSettingsStore((state) => state.logoutIsolatedCodex)
  const loginSharedClaude = useSettingsStore((state) => state.loginSharedClaude)
  const cancelSharedClaudeLogin = useSettingsStore((state) => state.cancelSharedClaudeLogin)
  const logoutSharedClaude = useSettingsStore((state) => state.logoutSharedClaude)
  const loginIsolatedClaude = useSettingsStore((state) => state.loginIsolatedClaude)
  const loginIsolatedClaudeBrowser = useSettingsStore((state) => state.loginIsolatedClaudeBrowser)
  const cancelIsolatedClaudeLogin = useSettingsStore((state) => state.cancelIsolatedClaudeLogin)
  const logoutIsolatedClaude = useSettingsStore((state) => state.logoutIsolatedClaude)
  const beginXaiOAuthLogin = useSettingsStore((state) => state.beginXaiOAuthLogin)
  const waitXaiOAuthLogin = useSettingsStore((state) => state.waitXaiOAuthLogin)
  const cancelXaiOAuthLogin = useSettingsStore((state) => state.cancelXaiOAuthLogin)
  const logoutXaiOAuth = useSettingsStore((state) => state.logoutXaiOAuth)

  // The last connection-test/sign-in failure, shown as an error line under the list.
  const [providerTestError, setProviderTestError] = useState<ProviderPanelError | undefined>(
    undefined
  )
  // True while the explicit isolated Codex sign-in is open in the browser; drives the cancel action.
  const [isCodexLoginPending, setIsCodexLoginPending] = useState(false)
  // True while the explicit shared Claude sign-in is open in the browser.
  const [isClaudeSharedLoginPending, setIsClaudeSharedLoginPending] = useState(false)
  // True while the claude-isolated browser sign-in (`claude setup-token`) is open in the browser.
  const [isClaudeIsolatedLoginPending, setIsClaudeIsolatedLoginPending] = useState(false)
  // Modal state for the Claude subscription's setup-token paste. The modal now doubles as the
  // fallback for the browser sign-in: "Sign in with browser" opens the browser AND this modal, so a
  // user whose browser didn't open (or who prefers a token) can paste one. The wizard uses its own
  // flow, so this state lives on the panel rather than the store.
  const [isClaudeSignInOpen, setIsClaudeSignInOpen] = useState(false)
  const [xaiSession, setXaiSession] = useState<XaiOAuthDeviceAuthorization>()
  const [isXaiLoginPending, setIsXaiLoginPending] = useState(false)
  const xaiLoginCancelledRef = useRef(false)
  // Guards the race between the two isolated sign-in paths. The browser flow (setup-token + its
  // localhost callback) and a manual paste both write the same provider token; whichever finishes
  // first wins. When the manual paste wins we cancel the background browser login, and this flag
  // stops that cancelled login's rejection from surfacing a spurious error over the paste's success.
  const manualClaudePasteWonRef = useRef(false)

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

  // Tear down in-flight Claude sign-ins the same way: both shared (browser OAuth) and isolated
  // (setup-token) can outlive the panel if the user navigates away mid-flow.
  const isClaudeSharedLoginPendingRef = useRef(isClaudeSharedLoginPending)
  useEffect(() => {
    isClaudeSharedLoginPendingRef.current = isClaudeSharedLoginPending
  }, [isClaudeSharedLoginPending])
  const isClaudeIsolatedLoginPendingRef = useRef(isClaudeIsolatedLoginPending)
  useEffect(() => {
    isClaudeIsolatedLoginPendingRef.current = isClaudeIsolatedLoginPending
  }, [isClaudeIsolatedLoginPending])
  useEffect(() => {
    return () => {
      if (isClaudeSharedLoginPendingRef.current) void cancelSharedClaudeLogin()
      if (isClaudeIsolatedLoginPendingRef.current) void cancelIsolatedClaudeLogin()
    }
  }, [cancelSharedClaudeLogin, cancelIsolatedClaudeLogin])
  const isXaiLoginPendingRef = useRef(isXaiLoginPending)
  useEffect(() => {
    isXaiLoginPendingRef.current = isXaiLoginPending
  }, [isXaiLoginPending])
  useEffect(() => {
    return () => {
      if (isXaiLoginPendingRef.current) {
        xaiLoginCancelledRef.current = true
        void cancelXaiOAuthLogin()
      }
    }
  }, [cancelXaiOAuthLogin])

  // Codex + Claude subscription pseudo-providers only make sense while their matching framework is the
  // active one. Hide claude-isolated and claude-shared from non-claude-code frameworks (same rule as codex).
  const visibleProviders = providers.filter((provider) => {
    if (provider.type === 'claude-isolated' || provider.type === 'claude-shared')
      return agentFrameworkId === 'claude-code'
    if (isCodexSubscriptionProvider(provider.type)) return agentFrameworkId === 'codex'

    return true
  })

  const handleTest = async (provider: ProviderView): Promise<void> => {
    onBusyProviderChange(provider.id)
    setProviderTestError(undefined)

    try {
      // The pass/fail result is reflected on the provider's card (green check or warning), not as a
      // separate status line.
      await validateProvider({ providerId: provider.id })
    } catch (error) {
      setProviderTestError({ action: 'test', detail: errorDetail(error) })
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
      setProviderTestError({ action: 'codex-sign-in', detail: errorDetail(error) })
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
        setProviderTestError(result.message ?? t('Codex sign-out did not complete. Try again.'))
      }
    } catch (error) {
      setProviderTestError({ action: 'codex-sign-out', detail: errorDetail(error) })
    }
  }

  // Imported authentication is copied into the app-owned profile. Refresh only on this explicit
  // action so ordinary edits stay self-contained, while users can still pick up a later CLI login or
  // loopback-route change without toggling auth modes.
  const handleCodexReimport = async (provider: ProviderView): Promise<void> => {
    onBusyProviderChange(provider.id)
    setProviderTestError(undefined)

    try {
      await saveProvider({
        id: provider.id,
        type: 'codex-shared',
        reimportCodexAuthentication: true
      })
    } catch (error) {
      setProviderTestError({ action: 'codex-reimport', detail: errorDetail(error) })
    } finally {
      onBusyProviderChange(undefined)
    }
  }

  // The Claude subscription's paste-token sign-in (the modal's submit). Forwards the token to main
  // and surfaces any failure through the same error line the other flows use. When a browser sign-in
  // is still running in the background, the manual paste takes over: mark it as the winner and cancel
  // the background login so the two paths don't both write the provider (or race a stale result onto
  // the card). The winner flag stops the cancelled login from surfacing its own error.
  const handleClaudeSignIn = async (token: string): Promise<ValidateProviderResult | undefined> => {
    setProviderTestError(undefined)

    if (isClaudeIsolatedLoginPending) {
      manualClaudePasteWonRef.current = true
      await cancelIsolatedClaudeLogin()
    }

    try {
      const result = await loginIsolatedClaude(token)
      if (!result.ok) {
        setProviderTestError(result.message ?? t('Could not save the Claude token. Try again.'))
      }

      return result
    } catch (error) {
      setProviderTestError({ action: 'claude-token-save', detail: errorDetail(error) })

      return undefined
    }
  }

  // The claude-isolated browser sign-in. The app runs `claude setup-token` under the isolated config
  // dir; the CLI opens the browser, runs its own localhost callback, captures the code, and prints
  // the token to stdout — the happy path needs no manual paste. We open the paste modal alongside it
  // as a fallback (browser didn't open / user prefers a token). On a successful browser callback we
  // close that modal automatically. Mirrors handleCodexLogin's pending/error handling otherwise.
  const handleClaudeIsolatedBrowserLogin = async (): Promise<void> => {
    manualClaudePasteWonRef.current = false
    setIsClaudeIsolatedLoginPending(true)
    setProviderTestError(undefined)
    // Open the fallback paste modal at the same time as the browser flow starts.
    setIsClaudeSignInOpen(true)

    try {
      const result = await loginIsolatedClaudeBrowser()
      // A manual paste finished first and cancelled this browser login: its outcome already won, so
      // don't overwrite the modal/card with this (now-cancelled) result.
      if (manualClaudePasteWonRef.current) return

      if (result.ok) {
        // Browser callback captured the token: close the fallback modal — the user's done.
        setIsClaudeSignInOpen(false)
      } else {
        // Browser login failed (e.g. it never opened). Leave the modal open so the user can paste a
        // token, and surface the reason there rather than only on the card behind it.
        setProviderTestError(result.message ?? t('Could not sign in to Claude. Try again.'))
      }
    } catch (error) {
      if (manualClaudePasteWonRef.current) return
      setProviderTestError({ action: 'claude-sign-in', detail: errorDetail(error) })
    } finally {
      setIsClaudeIsolatedLoginPending(false)
    }
  }

  const handleClaudeLogout = async (): Promise<void> => {
    setProviderTestError(undefined)

    try {
      const result = await logoutIsolatedClaude()
      if (!result.ok) {
        setProviderTestError(result.message ?? t('Claude sign-out did not complete. Try again.'))
      }
    } catch (error) {
      setProviderTestError({ action: 'claude-sign-out', detail: errorDetail(error) })
    }
  }

  // Claude shared mode: browser OAuth login via `claude auth login --claudeai`.
  const handleClaudeSharedLogin = async (): Promise<void> => {
    setIsClaudeSharedLoginPending(true)
    setProviderTestError(undefined)

    try {
      const result = await loginSharedClaude()
      if (!result.ok && !result.cancelled) {
        setProviderTestError(result.message ?? t('Could not sign in to Claude. Try again.'))
      }
    } catch (error) {
      setProviderTestError({ action: 'claude-sign-in', detail: errorDetail(error) })
    } finally {
      setIsClaudeSharedLoginPending(false)
    }
  }

  const handleClaudeSharedDisconnect = async (): Promise<void> => {
    setProviderTestError(undefined)

    try {
      const result = await logoutSharedClaude()
      if (!result.ok) {
        setProviderTestError(result.message ?? t('Could not disconnect Claude from Open Science.'))
      }
    } catch (error) {
      setProviderTestError({ action: 'claude-disconnect', detail: errorDetail(error) })
    }
  }

  const handleXaiLogin = async (): Promise<void> => {
    setProviderTestError(undefined)
    xaiLoginCancelledRef.current = false
    isXaiLoginPendingRef.current = true
    setIsXaiLoginPending(true)
    try {
      const session = await beginXaiOAuthLogin()
      if (xaiLoginCancelledRef.current) return
      setXaiSession(session)
      await waitXaiOAuthLogin()
      if (xaiLoginCancelledRef.current) return
      setXaiSession(undefined)
    } catch (error) {
      if (xaiLoginCancelledRef.current) return
      setProviderTestError({ action: 'xai-sign-in', detail: errorDetail(error) })
    } finally {
      isXaiLoginPendingRef.current = false
      setIsXaiLoginPending(false)
    }
  }

  const handleCancelXaiLogin = (): void => {
    xaiLoginCancelledRef.current = true
    isXaiLoginPendingRef.current = false
    void cancelXaiOAuthLogin()
    setXaiSession(undefined)
    setIsXaiLoginPending(false)
  }

  const handleXaiLogout = async (): Promise<void> => {
    setProviderTestError(undefined)
    try {
      await logoutXaiOAuth()
    } catch (error) {
      setProviderTestError({ action: 'xai-sign-out', detail: errorDetail(error) })
    }
  }

  const handleDelete = async (providerId: string): Promise<void> => {
    setProviderTestError(undefined)
    try {
      await deleteProvider(providerId)
    } catch (error) {
      setProviderTestError({ action: 'delete', detail: errorDetail(error) })
    }
  }

  return (
    <div className="space-y-5 p-5">
      {/* Main model selection and reasoning effort share one section and one row, mirroring the
          scenario model selectors below. The Model field needs at least one provider; the effort
          control is always visible. */}
      <SettingsSection
        title={t('Main model')}
        aria-label={t('Main model')}
        description={
          <>
            {t('The model that drives new agent sessions.')}{' '}
            {t(
              'Higher levels think longer, while lower levels respond faster. Choices follow the selected model and preserve relative strength when models change; some agent frameworks may approximate unsupported levels. Applies to subsequent requests.'
            )}
          </>
        }
      >
        <SettingsRow layout="model-effort" className="py-0 lg:grid-cols-[minmax(0,1fr)_auto]">
          {visibleProviders.length > 0 ? (
            <SettingsField label={t('Model')}>
              <ActiveModelSelect />
            </SettingsField>
          ) : null}
          {/* Not a SettingsField: a <label> would forward clicks to the segmented control's first
              radio option. The styling matches SettingsField's. */}
          <div className="grid min-w-0 gap-1.5 text-sm font-medium">
            <span>{t('Reasoning effort')}</span>
            <ReasoningEffortSelect />
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* Subagent / Reviewer / Vision routing collapsed into a single accordion card. */}
      <ScenarioModelList />

      <SettingsSection title={t('Providers')} aria-label={t('Providers')}>
        <ProviderList
          providers={visibleProviders}
          activeProviderId={activeProviderId}
          claudeSubscriptionProviderId={claudeSubscriptionProviderId}
          busyProviderId={busyProviderId}
          onEdit={onEditProvider}
          onDelete={(provider) => void handleDelete(provider.id)}
          onTest={(provider) => void handleTest(provider)}
          isCodexLoginPending={isCodexLoginPending}
          onCancelCodexLogin={() => void cancelCodexLogin()}
          onLoginIsolatedCodex={() => void handleCodexLogin()}
          onLogoutIsolatedCodex={() => void handleCodexLogout()}
          onReimportCodexAuthentication={(provider) => void handleCodexReimport(provider)}
          isClaudeSharedLoginPending={isClaudeSharedLoginPending}
          onLoginSharedClaude={() => void handleClaudeSharedLogin()}
          onCancelSharedClaudeLogin={() => void cancelSharedClaudeLogin()}
          onLogoutSharedClaude={() => void handleClaudeSharedDisconnect()}
          isClaudeIsolatedLoginPending={isClaudeIsolatedLoginPending}
          onLoginIsolatedClaude={() => void handleClaudeIsolatedBrowserLogin()}
          onCancelIsolatedClaudeLogin={() => {
            // Explicit cancel: suppress the "Sign-in cancelled" error the browser flow would
            // otherwise surface when its promise resolves, and close the fallback paste modal.
            manualClaudePasteWonRef.current = true
            setIsClaudeSignInOpen(false)
            void cancelIsolatedClaudeLogin()
          }}
          onLoginIsolatedClaudePaste={() => setIsClaudeSignInOpen(true)}
          onLogoutIsolatedClaude={() => void handleClaudeLogout()}
          isXaiLoginPending={isXaiLoginPending}
          onLoginXai={() => void handleXaiLogin()}
          onCancelXaiLogin={handleCancelXaiLogin}
          onLogoutXai={() => void handleXaiLogout()}
        />
        {providerTestError ? (
          <div className="mt-2">
            <p className="text-sm text-destructive" role="alert">
              {providerErrorCopy(providerTestError, t)}
            </p>
            <DiagnosticDetails
              detail={
                typeof providerTestError === 'string' || !providerTestError.detail
                  ? undefined
                  : localizeProviderResourceMessage(providerTestError.detail, t)
              }
            />
          </div>
        ) : null}
        {/* The add action lives with the list: a dashed ghost row appended after the last provider,
            matching the Available-group placeholder treatment. */}
        <button
          type="button"
          onClick={onCreateProvider}
          className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/60 hover:text-foreground"
        >
          <Plus className="size-4" aria-hidden="true" />
          {t('Add provider')}
        </button>
      </SettingsSection>
      {/* The Claude subscription's sign-in modal collects the pasted token. Closing it (without a
          successful paste) is a no-op for the store — the token only lands if the user confirms. */}
      <ClaudeIsolatedSignInModal
        open={isClaudeSignInOpen}
        onOpenChange={setIsClaudeSignInOpen}
        onSubmit={(token) => handleClaudeSignIn(token)}
        browserSignInPending={isClaudeIsolatedLoginPending}
      />
      <XaiOAuthSignInDialog
        open={Boolean(xaiSession)}
        session={xaiSession}
        error={providerTestError ? providerErrorCopy(providerTestError, t) : undefined}
        onCancel={handleCancelXaiLogin}
      />
    </div>
  )
}

export { ProvidersPanel }
