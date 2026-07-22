import { Dialog } from 'radix-ui'
import { Check, Copy, ExternalLink, FolderOpen } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useSettingsStore } from '@/stores/settings-store'
import { useUpdateStore } from '@/stores/update-store'
import { buildErrorReportText, buildGithubIssueUrl, type ErrorReportContext } from './error-report'

type ReportErrorDialogProps = {
  open: boolean
  error: string
  onClose: () => void
}

// Reviewable, consent-gated error report. Assembles a diagnostic bundle locally from the settings and
// update stores plus the preload bridge, shows the user exactly what it contains, and only unlocks the
// public "Open GitHub issue" action once they agree. Nothing is transmitted automatically; the local
// runtime log is never inlined (the user attaches it themselves after reviewing it).
const ReportErrorDialog = ({ open, error, onClose }: ReportErrorDialogProps): React.JSX.Element => {
  const appVersion = useUpdateStore((state) => state.appInfo?.version)
  const providers = useSettingsStore((state) => state.providers)
  const activeProviderId = useSettingsStore((state) => state.activeProviderId)
  const activeModel = useSettingsStore((state) => state.activeModel)
  const agentFrameworkId = useSettingsStore((state) => state.agentFrameworkId)
  const agentFrameworks = useSettingsStore((state) => state.agentFrameworks)

  const [consented, setConsented] = useState(false)
  const [copied, setCopied] = useState(false)
  const [revealMessage, setRevealMessage] = useState<string | null>(null)

  // Recompute the bundle only when an input changes; the picker and preview share one source of truth.
  const context = useMemo<ErrorReportContext>(() => {
    const provider = providers.find((candidate) => candidate.id === activeProviderId)
    const frameworkName = agentFrameworks.find(
      (framework) => framework.id === agentFrameworkId
    )?.displayName

    // The bridge is read defensively so the always-mounted dialog renders even where the preload
    // surface is absent (tests, early boot); the report helpers tolerate every missing field.
    return {
      error,
      appVersion,
      platform: window.api?.platform,
      frameworkName,
      providerName: provider?.name,
      model: activeModel,
      runtimeVersions: window.api?.getRuntimeVersions?.()
    }
  }, [
    error,
    appVersion,
    providers,
    activeProviderId,
    activeModel,
    agentFrameworkId,
    agentFrameworks
  ])

  const reportText = useMemo(() => buildErrorReportText(context), [context])
  const issueUrl = useMemo(() => buildGithubIssueUrl(context), [context])

  // Copies the reviewed bundle and briefly confirms; the write stays local (no network).
  const handleCopy = (): void => {
    void navigator.clipboard.writeText(reportText).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  // Reveals the on-device log so the user can attach it themselves; the log is never sent for them.
  const handleRevealLog = async (): Promise<void> => {
    const result = await window.api.logs.revealInFolder()
    if (!result.revealed) setRevealMessage(result.error ?? 'Could not reveal the log file.')
  }

  // Reset transient state whenever the dialog closes so a re-open starts from a clean, unconsented view.
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setConsented(false)
      setCopied(false)
      setRevealMessage(null)
      onClose()
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(640px,calc(100vh-2rem))] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
          <Dialog.Title className="text-base font-semibold text-text-000">
            Report this error
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
            Review what will be included below. This report is posted publicly on GitHub — remove
            anything sensitive before sharing. Your runtime log stays on this device and is never
            attached automatically.
          </Dialog.Description>

          <pre
            className="mt-4 min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-lg border border-border-200 bg-bg-100 px-3 py-2.5 font-mono text-[12px] leading-5 text-text-100"
            aria-label="Error report preview"
          >
            {reportText}
          </pre>

          <label className="mt-4 flex items-start gap-2 text-[13px] leading-5 text-text-100">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              checked={consented}
              onChange={(event) => setConsented(event.target.checked)}
            />
            <span>
              I&apos;ve reviewed the details above and agree to share them in a public GitHub issue.
            </span>
          </label>

          {revealMessage ? (
            <p className="mt-2 text-xs text-red-700" role="alert">
              {revealMessage}
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
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
