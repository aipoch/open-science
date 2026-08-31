import { Dialog } from 'radix-ui'
import { ExternalLink, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { buildStartupIssueTitle, buildStartupIssueUrl } from '@/lib/startup-issue'
import { cn } from '@/lib/utils'
import type { DatabaseStartupError } from '../../../shared/database-startup'

type StartupIssueDialogProps = {
  error: DatabaseStartupError
  onClose: () => void
}

const StartupIssueDialog = ({ error, onClose }: StartupIssueDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [diagnostics, setDiagnostics] = useState(error.diagnostics ?? '')
  const issueUrl = useMemo(() => buildStartupIssueUrl(error, diagnostics), [diagnostics, error])
  const issuePreview = useMemo(() => {
    const body = new URL(issueUrl).searchParams.get('body') ?? ''
    return `${buildStartupIssueTitle(error)}\n\n${body}`
  }, [error, issueUrl])
  const [consentedUrl, setConsentedUrl] = useState<string | null>(null)
  const consented = consentedUrl === issueUrl

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'flex max-h-[min(680px,calc(100vh-2rem))] w-[min(620px,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{t('Report this error')}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t(
                  'This report is posted publicly on GitHub. Edit the error text below to remove anything sensitive before sharing. Your runtime log stays on this device and is never attached automatically.'
                )}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                aria-label={t('Close')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>

          <div className={cn(dialogBodyClassName, 'min-h-0 flex-1 overflow-auto')}>
            <label className="text-[11px] font-medium uppercase tracking-wide text-text-300">
              {t('Error details')}
            </label>
            <textarea
              className="mt-1 min-h-32 w-full resize-y rounded-lg border border-input bg-bg-100 px-3 py-2.5 font-mono text-[12px] leading-5 text-text-100 focus:outline-none focus:ring-1 focus:ring-primary/50"
              aria-label={t('Error details')}
              value={diagnostics}
              onChange={(event) => setDiagnostics(event.target.value)}
            />

            <p className="mt-3 text-[11px] font-medium uppercase tracking-wide text-text-300">
              {t('GitHub issue prefill')}
            </p>
            <pre
              className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border-200 bg-bg-100 px-3 py-2 font-mono text-[11px] leading-5 text-text-200"
              aria-label={t('GitHub issue prefill')}
            >
              {issuePreview}
            </pre>

            <label className="mt-4 flex items-start gap-2 text-[13px] leading-5 text-text-100">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                checked={consented}
                onChange={(event) => setConsentedUrl(event.target.checked ? issueUrl : null)}
              />
              <span>
                <Trans
                  i18nKey="I've reviewed the details above and agree to share them in a public GitHub issue, subject to GitHub's <privacyLink>Privacy Statement</privacyLink>."
                  components={{
                    privacyLink: (
                      <a
                        href="https://docs.github.com/site-policy/privacy-policies/github-privacy-statement"
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-text-000"
                        onClick={(event) => event.stopPropagation()}
                      />
                    )
                  }}
                />
              </span>
            </label>
          </div>

          <div className={dialogFooterClassName}>
            <a
              href={consented ? issueUrl : undefined}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!consented}
              tabIndex={consented ? undefined : -1}
              onClick={(event) => {
                if (!consented) event.preventDefault()
                else onClose()
              }}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/80 ${
                consented ? '' : 'pointer-events-none opacity-50'
              }`}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {t('Open GitHub issue')}
            </a>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { StartupIssueDialog }
