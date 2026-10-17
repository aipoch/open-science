import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { useRunObservationQuestionStore } from '@/stores/run-observation-question-store'
import { isResearchDemoCarrier, refreshResearchDemoCarriers } from '@/stores/research-demo-store'
import { loadPersistedSession } from '@/lib/session-persistence/session-persistence'
import type {
  ResearchDemoSource,
  ResearchDemoInspection,
  ResearchDemoReceipt,
  ResearchDemoState,
  ResearchDemoBlockReason,
  StartResearchDemoRequest
} from '../../../../../shared/research-demo'
import { RunObservationPreview } from '../RunObservationPreview'
import { useObservationQuestionRecovery } from './use-observation-question-recovery'
import { DemoViewingNotice } from './DemoViewingNotice'

const researchDemoIsActive = (state: ResearchDemoState): boolean =>
  ['preparing', 'starting', 'running', 'saving', 'recovery-pending'].includes(state)

const sameSource = (left: ResearchDemoSource, right: ResearchDemoSource): boolean =>
  left.projectId === right.projectId &&
  left.sourceSessionId === right.sourceSessionId &&
  left.sourceImportId === right.sourceImportId

type Props = { source: ResearchDemoSource; isActive: boolean }

/** An explicit Replay action. Package declarations are inspected by Main, and Main owns the
 * operation. This surface never submits a conversation, supplies a shell command or owns a process. */
