import type { LinkSafetyModalProps as StreamdownLinkSafetyModalProps } from 'streamdown'
import { FocusScope } from '@radix-ui/react-focus-scope'
import { Check, Copy, ExternalLink, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'

type LinkSafetyModalProps = StreamdownLinkSafetyModalProps & {
  confirmLabel?: string
  description?: string
}

const LinkSafetyModal = ({
  url,
  isOpen,
  onClose,
  onConfirm,
  confirmLabel,
  description
}: LinkSafetyModalProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [isMounted, setIsMounted] = useState(isOpen)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const closeModal = useCallback((): void => {
    setCopied(false)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (isOpen) {
      const timeout = window.setTimeout(() => {
        setIsMounted(true)
      }, 0)

      return () => {
        window.clearTimeout(timeout)
      }
    }

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const timeout = window.setTimeout(
      () => {
        setIsMounted(false)
      },
      reducedMotion ? 0 : 400
    )

    return () => {
      window.clearTimeout(timeout)
    }
  }, [isOpen])

  useEffect(() => {
    const panel = panelRef.current

    if (!panel || isOpen || !isMounted) {
      return
    }

    const onAnimationEnd = (event: AnimationEvent): void => {
      if (event.target === panel) {
        setIsMounted(false)
      }
    }

    panel.addEventListener('animationend', onAnimationEnd)

    return () => {
      panel.removeEventListener('animationend', onAnimationEnd)
    }
  }, [isMounted, isOpen])

  useEffect(() => {
    if (!isMounted) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isMounted])

  const copyLink = useCallback(async (): Promise<void> => {
    if (!navigator.clipboard?.writeText) {
      return
    }

    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => {
        setCopied(false)
      }, 2000)
    } catch {
      // Clipboard may be unavailable in sandboxed contexts.
    }
  }, [url])

  if (!isOpen && !isMounted) {
    return null
  }

  return createPortal(
    <Fragment>
      <div
        aria-hidden="true"
        className={cn(dialogOverlayClassName, 'z-[80] pointer-events-auto break-normal')}
        data-state={isOpen ? 'open' : 'closed'}
        data-streamdown="link-safety-modal"
      />
      <FocusScope asChild loop trapped={isOpen}>
        <div
          className={dialogPanelClassName(
            'z-[80] pointer-events-auto flex h-auto max-h-[min(90vh,640px)] w-[min(420px,calc(100vw-3rem))] flex-col overflow-hidden p-0'
          )}
          data-state={isOpen ? 'open' : 'closed'}
          data-streamdown="link-safety-panel"
          inert={!isOpen}
          ref={panelRef}
          aria-label={t('Open external link?')}
          aria-hidden={!isOpen}
          aria-modal="true"
          role="dialog"
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape' || !isOpen) return
            event.preventDefault()
            event.stopPropagation()
            closeModal()
          }}
        >
          <div className={dialogHeaderClassName}>
            <h2 className={dialogTitleClassName}>{t('Open external link?')}</h2>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={dialogCloseButtonClassName}
              onClick={closeModal}
              aria-label={tCommon('Close')}
            >
              <X className="size-4" strokeWidth={2} aria-hidden />
            </Button>
          </div>

          <div className={cn(dialogBodyClassName, 'min-h-0 overflow-y-auto')}>
            <p className={dialogDescriptionClassName}>
              {description ?? t('You are about to visit an external website.')}
            </p>

            <div
              className={cn(
                'mt-3 break-words rounded-lg border border-border bg-muted p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]',
                url.length > 100 && 'max-h-32 overflow-y-auto'
              )}
            >
              {url}
            </div>
          </div>
          <div className={dialogFooterClassName}>
            <Button type="button" variant="outline" onClick={() => void copyLink()}>
              <span key={String(copied && isOpen)} className="button-feedback">
                {copied && isOpen ? (
                  <>
                    <Check className="size-3.5" aria-hidden />
                    {t('Copied')}
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" aria-hidden />
                    {t('Copy link')}
                  </>
                )}
              </span>
            </Button>
            <Button
              type="button"
              onClick={() => {
                onConfirm()
                closeModal()
              }}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {confirmLabel ?? t('Open link')}
            </Button>
          </div>
        </div>
      </FocusScope>
    </Fragment>,
    document.body
  )
}

export { LinkSafetyModal }
