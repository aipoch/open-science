import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type { UpsertProviderRequest } from '../../../../shared/settings'
import { isProviderUsableByFramework } from '../../../../shared/settings'
import { selectFrameworkApiEndpoints, useSettingsStore } from '@/stores/settings-store'
import { ProviderForm } from '../settings/ProviderForm'
import {
  createEmptyProviderFormValue,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerKindPatch,
  type ProviderFormValue
} from '../settings/provider-form-value'
import { describeValidation } from '../settings/validation-message'

const createCodexProviderFormValue = (): ProviderFormValue =>
  createEmptyProviderFormValue(providerKindPatch('codex-subscription'))

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
  const loginIsolatedClaude = useSettingsStore((state) => state.loginIsolatedClaude)

  const [isSaving, setIsSaving] = useState(false)
  // Required-field errors stay hidden until the user first tries to submit, so an untouched form is
  // not littered with "required" messages. A `*` on each label signals the requirement up front.
  const [showProviderErrors, setShowProviderErrors] = useState(false)
  const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined)
  const [validationOk, setValidationOk] = useState(false)
  // Keep the setup token outside ProviderFormValue: it is a one-time credential submitted to the
  // isolated Claude login action, not provider configuration that should survive this step.
  const [claudeSetupToken, setClaudeSetupToken] = useState('')
  // Mirrors the Settings teardown: a pending isolated sign-in lives in the main process for up to
  // five minutes, and its guard rejects a second attempt as "already in progress". If the wizard
  // unmounts mid-flow (app quit, relaunch, forced navigation), cancel it so the next attempt starts
  // clean. The ref is written only from event handlers/effects, never during render.
  const codexLoginPendingRef = useRef(false)
  useEffect(
    () => () => {
      if (codexLoginPendingRef.current) void cancelCodexLogin()
    },
    [cancelCodexLogin]
  )

  // Entering the step with Codex selected and an untouched form preselects the Codex subscription
  // kind — the same prefill the old single-file wizard applied on its Continue button.
  const didPrefillCodex = useRef(false)
  useEffect(() => {
    if (didPrefillCodex.current) return
    didPrefillCodex.current = true
    if (
      agentFrameworkId === 'codex' &&
      !formValue.name &&
      !formValue.baseUrl &&
      !formValue.model &&
      !formValue.key
    ) {
      setFormValue(createCodexProviderFormValue())
    }
    // formValue is read once at mount for the prefill check; later edits must not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentFrameworkId, setFormValue])

  // Onboarding always creates a provider, so required fields must be filled before it can continue.
  const formErrors = getProviderFormErrors(formValue)

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
        // Create the fixed provider record first, then verify the one-time setup token against that
        // exact record. This matches Settings while keeping onboarding's single submit action.
        const trimmedToken = claudeSetupToken.trim()
        if (!trimmedToken) {
          setValidationOk(false)
          setValidationMessage('Paste the token printed by `claude setup-token` to continue.')
          return
        }

        const providerId = await persistProvider(toUpsertRequest(formValue))
        const validation = await loginIsolatedClaude(trimmedToken)

        // A successful but discarded validation was not recorded on the provider, so activating it
        // would let onboarding finish with an unverified credential.
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
          setClaudeSetupToken('')
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
            <div className="mt-4 space-y-2">
              <label className="text-xs font-medium" htmlFor="wizard-claude-setup-token">
                Paste the token from <code className="font-mono">claude setup-token</code>
              </label>
              <Input
                id="wizard-claude-setup-token"
                aria-label="Claude setup token"
                value={claudeSetupToken}
                onChange={(event) => setClaudeSetupToken(event.target.value)}
                placeholder="sk-ant-..."
                autoComplete="off"
                spellCheck={false}
                disabled={isSaving}
              />
            </div>
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
            ? formValue.type === 'codex-isolated'
              ? 'Waiting for sign-in…'
              : 'Testing connection…'
            : formValue.type === 'codex-isolated'
              ? 'Sign in & continue'
              : 'Test & continue'}
        </Button>
      </CardFooter>
    </>
  )
}

export { ProviderStep }
