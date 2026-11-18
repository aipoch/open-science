import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2, Zap } from 'lucide-react'
import { OFFICIAL_VENDORS, type OfficialVendorId } from '@aipoch/providers'

import { Button } from '@/components/ui/button'
import { ProviderSilkBackground } from '@/components/react-bits/ProviderSilkBackground'
import { ErrorNotice } from '@/components/error-notice'
import { CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type {
  UpsertProviderRequest,
  ValidateProviderResult,
  XaiOAuthDeviceAuthorization
} from '../../../../shared/settings'
import { isProviderUsableByFramework } from '../../../../shared/settings-runtime'
import { cn } from '@/lib/utils'
import {
  selectActiveAgentFramework,
  selectFrameworkApiEndpoints,
  useSettingsStore
} from '@/stores/settings-store'
import { ClaudeIsolatedSignInModal } from '../settings/ClaudeIsolatedSignInModal'
import { ProviderForm } from '../settings/ProviderForm'
import { ProviderKindIcon } from '../settings/provider-icons'
import { XaiOAuthSignInDialog } from '../settings/XaiOAuthSignInDialog'
import {
  createEmptyProviderFormValue,
  defaultCustomApiEndpoint,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerFormApiEndpoints,
  providerFormModelForFramework,
  providerFormTokenLimits,
  providerKindPatch,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { describeValidation, localizeProviderResourceMessage } from '../settings/validation-message'

const isBrowserSignInProvider = (type: ProviderFormValue['type']): boolean =>
  type === 'codex-isolated' ||
  type === 'claude-isolated' ||
  type === 'claude-shared' ||
  type === 'xai-subscription'

// Converts a form value into the upsert request the main process expects.
const toUpsertRequest = (value: ProviderFormValue, id?: string): UpsertProviderRequest => ({
  ...(id ? { id, requireExisting: true } : {}),
  type: value.type,
  codexTransport: value.codexTransport,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  ...providerFormTokenLimits(value),
  vendorId: value.vendorId,
  region: value.region,
  // Persist the chosen API format so an OpenAI-compatible provider is validated + driven correctly.
  apiEndpoints: providerFormApiEndpoints(value),
  supportsImageInput: value.supportsImageInput,
  reasoningEffortPreset: value.type === 'custom' ? value.reasoningEffortPreset : undefined,
  reasoningEffortTransport: value.type === 'custom' ? value.reasoningEffortTransport : undefined,
  key: value.key || undefined
})

type ProviderStepProps = {
  // The draft lives in the wizard shell so going Back and returning keeps it; this step owns
  // validation, saving, and the isolated Codex sign-in flow.
  formValue: ProviderFormValue
  setFormValue: React.Dispatch<React.SetStateAction<ProviderFormValue>>
  providerId?: string
  onProviderSaved?: (id: string | undefined) => void
  onBack: () => void
  onAdvance: (method?: 'account' | 'api-key') => void
  variant?: 'form' | 'quick'
  children?: React.ReactNode
  canContinue?: boolean
  onBusyChange?: (busy: boolean) => void
  onAdvanced?: () => void
  onSkip?: () => void | Promise<void>
  isSkipping?: boolean
  skipError?: string
}

type QuickProviderCard = {
  id: string
  kindKey: string
  subscriptionKind?: string
  title: string
  description: string
  subscription: string
  accent: string
}

const PROVIDER_ACCENTS: Partial<Record<OfficialVendorId, string>> = {
  openai: '#111111',
  anthropic: '#d97757',
  xai: '#dce3ea',
  apodex: '#437dc4',
  deepseek: '#5786fe',
  bailian: '#7347ff',
  bailianplan: '#7347ff',
  zhipu: '#3d5afe',
  glmcodingplan: '#3d5afe',
  kimi: '#5d51e8',
  kimiforcode: '#5d51e8',
  minimax: '#e73562',
  stepfun: '#0160ff',
  stepplan: '#0160ff',
  xiaomimimo: '#ff6900',
  sensenova: '#5b29da',
  volcengine: '#006eff',
  tencent: '#006eff',
  tencentcodingplan: '#006eff',
  tencenttokenplan: '#006eff',
  nvidia: '#76b900',
  'opencode-go': '#b9b9b9',
  opencode: '#b9b9b9',
  openrouter: '#7624f4',
  requesty: '#1677ff'
}

const QUICK_SUBSCRIPTIONS: Partial<
  Record<
    OfficialVendorId,
    Pick<QuickProviderCard, 'subscriptionKind' | 'description' | 'subscription'>
  >
> = {
  openai: {
    subscriptionKind: 'codex-subscription',
    description: 'Use an existing Codex profile or sign in with a separate Open-Science profile.',
    subscription: 'Use your eligible ChatGPT subscription'
  },
  anthropic: {
    subscriptionKind: 'claude-subscription',
    description: 'Use an existing Claude profile or sign in with a separate Open-Science profile.',
    subscription: 'Use your eligible Claude subscription'
  },
  xai: {
    subscriptionKind: 'xai-subscription',
    description: 'Sign in to your xAI subscription with a browser device code.',
    subscription: 'Sign in with your xAI account'
  }
}

const QUICK_PROVIDER_CARDS: QuickProviderCard[] = [
  ...OFFICIAL_VENDORS.map((vendor) => ({
    id: vendor.id,
    kindKey: `official:${vendor.id}`,
    title: vendor.label,
    description: 'API key — models provided',
    subscription: '',
    accent: PROVIDER_ACCENTS[vendor.id] ?? '#dce3ea',
    ...QUICK_SUBSCRIPTIONS[vendor.id]
  })),
  {
    id: 'more',
    kindKey: 'custom',
    title: 'Custom Gateway',
    description: 'Use a compatible endpoint or connect another model provider.',
    subscription: '',
    accent: '#dbe8ff'
  }
]

// Model provider step: configure and validate the provider new research sessions will use. Reuses
// the settings page's ProviderForm so both surfaces stay in sync.
const ProviderStep = ({
  formValue,
  setFormValue,
  providerId: savedProviderId,
  onProviderSaved,
  onBack,
  onAdvance,
  variant = 'form',
  children,
  canContinue = true,
  onBusyChange,
  onAdvanced,
  onSkip,
  isSkipping = false,
  skipError
}: ProviderStepProps): React.JSX.Element => {
  const { t } = useTranslation()
  // Validation copy is shared with the settings page and lives in the `settings` namespace, so this
  // step holds a second, settings-scoped t for describeValidation.
  const { t: tSettings } = useTranslation()
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const saveAndActivateProvider = useSettingsStore((state) => state.saveAndActivateProvider)
  const persistProvider = useSettingsStore((state) => state.persistProvider)
  const setActiveProvider = useSettingsStore((state) => state.setActiveProvider)
  const loginIsolatedCodex = useSettingsStore((state) => state.loginIsolatedCodex)
  const cancelCodexLogin = useSettingsStore((state) => state.cancelCodexLogin)
  const loginIsolatedClaudeBrowser = useSettingsStore((state) => state.loginIsolatedClaudeBrowser)
  const loginIsolatedClaude = useSettingsStore((state) => state.loginIsolatedClaude)
  const cancelIsolatedClaudeLogin = useSettingsStore((state) => state.cancelIsolatedClaudeLogin)
  const loginSharedClaude = useSettingsStore((state) => state.loginSharedClaude)
  const cancelSharedClaudeLogin = useSettingsStore((state) => state.cancelSharedClaudeLogin)
  const beginXaiOAuthLogin = useSettingsStore((state) => state.beginXaiOAuthLogin)
  const waitXaiOAuthLogin = useSettingsStore((state) => state.waitXaiOAuthLogin)
  const cancelXaiOAuthLogin = useSettingsStore((state) => state.cancelXaiOAuthLogin)

  const [isSaving, setIsSaving] = useState(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const advanceIfMounted = (method: 'account' | 'api-key' = 'api-key'): void => {
    if (mounted.current) onAdvance(method)
  }
  const [isClaudeSignInOpen, setIsClaudeSignInOpen] = useState(false)
  const [xaiSession, setXaiSession] = useState<XaiOAuthDeviceAuthorization>()
  const claudeProviderIdRef = useRef<string | undefined>(undefined)
  const manualClaudePasteWonRef = useRef(false)
  // Required-field errors stay hidden until the user first tries to submit, so an untouched form is
  // not littered with "required" messages. A `*` on each label signals the requirement up front.
  const [showProviderErrors, setShowProviderErrors] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined)
  const [validationOk, setValidationOk] = useState(false)
  const [quickCardId, setQuickCardId] = useState<string>()
  const [hoveredQuickCardId, setHoveredQuickCardId] = useState<string>()
  const [quickMode, setQuickMode] = useState<'key' | undefined>()
  const [quickKeys, setQuickKeys] = useState<Record<string, string>>(() =>
    formValue.type === 'official' && formValue.vendorId
      ? { [formValue.vendorId]: formValue.key }
      : {}
  )
  // Combined advanced setup locks runtime selection while its provider is being tested.
  useEffect(() => {
    onBusyChange?.(isSaving)
    return () => onBusyChange?.(false)
  }, [isSaving, onBusyChange])
  const customApiEndpoint = defaultCustomApiEndpoint(frameworkEndpoints)
  const activeFramework = useSettingsStore(selectActiveAgentFramework)
  // Mirrors the Settings teardown: a pending isolated sign-in lives in the main process for up to
  // five minutes, and its guard rejects a second attempt as "already in progress". If the wizard
  // unmounts mid-flow (app quit, relaunch, forced navigation), cancel it so the next attempt starts
  // clean. The ref is written only from event handlers/effects, never during render.
  const codexLoginPendingRef = useRef(false)
  const claudeLoginPendingRef = useRef(false)
  const claudeSharedLoginPendingRef = useRef(false)
  const xaiLoginPendingRef = useRef(false)
  const xaiLoginCancelledRef = useRef(false)

  useEffect(
    () => () => {
      if (codexLoginPendingRef.current) void cancelCodexLogin()
      if (claudeLoginPendingRef.current) void cancelIsolatedClaudeLogin()
      if (claudeSharedLoginPendingRef.current) void cancelSharedClaudeLogin()
      if (xaiLoginPendingRef.current) void cancelXaiOAuthLogin()
    },
    [cancelCodexLogin, cancelIsolatedClaudeLogin, cancelSharedClaudeLogin, cancelXaiOAuthLogin]
  )

  // Seed an untouched draft from the active framework. Codex starts with its subscription provider;
  // custom-provider flows use the framework's preferred API format. An existing draft always wins
  // when navigating back to this step.
  useEffect(() => {
    setFormValue((current) => {
      if (
        current.providerFormTouched ||
        current.name ||
        current.baseUrl ||
        current.model ||
        current.key
      ) {
        return current
      }

      if (agentFrameworkId === 'codex') {
        return createEmptyProviderFormValue(providerKindPatch('codex-subscription'))
      }

      if (current.type !== 'custom' || current.apiEndpoint === customApiEndpoint) return current

      return { ...current, apiEndpoint: customApiEndpoint }
    })
  }, [agentFrameworkId, customApiEndpoint, setFormValue])

  // Required fields must be filled before the draft can be tested.
  const formErrors = getProviderFormErrors(formValue)

  const handleClaudeTokenFallback = async (token: string): Promise<ValidateProviderResult> => {
    manualClaudePasteWonRef.current = true
    await cancelIsolatedClaudeLogin()

    try {
      const result = await loginIsolatedClaude(token)
      if (result.applied === false) {
        const message = t(
          'The Claude provider changed during sign-in. Review the selection and try again.'
        )
        setValidationOk(false)
        setValidationMessage(message)
        return { ...result, ok: false, message }
      }

      setValidationOk(result.ok)
      setValidationMessage(describeValidation(result, tSettings))

      if (result.ok) {
        if (claudeProviderIdRef.current) {
          await setActiveProvider(claudeProviderIdRef.current)
        }
        setIsClaudeSignInOpen(false)
        advanceIfMounted('account')
      }

      return result
    } catch (error) {
      const message =
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save the Claude token.')
      setValidationOk(false)
      setValidationMessage(message)
      return { ok: false, category: 'unknown', message }
    }
  }

  const handleSaveProvider = async (valueOverride?: ProviderFormValue): Promise<void> => {
    if (!canContinue) return
    const value = valueOverride ?? formValue
    // Quick subscription selection may have just switched frameworks; use the persisted snapshot.
    const currentSettings = useSettingsStore.getState()
    const currentFrameworkEndpoints = selectFrameworkApiEndpoints(currentSettings)
    const valueFormErrors = getProviderFormErrors(value)
    // First submit attempt surfaces any missing required fields instead of testing an incomplete draft.
    if (hasProviderFormErrors(valueFormErrors)) {
      setShowProviderErrors(true)
      return
    }

    const providerValue =
      value.type === 'official'
        ? {
            ...value,
            model: providerFormModelForFramework(value, currentFrameworkEndpoints) ?? value.model
          }
        : value

    // A provider that validates can still be unusable by the selected framework (e.g. Claude + an
    // OpenAI-only gateway). Block that before it becomes the active provider, so onboarding can't
    // finish with a pair the agent can't actually spawn.
    if (
      !isProviderUsableByFramework(
        { apiEndpoints: providerFormApiEndpoints(providerValue), type: providerValue.type },
        { id: currentSettings.agentFrameworkId, supportedApiTypes: currentFrameworkEndpoints }
      )
    ) {
      const label =
        selectActiveAgentFramework(currentSettings)?.displayName ?? t('The selected agent')
      setValidationOk(false)
      setValidationMessage(
        t(
          "This provider isn't compatible with {{framework}}. Pick a provider whose API format {{framework}} supports, or change the agent framework.",
          { framework: label }
        )
      )
      return
    }

    setIsSaving(true)
    setValidationMessage(undefined)

    try {
      if (value.type === 'codex-isolated') {
        // Isolated sign-in is explicit: persist the provider first, then run the browser login.
        // Persisting alone never pops a browser; a cancelled login keeps the provider saved but
        // unverified, so the user can retry without re-entering anything.
        const providerId = await persistProvider(toUpsertRequest(value))
        // Arm the unmount teardown for exactly the duration of the main-process login.
        codexLoginPendingRef.current = true
        const validation = await loginIsolatedCodex().finally(() => {
          codexLoginPendingRef.current = false
        })

        // A discarded sign-in (the provider was switched/edited while the browser flow was open) can
        // report ok but was never recorded on the stored provider — advancing would finish onboarding
        // on an unverified profile. Keep the user here to retry against the provider they now have.
        if (validation.applied === false) {
          setValidationOk(false)
          setValidationMessage(
            t('The Codex provider changed during sign-in. Review the selection and try again.')
          )
          return
        }

        setValidationOk(validation.ok)
        setValidationMessage(describeValidation(validation, tSettings))

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          advanceIfMounted('account')
        }
        return
      }

      if (value.type === 'claude-isolated') {
        manualClaudePasteWonRef.current = false
        const providerId = await persistProvider(toUpsertRequest(value))
        claudeProviderIdRef.current = providerId
        claudeLoginPendingRef.current = true
        setIsClaudeSignInOpen(true)
        const validation = await loginIsolatedClaudeBrowser().finally(() => {
          claudeLoginPendingRef.current = false
        })

        if (manualClaudePasteWonRef.current) return

        if (validation.cancelled) {
          setIsClaudeSignInOpen(false)
          setValidationOk(false)
          setValidationMessage(undefined)
          return
        }

        if (validation.applied === false) {
          setIsClaudeSignInOpen(false)
          setValidationOk(false)
          setValidationMessage(
            t('The Claude provider changed during sign-in. Review the selection and try again.')
          )
          return
        }

        setValidationOk(validation.ok)
        setValidationMessage(describeValidation(validation, tSettings))

        if (validation.ok) {
          setIsClaudeSignInOpen(false)
          if (providerId) await setActiveProvider(providerId)
          advanceIfMounted('account')
        }
        return
      }

      if (value.type === 'claude-shared') {
        const providerId = await persistProvider(toUpsertRequest(value))
        claudeSharedLoginPendingRef.current = true
        const validation = await loginSharedClaude().finally(() => {
          claudeSharedLoginPendingRef.current = false
        })

        if (validation.cancelled) {
          setValidationOk(false)
          setValidationMessage(undefined)
          return
        }

        if (validation.applied === false) {
          setValidationOk(false)
          setValidationMessage(
            t('The Claude provider changed during sign-in. Review the selection and try again.')
          )
          return
        }

        setValidationOk(validation.ok)
        setValidationMessage(describeValidation(validation, tSettings))

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          advanceIfMounted('account')
        }
        return
      }

      if (value.type === 'xai-subscription') {
        const providerId = await persistProvider(toUpsertRequest(value))
        xaiLoginCancelledRef.current = false
        xaiLoginPendingRef.current = true
        let validation: ValidateProviderResult
        try {
          const session = await beginXaiOAuthLogin()
          if (xaiLoginCancelledRef.current) return
          setXaiSession(session)
          ;({ validation } = await waitXaiOAuthLogin())
        } finally {
          xaiLoginPendingRef.current = false
        }
        if (xaiLoginCancelledRef.current) return
        setXaiSession(undefined)
        if (validation.applied === false) {
          setValidationOk(false)
          setValidationMessage(t('The provider changed during testing. Try again.'))
          return
        }
        setValidationOk(validation.ok)
        setValidationMessage(describeValidation(validation, tSettings))
        if (validation.ok) {
          await setActiveProvider(providerId)
          advanceIfMounted('account')
        }
        return
      }

      const { providerId, validation } = await saveAndActivateProvider(
        toUpsertRequest(providerValue, savedProviderId)
      )
      // Persistence survives Back even though this page's permission to navigate does not.
      if (providerId) onProviderSaved?.(providerId)
      if (!mounted.current) return

      // A validation superseded by a newer test (or a provider removed/edited mid-test) reports its
      // outcome but was not recorded; do not finish onboarding on a result the stored provider never
      // received.
      if (validation.applied === false) {
        setValidationOk(false)
        setValidationMessage(t('The provider changed during testing. Try again.'))
        return
      }

      setValidationOk(validation.ok)
      setValidationMessage(describeValidation(validation, tSettings))

      if (validation.ok) {
        advanceIfMounted(value.type === 'codex-shared' ? 'account' : 'api-key')
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Provider no longer exists.') {
        onProviderSaved?.(undefined)
      }
      if (!mounted.current) return
      if (value.type === 'xai-subscription' && xaiLoginCancelledRef.current) return
      setValidationOk(false)
      setValidationMessage(
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save provider.')
      )
    } finally {
      setIsSaving(false)
    }
  }

  const chooseQuickProvider = async (
    card: QuickProviderCard,
    mode: 'account' | 'key'
  ): Promise<void> => {
    if (card.kindKey === 'custom') {
      onAdvanced?.()
      return
    }

    const kindKey = mode === 'account' ? card.subscriptionKind : card.kindKey
    if (!kindKey) return

    const nextValue = {
      ...createEmptyProviderFormValue(providerKindPatch(kindKey)),
      key: mode === 'key' ? (quickKeys[card.id] ?? '') : '',
      providerFormTouched: true
    }
    setQuickCardId(card.id)
    setQuickMode(mode === 'key' ? 'key' : undefined)
    setFormValue(nextValue)
    if (mode !== 'account') return

    // Quick setup chooses the provider first, so resolve its subscription runtime before login.
    setIsSaving(true)
    setValidationMessage(undefined)
    try {
      const settings = useSettingsStore.getState()
      const targetFramework =
        card.subscriptionKind === 'claude-subscription'
          ? 'claude-code'
          : card.subscriptionKind === 'codex-subscription' &&
              settings.agentFrameworkId !== 'open-science-agent'
            ? 'codex'
            : settings.agentFrameworkId
      if (targetFramework !== settings.agentFrameworkId) {
        await settings.setAgentFramework(targetFramework)
      }
      if (mounted.current) await handleSaveProvider(nextValue)
    } catch (error) {
      if (!mounted.current) return
      setValidationOk(false)
      setValidationMessage(
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save provider.')
      )
    } finally {
      setIsSaving(false)
    }
  }

  const handleQuickKeyChange = (card: QuickProviderCard, key: string): void => {
    setQuickKeys((current) => ({ ...current, [card.id]: key }))
    setQuickCardId(card.id)
    setQuickMode('key')
    const nextValue = {
      ...createEmptyProviderFormValue(providerKindPatch(card.kindKey)),
      key,
      providerFormTouched: true
    }
    setFormValue(nextValue)
  }

  const handleQuickKeySubmit = (card: QuickProviderCard): void => {
    if (isSaving) return
    setQuickCardId(card.id)
    const nextValue = {
      ...createEmptyProviderFormValue(providerKindPatch(card.kindKey)),
      key: quickKeys[card.id] ?? '',
      providerFormTouched: true
    }
    setFormValue(nextValue)
    void handleSaveProvider(nextValue)
  }

  if (variant === 'quick') {
    return (
      <section className="onboarding-quick-connect" data-onboarding-entry="connect">
        <header className="onboarding-quick-header">
          <div>
            <h1>{t('Bring the AI you already use.')}</h1>
            <p>{t('Connect an account to start your research in Open-Science.')}</p>
            <p className="onboarding-provider-count">
              {t(
                '{{providerCount}} provider presets plus custom gateways are available in Open-Science.',
                { providerCount: OFFICIAL_VENDORS.length }
              )}
            </p>
          </div>
          <div className="onboarding-step-dots" aria-label={t('Step 2 of 3')}>
            <span />
            <span className="is-active" />
            <span />
          </div>
        </header>

        <div className="onboarding-provider-viewport">
          <div className="onboarding-provider-track">
            {QUICK_PROVIDER_CARDS.map((card) => {
              const isKeyMode = quickCardId === card.id && quickMode === 'key'
              const subscriptionAvailable = Boolean(card.subscriptionKind)
              const showKeyForm = isKeyMode || (card.id !== 'more' && !subscriptionAvailable)

              return (
                <article
                  key={card.id}
                  className={cn(
                    'onboarding-provider-card',
                    `onboarding-provider-card-${card.id}`,
                    isKeyMode && 'is-key-mode'
                  )}
                  style={{ '--provider-accent': card.accent } as React.CSSProperties}
                  onMouseEnter={() => setHoveredQuickCardId(card.id)}
                  onMouseLeave={() => setHoveredQuickCardId(undefined)}
                >
                  <ProviderSilkBackground
                    color={card.accent}
                    active={hoveredQuickCardId === card.id}
                  />
                  <div className="onboarding-provider-card-body">
                    <ProviderKindIcon kindKey={card.kindKey} className="size-9" />
                    <h2>{card.id === 'more' ? t('Custom Gateway') : card.title}</h2>
                    <p>{t(card.description)}</p>
                  </div>
                  <div className="onboarding-provider-card-actions">
                    {showKeyForm ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          handleQuickKeySubmit(card)
                        }}
                        className="onboarding-provider-key-form"
                      >
                        <label htmlFor={`onboarding-key-${card.id}`}>{t('API key')}</label>
                        <div className="onboarding-provider-key-row">
                          <input
                            id={`onboarding-key-${card.id}`}
                            type="password"
                            value={quickKeys[card.id] ?? ''}
                            disabled={isSaving}
                            onChange={(event) => handleQuickKeyChange(card, event.target.value)}
                            placeholder={t('Enter your API key')}
                            autoComplete="off"
                            required
                          />
                          <Button
                            type="submit"
                            size="icon"
                            aria-label={t('Test connection and connect')}
                            title={t('Test connection and connect')}
                            disabled={isSaving}
                          >
                            <Zap aria-hidden="true" />
                          </Button>
                        </div>
                        {quickCardId === card.id && showProviderErrors && formErrors.key ? (
                          <p className="text-xs text-destructive">{t(formErrors.key)}</p>
                        ) : null}
                        {subscriptionAvailable ? (
                          <button
                            type="button"
                            className="onboarding-provider-card-link"
                            onClick={() => {
                              setQuickMode(undefined)
                              setQuickCardId(undefined)
                            }}
                          >
                            {t('Use an account instead')}
                          </button>
                        ) : null}
                      </form>
                    ) : (
                      <>
                        {subscriptionAvailable ? <small>{t(card.subscription)}</small> : null}
                        {subscriptionAvailable ? (
                          <Button
                            type="button"
                            onClick={() => void chooseQuickProvider(card, 'account')}
                            disabled={isSaving}
                            className="w-full"
                          >
                            {t('Continue with {{provider}}', { provider: card.title })}
                          </Button>
                        ) : null}
                        <button
                          type="button"
                          className="onboarding-provider-card-link"
                          onClick={() => void chooseQuickProvider(card, 'key')}
                          disabled={isSaving}
                        >
                          {t('Have an API key?')}
                        </button>
                      </>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        {validationMessage ? (
          <p className={cn('onboarding-provider-validation', validationOk && 'is-ok')} role="alert">
            {validationMessage}
          </p>
        ) : null}

        <footer className="onboarding-quick-footer">
          <Button type="button" variant="ghost" onClick={onBack} disabled={isSaving}>
            {t('Back', { context: 'step' })}
          </Button>
          <div>
            <Button
              type="button"
              variant="ghost"
              data-onboarding-action="skip"
              onClick={onSkip}
              disabled={isSaving || isSkipping}
            >
              <span aria-hidden="true">↗</span>
              {t('Skip for now, explore first')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-onboarding-action="advanced"
              onClick={onAdvanced}
              disabled={isSaving || isSkipping}
            >
              <Settings2 aria-hidden="true" />
              {t('Advanced options')}
            </Button>
          </div>
          {skipError ? (
            <p className="onboarding-provider-skip-error" role="alert">
              {skipError}
            </p>
          ) : null}
        </footer>
        <ClaudeIsolatedSignInModal
          open={isClaudeSignInOpen}
          onOpenChange={setIsClaudeSignInOpen}
          onSubmit={handleClaudeTokenFallback}
          browserSignInPending={isSaving && isClaudeSignInOpen}
        />
        <XaiOAuthSignInDialog
          open={Boolean(xaiSession)}
          session={xaiSession}
          error={validationMessage}
          onCancel={() => {
            xaiLoginCancelledRef.current = true
            setXaiSession(undefined)
            void cancelXaiOAuthLogin()
          }}
        />
      </section>
    )
  }

  return (
    <>
      <CardHeader className="onboarding-advanced-model-header gap-1 rounded-t-lg px-6 py-5">
        <h2 tabIndex={-1} className="text-[15px] font-semibold">
          {t('Connect a model')}
        </h2>
        <CardDescription className="text-xs leading-5">
          {t(
            'Choose your provider. Use Custom Gateway for a compatible endpoint or a local model server.'
          )}
        </CardDescription>
        <p className="text-xs leading-5 text-muted-foreground">
          {t(
            'Connect and test a model to finish setup. The agent needs this connection to respond to your requests.'
          )}
        </p>
      </CardHeader>
      <Separator className="bg-border-200" />

      <CardContent className="onboarding-advanced-model-content flex-1 px-6 py-5">
        <section aria-label={t('Configure model')}>
          {!encryptionAvailable ? (
            <ErrorNotice
              inline
              className="mb-4"
              tone="amber"
              description={t(
                'Secure key storage is unavailable. API keys cannot be saved until the system keychain is unlocked or authorized.'
              )}
            />
          ) : null}
          <ProviderForm
            key={savedProviderId ?? 'new-provider'}
            value={formValue}
            onChange={(patch) =>
              setFormValue((current) => ({ ...current, ...patch, providerFormTouched: true }))
            }
            errors={showProviderErrors ? formErrors : undefined}
            disabled={isSaving}
            encryptionAvailable={encryptionAvailable}
            showCodexSubscriptions={
              agentFrameworkId === 'codex' || agentFrameworkId === 'open-science-agent'
            }
            showClaudeIsolated={agentFrameworkId === 'claude-code'}
            defaultCustomApiEndpoint={customApiEndpoint}
            framework={activeFramework}
          />
          {formValue.type === 'claude-isolated' ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {t(
                "Sign in with your browser to connect your Claude subscription. We'll open Claude in your browser to authorize, then bring you right back."
              )}
            </p>
          ) : null}
          {validationMessage ? (
            <p
              className={`mt-4 text-sm ${validationOk ? 'text-primary' : 'text-destructive'}`}
              role="alert"
            >
              {validationMessage}
            </p>
          ) : null}
        </section>
      </CardContent>
      {children}
      <CardFooter className="onboarding-advanced-model-footer sticky bottom-0 z-10 mt-auto flex-wrap justify-end gap-2 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        {!canContinue ? (
          <p className="mr-auto text-xs text-text-100">
            {t('Complete every required item above to continue.')}
          </p>
        ) : null}
        {isSaving && formValue.type === 'codex-isolated' ? (
          <Button type="button" variant="outline" onClick={() => void cancelCodexLogin()}>
            {t('Cancel sign-in')}
          </Button>
        ) : isSaving && formValue.type === 'claude-isolated' ? (
          <Button type="button" variant="outline" onClick={() => void cancelIsolatedClaudeLogin()}>
            {t('Cancel sign-in')}
          </Button>
        ) : isSaving && formValue.type === 'claude-shared' ? (
          <Button type="button" variant="outline" onClick={() => void cancelSharedClaudeLogin()}>
            {t('Cancel sign-in')}
          </Button>
        ) : isSaving && formValue.type === 'xai-subscription' ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              xaiLoginCancelledRef.current = true
              setXaiSession(undefined)
              void cancelXaiOAuthLogin()
            }}
          >
            {t('Cancel sign-in')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              mounted.current = false
              onBack()
            }}
          >
            {t('Back', { context: 'step' })}
          </Button>
        )}
        <Button
          type="button"
          onClick={() => void handleSaveProvider()}
          disabled={isSaving || !canContinue}
          className="px-4"
          aria-busy={Boolean(isSaving)}
        >
          <span key={String(isSaving)} className="button-feedback">
            {isSaving
              ? isBrowserSignInProvider(formValue.type)
                ? t('Waiting for sign-in…')
                : t('Testing connection…')
              : isBrowserSignInProvider(formValue.type)
                ? t('Sign in & continue')
                : t('Test & continue')}
          </span>
        </Button>
      </CardFooter>
      <ClaudeIsolatedSignInModal
        open={isClaudeSignInOpen}
        onOpenChange={setIsClaudeSignInOpen}
        onSubmit={handleClaudeTokenFallback}
        browserSignInPending={isSaving && isClaudeSignInOpen}
      />
      <XaiOAuthSignInDialog
        open={Boolean(xaiSession)}
        session={xaiSession}
        error={validationMessage}
        onCancel={() => {
          xaiLoginCancelledRef.current = true
          setXaiSession(undefined)
          void cancelXaiOAuthLogin()
        }}
      />
    </>
  )
}

export { ProviderStep }
