import { useEffect, useRef, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { Check, Copy } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ValidateProviderResult } from '../../../../shared/settings'

// One-line shell command the user runs to mint a long-lived OAuth token. Mirrors Anthropic's
// `claude setup-token` docs (linked in the modal) — the command itself is portable across
// platforms, so the modal exposes only "Copy" (terminal pre-fill is out of scope for v1).
const SETUP_TOKEN_COMMAND = 'claude setup-token'

const SETUP_TOKEN_DOCS_URL =
  'https://docs.claude.com/en/docs/claude-code/authentication#generate-a-long-lived-token'

type ClaudeIsolatedSignInModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // The parent resolves the paste: returns the recorded outcome so callers can react (close on
  // success, keep the modal open with the error inline on failure). Undefined means the user
  // dismissed without submitting.
  onSubmit: (token: string) => Promise<ValidateProviderResult | undefined>
}

// The Claude subscription's setup-token paste modal. Mirrors the structure of the existing settings
// modals (AlertDialog shell, footer with Cancel + primary action) so the look/feel stays consistent.
// Re-mounts the inner body whenever the open prop flips, so a half-typed paste never leaks across
// opens without an explicit setState-in-effect (which the linter forbids).
const ClaudeIsolatedSignInModal = ({
  open,
  onOpenChange,
  onSubmit
}: ClaudeIsolatedSignInModalProps): React.JSX.Element => (
  <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
    <AlertDialog.Portal>
      <ClaudeIsolatedSignInModalBody
        key={open ? 'open' : 'closed'}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />
    </AlertDialog.Portal>
  </AlertDialog.Root>
)

// Inner body component: re-mounted on every open transition so its state starts blank without a
// setState-in-effect. Owns the paste input, copy-button state, and submit error.
const ClaudeIsolatedSignInModalBody = ({
  onOpenChange,
  onSubmit
}: Pick<ClaudeIsolatedSignInModalProps, 'onOpenChange' | 'onSubmit'>): React.JSX.Element => {
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Clears the copy-button "Copied" feedback on unmount so a future open can't show a stale hint.
  // The unmount cleanup is the only safe place for this: setting state from an effect body is
  // forbidden by the linter (cascading renders), and the timer ID only outlives a single mount.
  useEffect(() => {
    return () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    }
  }, [])

  const copyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(SETUP_TOKEN_COMMAND)
      setCopied(true)
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
      copyResetTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access is best-effort: the command text is also rendered inline so the user can
      // select-and-copy manually. We deliberately do not surface a modal-level error for clipboard
      // failures so a permission-block on a locked-down host still lets the paste flow proceed.
    }
  }

  const submit = async (): Promise<void> => {
    setSubmitError(undefined)
    setIsSubmitting(true)

    try {
      const result = await onSubmit(token)

      // onSubmit returns undefined when the user dismissed; only close on a recorded ok:true.
      if (result?.ok) {
        onOpenChange(false)
      } else if (result) {
        // The controller's failure message is the actionable one (e.g. "unlock the keychain"),
        // so we surface it inline rather than swapping in describeValidation's mapped text.
        setSubmitError(result.message ?? 'Could not save the Claude token.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-000 p-6 shadow-lg">
        <AlertDialog.Title className="text-base font-semibold">
          Sign in with Anthropic
        </AlertDialog.Title>
        <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">
          Use a long-lived OAuth token from <code className="font-mono">claude setup-token</code>.
          The token is stored encrypted in your app-owned Claude config directory and never read
          from or written to <code className="font-mono">~/.claude</code>. See{' '}
          <a
            href={SETUP_TOKEN_DOCS_URL}
            className="text-primary underline underline-offset-2"
            target="_blank"
            rel="noreferrer"
          >
            Anthropic&apos;s setup-token guide
          </a>{' '}
          for the full flow.
        </AlertDialog.Description>

        <div className="mt-5 space-y-4">
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Step 1 · Run</span>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs">
                {SETUP_TOKEN_COMMAND}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void copyCommand()}
                aria-label="Copy command"
              >
                {copied ? (
                  <>
                    <Check className="size-3.5" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" aria-hidden="true" />
                    Copy
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="claude-setup-token-input">
              Step 2 · Paste the token printed by setup-token
            </label>
            <Input
              id="claude-setup-token-input"
              aria-label="Claude setup token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="sk-ant-..."
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {submitError ? (
            <p className="text-xs text-destructive" role="alert">
              {submitError}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <AlertDialog.Cancel asChild>
            <Button type="button" variant="outline" disabled={isSubmitting}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={isSubmitting || token.trim().length === 0}
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </AlertDialog.Content>
    </>
  )
}

export { ClaudeIsolatedSignInModal }
