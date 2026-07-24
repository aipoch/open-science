import type { LinkSafetyModalProps } from 'streamdown'
import { Check, Copy, ExternalLink, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'

const LinkSafetyModal = ({
  url,
  isOpen,
  onClose,
  onConfirm
}: LinkSafetyModalProps): React.JSX.Element | null => {
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

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeModal()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeModal, isOpen])

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
        className={cn(dialogOverlayClassName, 'break-normal')}
        data-state={isOpen ? 'open' : 'closed'}
        data-streamdown="link-safety-modal"
      />
      <div
        className={dialogPanelClassName(
          'flex h-auto max-h-[min(90vh,640px)] w-[min(420px,calc(100vw-3rem))] flex-col overflow-hidden p-0'
        )}
        data-state={isOpen ? 'open' : 'closed'}
        data-streamdown="link-safety-panel"
        inert={!isOpen}
        ref={panelRef}
        aria-label="Open external link?"
        aria-hidden={!isOpen}
        aria-modal="true"
        role="dialog"
      >
        <div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={dialogCloseButtonClassName}
            onClick={closeModal}
            aria-label="Close"
          >
            <X className="size-4" strokeWidth={2} aria-hidden />
          </Button>
        </div>

        <div className="sd-link-safety-body">
          <p className="sd-link-safety-description">You are about to visit an external website.</p>

          <div
            className={url.length > 100 ? 'sd-link-safety-url max-scroll' : 'sd-link-safety-url'}
          >
            {url}
          </div>

          <div className="sd-link-safety-actions">
            <button type="button" onClick={() => void copyLink()}>
              {copied && isOpen ? (
                <>
                  <Check className="size-3.5" aria-hidden />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="size-3.5" aria-hidden />
                  Copy link
                </>
              )}
            </button>
            <button
              type="button"
              className="sd-link-safety-primary"
              onClick={() => {
                onConfirm()
                closeModal()
              }}
            >
              <ExternalLink className="size-3.5" aria-hidden />
              Open link
            </button>
          </div>
        </div>
      </div>
    </Fragment>,
    document.body
  )
}

export { LinkSafetyModal }