const ResearchDemoPanelContent = ({ source, isActive }: Props): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const [inspection, setInspection] = useState<ResearchDemoInspection>()
  const [receipts, setReceipts] = useState<ResearchDemoReceipt[]>([])
  const [selectedDemo, setSelectedDemo] = useState('')
  const [viewing, setViewing] = useState<string>()
  const [loading, setLoading] = useState(
    () => typeof window.api?.researchDemos?.inspect === 'function'
  )
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState<string>()
  const [error, setError] = useState<'load' | 'start' | 'stop' | 'record'>()
  const [refreshKey, setRefreshKey] = useState(0)
  const active = useRef(true)
  const currentView = useRef({ isActive, viewing })
  useLayoutEffect(() => {
    currentView.current = { isActive, viewing }
  }, [isActive, viewing])
  const pendingStart = useRef(false)
  const pendingStop = useRef(false)
  // Preserve an uncertain request's identity. A retry must never create another execution.
  const attempted = useRef<StartResearchDemoRequest | undefined>(undefined)
  const supported = typeof window.api?.researchDemos?.inspect === 'function'
  const recovery = useObservationQuestionRecovery(
    {
      projectId: source.projectId,
      sessionId: source.sourceSessionId
    },
    viewing ? { source, requestId: viewing, purpose: 'offline-demo' } : undefined
  )
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const putReceipt = useCallback(
    (receipt: ResearchDemoReceipt): void => {
      if (!active.current || !sameSource(source, receipt.source)) return
      setReceipts((current) =>
        [receipt, ...current.filter((item) => item.requestId !== receipt.requestId)].sort(
          (left, right) => right.createdAt - left.createdAt
        )
      )
      if (receipt.sessionId && !isResearchDemoCarrier(source.projectId, receipt.sessionId))
        void refreshResearchDemoCarriers(source.projectId)
    },
    [source]
  )
  useEffect(() => {
    if (!supported) return
    let current = true
    void Promise.allSettled([
      window.api.researchDemos.inspect(source),
      window.api.researchDemos.list(source)
    ]).then(([inspected, history]) => {
      if (!current) return
      if (inspected.status === 'fulfilled' && sameSource(inspected.value.source, source)) {
        setInspection(inspected.value)
        setSelectedDemo((selected) =>
          inspected.value.candidates.some((candidate) => candidate.demoVersionId === selected)
            ? selected
            : ((
                inspected.value.candidates.find((candidate) => candidate.status === 'ready') ??
                inspected.value.candidates[0]
              )?.demoVersionId ?? '')
        )
      } else {
        setInspection(undefined)
        setError('load')
      }
      if (history.status === 'fulfilled')
        setReceipts(history.value.receipts.filter((receipt) => sameSource(receipt.source, source)))
      else setError('load')
      setLoading(false)
      void refreshResearchDemoCarriers(source.projectId)
    })
    return () => {
      current = false
    }
  }, [source, supported, refreshKey])

  const pendingIds = receipts
    .filter((receipt) => researchDemoIsActive(receipt.state))
    .map((receipt) => receipt.requestId)
    .sort()
    .join(',')
  useEffect(() => {
    if (!supported || !isActive || !pendingIds) return
    let current = true
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling || !current) return
      polling = true
      const results = await Promise.allSettled(
        pendingIds
          .split(',')
          .map((requestId) => window.api.researchDemos.get({ ...source, requestId }))
      )
      if (current)
        for (const result of results) {
          if (result.status === 'fulfilled') putReceipt(result.value)
          else setError('load')
        }
      polling = false
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2000)
    return () => {
      current = false
      window.clearInterval(timer)
    }
  }, [source, supported, isActive, pendingIds, putReceipt])

  const stateLabels: Record<ResearchDemoState, string> = {
    preparing: t('Preparing demo…'),
    starting: t('Starting project…'),
    running: t('Demo running'),
    saving: t('Saving demo records…'),
    completed: t('Demo completed'),
    failed: t('Demo failed'),
    cancelled: t('Demo stopped'),
    interrupted: t('Demo interrupted'),
    'recovery-pending': t('Demo recovery pending')
  }
  const blockerLabels: Record<ResearchDemoBlockReason, string> = {
    'invalid-demo': t('The offline demo declaration is invalid.'),
    'unsupported-demo': t('This offline demo version is not supported.'),
    'descriptor-unavailable': t('The research description required by this demo is unavailable.'),
    'materials-unavailable': t('Required demo materials are unavailable.'),
    'runtime-unavailable': t('No compatible runtime is ready for this demo.'),
    'entrypoint-unavailable': t('The declared demo entrypoint is unavailable.'),
    'secrets-required': t('An offline demo cannot require private credentials.'),
    'service-unavailable': t('This device cannot host the demo project interface.')
  }
  const errorLabels = {
    load: t('Could not load offline demos. Please retry.'),
    start: t(
      'Could not start this demo. Retry checks the same request without a second execution.'
    ),
    stop: t('Could not stop this demo. Check its current status.'),
    record: t('Could not open the execution record. Please retry.')
  }
  const candidate = inspection?.candidates.find((item) => item.demoVersionId === selectedDemo)
  const busy = receipts.some((receipt) => researchDemoIsActive(receipt.state))
  const start = async (): Promise<void> => {
    if (!inspection || !candidate || candidate.status !== 'ready' || busy || pendingStart.current)
      return
    pendingStart.current = true
    setStarting(true)
    setError(undefined)
    const previous = attempted.current
    const request =
      previous &&
      previous.demoVersionId === candidate.demoVersionId &&
      previous.expectedSourceIdentity === inspection.source.identity
        ? previous
        : {
            ...source,
            demoVersionId: candidate.demoVersionId,
            expectedSourceIdentity: inspection.source.identity,
            requestId: crypto.randomUUID()
          }
    attempted.current = request
    try {
      const receipt = await window.api.researchDemos.start(request)
      if (!sameSource(receipt.source, source) || receipt.requestId !== request.requestId)
        throw new Error('Demo receipt does not match its request.')
      putReceipt(receipt)
      if (active.current) setViewing(receipt.requestId)
      attempted.current = undefined
    } catch {
      if (active.current) setError('start')
    } finally {
      pendingStart.current = false
      if (active.current) setStarting(false)
    }
  }
  const stop = async (receipt: ResearchDemoReceipt): Promise<void> => {
    if (pendingStop.current) return
    pendingStop.current = true
    setStopping(receipt.requestId)
    setError(undefined)
    try {
      putReceipt(await window.api.researchDemos.stop({ ...source, requestId: receipt.requestId }))
    } catch {
      if (active.current) setError('stop')
    } finally {
      pendingStop.current = false
      if (active.current) setStopping(undefined)
    }
  }
  const openRecord = async (receipt: ResearchDemoReceipt): Promise<void> => {
    if (!receipt.sessionId) return
    setError(undefined)
    const revision = useNavigationStore.getState().explicitNavigationRevision
    try {
      const session = await loadPersistedSession({
        projectId: source.projectId,
        sessionId: receipt.sessionId
      })
      if (!active.current || useNavigationStore.getState().explicitNavigationRevision !== revision)
        return
      if (!session || session.projectId !== source.projectId || session.id !== receipt.sessionId)
        throw new Error('Demo execution record unavailable.')
      useSessionStore.getState().upsertPersistedSession(session)
      useNavigationStore.getState().openSession(source.projectId, receipt.sessionId, 'user')
    } catch {
      if (active.current) setError('record')
    }
  }
  const viewed = receipts.find((receipt) => receipt.requestId === viewing)
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t('Offline demo')}>
      {!viewed || error ? (
        <div className="shrink-0 space-y-2 border-b border-border-200 p-3 text-xs text-text-300">
          {!viewed ? (
            <>
              <p>
                {t(
                  'Run the packaged offline demo to see the project in action. This does not reproduce the original experiment.'
                )}
              </p>
              <p>
                {t(
                  'No conversation model or external service is used. Your discussion and original research stay unchanged.'
                )}
              </p>
            </>
          ) : null}
          {error ? (
            <ErrorNotice
              inline
              tone="amber"
              description={errorLabels[error]}
              primaryButton={{
                label: t('Retry'),
                onClick: () => {
                  if (error === 'start') void start()
                  else {
                    setLoading(true)
                    setError(undefined)
                    setRefreshKey((key) => key + 1)
                  }
                },
                disabled: starting || loading
              }}
            />
          ) : null}
        </div>
      ) : null}
      {viewed ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-200 p-2">
            <Button variant="ghost" size="sm" onClick={() => setViewing(undefined)}>
              {t('Back to demo history')}
            </Button>
            <span role="status" className="min-w-0 flex-1 text-xs">
              {stateLabels[viewed.state]}
            </span>
            {researchDemoIsActive(viewed.state) ? (
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(stopping)}
                onClick={() => void stop(viewed)}
              >
                {stopping === viewed.requestId ? t('Stopping demo…') : t('Stop demo')}
              </Button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            {viewed.recordingTarget && !researchDemoIsActive(viewed.state) ? (
              <RunObservationPreview
                mode="recorded"
                target={viewed.recordingTarget}
                title={viewed.title}
                isActive={isActive}
                questionRecovery={recovery}
                onAskArchiveSelection={(selection) => {
                  const target = viewed.recordingTarget!
                  if (
                    !(['projectId', 'sessionId', 'artifactId', 'versionId'] as const).every(
                      (key) => selection.receiving[key] === target[key]
                    ) ||
                    !useRunObservationQuestionStore.getState().askRecorded(selection, {
                      source,
                      requestId: viewed.requestId,
                      purpose: 'offline-demo'
                    })
                  )
                    throw new Error(
                      t(
                        'Open an editable Session in this Project, or use Discuss from the imported research, to ask about this step.'
                      )
                    )
                }}
              />
            ) : viewed.runTarget ? (
              <RunObservationPreview
                target={viewed.runTarget}
                title={viewed.title}
                isActive={isActive}
                allowInteraction
                allowCapture
                onAskSelection={async (selection, viewerId) => {
                  const destination = useRunObservationQuestionStore.getState().destination
                  const revision = useNavigationStore.getState().explicitNavigationRevision
                  if (
                    !destination ||
                    destination.projectId !== source.projectId ||
                    !selection.selectionId
                  )
                    throw new Error(
                      t(
                        'Open an editable Session in this Project, or use Discuss from the imported research, to ask about this step.'
                      )
                    )
                  const question = await window.api.researchDemos.question({
                    ...source,
                    requestId: viewed.requestId,
                    viewerId,
                    selectionId: selection.selectionId,
                    destinationSessionId: destination.sessionId
                  })
                  if (
                    !active.current ||
                    !currentView.current.isActive ||
                    currentView.current.viewing !== viewed.requestId ||
                    useNavigationStore.getState().explicitNavigationRevision !== revision ||
                    !sameSource(question.source, source) ||
                    question.requestId !== viewed.requestId ||
                    question.selection.selectionId !== selection.selectionId ||
                    !useRunObservationQuestionStore.getState().askDemo(question, destination)
                  )
                    throw new Error(t('Could not reference this recorded step.'))
                }}
              />
            ) : (
              <p role="status" className="p-3 text-sm text-text-300">
                {researchDemoIsActive(viewed.state)
                  ? stateLabels[viewed.state]
                  : t('No observation was recorded for this demo.')}
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          {!supported ? (
            <p className="text-sm">{t('Offline demos are available in the desktop app.')}</p>
          ) : null}
          {loading ? (
            <p role="status" className="text-sm text-text-300">
              {t('Checking offline demos…')}
            </p>
          ) : null}
          {inspection && !inspection.candidates.length ? (
            <p className="text-sm text-text-300">
              {t(
                'No offline demo is included in this research. Existing recordings are still available.'
              )}
            </p>
          ) : null}
          {inspection?.candidates.length ? (
            <div className="space-y-3">
              <label className="block space-y-1 text-sm">
                <span>{t('Offline demo')}</span>
                <select
                  className="w-full rounded-md border border-border-200 bg-bg-100 p-2"
                  value={selectedDemo}
                  disabled={starting}
                  onChange={(event) => setSelectedDemo(event.target.value)}
                >
                  {inspection.candidates.map((item) => (
                    <option key={item.demoVersionId} value={item.demoVersionId}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              {candidate?.description ? (
                <p className="text-sm text-text-200">{candidate.description}</p>
              ) : null}
              {candidate?.status === 'ready' ? (
                <DemoViewingNotice
                  context={{
                    purpose: 'offline-demo',
                    conditionChanges: [],
                    demoViewing: candidate.demoViewing
                  }}
                  phase="preparing"
                />
              ) : null}
              {candidate?.substitutions.length ? (
                <div className="space-y-1 text-xs text-text-300">
                  <p>{t('This demo uses the following substitutions:')}</p>
                  <ul className="list-disc space-y-1 pl-4">
                    {candidate.substitutions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {candidate?.blockers.map((reason) => (
                <p key={reason} className="text-xs text-status-warning-foreground">
                  {blockerLabels[reason]}
                </p>
              ))}
              <Button
                size="sm"
                disabled={!candidate || candidate.status !== 'ready' || busy || starting || loading}
                onClick={() => void start()}
              >
                {starting ? t('Preparing demo…') : t('Start offline demo')}
              </Button>
            </div>
          ) : null}
          <div className="space-y-2 border-t border-border-200 pt-3">
            <p className="text-sm font-medium">{t('Demo history')}</p>
            {!receipts.length && !loading ? (
              <p className="text-xs text-text-300">{t('No demos have been run on this device.')}</p>
            ) : null}
            {receipts.map((receipt) => (
              <div
                key={receipt.requestId}
                className="space-y-2 rounded-md border border-border-200 p-3"
              >
                <p className="break-words text-sm font-medium">{receipt.title}</p>
                <p className="text-xs text-text-300">
                  {stateLabels[receipt.state]} ·{' '}
                  {new Date(receipt.createdAt).toLocaleString(i18n.language)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setViewing(receipt.requestId)}>
                    {t('View demo')}
                  </Button>
                  {receipt.sessionId ? (
                    <Button variant="ghost" size="sm" onClick={() => void openRecord(receipt)}>
                      {t('View execution record')}
                    </Button>
                  ) : null}
                  {researchDemoIsActive(receipt.state) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(stopping)}
                      onClick={() => void stop(receipt)}
                    >
                      {stopping === receipt.requestId ? t('Stopping demo…') : t('Stop demo')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
            {receipts.some((receipt) => receipt.sessionId) ? (
              <p className="text-xs text-text-300">
                {t(
                  'Open the execution record to export or delete its demo records using the Session menu.'
                )}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
}

export const ResearchDemoPanel = (props: Props): React.JSX.Element => (
  <ResearchDemoPanelContent key={JSON.stringify(props.source)} {...props} />
)
