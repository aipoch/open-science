import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Globe2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { createSourcePreviewItem } from '@/lib/source-preview'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSettingsStore } from '@/stores/settings-store'
import { notebookNetworkSettingsAllowDomain } from '../../../../shared/notebook-network'

import { LinkSafetyModal } from './LinkSafetyModal'

type SessionMessageLinkProps = ComponentProps<'a'> & {
  node?: unknown
  'data-incomplete'?: boolean
}

type FaviconState = 'local' | 'loading' | 'success' | 'error'

const SOURCE_PREVIEW_OPEN_DELAY_MS = 350
const SOURCE_PREVIEW_CLOSE_DELAY_MS = 150
const TOUCH_ACTIVATION_RESET_MS = 1000

const getSessionLinkHostname = (href: string | undefined): string | undefined => {
  if (!href) return undefined

  try {
    const url = new URL(href)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined

    return url.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

const getSessionLinkText = (children: ReactNode): string | undefined => {
  const label = Children.toArray(children)
    .map((part) => {
      if (typeof part === 'string' || typeof part === 'number') return String(part)
      if (isValidElement<{ children?: ReactNode }>(part)) {
        return getSessionLinkText(part.props.children) ?? ''
      }
      return ''
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
  return label || undefined
}

const SessionLinkFavicon = ({
  src,
  className
}: {
  src?: string
  className?: string
}): React.JSX.Element => {
  const [state, setState] = useState<FaviconState>(src ? 'loading' : 'local')

  return (
    <span
      data-session-link-favicon=""
      data-state={state}
      aria-hidden="true"
      className={cn(
        'relative me-[0.3em] inline-grid size-[1em] place-items-center align-[-0.125em] text-sd-muted',
        className
      )}
    >
      <Globe2
        data-session-link-favicon-fallback=""
        className={cn(
          'absolute inset-0 m-0! size-full! max-w-none! border-0! bg-transparent! p-0! transition-opacity duration-150',
          state === 'success' ? 'opacity-0' : state === 'loading' ? 'opacity-50' : 'opacity-75'
        )}
      />
      {src && state !== 'error' ? (
        <img
          src={src}
          alt=""
          width="16"
          height="16"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          className={cn(
            'absolute inset-0 m-0! size-full! max-w-none! rounded-none! border-0! bg-transparent! p-0! transition-opacity duration-150',
            state === 'success' ? 'opacity-100' : 'opacity-0'
          )}
          onLoad={() => setState('success')}
          onError={() => setState('error')}
        />
      ) : null}
    </span>
  )
}

const SessionMessageLink = ({
  children,
  className,
  href,
  title,
  'data-incomplete': dataIncomplete
}: SessionMessageLinkProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [isSafetyModalOpen, setIsSafetyModalOpen] = useState(false)
  const [isSourcePreviewOpen, setIsSourcePreviewOpen] = useState(false)
  const sourcePreviewTriggerRef = useRef<HTMLAnchorElement>(null)
  const sourcePreviewContentRef = useRef<HTMLDivElement>(null)
  const sourcePreviewTitleId = useId()
  const sourcePreviewOpenTimerRef = useRef<number | undefined>(undefined)
  const sourcePreviewCloseTimerRef = useRef<number | undefined>(undefined)
  const touchActivationResetTimerRef = useRef<number | undefined>(undefined)
  const isTouchActivationRef = useRef(false)
  const isSourcePreviewFocusWithinRef = useRef(false)
  const isSourcePreviewPointerWithinRef = useRef(false)
  const suppressNextFocusOpenRef = useRef(false)
  const upsertAndActivateItem = usePreviewWorkbenchStore((state) => state.upsertAndActivateItem)
  const notebookNetwork = useSettingsStore((state) => state.notebookNetwork)
  const linkHostname = getSessionLinkHostname(href)
  const isRemoteDomainAllowed = Boolean(
    linkHostname && notebookNetworkSettingsAllowDomain(notebookNetwork, linkHostname)
  )
  const faviconUrl =
    linkHostname && isRemoteDomainAllowed ? `https://${linkHostname}/favicon.ico` : undefined
  const sourceItem = href
    ? createSourcePreviewItem({
        href,
        title:
          typeof title === 'string' && title.trim() ? title.trim() : getSessionLinkText(children)
      })
    : undefined

  const clearSourcePreviewTimers = (): void => {
    window.clearTimeout(sourcePreviewOpenTimerRef.current)
    window.clearTimeout(sourcePreviewCloseTimerRef.current)
    sourcePreviewOpenTimerRef.current = undefined
    sourcePreviewCloseTimerRef.current = undefined
  }

  const openSourcePreview = (delay = 0): void => {
    clearSourcePreviewTimers()
    if (delay === 0) {
      setIsSourcePreviewOpen(true)
      return
    }
    sourcePreviewOpenTimerRef.current = window.setTimeout(() => {
      setIsSourcePreviewOpen(true)
      sourcePreviewOpenTimerRef.current = undefined
    }, delay)
  }

  const closeSourcePreview = (): void => {
    clearSourcePreviewTimers()
    sourcePreviewCloseTimerRef.current = window.setTimeout(() => {
      if (!isSourcePreviewFocusWithinRef.current && !isSourcePreviewPointerWithinRef.current) {
        setIsSourcePreviewOpen(false)
      }
      sourcePreviewCloseTimerRef.current = undefined
    }, SOURCE_PREVIEW_CLOSE_DELAY_MS)
  }

  const dismissSourcePreview = (restoreFocus = false): void => {
    clearSourcePreviewTimers()
    isSourcePreviewPointerWithinRef.current = false
    setIsSourcePreviewOpen(false)
    if (!restoreFocus) return

    suppressNextFocusOpenRef.current = true
    window.setTimeout(() => {
      const trigger = sourcePreviewTriggerRef.current
      if (trigger && document.activeElement !== trigger) {
        trigger.focus({ preventScroll: true })
      }
      suppressNextFocusOpenRef.current = false
    }, 0)
  }

  const activateSource = (restoreFocus = false): void => {
    dismissSourcePreview(restoreFocus)
    if (sourceItem && isRemoteDomainAllowed) {
      upsertAndActivateItem(sourceItem)
      return
    }
    setIsSafetyModalOpen(true)
  }

  useEffect(
    () => () => {
      clearSourcePreviewTimers()
      window.clearTimeout(touchActivationResetTimerRef.current)
    },
    []
  )

  if (sourceItem) {
    const hostname = linkHostname ?? new URL(sourceItem.url).hostname

    return (
      <Popover
        open={isSourcePreviewOpen}
        onOpenChange={(open) => {
          clearSourcePreviewTimers()
          setIsSourcePreviewOpen(open)
        }}
      >
        <PopoverTrigger asChild>
          <a
            ref={sourcePreviewTriggerRef}
            href={sourceItem.url}
            data-source-preview-link=""
            data-incomplete={dataIncomplete}
            data-session-message-link=""
            data-streamdown="link"
            className={className}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'touch') {
                isSourcePreviewPointerWithinRef.current = true
                openSourcePreview(SOURCE_PREVIEW_OPEN_DELAY_MS)
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== 'touch') {
                isSourcePreviewPointerWithinRef.current = false
                closeSourcePreview()
              }
            }}
            onPointerDown={(event) => {
              window.clearTimeout(touchActivationResetTimerRef.current)
              isTouchActivationRef.current = event.pointerType === 'touch'
              if (isTouchActivationRef.current) {
                touchActivationResetTimerRef.current = window.setTimeout(() => {
                  isTouchActivationRef.current = false
                }, TOUCH_ACTIVATION_RESET_MS)
              }
            }}
            onPointerCancel={() => {
              window.clearTimeout(touchActivationResetTimerRef.current)
              isTouchActivationRef.current = false
            }}
            onFocus={() => {
              isSourcePreviewFocusWithinRef.current = true
              if (suppressNextFocusOpenRef.current) {
                suppressNextFocusOpenRef.current = false
                return
              }
              openSourcePreview()
            }}
            onBlur={(event) => {
              if (!sourcePreviewContentRef.current?.contains(event.relatedTarget as Node | null)) {
                isSourcePreviewFocusWithinRef.current = false
                closeSourcePreview()
              }
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Tab' || event.shiftKey || !isSourcePreviewOpen) return
              const firstAction = sourcePreviewContentRef.current?.querySelector<HTMLElement>(
                '[data-source-preview-hover-url]'
              )
              if (!firstAction) return
              event.preventDefault()
              firstAction.focus()
            }}
            onClick={(event) => {
              event.preventDefault()
              window.clearTimeout(touchActivationResetTimerRef.current)
              if (isTouchActivationRef.current) {
                isTouchActivationRef.current = false
                openSourcePreview()
                return
              }
              activateSource()
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              event.preventDefault()
              activateSource()
            }}
          >
            <SessionLinkFavicon key={faviconUrl ?? 'local'} src={faviconUrl} />
            {children}
          </a>
        </PopoverTrigger>
        <PopoverContent
          ref={sourcePreviewContentRef}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          data-source-preview-hover-card=""
          aria-labelledby={sourcePreviewTitleId}
          className="w-fit min-w-56 max-w-[min(24rem,calc(100vw-1rem))] border border-border-300 bg-bg-000 p-3 text-text-000 shadow-card"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => dismissSourcePreview(true)}
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') {
              isSourcePreviewPointerWithinRef.current = true
              clearSourcePreviewTimers()
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'touch') {
              isSourcePreviewPointerWithinRef.current = false
              closeSourcePreview()
            }
          }}
          onFocusCapture={() => {
            isSourcePreviewFocusWithinRef.current = true
            clearSourcePreviewTimers()
          }}
          onBlurCapture={(event) => {
            const nextTarget = event.relatedTarget as Node | null
            if (
              !event.currentTarget.contains(nextTarget) &&
              !sourcePreviewTriggerRef.current?.contains(nextTarget)
            ) {
              isSourcePreviewFocusWithinRef.current = false
              closeSourcePreview()
            }
          }}
        >
          <div
            data-source-preview-hover-layout=""
            className={cn(
              'grid min-w-0 items-stretch',
              linkHostname ? 'grid-cols-[auto_minmax(0,1fr)] gap-x-2.5' : 'grid-cols-1'
            )}
          >
            {linkHostname ? (
              <div data-source-preview-hover-icon-column="" className="flex items-start">
                <SessionLinkFavicon
                  key={faviconUrl ?? 'local'}
                  className="mt-0.5 me-0 size-5 shrink-0"
                  src={faviconUrl}
                />
              </div>
            ) : null}
            <div data-source-preview-hover-content-column="" className="min-w-0">
              <div data-source-preview-hover-summary="" className="min-w-0">
                <div
                  id={sourcePreviewTitleId}
                  data-source-preview-hover-title=""
                  className="break-words text-sm font-medium leading-5 text-text-000"
                >
                  {sourceItem.title}
                </div>
                <div
                  data-source-preview-hover-hostname=""
                  className="truncate text-xs leading-4 text-text-000/70"
                >
                  {hostname}
                </div>
              </div>
              <div
                data-source-preview-hover-actions=""
                className="mt-3 flex min-w-0 items-center gap-2"
              >
                <a
                  href={sourceItem.url}
                  data-source-preview-hover-url=""
                  title={sourceItem.url}
                  className="min-w-0 flex-1 break-all text-xs leading-4 text-text-000 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                  onClick={(event) => {
                    event.preventDefault()
                    activateSource(true)
                  }}
                >
                  {sourceItem.url}
                </a>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-source-preview-hover-external=""
                        aria-label={t('Open source in browser')}
                        className="text-text-100 hover:text-text-000"
                        onClick={(event) => {
                          event.stopPropagation()
                          dismissSourcePreview(true)
                          window.open(sourceItem.url, '_blank', 'noreferrer')
                        }}
                      >
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('Open source in browser')}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </div>
        </PopoverContent>
        <LinkSafetyModal
          url={sourceItem.url}
          isOpen={isSafetyModalOpen}
          onClose={() => setIsSafetyModalOpen(false)}
          onConfirm={() => window.open(sourceItem.url, '_blank', 'noreferrer')}
        />
      </Popover>
    )
  }

  return (
    <>
      <button
        type="button"
        className={className}
        title={title}
        data-incomplete={dataIncomplete}
        data-session-message-link=""
        data-streamdown="link"
        disabled={!href}
        onClick={() => setIsSafetyModalOpen(true)}
      >
        {linkHostname ? <SessionLinkFavicon key={faviconUrl ?? 'local'} src={faviconUrl} /> : null}
        {children}
      </button>
      {href ? (
        <LinkSafetyModal
          url={href}
          isOpen={isSafetyModalOpen}
          onClose={() => setIsSafetyModalOpen(false)}
          onConfirm={() => window.open(href, '_blank', 'noreferrer')}
        />
      ) : null}
    </>
  )
}

export { SessionMessageLink }
