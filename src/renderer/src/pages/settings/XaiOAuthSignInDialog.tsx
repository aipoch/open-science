/* Hallmark · component: device authorization · genre: modern-minimal · theme: project Settings tokens */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 · contrast: pass (40–41) · slop: pass */
import { AlertDialog } from 'radix-ui'
import { Copy, ExternalLink, LoaderCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import type { XaiOAuthDeviceAuthorization } from '../../../../shared/settings'

type Props = {
  session?: XaiOAuthDeviceAuthorization
  error?: string
  open: boolean
  onCancel: () => void
}

export const XaiOAuthSignInDialog = ({
  session,
  error,
  open,
  onCancel
}: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const verificationUrl = session?.verificationUriComplete ?? session?.verificationUri
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content className={dialogPanelClassName('w-[min(480px,92vw)] p-0')}>
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Sign in to xAI (Grok)')}
            </AlertDialog.Title>
            <AlertDialog.Cancel asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                className={dialogCloseButtonClassName}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </AlertDialog.Cancel>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t('Open the xAI verification page and enter this one-time device code.')}
            </AlertDialog.Description>
            {session ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-lg border border-border bg-muted/30 p-4 text-center">
                  <div className="font-mono text-2xl font-semibold tracking-[0.2em] text-foreground">
                    {session.userCode}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => void navigator.clipboard.writeText(session.userCode)}
                  >
                    <Copy className="size-4" aria-hidden="true" />
                    {t('Copy code')}
                  </Button>
                </div>
                <Button asChild className="w-full">
                  <a href={verificationUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" aria-hidden="true" />
                    {t('Open xAI verification')}
                  </a>
                </Button>
                <div
                  className="flex items-center justify-center gap-2 text-xs text-muted-foreground"
                  role="status"
                >
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {t('Waiting for authorization…')}
                </div>
              </div>
            ) : null}
            {error ? (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" className={dialogCancelButtonClassName}>
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
