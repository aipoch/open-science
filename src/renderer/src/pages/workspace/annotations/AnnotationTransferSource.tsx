import { TransferSourceContext, type SourceContext } from './use-annotation-drag'
import { useContext, useRef, useState, type ReactElement, type PropsWithChildren } from 'react'
import { ArrowRightLeft, ChevronRight, MessageSquare, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ActionMenuProvider, ActionMenuTarget, useActionMenu } from '@/components/action-menu'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName,
  dialogHeaderClassName,
  dialogFooterClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import { validateAnnotations, type Annotation } from '../../../../../shared/annotations'
import { sideChatSummary } from '../side-chat-summary'
import { useSideChatTransfers } from '../use-side-chat-controller'
import { annotationTransfers } from './annotation-transfer'

const catalog = { move: { labelKey: 'Move to Side chat…', icon: ArrowRightLeft } }
const recipe = [{ kind: 'action' as const, action: 'move' as const }]

export function AnnotationTransferSource({
  children,
  ...source
}: PropsWithChildren<Omit<SourceContext, 'select'>>): React.JSX.Element {
  const { t } = useTranslation()
  const targets = useSideChatTransfers()
  const availableTargets = targets.views.filter(
    (view) => view.parentSessionId === source.parentSessionId && view.projectId === source.projectId
  )
  const newChatReason = targets.unavailableReason({
    sessionId: source.parentSessionId,
    projectId: source.projectId
  })
  const [token, setToken] = useState<string>()
  const [error, setError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [restoreError, setRestoreError] = useState<string>()
  const refreshGeneration = useRef(0)
  const select = (value: string): void => {
    setError(false)
    setToken(value)
    setRestoreError(undefined)
    const generation = ++refreshGeneration.current
    const pending = targets.refresh()
    if (!pending) return
    setRefreshing(true)
    void pending
      .catch((reason: unknown) => {
        if (refreshGeneration.current === generation)
          setRestoreError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (refreshGeneration.current === generation) setRefreshing(false)
      })
  }
  const move = (id?: string): void => {
    if (!token) return
    const transfer = annotationTransfers.read(token)
    if (!transfer || validateAnnotations([transfer.annotation])) {
      setError(true)
      return
    }
    const targetId =
      id ?? targets.create({ sessionId: transfer.parentSessionId, projectId: transfer.projectId })
    if (
      !targetId ||
      !annotationTransfers.commit(token, (item) => targets.receive(targetId, item))
    ) {
      setError(true)
      return
    }
    targets.open(targetId)
    setToken(undefined)
  }
  return (
    <TransferSourceContext.Provider value={{ ...source, select }}>
      <ActionMenuProvider>{children}</ActionMenuProvider>
      <Dialog.Root
        open={Boolean(token)}
        onOpenChange={(open) => {
          if (!open) {
            refreshGeneration.current += 1
            setRefreshing(false)
            setToken(undefined)
            annotationTransfers.cancel()
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}>
            <div className={dialogHeaderClassName}>
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border-200 bg-bg-100 text-text-200">
                  <ArrowRightLeft className="size-4" aria-hidden="true" />
                </span>
                <Dialog.Title className={dialogTitleClassName}>
                  {t('Move to Side chat')}
                </Dialog.Title>
              </div>
            </div>
            <div className="space-y-4 p-5">
              <Dialog.Description className={dialogDescriptionClassName}>
                {t(
                  'Choose a Side chat. The annotation will be added to its draft without sending.'
                )}
              </Dialog.Description>
              {refreshing ? (
                <p role="status" className="text-xs text-text-300">
                  {t('Loading…')}
                </p>
              ) : null}
              {restoreError ? (
                <p role="alert" className="text-xs text-danger-000">
                  {t('Could not restore Side chats: {{error}}', { error: restoreError })}
                </p>
              ) : null}
              {availableTargets.length > 0 ? (
                <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                  {availableTargets.map((view) => {
                    const summary = sideChatSummary(view) || t('Empty draft')
                    return (
                      <button
                        key={view.id}
                        type="button"
                        className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        disabled={Boolean(
                          targets.unavailableReason(
                            { sessionId: view.parentSessionId, projectId: view.projectId },
                            view.id
                          )
                        )}
                        title={targets.unavailableReason(
                          { sessionId: view.parentSessionId, projectId: view.projectId },
                          view.id
                        )}
                        onClick={() => move(view.id)}
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-bg-200 text-text-200">
                          <MessageSquare className="size-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-text-000">
                            {summary}
                          </span>
                          <span className="block text-xs text-text-300">{t('Side chat')}</span>
                        </span>
                        <ChevronRight
                          className="size-4 shrink-0 text-text-300 transition-transform group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </button>
                    )
                  })}
                </div>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="w-full justify-start gap-2 rounded-lg shadow-none"
                disabled={Boolean(newChatReason)}
                title={newChatReason}
                onClick={() => move()}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t('New side chat')}
              </Button>
              {newChatReason ? (
                <p role="status" className="text-xs text-text-300">
                  {newChatReason}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-danger-000">
                  {t('Could not move this annotation. It may have changed or the target is full.')}
                </p>
              ) : null}
            </div>
            <div className={dialogFooterClassName}>
              <Dialog.Close asChild>
                <Button variant="ghost">{t('Cancel')}</Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </TransferSourceContext.Provider>
  )
}

export function AnnotationMoveTarget({
  annotation,
  children
}: {
  annotation: Annotation
  children: ReactElement
}): React.JSX.Element {
  const source = useContext(TransferSourceContext)
  if (!source?.select) return children
  return (
    <MoveMenuTarget source={source} annotation={annotation}>
      {children}
    </MoveMenuTarget>
  )
}
function MoveMenuTarget({
  source,
  annotation,
  children
}: {
  source: SourceContext
  annotation: Annotation
  children: ReactElement
}): React.JSX.Element {
  const menu = useActionMenu()
  const id = `${source.sourceId}:${annotation.id}`
  return (
    <ActionMenuTarget
      asChild
      targetId={`annotation-move:${id}`}
      identityKey={id}
      invocation={annotation}
      catalog={catalog}
      recipe={recipe}
      bindings={{
        move: {
          disabled: source.disabled,
          execute: () => {
            const token = annotationTransfers.begin(id)
            if (token) source.select?.(token)
          }
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        menu.openMenu({
          targetId: `annotation-move:${id}`,
          pointer: { x: rect.left, y: rect.bottom },
          focusTarget: event.target instanceof HTMLElement ? event.target : event.currentTarget
        })
      }}
    >
      {children}
    </ActionMenuTarget>
  )
}
