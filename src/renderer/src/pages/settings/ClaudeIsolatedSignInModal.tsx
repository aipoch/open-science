import { useEffect, useRef, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { Check, Copy, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
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
  // True while a browser sign-in is running in the background (the modal was opened alongside it as
  // a fallback). Drives a status banner: the happy path finishes in the browser and auto-closes this
  // modal, so the paste form here is only needed if the browser didn't open or the user prefers it.
  browserSignInPending?: boolean
}

// The Claude subscription's setup-token paste modal. Mirrors the structure of the existing settings
// modals (AlertDialog shell, footer with Cancel + primary action) so the look/feel stays consistent.
// Re-mounts the inner body whenever the open prop flips, so a half-typed paste never leaks across
// opens without an explicit setState-in-effect (which the linter forbids).
const ClaudeIsolatedSignInModal = ({
  open,
  onOpenChange,
  onSubmit,
  browserSignInPending = false
}: ClaudeIsolatedSignInModalProps): React.JSX.Element => (
  <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
    <AlertDialog.Portal>
      <ClaudeIsolatedSignInModalBody
        key={open ? 'open' : 'closed'}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        browserSignInPending={browserSignInPending}
      />
    </AlertDialog.Portal>
  </AlertDialog.Root>
)

// Inner body component: re-mounted on every open transition so its state starts blank without a
// setState-in-effect. Owns the paste input, copy-button state, and submit error.
const ClaudeIsolatedSignInModalBody = ({
  onOpenChange,
  onSubmit,
  browserSignInPending
}: Pick<
  ClaudeIsolatedSignInModalProps,
  'onOpenChange' | 'onSubmit' | 'browserSignInPending'
>): React.JSX.Element => {
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
      <AlertDialog.Overlay className={dialogOverlayClassName} />
      <AlertDialog.Content className={dialogPanelClassName('w-[min(560px,92vw)]')}>
        <AlertDialog.Title className={dialogTitleClassName}>
          Sign in with Anthropic
        </AlertDialog.Title>
        <AlertDialog.Description className={dialogDescriptionClassName}>
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

        {browserSignInPending ? (
          // The browser sign-in is running: its CLI callback captures the token and auto-closes this
          // modal on success. This banner tells the user the paste form below is only a fallback.
          <div
            className="mt-4 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
            <span>
              Opening your browser to sign in… finish there and this closes automatically.
              Didn&apos;t open, or prefer a token? Paste one below.
            </span>
          </div>
        ) : null}

        <div className="mt-5 space-y-4">
          {/* The "Run this command" step only makes sense for a pure manual sign-in. During a browser
              sign-in the app already runs `claude setup-token` for the user, so showing it as a step
              they must run would be misleading — hide it and drop the now-orphaned "Step" numbering. */}
          {browserSignInPending ? null : (
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
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium" htmlFor="claude-setup-token-input">
              {browserSignInPending
                ? 'Paste the token printed by setup-token'
                : 'Step 2 · Paste the token printed by setup-token'}
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

        <div className={dialogFooterClassName}>
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
