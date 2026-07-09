import type { LinkSafetyModalProps } from 'streamdown'
import { Check, Copy, ExternalLink, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// Same portal chrome as table fullscreen: flat mask, header bar, white card body.
const LinkSafetyModal = ({
  url,
  isOpen,
  onClose,
  onConfirm
}: LinkSafetyModalProps): React.JSX.Element | null => {
  const [copied, setCopied] = useState(false)

  const closeModal = useCallback((): void => {
    setCopied(false)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeModal()
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
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

  if (!isOpen) {
    return null
  }

  return createPortal(
    <div
      aria-label="Open external link?"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-streamdown="link-safety-modal"
      onClick={closeModal}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          closeModal()
        }
      }}
      role="dialog"
    >
      <div
        role="presentation"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <div>
          <button type="button" onClick={closeModal} aria-label="Close">
            <X className="size-3.5" strokeWidth={2} aria-hidden />
          </button>
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
    </div>,
    document.body
  )
}

export { LinkSafetyModal }
