import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, Settings2, X, Zap } from 'lucide-react'
import { OFFICIAL_VENDORS, type OfficialVendorId } from '@aipoch/providers'

import { isSupportedClaudeCliVersion } from '../../../../shared/claude-runtime'
import { describeInstallProgress } from '../settings/claude-install-progress'
import { Button } from '@/components/ui/button'
import { ProviderSilkBackground } from '@/components/react-bits/ProviderSilkBackground'
import { ErrorNotice } from '@/components/error-notice'
import { CardContent, CardDescription, CardFooter, CardHeader } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type {
  ClaudeInstallResult,
  UpsertProviderRequest,
  ValidateProviderResult,
  XaiOAuthDeviceAuthorization
} from '../../../../shared/settings'
import { CODEX_IMPORT_FILE_MISSING_MESSAGE } from '../../../../shared/codex-runtime'
import { unwrapIpcErrorDetail } from '../../../../shared/failure/messages'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  isCodexSubscriptionProvider,
  isProviderUsableByFramework
} from '../../../../shared/settings-runtime'
import { clsx } from 'clsx'
import {
  selectActiveAgentFramework,
  selectFrameworkApiEndpoints,
  useSettingsStore
} from '@/stores/settings-store'
import { ClaudeIsolatedSignInModal } from '../settings/ClaudeIsolatedSignInModal'
import { ProviderForm, type CodexAuthMode } from '../settings/ProviderForm'
import { isDesktopRenderer } from '@/lib/interface-scale'
import {
  codeBuddyAccounts,
  WORKBUDDY_PROFILE_MESSAGE,
  type CodeBuddySite
} from '../../../../shared/codebuddy-subscription'
import { ProviderKindPicker } from '../settings/ProviderKindPicker'
import { ProviderKindIcon } from '../settings/provider-icons'
import { XaiOAuthSignInDialog } from '../settings/XaiOAuthSignInDialog'
import {
  createEmptyProviderFormValue,
  defaultCustomApiEndpoint,
  defaultProviderKindKey,
  providerKindAvailability,
  isProviderKindAvailable,
  PROVIDER_KINDS,
  selectedKindKey,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerFormApiEndpoints,
  providerFormLocalModels,
  providerFormManualModels,
  providerFormModel,
  providerFormModelForFramework,
  providerFormTokenLimits,
  providerKindPatch,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { onboardingErrorMessage } from './onboarding-error'
import { OnboardingErrorNotice, type OnboardingFailure } from './OnboardingErrorNotice'
import {
  CATEGORY_KEYS,
  describeValidation,
  localizeProviderResourceMessage
} from '../settings/validation-message'
import { mergeLocalModels } from '../settings/provider-model-form'
import { modelCatalogErrorMessage } from '../settings/model-catalog-feedback'
import type { ProviderStepOperation } from './use-provider-step-operation'

const isBrowserSignInProvider = (type: ProviderFormValue['type']): boolean =>
  type === 'codex-isolated' ||
  type === 'claude-isolated' ||
  type === 'claude-shared' ||
  type === 'xai-subscription' ||
  type === 'codebuddy-subscription'

// Converts a form value into the upsert request the main process expects.
const toUpsertRequest = (value: ProviderFormValue, id?: string): UpsertProviderRequest => ({
  ...(id ? { id, requireExisting: true } : {}),
  type: value.type,
  codexTransport: value.codexTransport,
  name: value.name,
  baseUrl: value.baseUrl,
  model: providerFormModel(value),
  localModels: providerFormLocalModels(value),
  manualModels: providerFormManualModels(value),
  ...providerFormTokenLimits(value),
  vendorId: value.vendorId,
  region: value.region,
  cloudflare: value.cloudflare,
  manualConnection: value.manualConnection,
  localPresetId: value.type === 'custom' ? (value.localPresetId ?? null) : undefined,
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
  onAdvance: () => void
  variant?: 'form' | 'quick'
  picker?: { kind?: string; select: (kind?: string) => void }
  canContinue?: boolean
  onAdvanced?: (kind?: string) => void
  onSkip?: () => void | Promise<void>
  skipError?: OnboardingFailure & { onDismiss: () => void }
  operation: ProviderStepOperation
}

const providerLinkClass =
  'mx-auto mt-[0.55rem] block text-[0.72rem] text-text-200 underline underline-offset-[0.2rem] hover:text-text-000'

const quickNoticeClass =
  'rounded-md border border-[color-mix(in_oklab,var(--warning-ink)_28%,var(--border))] bg-[color-mix(in_oklab,var(--warning-ink)_8%,var(--card))] px-3 py-2 [--warning-ink:var(--color-status-warning-foreground)] dark:[--warning-ink:var(--color-status-warning-dark-foreground)]'

type QuickProviderCard = {
  id: string
  kindKey: string
  subscriptionKind?: string
  title: string
  description?: string
  requiresConnectionConfiguration?: boolean
  subscriptionLabel?: (t: TFunction) => string
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
    Pick<QuickProviderCard, 'subscriptionKind' | 'description' | 'subscriptionLabel'>
  >
> = {
  openai: {
    subscriptionKind: 'codex-subscription',
    description: 'Use an existing Codex profile or sign in with a separate Open-Science profile.',
    subscriptionLabel: (t) => t('Use your eligible ChatGPT subscription')
  },
  anthropic: {
    subscriptionKind: 'claude-subscription',
    description:
      'Quick sign-in uses your shared Claude CLI profile. For a separate profile, use Advanced options.',
    subscriptionLabel: (t) => t('Use your eligible Claude subscription')
  },
  xai: {
    subscriptionKind: 'xai-subscription',
    description: 'Sign in to your xAI subscription with a browser device code.',
    subscriptionLabel: (t) => t('Sign in with your xAI account')
  }
}

const bundledModelCount = new Set(
  OFFICIAL_VENDORS.flatMap((vendor) => vendor.models.map((model) => model.id))
).size

const QUICK_PROVIDER_CARDS: QuickProviderCard[] = [
  ...OFFICIAL_VENDORS.map((vendor) => ({
    id: vendor.id,
    kindKey: `official:${vendor.id}`,
    title: vendor.label,
    description: vendor.requiresConnectionConfiguration ? undefined : 'API key — models provided',
    requiresConnectionConfiguration: vendor.requiresConnectionConfiguration,
    accent: PROVIDER_ACCENTS[vendor.id] ?? '#dce3ea',
    ...QUICK_SUBSCRIPTIONS[vendor.id]
  })),
  {
    id: 'more',
    kindKey: 'custom',
    title: 'Custom Gateway',
    description: 'Use a compatible endpoint or connect another model provider.',
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
  picker,
  canContinue = true,
  onAdvanced,
  onSkip,
  skipError,
  operation
}: ProviderStepProps): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  // Validation copy is shared with the settings page and lives in the `settings` namespace, so this
  // step holds a second, settings-scoped t for describeValidation.
  const { t: tSettings } = useTranslation()
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const frameworkEndpoints = useSettingsStore(selectFrameworkApiEndpoints)
  const providers = useSettingsStore((state) => state.providers)
  const availability = providerKindAvailability(agentFrameworkId, providers, isDesktopRenderer())
  const currentKindKey = selectedKindKey(formValue)
  const pickedKind = picker?.kind && PROVIDER_KINDS.find((kind) => kind.key === picker.kind)
  const showPicker =
    !!picker &&
    (!picker.kind ||
      picker.kind !== currentKindKey ||
      (!!pickedKind && !isProviderKindAvailable(pickedKind, availability)))
  const modelHeading = useRef<HTMLHeadingElement>(null)
  const wasShowingPicker = useRef(showPicker)
  useEffect(() => {
    if (wasShowingPicker.current && !showPicker) modelHeading.current?.focus()
    wasShowingPicker.current = showPicker
  }, [showPicker])
  const codeBuddyLogin = useRef<CodeBuddySite | undefined>(undefined)
  const codeBuddyAccount = useSettingsStore((state) => state.codeBuddyAccount)
  const cancelCodeBuddy = (): void => {
    const site = codeBuddyLogin.current
    if (site) {
      codeBuddyLogin.current = undefined
      void codeBuddyAccount({ site, action: 'cancel' }).catch(() => undefined)
    }
  }
  const activeModel = useSettingsStore((state) => state.activeModel)
  const existingProvider = useSettingsStore((state) =>
    state.providers.find((provider) => provider.id === state.activeProviderId)
  )
  const encryptionAvailable = useSettingsStore((state) => state.encryptionAvailable)
  const saveAndActivateProvider = useSettingsStore((state) => state.saveAndActivateProvider)
  const refreshProviderModels = useSettingsStore((state) => state.refreshProviderModels)
  const addOnboardingKiloProvider = useSettingsStore((state) => state.addOnboardingKiloProvider)
  const existingKiloId = useSettingsStore(
    (state) =>
      state.providers.find(({ type, vendorId }) => type === 'official' && vendorId === 'kilo')?.id
  )
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

  const [authStage, setAuthStage] = useState<'detect' | 'install' | 'auth'>()
  const [installError, setInstallError] = useState<{
    cardId: 'openai' | 'anthropic'
    retryMode?: CodexAuthMode
    failure: OnboardingFailure
  }>()
  const [quickCardId, setQuickCardId] = useState<string>()
  const progress = useSettingsStore(
    (state) =>
      state.installStates[quickCardId === 'openai' ? 'codex' : 'claude-code'].installProgress
  )
  const preparingCodex = quickCardId === 'openai' && authStage === 'detect'
  const installing = authStage === 'install' || (preparingCodex && Boolean(progress))
  const installProgress = installing && progress ? describeInstallProgress(progress, t) : undefined
  const pendingInstall = useRef<
    { id: string; cancel: (id: string) => Promise<void>; settled: Promise<unknown> } | undefined
  >(undefined)
  const [isSaving, setIsSaving] = useState(false)
  const [isSkipping, setIsSkipping] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const [catalogError, setCatalogError] = useState<string>()
  const busy = operation.pending
  const quickBusy = busy || isSaving
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const advanceIfMounted = (): void => {
    if (mounted.current) onAdvance()
  }
  const [isClaudeSignInOpen, setIsClaudeSignInOpen] = useState(false)
  const [xaiSession, setXaiSession] = useState<XaiOAuthDeviceAuthorization>()
  const claudeProviderIdRef = useRef<string | undefined>(undefined)
  const manualClaudePasteWonRef = useRef(false)
  // Required-field errors stay hidden until the user first tries to submit, so an untouched form is
  // not littered with "required" messages. A `*` on each label signals the requirement up front.
  const [showProviderErrors, setShowProviderErrors] = useState(false)
  const [feedback, setValidationMessage] = useState<string | OnboardingFailure>()
  const validationMessage = typeof feedback === 'object' ? feedback.summary : feedback
  const codexImportFailure = (cause: unknown): OnboardingFailure => {
    const details = onboardingErrorMessage(cause, 'codex-shared')
    const signIn = t('Sign in with Open-Science')
    const summary =
      unwrapIpcErrorDetail(details) === CODEX_IMPORT_FILE_MISSING_MESSAGE
        ? t(
            'No Codex sign-in file was found to import. Choose “{{signIn}}” to connect the same account.',
            { signIn }
          )
        : t(
            'Your Codex sign-in could not be imported. Try again or choose “{{signIn}}” to connect your account.',
            { signIn }
          )
    return { summary, details }
  }
  const validationFeedback = (
    result: ValidateProviderResult,
    signInFailure?: string
  ): string | OnboardingFailure => {
    if (variant !== 'quick' || result.ok) return describeValidation(result, tSettings)
    const details = [result.category, result.status && `HTTP ${result.status}`, result.message]
      .filter(Boolean)
      .join('\n')
    return {
      summary:
        (result.category === 'auth' && signInFailure) || tSettings(CATEGORY_KEYS[result.category]),
      details
    }
  }
  const [validationOk, setValidationOk] = useState(false)
  const [hoveredQuickCardId, setHoveredQuickCardId] = useState<string>()
  const [quickMode, setQuickMode] = useState<'key' | undefined>()
  const [quickKeys, setQuickKeys] = useState<Record<string, string>>(() =>
    formValue.type === 'official' && formValue.vendorId
      ? { [formValue.vendorId]: formValue.key }
      : {}
  )
  const customApiEndpoint = defaultCustomApiEndpoint(frameworkEndpoints)
  const activeFramework = useSettingsStore(selectActiveAgentFramework)
  const canReuseExistingProvider =
    !formValue.providerFormTouched &&
    existingProvider !== undefined &&
    existingProvider.lastValidatedAt !== undefined &&
    existingProvider.lastValidationFailure === undefined &&
    !existingProvider.needsKey &&
    isProviderUsableByFramework(
      { apiEndpoints: existingProvider.apiEndpoints, type: existingProvider.type },
      { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
    )
  // Mirrors the Settings teardown: a pending isolated sign-in lives in the main process for up to
  // five minutes, and its guard rejects a second attempt as "already in progress". If the wizard
  // unmounts mid-flow (app quit, relaunch, forced navigation), cancel it so the next attempt starts
  // clean. The ref is written only from event handlers/effects, never during render.
  const quickAuth = useRef<AbortController | undefined>(undefined)
  const codexLoginPendingRef = useRef(false)
  const claudeLoginPendingRef = useRef(false)
  const claudeSharedLoginPendingRef = useRef(false)
  const xaiLoginPendingRef = useRef(false)
  const xaiLoginCancelledRef = useRef(false)

  useEffect(
    () => () => {
      if (codeBuddyLogin.current)
        void codeBuddyAccount({ site: codeBuddyLogin.current, action: 'cancel' }).catch(
          () => undefined
        )
      quickAuth.current?.abort()
      if (pendingInstall.current) void pendingInstall.current.cancel(pendingInstall.current.id)
      if (codexLoginPendingRef.current) void cancelCodexLogin()
      if (claudeLoginPendingRef.current) void cancelIsolatedClaudeLogin()
      if (claudeSharedLoginPendingRef.current) void cancelSharedClaudeLogin()
      if (xaiLoginPendingRef.current) void cancelXaiOAuthLogin()
    },
    [
      cancelCodexLogin,
      cancelIsolatedClaudeLogin,
      cancelSharedClaudeLogin,
      cancelXaiOAuthLogin,
      codeBuddyAccount
    ]
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

  const handleRefreshModels = async (): Promise<void> => {
    if (!operation.begin()) return
    setIsRefreshingModels(true)
    setCatalogError(undefined)
    try {
      const result = await refreshProviderModels({ draft: toUpsertRequest(formValue) })
      if (!mounted.current) return
      if (!result.ok) {
        setCatalogError(modelCatalogErrorMessage(result.code, t))
        return
      }
      setFormValue((current) => ({
        ...current,
        localModels: mergeLocalModels(current.localModels ?? [], result.models ?? [])
      }))
    } catch {
      if (mounted.current) setCatalogError(modelCatalogErrorMessage(undefined, t))
    } finally {
      operation.finish()
      if (mounted.current) setIsRefreshingModels(false)
    }
  }

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
      setValidationMessage(validationFeedback(result, t('Could not sign in to Claude. Try again.')))

      if (result.ok) {
        if (claudeProviderIdRef.current) {
          await setActiveProvider(claudeProviderIdRef.current)
        }
        setIsClaudeSignInOpen(false)
        advanceIfMounted()
      }

      return result
    } catch (error) {
      const message =
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save the Claude token.')
      setValidationOk(false)
      setValidationMessage(
        variant === 'quick'
          ? { summary: t('Could not save the Claude token.'), details: message }
          : message
      )
      return { ok: false, category: 'unknown', message }
    }
  }

  const handleSkip = async (): Promise<void> => {
    if (!operation.begin()) return
    setIsSkipping(true)
    setValidationMessage(undefined)
    try {
      if (canReuseExistingProvider) {
        advanceIfMounted()
        return
      }
      await addOnboardingKiloProvider()
      advanceIfMounted()
    } catch (error) {
      if (!mounted.current) return
      setValidationOk(false)
      setValidationMessage(
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save provider.')
      )
    } finally {
      operation.finish()
      setIsSkipping(false)
    }
  }

  const handleSaveProvider = async (
    valueOverride?: ProviderFormValue,
    signal?: AbortSignal
  ): Promise<void> => {
    if (!canContinue) return
    const value = valueOverride ?? formValue
    const valueFormErrors = getProviderFormErrors(value)
    // First submit attempt surfaces any missing required fields instead of testing an incomplete draft.
    if (hasProviderFormErrors(valueFormErrors)) {
      setShowProviderErrors(true)
      return
    }

    // Quick authorization already owns the operation while preparing its runtime.
    if (!signal && !operation.begin()) return
    setIsSaving(true)
    setValidationMessage(undefined)

    try {
      if (variant === 'quick') {
        // Claude prepares and selects its own runtime in connectQuickClaude.
        const settings = useSettingsStore.getState()
        const target = isCodexSubscriptionProvider(value.type)
          ? 'codex'
          : DEFAULT_AGENT_FRAMEWORK_ID
        if (settings.agentFrameworkId !== target) {
          if (isCodexSubscriptionProvider(value.type)) {
            await settings.setAgentFramework(target, { runtimeAlreadyDetected: true })
          } else {
            await settings.setAgentFramework(target)
          }
          if (!mounted.current || signal?.aborted) return
        }
      }
      const currentSettings = useSettingsStore.getState()
      const currentFrameworkEndpoints = selectFrameworkApiEndpoints(currentSettings)
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

      if (value.type === 'codebuddy-subscription' && value.codeBuddySite) {
        const site = value.codeBuddySite
        const mode = value.codeBuddyAuthMode ?? 'isolated'
        codeBuddyLogin.current = site
        const result = await codeBuddyAccount({ action: 'login', site, mode })
        if (!mounted.current || codeBuddyLogin.current !== site) return
        if (!result.ok) {
          setValidationOk(false)
          setValidationMessage(
            result.message === WORKBUDDY_PROFILE_MESSAGE
              ? t('WorkBuddy profile found. Sign in to the selected site in CodeBuddy CLI.')
              : mode === 'shared' && result.category === 'auth'
                ? t('Sign in to the selected site in CodeBuddy CLI.')
                : t('CodeBuddy account request failed.')
          )
          return
        }
        const id = codeBuddyAccounts[site].id
        await setActiveProvider(id)
        if (!mounted.current || codeBuddyLogin.current !== site) return
        onProviderSaved?.(id)
        advanceIfMounted()
        return
      }

      if (value.type === 'codex-isolated') {
        // Isolated sign-in is explicit: persist the provider first, then run the browser login.
        // Persisting alone never pops a browser; a cancelled login keeps the provider saved but
        // unverified, so the user can retry without re-entering anything.
        const providerId = await persistProvider(toUpsertRequest(value))
        signal?.throwIfAborted()
        // Arm the unmount teardown for exactly the duration of the main-process login.
        codexLoginPendingRef.current = true
        const validation = await loginIsolatedCodex().finally(() => {
          if (!signal?.aborted) codexLoginPendingRef.current = false
        })
        signal?.throwIfAborted()

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
        setValidationMessage(validationFeedback(validation, t('Could not sign in to Codex.')))

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          signal?.throwIfAborted()
          advanceIfMounted()
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
        setValidationMessage(
          validationFeedback(validation, t('Could not sign in to Claude. Try again.'))
        )

        if (validation.ok) {
          setIsClaudeSignInOpen(false)
          if (providerId) await setActiveProvider(providerId)
          advanceIfMounted()
        }
        return
      }

      if (value.type === 'claude-shared') {
        const providerId = await persistProvider(toUpsertRequest(value))
        signal?.throwIfAborted()
        claudeSharedLoginPendingRef.current = true
        const validation = await loginSharedClaude().finally(() => {
          if (!signal?.aborted) claudeSharedLoginPendingRef.current = false
        })
        signal?.throwIfAborted()

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
        setValidationMessage(
          validationFeedback(validation, t('Could not sign in to Claude. Try again.'))
        )

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          signal?.throwIfAborted()
          advanceIfMounted()
        }
        return
      }

      if (value.type === 'xai-subscription') {
        const providerId = await persistProvider(toUpsertRequest(value))
        signal?.throwIfAborted()
        xaiLoginCancelledRef.current = false
        xaiLoginPendingRef.current = true
        let validation: ValidateProviderResult
        try {
          const session = await beginXaiOAuthLogin()
          signal?.throwIfAborted()
          if (xaiLoginCancelledRef.current) return
          setXaiSession(session)
          ;({ validation } = await waitXaiOAuthLogin())
        } finally {
          if (!signal?.aborted) {
            xaiLoginPendingRef.current = false
            setXaiSession(undefined)
          }
        }
        signal?.throwIfAborted()
        if (xaiLoginCancelledRef.current) return
        if (validation.applied === false) {
          setValidationOk(false)
          setValidationMessage(t('The provider changed during testing. Try again.'))
          return
        }
        setValidationOk(validation.ok)
        setValidationMessage(validationFeedback(validation, t('Could not sign in to xAI.')))
        if (validation.ok) {
          await setActiveProvider(providerId)
          signal?.throwIfAborted()
          advanceIfMounted()
        }
        return
      }

      const isKilo = providerValue.type === 'official' && providerValue.vendorId === 'kilo'
      const request = toUpsertRequest(
        providerValue,
        (isKilo ? existingKiloId : undefined) ?? savedProviderId
      )
      const quickKey = variant === 'quick' && value.type === 'official'
      const explicitImport = variant === 'quick' && value.type === 'codex-shared'
      const { providerId, validation } = quickKey
        ? await currentSettings.saveValidatedProvider(request)
        : explicitImport
          ? await currentSettings.saveProvider({ ...request, reimportCodexAuthentication: true })
          : await saveAndActivateProvider(request)
      signal?.throwIfAborted()
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
      setValidationMessage(
        variant === 'quick' && value.type === 'codex-shared' && !validation.ok
          ? codexImportFailure(validation.message)
          : validationFeedback(validation)
      )

      if (validation.ok) {
        if ((quickKey || explicitImport) && providerId)
          await setActiveProvider(providerId, providerValue.model || undefined)
        signal?.throwIfAborted()
        advanceIfMounted()
      }
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof Error && error.message === 'Provider no longer exists.') {
        onProviderSaved?.(undefined)
      }
      if (!mounted.current) return
      if (value.type === 'xai-subscription' && xaiLoginCancelledRef.current) return
      setValidationOk(false)
      if (variant === 'quick' && value.type === 'codex-shared') {
        setValidationMessage(codexImportFailure(error))
        return
      }
      if (variant === 'quick') {
        const details = onboardingErrorMessage(error, value.type)
        let summary = t('Could not save provider.')
        if (value.type === 'codex-isolated') summary = t('Could not sign in to Codex.')
        if (value.type === 'xai-subscription') {
          switch (unwrapIpcErrorDetail(details)) {
            case 'expired_token':
              summary = t('Authorization expired')
              break
            case 'access_denied':
            case 'xAI sign-in was denied.':
              summary = t('Permission denied')
              break
            default:
              summary = t('Could not sign in to xAI.')
          }
        }
        setValidationMessage({ summary, details })
      } else {
        setValidationMessage(
          error instanceof Error
            ? localizeProviderResourceMessage(error.message, tSettings)
            : t('Could not save provider.')
        )
      }
    } finally {
      codeBuddyLogin.current = undefined
      if (!signal) {
        operation.finish()
        setIsSaving(false)
      }
    }
  }

  const prepareQuickRuntime = async (
    target: 'anthropic' | CodexAuthMode,
    signal: AbortSignal,
    prepare: (id: string) => Promise<ClaudeInstallResult>,
    cancel: (id: string) => Promise<void>,
    failureMessage: string
  ): Promise<void> => {
    signal.throwIfAborted()
    const id = crypto.randomUUID()
    const operation = prepare(id)
    pendingInstall.current = { id, cancel, settled: operation }
    try {
      const result = await operation
      signal.throwIfAborted()
      if (!result.ok) throw new Error(result.error || failureMessage)
    } catch (error) {
      if (!signal.aborted) {
        const cardId = target === 'anthropic' ? 'anthropic' : 'openai'
        setInstallError({
          cardId,
          retryMode: target === 'anthropic' ? undefined : target,
          failure: { summary: failureMessage, details: onboardingErrorMessage(error, cardId) }
        })
      }
      throw error
    } finally {
      if (pendingInstall.current?.id === id) pendingInstall.current = undefined
    }
  }

  // Use the shared CLI profile for both OAuth and ACP. Only a local launch failure can
  // retry via installation; an OAuth rejection or failed subscription probe must stay visible.
  const connectQuickClaude = async (
    value: ProviderFormValue,
    signal: AbortSignal
  ): Promise<void> => {
    const settings = useSettingsStore.getState()
    setAuthStage('detect')
    let installed = false
    const install = async (): Promise<void> => {
      signal.throwIfAborted()
      installed = true
      setAuthStage('install')
      await prepareQuickRuntime(
        'anthropic',
        signal,
        (id) => settings.installClaude('managed', undefined, id),
        cancelSharedClaudeLogin,
        t('Could not install Claude Code. Try again.')
      )
    }
    const detected = await settings.detectClaude()
    signal.throwIfAborted()
    // detectClaude also refreshes preflight, which checks the ACP adapter alongside the CLI.
    if (
      !detected.found ||
      !detected.path ||
      !isSupportedClaudeCliVersion(detected.version) ||
      !useSettingsStore.getState().preflight.claudeReady
    )
      await install()
    signal.throwIfAborted()
    if (useSettingsStore.getState().agentFrameworkId !== 'claude-code') {
      await settings.setAgentFramework('claude-code', { runtimeAlreadyDetected: true })
      signal.throwIfAborted()
    }
    const providerId = await persistProvider(toUpsertRequest(value))
    signal.throwIfAborted()
    const signIn = async (): Promise<ValidateProviderResult> => {
      setAuthStage('auth')
      claudeSharedLoginPendingRef.current = true
      try {
        return await loginSharedClaude()
      } finally {
        if (!signal.aborted) claudeSharedLoginPendingRef.current = false
      }
    }
    let validation = await signIn()
    signal.throwIfAborted()
    if (
      !installed &&
      !validation.cancelled &&
      validation.applied !== false &&
      validation.cliLaunchFailed
    ) {
      await install()
      signal.throwIfAborted()
      validation = await signIn()
      signal.throwIfAborted()
    }
    if (validation.cancelled) return
    if (validation.applied === false) {
      setValidationOk(false)
      setValidationMessage(
        t('The Claude provider changed during sign-in. Review the selection and try again.')
      )
      return
    }
    if (!validation.ok) {
      setValidationOk(false)
      setValidationMessage(
        validationFeedback(validation, t('Could not sign in to Claude. Try again.'))
      )
      return
    }
    await setActiveProvider(providerId)
    signal.throwIfAborted()
    advanceIfMounted()
  }

  const openProviderConfiguration = (card: QuickProviderCard): void => {
    setFormValue({
      ...createEmptyProviderFormValue(
        providerKindPatch(card.kindKey, customApiEndpoint, activeFramework?.supportedApiTypes)
      ),
      providerFormTouched: true
    })
    onAdvanced?.(card.kindKey)
  }

  const chooseQuickProvider = async (
    card: QuickProviderCard,
    mode: 'account' | 'key' | CodexAuthMode
  ): Promise<void> => {
    if (quickBusy || quickAuth.current) return
    if (card.kindKey === 'custom') {
      openProviderConfiguration(card)
      return
    }

    const kindKey = mode === 'key' ? card.kindKey : card.subscriptionKind
    if (!kindKey || (mode !== 'key' && !operation.begin())) return

    const nextValue = {
      ...createEmptyProviderFormValue(providerKindPatch(kindKey)),
      ...(mode === 'codex-shared' || mode === 'codex-isolated' ? { type: mode } : {}),
      key: mode === 'key' ? (quickKeys[card.id] ?? '') : '',
      providerFormTouched: true
    }
    setInstallError(undefined)
    setQuickCardId(card.id)
    setQuickMode(mode === 'key' ? 'key' : undefined)
    setFormValue(nextValue)
    if (mode === 'key') return

    const attempt = new AbortController()
    quickAuth.current = attempt
    // Quick setup chooses the provider first, so resolve its subscription runtime before login.
    setIsSaving(true)
    setValidationMessage(undefined)
    try {
      if (card.subscriptionKind === 'claude-subscription') {
        await connectQuickClaude(nextValue, attempt.signal)
        return
      }
      const settings = useSettingsStore.getState()
      if (mode === 'codex-isolated' || mode === 'codex-shared') {
        setAuthStage('detect')
        await prepareQuickRuntime(
          mode,
          attempt.signal,
          (id) => settings.installCodex('managed', id),
          cancelCodexLogin,
          t('Could not prepare Codex. Try again.')
        )
        setAuthStage('auth')
      }
      if (mounted.current && !attempt.signal.aborted)
        await handleSaveProvider(nextValue, attempt.signal)
    } catch (error) {
      if (!mounted.current || attempt.signal.aborted) return
      if (mode === 'codex-shared') {
        setValidationOk(false)
        setValidationMessage(codexImportFailure(error))
        return
      }
      setValidationOk(false)
      setValidationMessage({
        summary:
          card.id === 'anthropic'
            ? t('Could not sign in to Claude. Try again.')
            : t('Could not sign in to Codex.'),
        details: onboardingErrorMessage(error, card.id)
      })
    } finally {
      if (quickAuth.current === attempt && (!attempt.signal.aborted || !mounted.current)) {
        quickAuth.current = undefined
        setAuthStage(undefined)
        operation.finish()
        setIsSaving(false)
      }
    }
  }

  const cancelQuickAuthorization = async (): Promise<void> => {
    const attempt = quickAuth.current
    if (!attempt || attempt.signal.aborted) return
    attempt.abort()
    try {
      const install = pendingInstall.current
      if (install) {
        await install.cancel(install.id)
        await install.settled.catch(() => undefined)
      } else if (codexLoginPendingRef.current) {
        codexLoginPendingRef.current = false
        await cancelCodexLogin()
      } else if (claudeSharedLoginPendingRef.current) {
        claudeSharedLoginPendingRef.current = false
        await cancelSharedClaudeLogin()
      } else if (xaiLoginPendingRef.current) {
        xaiLoginPendingRef.current = false
        setXaiSession(undefined)
        await cancelXaiOAuthLogin()
      }
    } catch (error) {
      setValidationOk(false)
      setValidationMessage({
        summary: t('Could not cancel. Try again.'),
        details: onboardingErrorMessage(error, 'cancelQuickAuthorization')
      })
    } finally {
      if (quickAuth.current === attempt) {
        quickAuth.current = undefined
        setAuthStage(undefined)
        operation.finish()
        setIsSaving(false)
      }
    }
  }

  const handleQuickKeyChange = (card: QuickProviderCard, key: string): void => {
    if (quickBusy) return
    if (installError) {
      setInstallError(undefined)
      setValidationMessage(undefined)
    }
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
    if (quickBusy) return
    setInstallError(undefined)
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
    const retryMode = installError?.retryMode
    const installCard = installError
      ? QUICK_PROVIDER_CARDS.find((card) => card.id === installError.cardId)
      : undefined
    return (
      <section
        className="flex max-h-[inherit] flex-col px-10 pt-8 pb-6 onboarding-narrow:px-[1.15rem] onboarding-narrow:pt-[1.35rem] onboarding-narrow:pb-[1.15rem]"
        data-onboarding-entry="connect"
      >
        <header className="flex items-start justify-between gap-6">
          <div>
            <h1 className="m-0 mt-[0.7rem] font-onboarding-serif text-[clamp(1.9rem,4vw,2.45rem)] font-normal tracking-[-0.04em]">
              {t('Bring the AI you already use.')}
            </h1>
            <p className="mt-[0.35rem] text-[0.95rem] leading-[1.45] text-muted-foreground">
              {t('Connect your AI account to start researching in Open-Science.')}
            </p>
            <p className="mt-[0.3rem] text-[0.95rem] leading-[1.2] text-muted-foreground">
              {t('Our catalog includes {{modelCount}} chat models.', {
                modelCount: bundledModelCount
              })}
            </p>
          </div>
          <div className="flex gap-[0.35rem] pt-[0.3rem]" aria-label={t('Step 2 of 3')}>
            <span className="size-[0.4rem] rounded-[50%] bg-border" />
            <span className="h-[0.4rem] w-[1.35rem] rounded-[0.25rem] bg-primary" />
            <span className="size-[0.4rem] rounded-[50%] bg-border" />
          </div>
        </header>

        <div className="onboarding-provider-viewport mt-10 -mx-10 overflow-visible onboarding-narrow:-mx-[1.15rem] onboarding-short:mt-5">
          {/* Leave room inside the scrollport for the raised card and its shadow. */}
          <div className="flex gap-4 overflow-x-auto -mt-8 -mb-9 px-10 pt-8 pb-12 snap-x snap-mandatory scrollbar-thin onboarding-narrow:px-[1.15rem]">
            {QUICK_PROVIDER_CARDS.map((card) => {
              const isKeyMode = quickCardId === card.id && quickMode === 'key'
              const isAuthorizing =
                isSaving && quickCardId === card.id && !isKeyMode && Boolean(card.subscriptionKind)
              const subscriptionAvailable = Boolean(card.subscriptionKind)
              const showKeyForm = isKeyMode || (card.id !== 'more' && !subscriptionAvailable)

              return (
                <article
                  key={card.id}
                  className={clsx(
                    'onboarding-provider-card group/provider onboarding-card-palette relative isolate flex min-h-104 flex-none basis-70 snap-center flex-col overflow-hidden rounded-2xl border',
                    'border-[color-mix(in_oklab,var(--provider-accent)_24%,var(--border))] bg-bg-10 bg-onboarding-card bg-size-[180%_180%] shadow-(--shadow-card)',
                    'transition-[transform,box-shadow] duration-180 ease-onboarding-default motion-reduce:transition-none onboarding-narrow:basis-[min(17.5rem,calc(100vw_-_3.5rem))] onboarding-narrow:min-h-96 onboarding-short:min-h-[min(24rem,54svh)]',
                    '[&:is(:hover,:focus-within)]:z-2 [&:is(:hover,:focus-within)]:transform-[translateY(-0.25rem)] [&:is(:hover,:focus-within)]:border-[color-mix(in_oklab,var(--provider-accent)_45%,var(--text-200))] [&:is(:hover,:focus-within)]:shadow-onboarding-card-hover',
                    `onboarding-provider-card-${card.id}`,
                    (isAuthorizing || installError?.cardId === card.id) && 'is-authorizing'
                  )}
                  style={{ '--provider-accent': card.accent } as React.CSSProperties}
                  onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') setHoveredQuickCardId(card.id)
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType === 'mouse') setHoveredQuickCardId(undefined)
                  }}
                >
                  <div className="relative flex flex-1 flex-col rounded-[calc(1rem_-_1px)] [clip-path:inset(0_round_calc(1rem_-_1px))] after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-onboarding-sheen after:opacity-14 after:transition-opacity after:duration-360 after:ease-onboarding-default group-[:is(:hover,:focus-within)]/provider:after:opacity-7">
                    <ProviderSilkBackground
                      color={card.accent}
                      active={hoveredQuickCardId === card.id}
                    />
                    <div className="relative z-1 flex-1 p-[1.45rem] onboarding-short:py-[0.85rem]">
                      <ProviderKindIcon
                        kindKey={card.kindKey}
                        className={clsx(
                          'size-9',
                          ['openai', 'anthropic', 'xai'].includes(card.id) &&
                            'brightness-0 invert-92'
                        )}
                      />
                      <h2 className="mt-[1.1rem] font-onboarding-serif text-[1.65rem] font-normal tracking-[-0.035em] text-text-000">
                        {card.id === 'more' ? t('Custom Gateway') : card.title}
                      </h2>
                      {card.description && (
                        <p className="mt-2 text-[0.78rem] leading-[1.65] text-text-100">
                          {t(card.description)}
                        </p>
                      )}
                    </div>
                    <div
                      className={clsx(
                        'onboarding-provider-card-actions relative z-1 min-h-30 px-[1.35rem] pt-[1.1rem] pb-[1.4rem] bg-onboarding-tray backdrop-blur-[18px] backdrop-saturate-112 transition-[opacity,transform] duration-180 ease-onboarding-default motion-reduce:transition-none',
                        'onboarding-short:min-h-28 onboarding-short:pt-[0.6rem] onboarding-short:pb-[0.85rem]',
                        !(isKeyMode || isAuthorizing || installError?.cardId === card.id) &&
                          'pointer-events-none opacity-0 transform-[translateY(0.65rem)] group-[:is(:hover,:focus-within)]/provider:pointer-events-auto group-[:is(:hover,:focus-within)]/provider:opacity-100 group-[:is(:hover,:focus-within)]/provider:transform-none',
                        '[@media(hover:none),(any-pointer:coarse)]:opacity-100 [@media(hover:none),(any-pointer:coarse)]:pointer-events-auto [@media(hover:none),(any-pointer:coarse)]:transform-none'
                      )}
                    >
                      {card.requiresConnectionConfiguration ? (
                        <Button
                          type="button"
                          disabled={quickBusy}
                          onClick={() => openProviderConfiguration(card)}
                        >
                          {t('Configure')}
                        </Button>
                      ) : showKeyForm ? (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault()
                            handleQuickKeySubmit(card)
                          }}
                        >
                          <label
                            className="mb-[0.45rem] block text-[0.7rem] text-text-200"
                            htmlFor={`onboarding-key-${card.id}`}
                          >
                            {t('API key')}
                          </label>
                          <div className="flex items-center gap-[0.45rem]">
                            <input
                              className="box-border h-[2.3rem] min-w-0 flex-1 rounded-lg border border-text-300/35 bg-bg-10 px-[0.65rem] py-[0.55rem] text-[0.72rem] text-text-000"
                              id={`onboarding-key-${card.id}`}
                              type="password"
                              value={quickKeys[card.id] ?? ''}
                              disabled={quickBusy}
                              onChange={(event) => handleQuickKeyChange(card, event.target.value)}
                              placeholder={t('Enter your API key')}
                              autoComplete="off"
                              required
                            />
                            <Button
                              type="submit"
                              size="icon"
                              className="box-border size-[2.3rem] min-w-[2.3rem] p-0 [&_svg]:w-[0.95rem]!"
                              aria-label={t('Test connection and connect')}
                              title={t('Test connection and connect')}
                              disabled={quickBusy}
                            >
                              {isSaving && quickCardId === card.id ? (
                                <LoaderCircle
                                  className="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Zap aria-hidden="true" />
                              )}
                            </Button>
                          </div>
                          {quickCardId === card.id && showProviderErrors && formErrors.key ? (
                            <p className="text-xs text-destructive">{t(formErrors.key)}</p>
                          ) : null}
                          {subscriptionAvailable ? (
                            <button
                              type="button"
                              className={providerLinkClass}
                              disabled={quickBusy}
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
                          {isAuthorizing && installing && (
                            <div className="mb-[0.7rem] py-2 px-[0.65rem] rounded-md bg-card text-foreground">
                              <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs tabular-nums">
                                <span>{installProgress?.label ?? t('Installing…')}</span>
                                {installProgress?.fraction != null && (
                                  <span aria-hidden="true" className="font-medium">
                                    {Math.min(
                                      1,
                                      Math.max(0, installProgress.fraction)
                                    ).toLocaleString(i18n?.language, { style: 'percent' })}
                                  </span>
                                )}
                              </div>
                              <progress
                                className={clsx(
                                  'block h-1.5 w-full appearance-none overflow-hidden rounded-full forced-colors:appearance-auto',
                                  '[&::-webkit-progress-bar]:bg-bg-300 [&::-webkit-progress-value]:rounded-[inherit] [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-160 [&::-webkit-progress-value]:ease-[ease-out] motion-reduce:[&::-webkit-progress-value]:transition-none',
                                  'indeterminate:[&::-webkit-progress-bar]:bg-[linear-gradient(var(--primary),var(--primary))] indeterminate:[&::-webkit-progress-bar]:bg-left indeterminate:[&::-webkit-progress-bar]:bg-size-[36%_100%] indeterminate:[&::-webkit-progress-bar]:bg-no-repeat indeterminate:[&::-webkit-progress-bar]:animate-onboarding-download motion-reduce:indeterminate:[&::-webkit-progress-bar]:animate-none'
                                )}
                                aria-label={installProgress?.label ?? t('Installing…')}
                                max={1}
                                value={installProgress?.fraction}
                              />
                            </div>
                          )}
                          {card.subscriptionLabel ? (
                            <small className="mb-[0.7rem] block text-[0.7rem] leading-[1.3] text-text-200">
                              {card.subscriptionLabel(t)}
                            </small>
                          ) : null}
                          {card.subscriptionKind === 'codex-subscription' && !isAuthorizing ? (
                            <div
                              role="group"
                              aria-label={t('Codex authentication')}
                              className="grid grid-cols-2 gap-1.5"
                            >
                              {(['codex-shared', 'codex-isolated'] as const).map((mode) => (
                                <Button
                                  key={mode}
                                  type="button"
                                  size="sm"
                                  disabled={quickBusy}
                                  className="h-auto min-w-0 py-1.5 text-xs whitespace-normal"
                                  onClick={() => void chooseQuickProvider(card, mode)}
                                >
                                  {mode === 'codex-shared'
                                    ? t('Import existing Codex sign-in')
                                    : t('Sign in with Open-Science')}
                                </Button>
                              ))}
                            </div>
                          ) : subscriptionAvailable ? (
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                onClick={
                                  isAuthorizing
                                    ? undefined
                                    : () => void chooseQuickProvider(card, 'account')
                                }
                                disabled={quickBusy}
                                aria-busy={isAuthorizing}
                                className="min-w-0 flex-1"
                              >
                                {isAuthorizing
                                  ? installing
                                    ? t('Installing…')
                                    : authStage === 'detect'
                                      ? t('Detecting…')
                                      : t('Signing in…')
                                  : t('Continue with {{provider}}', { provider: card.title })}
                              </Button>
                              {isAuthorizing && (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  aria-label={t('Cancel sign-in')}
                                  onClick={() => void cancelQuickAuthorization()}
                                >
                                  <X
                                    aria-hidden="true"
                                    className="size-3.5 text-status-warning-dark-foreground"
                                  />
                                  {t('Cancel')}
                                </Button>
                              )}
                            </div>
                          ) : null}
                          <button
                            type="button"
                            className={providerLinkClass}
                            onClick={() => void chooseQuickProvider(card, 'key')}
                            disabled={quickBusy}
                          >
                            {t('Have an API key?')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        <div className="onboarding-quick-feedback flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-y-contain p-1 *:shrink-0">
          {installError && installCard && (
            <OnboardingErrorNotice
              className={quickNoticeClass}
              failure={installError.failure}
              retry={
                retryMode
                  ? {
                      label: t('Retry'),
                      disabled: quickBusy,
                      onClick: () => void chooseQuickProvider(installCard, retryMode)
                    }
                  : undefined
              }
              onDismiss={() => {
                setInstallError(undefined)
                setValidationMessage(undefined)
              }}
            />
          )}
          {validationMessage &&
            !installError &&
            (validationOk ? (
              <p className="mt-3 text-xs text-primary" role="status">
                {validationMessage}
              </p>
            ) : (
              <OnboardingErrorNotice
                className={quickNoticeClass}
                failure={
                  typeof feedback === 'object'
                    ? feedback
                    : {
                        summary: validationMessage,
                        details: [quickCardId, agentFrameworkId].filter(Boolean).join(' / ')
                      }
                }
                onDismiss={() => setValidationMessage(undefined)}
              />
            ))}

          {skipError ? (
            <OnboardingErrorNotice
              className={quickNoticeClass}
              failure={skipError}
              onDismiss={skipError.onDismiss}
            />
          ) : null}
          <footer className="flex flex-none items-end justify-between gap-4 pt-5 [[data-notice-level=warning]+&]:pt-1">
            <Button
              className="min-h-[1.9rem] text-[0.75rem] leading-(--text-sm--line-height)"
              type="button"
              variant="ghost"
              onClick={onBack}
              disabled={quickBusy}
            >
              {t('Back', { context: 'step' })}
            </Button>
            <div className="flex flex-col items-start">
              <Button
                className="min-h-[1.9rem] text-[0.75rem] leading-(--text-sm--line-height)"
                type="button"
                variant="ghost"
                data-onboarding-action="skip"
                onClick={onSkip}
                disabled={quickBusy}
              >
                <span className="w-[0.9rem] shrink-0 text-center" aria-hidden="true">
                  ↗
                </span>
                {t('Skip to access free Kilo models.')}
              </Button>
              <Button
                className="min-h-[1.9rem] text-[0.75rem] leading-(--text-sm--line-height)"
                type="button"
                variant="ghost"
                data-onboarding-action="advanced"
                onClick={() => onAdvanced?.()}
                disabled={quickBusy}
              >
                <Settings2 className="h-4 w-[0.9rem]! shrink-0 text-center" aria-hidden="true" />
                {t('Advanced options')}
              </Button>
            </div>
          </footer>
        </div>
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
          onCancel={() => void cancelQuickAuthorization()}
        />
      </section>
    )
  }

  return (
    <>
      <CardHeader className="gap-1 rounded-t-lg px-6 pt-5 pb-3">
        <h2 ref={modelHeading} tabIndex={-1} className="text-[15px] font-semibold">
          {t('Connect a model')}
        </h2>
        <CardDescription className="text-xs leading-5">
          {t(
            'Choose your provider. Use Custom Gateway for a compatible endpoint or a local model server.'
          )}
        </CardDescription>
        <p className="text-xs leading-5 text-muted-foreground">
          {canReuseExistingProvider && existingProvider
            ? t('Already configured: {{name}} ({{model}}). You can continue with this provider.', {
                name: existingProvider.name,
                model: existingProvider.model ?? activeModel ?? t('default model')
              })
            : t('Skip to access free Kilo models.')}
        </p>
      </CardHeader>
      <Separator className="bg-border-200" />

      <CardContent className="flex-1 px-6 pt-5 pb-6">
        <section aria-label={t('Configure model')}>
          {showPicker ? (
            <ProviderKindPicker
              {...availability}
              recommendedKey={defaultProviderKindKey(agentFrameworkId)}
              onSelect={(kind) => {
                if (!formValue.providerFormTouched || selectedKindKey(formValue) !== kind) {
                  setFormValue({
                    ...createEmptyProviderFormValue(
                      providerKindPatch(kind, customApiEndpoint, activeFramework?.supportedApiTypes)
                    ),
                    providerFormTouched: true
                  })
                }
                picker.select(kind)
                setShowProviderErrors(false)
                setCatalogError(undefined)
                setValidationMessage(undefined)
              }}
            />
          ) : (
            <>
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
                onChange={(patch) => {
                  if ('baseUrl' in patch || 'localPresetId' in patch || 'key' in patch)
                    setCatalogError(undefined)
                  setFormValue((current) => ({ ...current, ...patch, providerFormTouched: true }))
                }}
                errors={showProviderErrors ? formErrors : undefined}
                disabled={isSaving || isSkipping || isRefreshingModels}
                onRefreshModels={formValue.localPresetId ? handleRefreshModels : undefined}
                isRefreshingModels={isRefreshingModels}
                catalogError={catalogError}
                encryptionAvailable={encryptionAvailable}
                {...availability}
                onChangeProviderKind={
                  picker
                    ? () => {
                        picker.select()
                        setValidationMessage(undefined)
                      }
                    : undefined
                }
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
            </>
          )}
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
      <CardFooter className="sticky bottom-0 z-10 mt-auto flex-wrap justify-end gap-2 rounded-b-lg border-border-200 bg-bg-10 px-6 py-[0.8rem]">
        {!canContinue ? (
          <p className="mr-auto text-xs text-text-100">
            {t('Complete every required item above to continue.')}
          </p>
        ) : null}
        {isSaving && formValue.type === 'codebuddy-subscription' ? (
          <Button type="button" variant="outline" onClick={cancelCodeBuddy}>
            {t('Cancel sign-in')}
          </Button>
        ) : isSaving && formValue.type === 'codex-isolated' ? (
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
            disabled={isSkipping || (!!picker && busy)}
            onClick={() => {
              if (picker && !showPicker) {
                picker.select()
                setValidationMessage(undefined)
              } else {
                mounted.current = false
                onBack()
              }
            }}
          >
            {t('Back', { context: 'step' })}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleSkip()}
          disabled={busy}
          aria-busy={isSkipping}
        >
          {canReuseExistingProvider ? t('Use configured provider') : t('Skip')}
        </Button>
        {!showPicker && (
          <Button
            type="button"
            onClick={() => void handleSaveProvider()}
            disabled={busy || !canContinue}
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
        )}
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
