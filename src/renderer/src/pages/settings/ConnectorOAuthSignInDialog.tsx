/* Hallmark · component: Connector OAuth sign-in · genre: modern-minimal · theme: project Settings tokens */
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 · contrast: project tokens · slop: pass */
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { AlertDialog } from 'radix-ui'
import { LoaderCircle, X } from 'lucide-react'
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
import { useSettingsStore } from '@/stores/settings-store'
import type { CustomServerView } from '../../../../shared/settings'

type ConnectorOAuthSignInDialogProps = {
  server: CustomServerView
  onAuthenticated: () => void
  onFinish: () => void
}

// Owns the complete interactive OAuth attempt so add/list callers only select a Connector and react
// to its outcome. Main remains authoritative for browser launch, callback validation, and tokens.
const ConnectorOAuthSignInDialog = ({
  server,
  onAuthenticated,
  onFinish
}: ConnectorOAuthSignInDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const authenticateCustomServer = useSettingsStore((state) => state.authenticateCustomServer)
  const cancelCustomServerAuthentication = useSettingsStore(
    (state) => state.cancelCustomServerAuthentication
  )
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<string>()
  const pendingRef = useRef(false)
  const generationRef = useRef(0)
  const handleAuthenticated = useEffectEvent(onAuthenticated)
  const serverId = server.id

  useEffect(() => {
    const generation = ++generationRef.current
    pendingRef.current = true

    void authenticateCustomServer({ id: serverId }).then(
      () => {
        if (generationRef.current !== generation) return
        pendingRef.current = false
        handleAuthenticated()
      },
      (cause: unknown) => {
        if (generationRef.current !== generation) return
        pendingRef.current = false
        setError(cause instanceof Error ? cause.message : t('OAuth sign-in failed.'))
      }
    )

    return () => {
      if (generationRef.current !== generation || !pendingRef.current) return
      generationRef.current += 1
      pendingRef.current = false
      void cancelCustomServerAuthentication({ id: serverId })
    }
  }, [attempt, authenticateCustomServer, cancelCustomServerAuthentication, serverId, t])

  const finish = (): void => {
    generationRef.current += 1
    if (pendingRef.current) {
      pendingRef.current = false
      void cancelCustomServerAuthentication({ id: serverId })
    }
    onFinish()
  }

  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && finish()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Sign in to {{name}}', { name: server.displayName })}
            </AlertDialog.Title>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={dialogCloseButtonClassName}
              onClick={finish}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {t(
                'Complete authorization in your browser. This dialog will update when sign-in finishes.'
              )}
            </AlertDialog.Description>
            {error ? (
              <p className="mt-4 text-sm text-destructive" role="alert">
                {t(error)}
              </p>
            ) : (
              <div
                className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t('Waiting for authorization…')}
              </div>
            )}
          </div>
          <div className={dialogFooterClassName}>
            <Button
              type="button"
              variant="outline"
              className={dialogCancelButtonClassName}
              onClick={finish}
            >
              {error ? t('Finish later') : t('Cancel')}
            </Button>
            {error ? (
              <Button
                type="button"
                onClick={() => {
                  setError(undefined)
                  setAttempt((current) => current + 1)
                }}
              >
                {t('Try again')}
              </Button>
            ) : null}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

export { ConnectorOAuthSignInDialog }
export type { ConnectorOAuthSignInDialogProps }
