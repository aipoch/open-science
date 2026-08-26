import {
  CircleCheck,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  PlugZap,
  RefreshCw,
  Route,
  TriangleAlert,
  Trash2,
  X
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import type {
  ChatApiEndpoint,
  ClaudeSubscriptionProviderId,
  ProviderValidationFailure,
  ProviderView
} from '../../../../shared/settings'
import {
  codexSubscriptionProviderIdentity,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isXaiSubscriptionProvider,
  providerEndpoints,
  providerValidationFailed,
  resolveCodexSubscriptionType,
  selectClaudeSubscriptionProvider
} from '../../../../shared/settings'
import { getOfficialVendor } from '../../../../shared/provider-registry'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { ProviderKindIcon } from './provider-icons'
import { providerKindKey } from './provider-form-value'
import { SettingsIconAction } from './SettingsLayout'
import { localizeProviderResourceMessage } from './validation-message'

type ProviderListProps = {
  providers: ProviderView[]
  // Provider that sources the currently selected model. Not shown as an "active provider"; used only
  // to keep the in-use provider from being deleted (which would leave no selectable model).
  activeProviderId: string | undefined
  claudeSubscriptionProviderId?: ClaudeSubscriptionProviderId
  busyProviderId?: string
  onEdit: (provider: ProviderView) => void
  onDelete: (provider: ProviderView) => void
  onTest: (provider: ProviderView) => void
  // True while the explicit isolated sign-in flow is open in the browser (cancellable).
  isCodexLoginPending?: boolean
  onCancelCodexLogin?: () => void
  onLoginIsolatedCodex?: () => void
  onLogoutIsolatedCodex?: () => void
  onReimportCodexAuthentication?: (provider: ProviderView) => void
  // Claude subscription's browser OAuth sign-in (shared mode): opens the browser and lands
  // credentials in ~/.claude. Mirrors the codex-isolated flow shape.
  isClaudeSharedLoginPending?: boolean
  onLoginSharedClaude?: () => void
  onCancelSharedClaudeLogin?: () => void
  onLogoutSharedClaude?: () => void
  // Claude subscription's isolated mode. The primary sign-in (onLoginIsolatedClaude) is a browser
  // OAuth: the app runs `claude setup-token` under the isolated config dir, which opens the browser
  // and returns the token — mirroring the codex-isolated flow, so it carries a pending flag and a
  // cancel affordance. onLoginIsolatedClaudePaste is the fallback that opens the manual paste modal
  // for users who prefer to mint and paste the token themselves.
  isClaudeIsolatedLoginPending?: boolean
  onLoginIsolatedClaude?: () => void
  onCancelIsolatedClaudeLogin?: () => void
  onLoginIsolatedClaudePaste?: () => void
  onLogoutIsolatedClaude?: () => void
  isXaiLoginPending?: boolean
  onLoginXai?: () => void
  onCancelXaiLogin?: () => void
  onLogoutXai?: () => void
}

// Concise, actionable reason for a failed connection test, shown on the unverified warning.
// Known application-generated resource errors are localized; gateway-supplied text stays verbatim.
const describeValidationFailure = (failure: ProviderValidationFailure, t: TFunction): string => {
  const message = failure.message ? localizeProviderResourceMessage(failure.message, t) : undefined

  switch (failure.category) {
    case 'auth':
      return message
        ? t('Test failed: {{message}}', { message })
        : t('Test failed: authentication rejected — check the API key.')
    case 'network':
      return t('Test failed: could not reach the endpoint — check the base URL/connection.')
    case 'bad-url':
      return t('Test failed: the base URL looks invalid.')
    case 'model-not-found':
      return t('Test failed: the configured model was not found.')
    case 'timeout':
      return t('Test failed: the connection timed out.')
    case 'incompatible':
      // The pairing, not the credential, is the problem — carry the specific route-mismatch reason.
      return message ?? t('Not compatible with the active agent framework.')
    case 'server-error':
      // Gateway or upstream service temporarily unavailable — surface the specific error when present.
      if (!message)
        return t('Test failed: the gateway or upstream service is temporarily unavailable.')
      return failure.status
        ? t('Test failed: {{message}} (HTTP {{status}})', {
            message,
            status: failure.status
          })
        : t('Test failed: {{message}}', { message })
    default:
      return message ? t('Test failed: {{message}}', { message }) : t('Connection test failed.')
  }
}

// Endpoint route + full description for the chat API a provider speaks. Rendered as a route-icon badge
// showing the raw /v1 path (not a vendor name) so the user reads it as "which API shape", distinct from
// the provider's own name/brand: Claude Code needs the Anthropic /v1/messages route, while OpenCode also
// accepts the OpenAI /v1/chat/completions route.
const ENDPOINT_PATHS: Record<ChatApiEndpoint, string> = {
  anthropic: '/v1/messages',
  openai: '/v1/chat/completions',
  responses: '/v1/responses'
}

// Human label for a provider type badge: the vendor name for official providers, else a type name.
// Vendor names and the Codex identity are proper nouns and stay as the registry supplies them.
const describeType = (provider: ProviderView, t: TFunction): string => {
  if (provider.type === 'custom') return t('Custom')
  if (provider.type === 'claude-isolated' || provider.type === 'claude-shared')
    return t('Claude subscription')
  if (isCodexSubscriptionProvider(provider.type)) return codexSubscriptionProviderIdentity().name
  if (isXaiSubscriptionProvider(provider.type)) return 'xAI (Grok) OAuth'

  return provider.vendorId
    ? (getOfficialVendor(provider.vendorId)?.label ?? t('Official'))
    : t('Official')
}

// Lists configured providers with their type, masked key, and model. Each row leads with the
// select/selected control, followed by compact icon actions (test / edit / delete) with hover
// tooltips. Shared by the settings page (the onboarding wizard uses the form directly).
const ProviderList = ({
  providers,
  activeProviderId,
  claudeSubscriptionProviderId,
  busyProviderId,
  onEdit,
  onDelete,
  onTest,
  isCodexLoginPending = false,
  onCancelCodexLogin,
  onLoginIsolatedCodex,
  onLogoutIsolatedCodex,
  onReimportCodexAuthentication,
  isClaudeSharedLoginPending = false,
  onLoginSharedClaude,
  onCancelSharedClaudeLogin,
  onLogoutSharedClaude,
  isClaudeIsolatedLoginPending = false,
  onLoginIsolatedClaude,
  onCancelIsolatedClaudeLogin,
  onLoginIsolatedClaudePaste,
  onLogoutIsolatedClaude,
  isXaiLoginPending = false,
  onLoginXai,
  onCancelXaiLogin,
  onLogoutXai
}: ProviderListProps): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()

  if (providers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        {t('No providers yet. Add one to choose your model source.')}
      </div>
    )
  }

  const codexProviders = providers.filter((provider) => isCodexSubscriptionProvider(provider.type))
  const selectedCodexProvider =
    codexProviders.find((provider) => provider.id === activeProviderId) ?? codexProviders[0]

  // Collapse both Claude subscription modes into one card while remembering the last configured mode
  // even when another provider currently supplies the selected model.
  const selectedClaudeProvider = selectClaudeSubscriptionProvider(
    providers,
    activeProviderId,
    claudeSubscriptionProviderId
  )

  const displayedProviders = [
    ...providers.filter(
      (provider) =>
        !isCodexSubscriptionProvider(provider.type) && !isClaudeSubscriptionProvider(provider.type)
    ),
    ...(selectedCodexProvider
      ? [{ ...selectedCodexProvider, name: codexSubscriptionProviderIdentity().name }]
      : []),
    ...(selectedClaudeProvider
      ? [{ ...selectedClaudeProvider, name: t('Claude subscription') }]
      : [])
  ]

  return (
    <TooltipProvider delayDuration={200}>
      <ul className="space-y-2">
        {displayedProviders.map((provider) => {
          const isActiveSource = provider.id === activeProviderId
          const isBusy = provider.id === busyProviderId
          // A failed test flags the provider as unverified: it shows a warning here and is excluded
          // from the model pickers until a later test passes.
          const failure = providerValidationFailed(provider)
            ? provider.lastValidationFailure
            : undefined
          // A passing test shows a green check. Suppressed while a test is in flight.
          const isVerified = !failure && !isBusy && provider.lastValidatedAt !== undefined
          const isCodexSubscription = isCodexSubscriptionProvider(provider.type)
          const isXaiSubscription = isXaiSubscriptionProvider(provider.type)
          const codexSubscriptionType = isCodexSubscription
            ? resolveCodexSubscriptionType(provider)
            : undefined
          // The provider sourcing the selected model (and the last remaining one) can't be deleted:
          // removing it would leave no model to run, so its delete action stays disabled.
          const canDelete = !isActiveSource && displayedProviders.length > 1
          // The chat endpoint(s) this provider speaks; defaults to Anthropic when unset (older/custom).
          const providerRoutes = providerEndpoints(provider)
          const endpoint = {
            path: providerRoutes.map((route) => ENDPOINT_PATHS[route]).join(' · '),
            full:
              providerRoutes.map((route) => ENDPOINT_PATHS[route]).join(' and ') +
              (providerRoutes.length > 1 ? ' endpoints' : ' endpoint')
          }

          return (
            <li
              key={provider.id}
              data-slot="settings-list-row"
              className="rounded-lg border border-border bg-card p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {provider.name}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      <ProviderKindIcon
                        kindKey={providerKindKey(provider.type, provider.vendorId)}
                        className="size-3"
                      />
                      {describeType(provider, t)}
                    </span>
                    {!isCodexSubscription ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                            aria-label={t('Speaks the {{protocol}}', { protocol: endpoint.full })}
                          >
                            <Route className="size-3" strokeWidth={2} aria-hidden="true" />
                            {endpoint.path}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t('Speaks the {{protocol}}', { protocol: endpoint.full })}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                    {isBusy ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {t('Testing…')}
                      </span>
                    ) : failure ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex shrink-0 text-amber-500"
                            aria-label={describeValidationFailure(failure, t)}
                          >
                            <TriangleAlert
                              className="size-3.5"
                              strokeWidth={2}
                              aria-hidden="true"
                            />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{describeValidationFailure(failure, t)}</TooltipContent>
                      </Tooltip>
                    ) : isVerified ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="inline-flex shrink-0 text-emerald-500"
                            aria-label={t('Connection verified')}
                          >
                            <CircleCheck className="size-3.5" strokeWidth={2} aria-hidden="true" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{t('Connection verified')}</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {codexSubscriptionType === 'codex-shared' ? (
                      <div>{t('Authentication imported into Open Science')}</div>
                    ) : codexSubscriptionType === 'codex-isolated' ? (
                      <div>{t('Codex login stored separately by Open Science')}</div>
                    ) : provider.type === 'claude-isolated' && isClaudeIsolatedLoginPending ? (
                      // Browser sign-in in flight. `claude setup-token` opens the browser itself and
                      // waits on a localhost callback; when the browser fails to open it stays silent
                      // (no fallback URL), so tell the user the escape hatch up front: cancel and paste
                      // a setup token instead. Without this line a stuck login looks like a hang.
                      <div>
                        {t(
                          "Opening your browser to sign in… Didn't open? Cancel and use a setup token."
                        )}
                      </div>
                    ) : provider.type === 'claude-isolated' ? (
                      // The Claude subscription card carries an OAuth token, so we surface the masked
                      // hint the same way custom/official providers do (no Keychain leak). The
                      // signed in / signed out framing belongs to the card icon, not this line. The
                      // "Expires" line is the issue #347 requirement to make the one-year
                      // setup-token lifetime visible on the card.
                      provider.maskedKey ? (
                        <>
                          <div className="font-mono">
                            {t('Token: {{masked}}', { masked: provider.maskedKey })}
                          </div>
                          {provider.expiresAt !== undefined ? (
                            <div>
                              {t('Expires')}{' '}
                              <time dateTime={new Date(provider.expiresAt).toISOString()}>
                                {formatDate(provider.expiresAt, 'date')}
                              </time>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div>{t('Not signed in')}</div>
                      )
                    ) : isXaiSubscription ? (
                      <>
                        <div>{provider.accountEmail ?? t('Not signed in')}</div>
                        <div>
                          {t('{{count}} models', {
                            defaultValue_one: '{{count}} model',
                            count: provider.models.length
                          })}
                        </div>
                      </>
                    ) : (
                      // custom + official both authenticate with a key; official's models come from its
                      // catalog (shown as a count) rather than a single stored model.
                      <>
                        {provider.type === 'custom' && provider.model ? (
                          <div className="truncate">
                            {t('Model: {{name}}', { name: provider.model })}
                          </div>
                        ) : null}
                        {provider.type === 'official' && provider.models.length > 0 ? (
                          <div className="truncate">
                            {t('{{count}} models', {
                              defaultValue_one: '{{count}} model',
                              count: provider.models.length
                            })}
                          </div>
                        ) : null}
                        {provider.maskedKey ? (
                          <div className="font-mono">
                            {t('Key: {{masked}}', { masked: provider.maskedKey })}
                          </div>
                        ) : null}
                        {provider.needsKey ? (
                          <div className="text-destructive">{t('Key needs re-entry')}</div>
                        ) : null}
                      </>
                    )}
                    {failure ? (
                      <div className="text-amber-600 dark:text-amber-500">
                        {describeValidationFailure(failure, t)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {isXaiSubscription && isXaiLoginPending ? (
                    <SettingsIconAction
                      label={t('Cancel sign-in')}
                      icon={X}
                      onClick={() => onCancelXaiLogin?.()}
                      className="border border-border text-foreground"
                    />
                  ) : isCodexSubscription && isCodexLoginPending ? (
                    <SettingsIconAction
                      label={t('Cancel sign-in')}
                      icon={X}
                      onClick={() => onCancelCodexLogin?.()}
                      className="border border-border text-foreground"
                    />
                  ) : (provider.type === 'claude-isolated' && isClaudeIsolatedLoginPending) ||
                    (provider.type === 'claude-shared' && isClaudeSharedLoginPending) ? (
                    // Browser sign-in in flight: the Cancel affordance lives in the sign-in group
                    // below, so suppress the Test button here to avoid a confusing mid-login test.
                    <></>
                  ) : (
                    <SettingsIconAction
                      label={isCodexSubscription ? t('Check Codex login') : t('Test connection')}
                      icon={PlugZap}
                      onClick={() => onTest(provider)}
                      disabled={isBusy}
                      className="border border-border text-foreground"
                    />
                  )}
                  {codexSubscriptionType === 'codex-shared' && !isCodexLoginPending ? (
                    <SettingsIconAction
                      label={t('Re-import Codex login')}
                      icon={RefreshCw}
                      onClick={() => onReimportCodexAuthentication?.(provider)}
                      disabled={isBusy}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {codexSubscriptionType === 'codex-isolated' &&
                  !isVerified &&
                  !isCodexLoginPending ? (
                    <SettingsIconAction
                      label={t('Sign in')}
                      icon={LogIn}
                      onClick={() => onLoginIsolatedCodex?.()}
                      disabled={isBusy}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {codexSubscriptionType === 'codex-isolated' && isVerified ? (
                    <SettingsIconAction
                      label={t('Sign out')}
                      icon={LogOut}
                      onClick={() => onLogoutIsolatedCodex?.()}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {isXaiSubscription && !provider.hasKey && !isXaiLoginPending ? (
                    <SettingsIconAction
                      label={t('Sign in')}
                      icon={LogIn}
                      onClick={() => onLoginXai?.()}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {isXaiSubscription && provider.hasKey ? (
                    <SettingsIconAction
                      label={t('Sign out')}
                      icon={LogOut}
                      onClick={() => onLogoutXai?.()}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {provider.type === 'claude-isolated' &&
                  !isVerified &&
                  !isClaudeIsolatedLoginPending ? (
                    <>
                      <SettingsIconAction
                        label={t('Sign in with browser')}
                        icon={LogIn}
                        onClick={() => onLoginIsolatedClaude?.()}
                        disabled={isBusy}
                        className="border border-border text-foreground"
                      />
                      <SettingsIconAction
                        label={t('Use setup token')}
                        icon={KeyRound}
                        onClick={() => onLoginIsolatedClaudePaste?.()}
                        disabled={isBusy}
                        className="border border-border text-foreground"
                      />
                    </>
                  ) : null}
                  {provider.type === 'claude-isolated' && isClaudeIsolatedLoginPending ? (
                    <SettingsIconAction
                      label={t('Cancel sign-in')}
                      icon={X}
                      onClick={() => onCancelIsolatedClaudeLogin?.()}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {provider.type === 'claude-isolated' && isVerified ? (
                    <SettingsIconAction
                      label={t('Sign out')}
                      icon={LogOut}
                      onClick={() => onLogoutIsolatedClaude?.()}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {provider.type === 'claude-shared' &&
                  !isVerified &&
                  isClaudeSharedLoginPending ? (
                    // Browser sign-in in flight: swap to Cancel so the user can back out of a login
                    // that won't complete, mirroring codex-isolated (and the OpenAI subscription).
                    <SettingsIconAction
                      label={t('Cancel sign-in')}
                      icon={X}
                      onClick={() => onCancelSharedClaudeLogin?.()}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {provider.type === 'claude-shared' &&
                  !isVerified &&
                  !isClaudeSharedLoginPending ? (
                    <SettingsIconAction
                      label={t('Sign in with browser')}
                      icon={LogIn}
                      onClick={() => onLoginSharedClaude?.()}
                      disabled={isBusy}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  {provider.type === 'claude-shared' && isVerified ? (
                    <SettingsIconAction
                      label={t('Disconnect from Open Science')}
                      icon={LogOut}
                      onClick={() => onLogoutSharedClaude?.()}
                      className="border border-border text-foreground"
                    />
                  ) : null}
                  <SettingsIconAction
                    label={t('Edit')}
                    icon={Pencil}
                    onClick={() => onEdit(provider)}
                    className="border border-border text-foreground"
                  />
                  <SettingsIconAction
                    label={t('Delete')}
                    icon={Trash2}
                    onClick={() => onDelete(provider)}
                    disabled={!canDelete}
                    className="border border-border"
                    danger
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </TooltipProvider>
  )
}

export { ProviderList }
