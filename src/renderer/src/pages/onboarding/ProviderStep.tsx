import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type { UpsertProviderRequest, ValidateProviderResult } from '../../../../shared/settings'
import { isProviderUsableByFramework } from '../../../../shared/settings'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import { ClaudeIsolatedSignInModal } from '../settings/ClaudeIsolatedSignInModal'
import { ProviderForm } from '../settings/ProviderForm'
import {
  createEmptyProviderFormValue,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerKindPatch,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { describeValidation } from '../settings/validation-message'

const isBrowserSignInProvider = (type: ProviderFormValue['type']): boolean =>
  type === 'codex-isolated' || type === 'claude-isolated' || type === 'claude-shared'

// Converts a form value into the upsert request the main process expects.
const toUpsertRequest = (value: ProviderFormValue): UpsertProviderRequest => ({
  type: value.type,
  name: value.name,
  baseUrl: value.baseUrl,
  model: value.model,
  vendorId: value.vendorId,
  region: value.region,
  // Persist the chosen API format so an OpenAI-compatible provider is validated + driven correctly.
  apiEndpoints: [value.apiEndpoint],
  supportsImageInput: value.supportsImageInput,
  key: value.key || undefined
})

type ProviderStepProps = {
  // The draft lives in the wizard shell so going Back and returning keeps it; this step owns
  // validation, saving, and the isolated Codex sign-in flow.
  formValue: ProviderFormValue
  setFormValue: React.Dispatch<React.SetStateAction<ProviderFormValue>>
  onBack: () => void
  onAdvance: () => void
}

// Model provider step: configure and validate the provider new research sessions will use. Reuses
// the settings page's ProviderForm so both surfaces stay in sync.
const ProviderStep = ({
  formValue,
  setFormValue,
  onBack,
  onAdvance
}: ProviderStepProps): React.JSX.Element => {
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)
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

  const [isSaving, setIsSaving] = useState(false)
  const [isClaudeSignInOpen, setIsClaudeSignInOpen] = useState(false)
  const claudeProviderIdRef = useRef<string | undefined>(undefined)
  const manualClaudePasteWonRef = useRef(false)
  // Required-field errors stay hidden until the user first tries to submit, so an untouched form is
  // not littered with "required" messages. A `*` on each label signals the requirement up front.
  const [showProviderErrors, setShowProviderErrors] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined)
  const [validationOk, setValidationOk] = useState(false)
  // Mirrors the Settings teardown: a pending isolated sign-in lives in the main process for up to
  // five minutes, and its guard rejects a second attempt as "already in progress". If the wizard
  // unmounts mid-flow (app quit, relaunch, forced navigation), cancel it so the next attempt starts
  // clean. The ref is written only from event handlers/effects, never during render.
  const codexLoginPendingRef = useRef(false)
  const claudeLoginPendingRef = useRef(false)
  const claudeSharedLoginPendingRef = useRef(false)
  useEffect(
    () => () => {
      if (codexLoginPendingRef.current) void cancelCodexLogin()
      if (claudeLoginPendingRef.current) void cancelIsolatedClaudeLogin()
      if (claudeSharedLoginPendingRef.current) void cancelSharedClaudeLogin()
    },
    [cancelCodexLogin, cancelIsolatedClaudeLogin, cancelSharedClaudeLogin]
  )

  // Codex starts with its subscription provider, but an existing draft always wins when navigating
  // back to this step.
  useEffect(() => {
    if (agentFrameworkId !== 'codex') return

    setFormValue((current) =>
      current.name || current.baseUrl || current.model || current.key
        ? current
        : createEmptyProviderFormValue(providerKindPatch('codex-subscription'))
    )
  }, [agentFrameworkId, setFormValue])

  // Onboarding always creates a provider, so required fields must be filled before it can continue.
  const formErrors = getProviderFormErrors(formValue)

  const handleClaudeTokenFallback = async (token: string): Promise<ValidateProviderResult> => {
    manualClaudePasteWonRef.current = true
    await cancelIsolatedClaudeLogin()

    try {
      const result = await loginIsolatedClaude(token)
      if (result.applied === false) {
        const message =
          'The Claude provider changed during sign-in. Review the selection and try again.'
        setValidationOk(false)
        setValidationMessage(message)
        return { ...result, ok: false, message }
      }

      setValidationOk(result.ok)
      setValidationMessage(describeValidation(result))

      if (result.ok) {
        if (claudeProviderIdRef.current) {
          await setActiveProvider(claudeProviderIdRef.current)
        }
        setIsClaudeSignInOpen(false)
        onAdvance()
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save the Claude token.'
      setValidationOk(false)
      setValidationMessage(message)
      return { ok: false, category: 'unknown', message }
    }
  }

  const handleSaveProvider = async (): Promise<void> => {
    // First submit attempt surfaces any missing required fields instead of testing an incomplete draft.
    if (hasProviderFormErrors(formErrors)) {
      setShowProviderErrors(true)
      return
    }

    // A provider that validates can still be unusable by the selected framework (e.g. Claude + an
    // OpenAI-only gateway). Block that before it becomes the active provider, so onboarding can't
    // finish with a pair the agent can't actually spawn.
    if (
      !isProviderUsableByFramework(
        { apiEndpoints: [formValue.apiEndpoint], type: formValue.type },
        { id: agentFrameworkId, supportedApiTypes: frameworkEndpoints }
      )
    ) {
      const label =
        agentFrameworks.find((framework) => framework.id === agentFrameworkId)?.displayName ??
        'the selected agent'
      setValidationOk(false)
      setValidationMessage(
        `This provider isn't compatible with ${label}. Pick a provider whose API format ${label} supports, or change the agent framework.`
      )
      return
    }

    setIsSaving(true)
    setValidationMessage(undefined)

    try {
      if (formValue.type === 'codex-isolated') {
        // Isolated sign-in is explicit: persist the provider first, then run the browser login.
        // Persisting alone never pops a browser; a cancelled login keeps the provider saved but
        // unverified, so the user can retry without re-entering anything.
        const providerId = await persistProvider(toUpsertRequest(formValue))
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
            'The Codex provider changed during sign-in. Review the selection and try again.'
          )
          return
        }

        setValidationOk(validation.ok)
        setValidationMessage(describeValidation(validation))

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          onAdvance()
        }
        return
      }

      if (formValue.type === 'claude-isolated') {
        manualClaudePasteWonRef.current = false
        const providerId = await persistProvider(toUpsertRequest(formValue))
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
            'The Claude provider changed during sign-in. Review the selection and try again.'
          )
          return
        }

        setValidationOk(validation.ok)
        setValidationMessage(describeValidation(validation))

        if (validation.ok) {
          setIsClaudeSignInOpen(false)
          if (providerId) await setActiveProvider(providerId)
          onAdvance()
        }
        return
      }

      if (formValue.type === 'claude-shared') {
        const providerId = await persistProvider(toUpsertRequest(formValue))
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
            'The Claude provider changed during sign-in. Review the selection and try again.'
          )
          return
        }

        setValidationOk(validation.ok)
        setValidationMessage(describeValidation(validation))

        if (validation.ok) {
          if (providerId) await setActiveProvider(providerId)
          onAdvance()
        }
        return
      }

      const { validation } = await saveAndActivateProvider(toUpsertRequest(formValue))

      // A validation superseded by a newer test (or a provider removed/edited mid-test) reports its
      // outcome but was not recorded; do not finish onboarding on a result the stored provider never
      // received.
      if (validation.applied === false) {
        setValidationOk(false)
        setValidationMessage('The provider changed during testing. Try again.')
        return
      }

      setValidationOk(validation.ok)
      setValidationMessage(describeValidation(validation))

      if (validation.ok) {
        onAdvance()
      }
    } catch (error) {
      setValidationOk(false)
      setValidationMessage(error instanceof Error ? error.message : 'Could not save provider.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <CardHeader className="gap-1 rounded-t-lg px-6 py-5">
        <CardTitle className="text-[15px] font-semibold">Connect a model</CardTitle>
        <CardDescription className="text-xs leading-5">
          Choose the provider Open Science should use for new research sessions.
        </CardDescription>
      </CardHeader>
      <Separator className="bg-border-200" />

      <CardContent className="flex-1 px-6 py-5">
        <section aria-label="Configure model">
          {!encryptionAvailable ? (
            <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              Secure key storage is unavailable. API keys cannot be saved until the system keychain
              is unlocked or authorized.
            </p>
          ) : null}
          <ProviderForm
            value={formValue}
            onChange={(patch) => setFormValue((current) => ({ ...current, ...patch }))}
            errors={showProviderErrors ? formErrors : undefined}
            disabled={isSaving}
            encryptionAvailable={encryptionAvailable}
            showCodexSubscriptions={agentFrameworkId === 'codex'}
            showClaudeIsolated={agentFrameworkId === 'claude-code'}
          />
          {formValue.type === 'claude-isolated' ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Sign in with your browser to connect your Claude subscription. We&apos;ll open Claude
              in your browser to authorize, then bring you right back.
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
      <CardFooter className="mt-auto justify-end gap-2 rounded-b-lg border-border-200 bg-bg-10 px-6 py-3">
        {isSaving && formValue.type === 'codex-isolated' ? (
          <Button type="button" variant="outline" onClick={() => void cancelCodexLogin()}>
            Cancel sign-in
          </Button>
        ) : isSaving && formValue.type === 'claude-isolated' ? (
          <Button type="button" variant="outline" onClick={() => void cancelIsolatedClaudeLogin()}>
            Cancel sign-in
          </Button>
        ) : isSaving && formValue.type === 'claude-shared' ? (
          <Button type="button" variant="outline" onClick={() => void cancelSharedClaudeLogin()}>
            Cancel sign-in
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onBack}>
            Back
          </Button>
        )}
        <Button
          type="button"
          onClick={() => void handleSaveProvider()}
          disabled={isSaving}
          className="px-4"
        >
          {isSaving
            ? isBrowserSignInProvider(formValue.type)
              ? 'Waiting for sign-in…'
              : 'Testing connection…'
            : isBrowserSignInProvider(formValue.type)
              ? 'Sign in & continue'
              : 'Test & continue'}
        </Button>
      </CardFooter>
      <ClaudeIsolatedSignInModal
        open={isClaudeSignInOpen}
        onOpenChange={setIsClaudeSignInOpen}
        onSubmit={handleClaudeTokenFallback}
        browserSignInPending={isSaving && isClaudeSignInOpen}
      />
    </>
  )
}

export { ProviderStep }
