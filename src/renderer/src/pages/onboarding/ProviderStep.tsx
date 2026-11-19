import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, Settings2, Zap } from 'lucide-react'
import { OFFICIAL_VENDORS, type OfficialVendorId } from '@aipoch/providers'

import { isSupportedClaudeCliVersion } from '../../../../shared/claude-runtime'
import { describeInstallProgress } from '../settings/claude-install-progress'
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
import { CODEX_IMPORT_FILE_MISSING_MESSAGE } from '../../../../shared/codex-runtime'
import { unwrapIpcErrorDetail } from '../../../../shared/failure/messages'
import { isProviderUsableByFramework } from '../../../../shared/settings-runtime'
import { cn } from '@/lib/utils'
import {
  selectActiveAgentFramework,
  selectFrameworkApiEndpoints,
  useSettingsStore
} from '@/stores/settings-store'
import { ClaudeIsolatedSignInModal } from '../settings/ClaudeIsolatedSignInModal'
import { ProviderForm, type CodexAuthMode } from '../settings/ProviderForm'
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

const bundledModelCount = new Set(
  OFFICIAL_VENDORS.flatMap((vendor) => vendor.models.map((model) => model.id))
).size

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

  const [claudeStage, setClaudeStage] = useState<'detect' | 'install' | 'auth'>()
  const [claudeInstallError, setClaudeInstallError] = useState<string>()
  const progress = useSettingsStore((state) => state.installStates['claude-code'].installProgress)
  const installProgress =
    claudeStage === 'install' && progress ? describeInstallProgress(progress, t) : undefined
  const pendingClaudeInstall = useRef<{ id: string; settled: Promise<unknown> } | undefined>(
    undefined
  )
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
  const [feedback, setValidationMessage] = useState<
    string | { summary: string; details?: string }
  >()
  const validationMessage = typeof feedback === 'object' ? feedback.summary : feedback
  const codexImportFailure = (cause: unknown) => {
    const details =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
    const signIn = t('Sign in with Open-Science')
    const summary =
      details && unwrapIpcErrorDetail(details) === CODEX_IMPORT_FILE_MISSING_MESSAGE
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
  const quickAuth = useRef<AbortController | undefined>(undefined)
  const codexLoginPendingRef = useRef(false)
  const claudeLoginPendingRef = useRef(false)
  const claudeSharedLoginPendingRef = useRef(false)
  const xaiLoginPendingRef = useRef(false)
  const xaiLoginCancelledRef = useRef(false)

  useEffect(
    () => () => {
      quickAuth.current?.abort()
      if (pendingClaudeInstall.current)
        void cancelSharedClaudeLogin(pendingClaudeInstall.current.id)
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

  const handleSaveProvider = async (
    valueOverride?: ProviderFormValue,
    signal?: AbortSignal
  ): Promise<void> => {
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
        setValidationMessage(describeValidation(validation, tSettings))

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          signal?.throwIfAborted()
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
        setValidationMessage(describeValidation(validation, tSettings))

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          signal?.throwIfAborted()
          advanceIfMounted('account')
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
          if (!signal?.aborted) xaiLoginPendingRef.current = false
        }
        signal?.throwIfAborted()
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
          signal?.throwIfAborted()
          advanceIfMounted('account')
        }
        return
      }

      const request = toUpsertRequest(providerValue, savedProviderId)
      // Shared Codex checks the local profile; defer activation until the attempt is still current.
      const { providerId, validation } = signal
        ? await currentSettings.saveProvider(request)
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
          : describeValidation(validation, tSettings)
      )

      if (validation.ok) {
        if (signal && providerId)
          await setActiveProvider(providerId, providerValue.model || undefined)
        signal?.throwIfAborted()
        advanceIfMounted(value.type === 'codex-shared' ? 'account' : 'api-key')
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
      setValidationMessage(
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save provider.')
      )
    } finally {
      if (!signal) setIsSaving(false)
    }
  }

  // Use the shared CLI profile for both OAuth and ACP. Only a local launch failure can
  // retry via installation; an OAuth rejection or failed subscription probe must stay visible.
  const connectQuickClaude = async (
    value: ProviderFormValue,
    signal: AbortSignal
  ): Promise<void> => {
    const settings = useSettingsStore.getState()
    setClaudeStage('detect')
    let installed = false
    const install = async (): Promise<void> => {
      signal.throwIfAborted()
      installed = true
      setClaudeStage('install')
      const id = crypto.randomUUID()
      const operation = settings.installClaude('managed', undefined, id)
      pendingClaudeInstall.current = { id, settled: operation }
      try {
        const result = await operation
        signal.throwIfAborted()
        if (!result.ok)
          throw new Error(result.error || t('Could not install Claude Code. Try again.'))
      } catch (error) {
        if (!signal.aborted)
          setClaudeInstallError(
            error instanceof Error ? error.message : t('Could not install Claude Code. Try again.')
          )
        throw error
      } finally {
        if (pendingClaudeInstall.current?.id === id) pendingClaudeInstall.current = undefined
      }
    }
    const detected = await settings.detectClaude()
    signal.throwIfAborted()
    if (!detected.found || !detected.path || !isSupportedClaudeCliVersion(detected.version))
      await install()
    signal.throwIfAborted()
    if (useSettingsStore.getState().agentFrameworkId !== 'claude-code') {
      await settings.setAgentFramework('claude-code', { runtimeAlreadyDetected: true })
      signal.throwIfAborted()
    }
    const providerId = await persistProvider(toUpsertRequest(value))
    signal.throwIfAborted()
    const signIn = async (): Promise<ValidateProviderResult> => {
      setClaudeStage('auth')
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
    if (validation.applied === false)
      throw new Error(
        t('The Claude provider changed during sign-in. Review the selection and try again.')
      )
    if (!validation.ok) throw new Error(describeValidation(validation, tSettings))
    await setActiveProvider(providerId)
    signal.throwIfAborted()
    advanceIfMounted('account')
  }

  const chooseQuickProvider = async (
    card: QuickProviderCard,
    mode: 'account' | 'key' | CodexAuthMode
  ): Promise<void> => {
    if (card.kindKey === 'custom') {
      onAdvanced?.()
      return
    }

    const kindKey = mode === 'key' ? card.kindKey : card.subscriptionKind
    if (!kindKey) return

    const nextValue = {
      ...createEmptyProviderFormValue(providerKindPatch(kindKey)),
      ...(mode === 'codex-shared' || mode === 'codex-isolated' ? { type: mode } : {}),
      key: mode === 'key' ? (quickKeys[card.id] ?? '') : '',
      providerFormTouched: true
    }
    setClaudeInstallError(undefined)
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
      const targetFramework =
        card.subscriptionKind === 'codex-subscription' &&
        settings.agentFrameworkId !== 'open-science-agent'
          ? 'codex'
          : settings.agentFrameworkId
      if (targetFramework !== settings.agentFrameworkId) {
        await settings.setAgentFramework(targetFramework)
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
      setValidationMessage(
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save provider.')
      )
    } finally {
      if (!attempt.signal.aborted) {
        quickAuth.current = undefined
        setClaudeStage(undefined)
        setIsSaving(false)
      }
    }
  }

  const cancelQuickAuthorization = async (): Promise<void> => {
    const attempt = quickAuth.current
    if (!attempt || attempt.signal.aborted) return
    attempt.abort()
    try {
      const install = pendingClaudeInstall.current
      if (install) {
        await cancelSharedClaudeLogin(install.id)
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
      setValidationMessage(
        error instanceof Error
          ? localizeProviderResourceMessage(error.message, tSettings)
          : t('Could not save provider.')
      )
    } finally {
      quickAuth.current = undefined
      setClaudeStage(undefined)
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
            <p>{t('Connect your AI account to start researching in Open-Science.')}</p>
            <p className="onboarding-provider-count">
              {t('Our catalog includes {{modelCount}} chat models.', {
                modelCount: bundledModelCount
              })}
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
              const isAuthorizing =
                isSaving && quickCardId === card.id && !isKeyMode && Boolean(card.subscriptionKind)
              const subscriptionAvailable = Boolean(card.subscriptionKind)
              const showKeyForm = isKeyMode || (card.id !== 'more' && !subscriptionAvailable)

              return (
                <article
                  key={card.id}
                  className={cn(
                    'onboarding-provider-card',
                    `onboarding-provider-card-${card.id}`,
                    isKeyMode && 'is-key-mode',
                    (isAuthorizing || (card.id === 'anthropic' && claudeInstallError)) &&
                      'is-authorizing'
                  )}
                  style={{ '--provider-accent': card.accent } as React.CSSProperties}
                  onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') setHoveredQuickCardId(card.id)
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType === 'mouse') setHoveredQuickCardId(undefined)
                  }}
                >
                  <div className="onboarding-provider-card-surface">
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
                          {card.id === 'anthropic' && claudeInstallError && (
                            <ErrorNotice
                              level="warning"
                              role="alert"
                              description={claudeInstallError}
                              secondaryButton={{
                                label: t('Dismiss'),
                                onClick: () => {
                                  setClaudeInstallError(undefined)
                                  setValidationMessage(undefined)
                                }
                              }}
                            />
                          )}
                          {isAuthorizing && claudeStage === 'install' && (
                            <div role="status" className="text-xs">
                              <span>{installProgress?.label ?? t('Installing…')}</span>
                              <progress
                                aria-label={t('Installing…')}
                                max={1}
                                value={installProgress?.fraction}
                                className="block w-full"
                              />
                            </div>
                          )}
                          {subscriptionAvailable ? <small>{t(card.subscription)}</small> : null}
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
                                  disabled={isSaving}
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
                                disabled={isSaving}
                                aria-busy={isAuthorizing}
                                className="min-w-0 flex-1"
                              >
                                {isAuthorizing
                                  ? claudeStage === 'detect'
                                    ? t('Detecting…')
                                    : claudeStage === 'install'
                                      ? t('Installing…')
                                      : t('Signing in…')
                                  : t('Continue with {{provider}}', { provider: card.title })}
                              </Button>
                              {isAuthorizing && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="border-status-warning-foreground/30 bg-status-warning-surface text-status-warning-foreground hover:bg-status-warning-surface/90 hover:text-status-warning-foreground dark:border-status-warning-dark-foreground/40 dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground dark:hover:bg-status-warning-dark-surface/90 dark:hover:text-status-warning-dark-foreground"
                                  aria-label={t('Cancel sign-in')}
                                  onClick={() => void cancelQuickAuthorization()}
                                >
                                  {t('Cancel')}
                                </Button>
                              )}
                            </div>
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
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        {validationMessage &&
          !claudeInstallError &&
          (validationOk ? (
            <p className="mt-3 text-xs text-primary" role="status">
              {validationMessage}
            </p>
          ) : (
            <ErrorNotice
              level="warning"
              role="alert"
              description={validationMessage}
              errorCode={typeof feedback === 'object' ? feedback.details : undefined}
              diagnosticsLabel={t('Error details')}
              className="mt-3 border-status-warning-foreground/30 bg-status-warning-surface dark:border-status-warning-dark-foreground/30 dark:bg-status-warning-dark-surface"
              secondaryButton={{
                label: t('Dismiss'),
                onClick: () => setValidationMessage(undefined)
              }}
            />
          ))}

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
          onCancel={() => void cancelQuickAuthorization()}
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
