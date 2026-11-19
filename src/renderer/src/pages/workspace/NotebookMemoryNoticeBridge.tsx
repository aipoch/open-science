import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogBodyClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  dismissNotebookMemoryRejection,
  observeNotebookMemoryPolicy,
  presentNotebookMemoryRejection,
  useNotebookMemoryNoticeStore
} from '@/stores/notebook-memory-notice-store'
import {
  createProjectComputePreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { NotebookMemoryRejectedEvent } from '../../../../shared/notebook-memory'

export const NotebookMemoryNoticeBridge = ({
  projectId,
  canManage = true,
  onContinue
}: {
  projectId?: string
  canManage?: boolean
  onContinue?: (event: NotebookMemoryRejectedEvent) => void | Promise<void>
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { rejection, terminal, rejectedTerminalId, warning, pressure } =
    useNotebookMemoryNoticeStore()
  const reproductionRejection = rejection?.source === 'reproduction'
  const terminalRejection = rejection?.source === 'user' && rejection.inputKind === 'terminal'
  const retryTerminal =
    terminalRejection && terminal && terminal.id === rejectedTerminalId && terminal.enabled
      ? terminal.retry
      : undefined
  useEffect(() => window.api.notebook?.onMemoryRejected?.(presentNotebookMemoryRejection), [])
  useEffect(() => window.api.notebook?.onMemoryPolicyChanged?.(observeNotebookMemoryPolicy), [])

  const memory = rejection?.memory ?? warning?.memory
  const polling = useRef(false)
  const retrying = useRef(false)
  const [busy, setBusy] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [actionError, setActionError] = useState<{ owner: string; message: string }>()
  const noticeScope = memory?.executionScope
  const noticeOwner = rejection
    ? `request:${rejection.refusalId ?? `${rejection.projectId}:${rejection.sessionId}:${rejection.inputKind}`}`
    : warning
      ? 'critical'
      : undefined
  useEffect(() => {
    const read = window.api.notebook?.getMemoryPolicyState
    if (!noticeScope || !noticeOwner || !read) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      if (polling.current) {
        timer = setTimeout(() => void refresh(), 5000)
        return
      }
      polling.current = true
      try {
        const next = await read({ executionScope: noticeScope })
        if (!current) return
        setRefreshFailed(false)
        const state = useNotebookMemoryNoticeStore.getState()
        useNotebookMemoryNoticeStore.setState({
          ...(next.status === 'healthy'
            ? {
                criticalScopes: state.criticalScopes.filter((scope) => scope !== noticeScope),
                pressure:
                  state.pressure?.memory.executionScope === noticeScope ? undefined : state.pressure
              }
            : {}),
          ...(state.rejection?.memory.executionScope === noticeScope
            ? { rejection: { ...state.rejection, memory: next } }
            : {}),
          ...(state.warning?.memory.executionScope === noticeScope
            ? { warning: { ...state.warning, memory: next } }
            : {})
        })
      } catch {
        if (current) setRefreshFailed(true)
      } finally {
        polling.current = false
        if (current) timer = setTimeout(() => void refresh(), 5000)
      }
    }
    void refresh()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [noticeScope, noticeOwner])

  const recovered = memory?.status === 'healthy' && !refreshFailed
  const unavailable = memory?.status === 'unavailable'
  const repairRequired =
    unavailable &&
    [
      'memory-component-unavailable',
      'mac-memory-unavailable',
      'platform-unavailable',
      'execution-domain-unavailable'
    ].includes(memory.reason)
  const manageDisabled = !canManage || Boolean(rejection && rejection.projectId !== projectId)
  const manage = (): void => {
    if (manageDisabled) return
    dismissNotebookMemoryRejection()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectComputePreviewItem())
  }
  const retry = async (): Promise<void> => {
    if (!rejection || retrying.current || !noticeOwner) return
    if (retryTerminal) {
      dismissNotebookMemoryRejection()
      await retryTerminal()
      return
    }
    if (
      terminalRejection ||
      !onContinue ||
      (!reproductionRejection && !rejection.refusalId) ||
      rejection.projectId !== projectId
    )
      return
    retrying.current = true
    setBusy(true)
    try {
      await onContinue(rejection)
      const latest = useNotebookMemoryNoticeStore.getState().rejection
      if (latest?.refusalId === rejection.refusalId && latest?.sessionId === rejection.sessionId)
        dismissNotebookMemoryRejection()
    } catch (error) {
      setActionError({
        owner: noticeOwner,
        message: error instanceof Error ? error.message : String(error)
      })
    } finally {
      retrying.current = false
      setBusy(false)
    }
  }
  return (
    <>
      {pressure && !rejection && !warning ? (
        <ErrorNotice
          inline
          role="status"
          tone="amber"
          title={t('System memory is under pressure')}
          description={t(
            'Notebook resources are active. Manage them in Compute if they are no longer needed.'
          )}
          primaryButton={{
            label: t('Manage Notebook resources'),
            onClick: manage,
            disabled: manageDisabled
          }}
        />
      ) : null}
      <Dialog.Root
        open={Boolean(rejection || warning)}
        onOpenChange={(open) => {
          if (!open) dismissNotebookMemoryRejection()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            className={dialogPanelClassName('flex w-[min(520px,calc(100vw-2rem))] flex-col p-0')}
            data-testid="notebook-memory-notice"
          >
            <div className={dialogHeaderClassName}>
              <Dialog.Title className={dialogTitleClassName}>
                {recovered
                  ? t('Notebook execution needs your decision.')
                  : unavailable
                    ? t('Notebook memory checking is unavailable')
                    : t('System memory is under pressure')}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                {t('Notebook execution needs your decision.')}
              </Dialog.Description>
            </div>
            <div className={dialogBodyClassName}>
              <ErrorNotice
                inline
                tone="amber"
                description={
                  rejection
                    ? t(
                        'This code did not run. Choose whether to retry or manage Notebook resources.'
                      )
                    : t(
                        'Notebook resources are active. Manage them in Compute if they are no longer needed.'
                      )
                }
                errorCode={memory ? JSON.stringify(memory, null, 2) : undefined}
                diagnosticsLabel={t('Memory check details')}
              />
              {repairRequired ? (
                <p className="mt-3 text-sm text-text-200">
                  {t(
                    'The memory checking component is unavailable. Update or repair the installation before retrying.'
                  )}
                </p>
              ) : unavailable ? (
                <p className="mt-3 text-sm text-text-200">
                  {t(
                    'Available memory could not be confirmed. Recheck after the sampling cooldown.'
                  )}
                </p>
              ) : null}
              {refreshFailed ? (
                <p className="mt-3 text-sm text-text-200" role="status">
                  {t('The latest memory status could not be read. Retry will check it again.')}
                </p>
              ) : null}
              {recovered ? (
                <p className="mt-3 text-sm text-text-200" role="status">
                  {t('Memory has recovered. Execution still requires your choice.')}
                </p>
              ) : null}
              {terminalRejection && !retryTerminal ? (
                <p className="mt-3 text-sm text-text-200">
                  {t('Return to the same active Notebook terminal to retry its current contents.')}
                </p>
              ) : null}
              {rejection && rejection.projectId !== projectId ? (
                <p className="mt-3 text-sm text-text-200">
                  {t('Open the affected project to retry or manage its Notebook resources.')}
                </p>
              ) : null}
              {actionError && actionError.owner === noticeOwner ? (
                <ErrorNotice inline description={actionError.message} />
              ) : null}
            </div>
            <div className={dialogFooterClassName}>
              <Button variant="ghost" onClick={dismissNotebookMemoryRejection}>
                {t('Cancel')}
              </Button>
              <Button variant="secondary" disabled={manageDisabled || busy} onClick={manage}>
                {t('Manage Notebook resources')}
              </Button>
              {rejection ? (
                <Button
                  aria-busy={busy || undefined}
                  disabled={
                    busy ||
                    (terminalRejection
                      ? !retryTerminal
                      : (!reproductionRejection && !rejection.refusalId) ||
                        rejection.projectId !== projectId ||
                        !onContinue)
                  }
                  onClick={() => void retry()}
                >
                  {reproductionRejection
                    ? t('Open reproducibility checks')
                    : t('Recheck and retry')}
                </Button>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
