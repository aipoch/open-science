import { isDesktopRenderer } from '@/lib/interface-scale'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActionToast } from '@/components/ActionToast'
import { ErrorNotice } from '@/components/error-notice'
import { Notice } from '@/components/notice'
import { Button } from '@/components/ui/button'
import type { WorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import type { ChatSession } from '@/stores/session-store'
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
  dismissNotebookMemoryPressure,
  observeNotebookMemoryPolicy,
  presentNotebookMemoryRejection,
  recordNotebookMemoryCheck,
  useNotebookMemoryNoticeStore
} from '@/stores/notebook-memory-notice-store'
import {
  createProjectComputePreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { NotebookMemoryRejectedEvent } from '../../../../shared/notebook-memory'
import {
  useNotebookMemoryContinuation,
  useNotebookMemoryContinuationStatus
} from './useNotebookMemoryContinuation'

export const NotebookMemoryContinuationNotice = ({
  session
}: {
  session?: ChatSession
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const status = useNotebookMemoryContinuationStatus(isDesktopRenderer() ? session : undefined)
  if (!status) return null
  return (
    <Notice
      inline
      className="mb-2"
      role="status"
      level={status === 'started' ? 'success' : 'info'}
      description={
        status === 'continuing'
          ? t('Continuing Notebook work…')
          : status === 'started'
            ? t('Notebook execution started')
            : status === 'not-executed'
              ? t('Memory check passed. Notebook did not run this turn.')
              : t('Memory check passed. Notebook execution could not be confirmed.')
      }
    />
  )
}

type MemoryReading = NotebookMemoryRejectedEvent['memory']

function MemoryCheckDetails({
  trigger,
  latest
}: {
  trigger: MemoryReading
  latest?: MemoryReading
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const readings = latest ? [trigger, latest] : [trigger]
  const formatted = new Intl.NumberFormat(i18n?.language, { maximumFractionDigits: 2 })
  const bytes = (value: number): string =>
    value < 1024 ** 3
      ? `${formatted.format(value / 1024 ** 2)} MiB`
      : `${formatted.format(value / 1024 ** 3)} GiB`
  // An ancestor can block a healthy-looking leaf. Compare the same group and limit across checks.
  const cgroupRows = readings
    .flatMap(({ reason, limitingCgroupPath }) =>
      limitingCgroupPath && (reason === 'linux-cgroup-high' || reason === 'linux-cgroup-low')
        ? [{ path: limitingCgroupPath, high: reason === 'linux-cgroup-high' }]
        : []
    )
    .filter(
      (entry, index, all) =>
        all.findIndex((other) => other.path === entry.path && other.high === entry.high) === index
    )
  const result = (reading: MemoryReading): string => {
    if (reading.status === 'healthy') return t('Memory has recovered')
    if (reading.status === 'unavailable') return t('Unavailable')
    if (reading.reason === 'windows-commit-low' || reading.reason === 'linux-commit-low')
      return t('Low remaining commit capacity')
    if (reading.reason === 'windows-physical-low' || reading.reason === 'linux-memory-low')
      return t('Low available RAM')
    switch (reading.reason) {
      case 'mac-memory-warning':
        return t('Memory pressure warning')
      case 'mac-memory-critical':
        return t('Critical memory pressure')
      case 'mac-memory-recovering':
        return t('Waiting for stable memory pressure')
      case 'linux-cgroup-high':
        return t('cgroup throttling threshold')
      case 'linux-cgroup-low':
        return t('Low cgroup memory headroom')
      default:
        return t('System memory is under pressure')
    }
  }
  const row = (
    label: string,
    value: (reading: MemoryReading) => string | undefined
  ): React.JSX.Element | null => {
    const cells = readings.map(value)
    if (cells.every((cell) => cell === undefined)) return null
    return (
      <tr key={label} className="border-t border-border">
        <th scope="row" className="py-2 pr-2 text-left font-normal text-muted-foreground">
          {label}
        </th>
        {cells.map((cell, index) => (
          <td key={index} className="px-1 py-2 align-top tabular-nums">
            {cell ?? '—'}
          </td>
        ))}
      </tr>
    )
  }
  return (
    <details className="mt-2 border-t border-border pt-2 text-xs leading-5">
      <summary className="cursor-pointer rounded-sm text-muted-foreground underline decoration-dotted underline-offset-4">
        {t('Memory check details')}
      </summary>
      <table className="mt-2 w-full table-fixed text-left">
        <thead>
          <tr>
            <td />
            <th scope="col" className="px-1 py-1 font-medium">
              {t('When execution was blocked')}
            </th>
            {latest && (
              <th scope="col" className="px-1 py-1 font-medium">
                {t('Latest check')}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {row(t('Checked at'), (r) => new Date(r.checkedAt).toLocaleTimeString(i18n?.language))}
          {row(t('Status'), result)}
          {row(t('Recovery time remaining'), (r) =>
            r.recoveryRemainingMs === undefined
              ? undefined
              : Math.ceil(r.recoveryRemainingMs / 1000).toLocaleString(i18n?.language, {
                  style: 'unit',
                  unit: 'second',
                  unitDisplay: 'short'
                })
          )}
          {cgroupRows.map(({ path, high }) => {
            const metric = high
              ? t('cgroup usage / throttling limit')
              : t('cgroup usage / hard limit')
            return row(cgroupRows.length > 1 ? `${metric} (${path})` : metric, (r) => {
              const constraint = r.cgroupConstraints?.find((entry) => entry.path === path)
              const limit = high ? constraint?.highBytes : constraint?.maxBytes
              return constraint && limit !== undefined
                ? `${bytes(constraint.currentBytes)} / ${bytes(limit)}`
                : undefined
            })
          })}
          {row(t('Remaining capacity threshold'), (r) => {
            if (r.remainingThresholdRatio === undefined) return undefined
            const percent = r.remainingThresholdRatio.toLocaleString(i18n?.language, {
              style: 'percent',
              maximumFractionDigits: 2
            })
            return r.reason === 'windows-physical-low' && r.totalBytes !== undefined
              ? `${bytes(r.remainingThresholdRatio * r.totalBytes)} (${percent})`
              : percent
          })}
          {row(t('Available RAM / total'), (r) =>
            r.availableBytes !== undefined && r.totalBytes !== undefined
              ? `${bytes(r.availableBytes)} / ${bytes(r.totalBytes)}`
              : undefined
          )}
          {row(t('Committed / limit'), (r) =>
            r.committedBytes !== undefined && r.commitLimitBytes !== undefined
              ? `${bytes(r.committedBytes)} / ${bytes(r.commitLimitBytes)}`
              : undefined
          )}
        </tbody>
      </table>
      <details className="mt-2 text-muted-foreground">
        <summary className="cursor-pointer">{t('Technical details')}</summary>
        <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
          {JSON.stringify({ trigger, latest }, null, 2)}
        </pre>
      </details>
    </details>
  )
}

export const NotebookMemoryNoticeBridge = ({
  projectId,
  canManage = true,
  onContinue,
  sendMessage
}: {
  projectId?: string
  canManage?: boolean
  onContinue?: (event: NotebookMemoryRejectedEvent) => void | Promise<void>
  sendMessage?: WorkspaceAgentRuntime['sendMessage']
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { rejection, latestCheck, terminal, rejectedTerminalId } = useNotebookMemoryNoticeStore()
  const reproductionRejection = rejection?.source === 'reproduction'
  const terminalRejection = rejection?.source === 'user' && rejection.inputKind === 'terminal'
  const memoryDecision =
    isDesktopRenderer() && !terminalRejection && !reproductionRejection && rejection?.refusalId
      ? { ...rejection, refusalId: rejection.refusalId }
      : undefined
  const recheck = useNotebookMemoryContinuation(memoryDecision, 'notice', sendMessage)
  const needsDesktop =
    !isDesktopRenderer() &&
    Boolean(rejection?.refusalId) &&
    !terminalRejection &&
    !reproductionRejection
  const retryTerminal =
    terminalRejection && terminal && terminal.id === rejectedTerminalId && terminal.enabled
      ? terminal.retry
      : undefined
  useEffect(() => window.api.notebook?.onMemoryRejected?.(presentNotebookMemoryRejection), [])

  const memory = latestCheck ?? rejection?.memory
  const polling = useRef(false)
  const retrying = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failedCheck, setFailedCheck] = useState<NotebookMemoryRejectedEvent>()
  const refreshFailed = Boolean(rejection && failedCheck === rejection)
  const [actionError, setActionError] = useState<{ owner: string; message: string }>()
  const noticeScope = memory?.executionScope
  const noticeOwner = rejection
    ? `request:${rejection.refusalId ?? `${rejection.projectId}:${rejection.sessionId}:${rejection.inputKind}`}`
    : undefined
  useEffect(() => {
    const read = window.api.notebook?.getMemoryPolicyState
    if (!noticeScope || !rejection || !read) return
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
        setFailedCheck(undefined)
        const state = useNotebookMemoryNoticeStore.getState()
        if (state.rejection !== rejection) return
        recordNotebookMemoryCheck(rejection, next)
        if (
          next.status === 'healthy' &&
          useNotebookMemoryNoticeStore.getState().latestCheck === next
        ) {
          useNotebookMemoryNoticeStore.setState({
            dismissedPressureScopes: state.dismissedPressureScopes.filter(
              (scope) => scope !== noticeScope
            ),
            pressure:
              state.pressure?.memory.executionScope === noticeScope ? undefined : state.pressure
          })
        }
      } catch {
        if (current) setFailedCheck(rejection)
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
  }, [noticeScope, rejection])

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
  const later = (): void => {
    if (!recheck.isChecking()) dismissNotebookMemoryRejection()
  }
  const manage = (): void => {
    if (manageDisabled || recheck.isChecking()) return
    dismissNotebookMemoryRejection()
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(createProjectComputePreviewItem())
  }
  const retry = async (): Promise<void> => {
    if (!rejection || retrying.current || !noticeOwner) return
    if (memoryDecision) {
      if (rejection.projectId === projectId) await recheck.checkAndContinue()
      return
    }
    if (retryTerminal) {
      dismissNotebookMemoryRejection()
      await retryTerminal()
      return
    }
    if (
      terminalRejection ||
      !onContinue ||
      !reproductionRejection ||
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
      <Dialog.Root
        open={Boolean(rejection)}
        onOpenChange={(open) => {
          if (!open) later()
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
                  needsDesktop
                    ? t(
                        'Open the same Session and branch in the Open-Science desktop app, then choose Continue Notebook work in Compute.'
                      )
                    : t(
                        'This code did not run. Choose whether to retry or manage Notebook resources.'
                      )
                }
              >
                {rejection && (
                  <MemoryCheckDetails trigger={rejection.memory} latest={latestCheck} />
                )}
              </ErrorNotice>
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
              {recovered && !recheck.error ? (
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
              {recheck.error && <ErrorNotice inline role="alert" description={recheck.error} />}
            </div>
            <div className={dialogFooterClassName}>
              <Button variant="ghost" disabled={recheck.busy} onClick={later}>
                {memoryDecision ? t('Later') : t('Cancel')}
              </Button>
              <Button
                variant="secondary"
                disabled={manageDisabled || busy || recheck.busy}
                onClick={manage}
              >
                {memoryDecision ? t('Manage resources') : t('Manage Notebook resources')}
              </Button>
              {rejection && !needsDesktop ? (
                <Button
                  aria-busy={busy || recheck.busy || undefined}
                  disabled={
                    busy ||
                    recheck.busy ||
                    (memoryDecision
                      ? rejection.projectId !== projectId || !sendMessage
                      : terminalRejection
                        ? !retryTerminal
                        : !reproductionRejection ||
                          rejection.projectId !== projectId ||
                          !onContinue)
                  }
                  onClick={() => void retry()}
                >
                  {memoryDecision ? (
                    <span key={String(recheck.busy)} className="button-feedback">
                      {recheck.busy ? t('Checking…') : t('Check and continue')}
                    </span>
                  ) : reproductionRejection ? (
                    t('Open reproducibility checks')
                  ) : (
                    t('Recheck and retry')
                  )}
                </Button>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}

// Render in the shared bottom stack, never in the workspace's height-constrained grid.
export const NotebookMemoryPressureNotice = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  useEffect(() => window.api.notebook?.onMemoryPolicyChanged?.(observeNotebookMemoryPolicy), [])
  const pressure = useNotebookMemoryNoticeStore((state) => state.pressure)
  const rejection = useNotebookMemoryNoticeStore((state) => state.rejection)
  if (!pressure || rejection) return null
  return (
    <div data-bottom-notice className="pointer-events-auto">
      <ActionToast
        key={pressure.memory.executionScope}
        title={t('System memory is under pressure')}
        level="warning"
        dismissLabel={t('Close')}
        onDismiss={dismissNotebookMemoryPressure}
        autoDismissMs={6000}
        className="static inset-auto mx-0 w-full max-w-none"
        testId="notebook-memory-pressure-toast"
      />
    </div>
  )
}
