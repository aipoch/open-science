import { Dialog } from 'radix-ui'
import { Check, Copy, ExternalLink, FolderOpen, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useUpdateStore } from '@/stores/update-store'
import {
  buildEnvironmentBlock,
  buildErrorReportText,
  buildGithubIssuePrefill,
  resolveSessionSubject,
  type ErrorReportContext,
  type SessionReportSubject
} from './error-report'

type ReportErrorDialogProps = {
  open: boolean
  error: string
  // Session-level identifiers and run model snapshot used to attribute the report to the configuration
  // that was active when the run failed, rather than the current global settings.
  subject: SessionReportSubject
  onClose: () => void
}

// Reviewable, consent-gated error report. Assembles a diagnostic bundle locally from the settings and
// update stores plus the preload bridge, shows the user exactly what it contains, and only unlocks the
// public "Open GitHub issue" action once they agree. Nothing is transmitted automatically; the local
// runtime log is never inlined (the user attaches it themselves after reviewing it).
const ReportErrorDialog = ({
  open,
  error,
  subject,
  onClose
}: ReportErrorDialogProps): React.JSX.Element => {
  const appVersion = useUpdateStore((state) => state.appInfo?.version)
  const providers = useSettingsStore((state) => state.providers)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)

  // Derive environment facts live, while the failed session supplies framework/backend identifiers and
  // its run model snapshot. The bridge is read defensively so the dialog renders where the preload
  // surface is absent (tests, early boot); the helpers tolerate every missing field.
  const context = useMemo<ErrorReportContext>(() => {
    const resolved = resolveSessionSubject(subject, providers, agentFrameworks)
    return {
      error,
      appVersion,
      platform: window.api?.platform,
      frameworkName: resolved.frameworkName,
      providerName: resolved.providerName,
      model: resolved.model,
      runtimeVersions: window.api?.getRuntimeVersions?.()
    }
    // Depend on the primitive subject fields, not the object identity (a fresh literal each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    error,
    appVersion,
    providers,
    agentFrameworks,
    subject.agentFrameworkId,
    subject.agentBackendId,
    subject.model
  ])

  const [copied, setCopied] = useState(false)
  const [revealMessage, setRevealMessage] = useState<string | null>(null)
  // Only the error text is editable — it is the unpredictable, possibly-sensitive part users may need
  // to redact. Environment facts are non-sensitive and shown read-only below. Seeded lazily from the
  // current error; the parent remounts this dialog on each open, so it stays fresh.
  const [editedError, setEditedError] = useState(error)

  // The edited error flows into every output so redactions are reflected everywhere it is shared.
  const editedContext = useMemo<ErrorReportContext>(
    () => ({ ...context, error: editedError }),
    [context, editedError]
  )
  const environmentBlock = useMemo(() => buildEnvironmentBlock(context), [context])
  const issuePrefill = useMemo(() => buildGithubIssuePrefill(editedContext), [editedContext])
  const issueUrl = issuePrefill.url
  const issuePrefillPreview = useMemo(
    () =>
      [
        'What happened',
        issuePrefill.fields['what-happened'] ?? '(not prefilled)',
        '',
        'App version',
        issuePrefill.fields['app-version'] ?? '(not prefilled)',
        '',
        'Provider / model',
        issuePrefill.fields['provider-model'] ?? '(not prefilled)',
        '',
        'Relevant logs',
        issuePrefill.fields.logs ?? '(not prefilled)'
      ].join('\n'),
    [issuePrefill]
  )

  // Consent is tied to the exact payload it was given for, not a bare flag. We record the URL the user
  // consented to; consent holds only while that still equals the current URL. So if a store field lands
  // late (e.g. getAppInfo() resolving after an early open) or the user edits the error, issueUrl changes
  // and consent lapses in the SAME render — the user re-confirms the complete bundle, and a late field
  // can never ride into an already-consented URL. Deriving (not an effect) closes the one-frame gap
  // where the link could be clicked with stale consent.
  const [consentedUrl, setConsentedUrl] = useState<string | null>(null)
  const consented = consentedUrl === issueUrl

  // Copies the full bundle (error + environment) with the redacted error; the write stays local.
  const handleCopy = (): void => {
    void navigator.clipboard
      .writeText(buildErrorReportText(editedContext))
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        setRevealMessage('Could not write to clipboard.')
      })
  }

  // Reveals the on-device log so the user can attach it themselves; the log is never sent for them.
  // Defensive: `window.api` may be absent in tests or early boot (mirrors the useMemo guard above),
  // and the IPC call itself can reject — both surface inline rather than throwing (matches GeneralPanel).
  const handleRevealLog = async (): Promise<void> => {
    if (!window.api?.logs?.revealInFolder) {
      setRevealMessage('Log reveal is not available in this environment.')
      return
    }
    try {
      const result = await window.api.logs.revealInFolder()
      if (!result.revealed) setRevealMessage(result.error ?? 'Could not reveal the log file.')
    } catch (error) {
      setRevealMessage(error instanceof Error ? error.message : 'Could not reveal the log file.')
    }
  }

  // Reset transient state whenever the dialog closes so a re-open starts from a clean view.
  const handleOpenChange = (next: boolean): void => {
    if (!next) onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'flex max-h-[min(640px,calc(100vh-2rem))] w-[min(560px,calc(100vw-2rem))] flex-col'
          )}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>Report this error</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                This report is posted publicly on GitHub. Edit the error text below to remove
                anything sensitive before sharing. Your runtime log stays on this device and is
                never attached automatically.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                aria-label="Close"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <label className="mt-4 text-[11px] font-medium uppercase tracking-wide text-text-300">
            Error details
          </label>
          <textarea
            className="mt-1 min-h-0 flex-1 resize-none overflow-auto rounded-lg border border-border-200 bg-bg-100 px-3 py-2.5 font-mono text-[12px] leading-5 text-text-100 focus:outline-none focus:ring-1 focus:ring-primary/50"
            aria-label="Error details"
            value={editedError}
            onChange={(event) => {
              // Editing changes issueUrl, so consent lapses automatically via consentedUrl !== issueUrl.
              setEditedError(event.target.value)
            }}
          />

          <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-text-300">
            Also included
          </p>
          <pre
            className="mt-1 max-h-28 shrink-0 overflow-auto whitespace-pre-wrap rounded-lg border border-border-200 bg-bg-100 px-3 py-2 font-mono text-[11px] leading-5 text-text-200"
            aria-label="Report environment"
          >
            {environmentBlock}
          </pre>

          {issuePrefill.truncatedFields.length > 0 ? (
            <>
              <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-text-300">
                GitHub issue prefill
              </p>
              <pre
                className="mt-1 max-h-28 shrink-0 overflow-auto whitespace-pre-wrap rounded-lg border border-border-200 bg-bg-100 px-3 py-2 font-mono text-[11px] leading-5 text-text-200"
                aria-label="GitHub issue prefill"
              >
                {issuePrefillPreview}
              </pre>
            </>
          ) : null}

          <label className="mt-4 flex items-start gap-2 text-[13px] leading-5 text-text-100">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={consented}
              // Consent is granted for the payload on screen now; bind it to that exact URL.
              onChange={(event) => setConsentedUrl(event.target.checked ? issueUrl : null)}
            />
            <span>
              I&apos;ve reviewed the details above and agree to share them in a public GitHub issue,
              subject to GitHub&apos;s{' '}
              <a
                href="https://docs.github.com/site-policy/privacy-policies/github-privacy-statement"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-text-000"
                onClick={(event) => event.stopPropagation()}
              >
                Privacy Statement
              </a>
              .
            </span>
          </label>

          {revealMessage ? (
            <p className="mt-2 text-xs text-red-700" role="alert">
              {revealMessage}
            </p>
          ) : null}

          <div className={cn(dialogFooterClassName, 'flex-wrap items-center')}>
            <button
              type="button"
              className="mr-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-200 bg-bg-000 px-2.5 text-sm font-medium text-text-100 hover:bg-bg-200 hover:text-text-000"
              onClick={() => void handleRevealLog()}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              Reveal log file
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-200 bg-bg-000 px-2.5 text-sm font-medium text-text-100 hover:bg-bg-200 hover:text-text-000"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="size-4" aria-hidden="true" />
              ) : (
                <Copy className="size-4" aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy details'}
            </button>
            <a
              href={consented ? issueUrl : undefined}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!consented}
              tabIndex={consented ? undefined : -1}
              onClick={(event) => {
                if (!consented) event.preventDefault()
                else handleOpenChange(false)
              }}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/80 ${
                consented ? '' : 'pointer-events-none opacity-50'
              }`}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              Open GitHub issue
            </a>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { ReportErrorDialog }
