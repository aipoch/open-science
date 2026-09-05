import { useVersionHistoryPages } from './use-version-history-pages'
import { VersionHistoryLoadButton } from './VersionHistoryLoadButton'
import {
  provenanceReadFailure,
  unwrapProvenanceRead,
  type ProvenanceReadFailure
} from '../../../../shared/provenance-read-result'
import { ProvenanceLoadNotice } from './ProvenanceLoadNotice'
import { ChevronLeft, ChevronRight, Circle, Download, LoaderCircle, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { ReviewerCard } from '@/components/ReviewerCard'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import {
  createSessionReviewerPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type {
  NotebookInputFileSummary,
  NotebookOutput,
  NotebookRunRecord
} from '../../../../shared/notebook'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionProvenance,
  ProvenanceNotebookRun,
  ProvenanceMessage
} from '../../../../shared/artifact-provenance'
import { isArtifactNotebookProducer } from '../../../../shared/artifact-provenance'
import type {
  ArtifactCodeReconstruction,
  ArtifactCodeReconstructionState
} from '../../../../shared/artifact-code-reconstruction'
import type { PersistedToolActivity } from '../../../../shared/session-persistence'
import type { GoToTranscriptIntent, ReviewUpdateEvent } from '../../../../shared/reviewer'
import {
  createPreviewFileItemForArtifactVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { NotebookInputDataStrip } from './NotebookInputDataStrip'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookDialogCell } from './SessionNotebookDialog'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceContextCompactionActivityRow } from './WorkspaceContextCompactionActivityRow'
import { WorkspacePlanActivityRecord } from './WorkspacePlanActivityRecord'
import { WorkspaceElicitationCard } from './WorkspaceElicitationCard'
import { WorkspaceAssistantTurnCompletion, WorkspaceMessageItem } from './WorkspaceMessageItem'
import { createWorkspaceConversationTimeline } from './workspace-conversation-timeline'
import { useHorizontalScrollFade } from './use-horizontal-scroll-fade'

type ProvenanceTab = 'code' | 'execution' | 'messages' | 'environment' | 'review'
type DeferredProvenanceTab = Extract<ProvenanceTab, 'execution' | 'messages' | 'review'>
type DeferredSection =
  | Pick<ArtifactVersionProvenance, 'execution'>
  | Pick<ArtifactVersionProvenance, 'messages'>
  | Pick<ArtifactVersionProvenance, 'review'>
type DeferredSectionResult =
  | { state: 'loaded'; section: DeferredSection }
  | { state: 'error'; message: string; kind: ProvenanceReadFailure['kind'] }

type CodeReconstructionPanelState =
  | { status: 'loading' }
  | { status: 'loaded'; value: ArtifactCodeReconstructionState }
  | { status: 'generating'; previous: ArtifactCodeReconstructionState }
  | {
      status: 'error'
      message: string
      previous?: ArtifactCodeReconstructionState
    }

type ArtifactProvenancePanelProps = {
  item: PreviewFileItem
  projectId: string
  onClose: () => void
  onVersionChange?: (item: PreviewFileItem) => boolean
}

const tabs: Array<{ id: ProvenanceTab; label: string }> = [
  { id: 'code', label: 'Code' },
  { id: 'execution', label: 'Execution Log' },
  { id: 'messages', label: 'Messages' },
  { id: 'environment', label: 'Environment' },
  { id: 'review', label: 'Review' }
]

const tabActionBarClassName = 'flex items-center gap-3 border-b border-border-300/50 px-4 py-2'

const scriptDownloadFormats = {
  python: { extension: 'py', mimeType: 'text/x-python' },
  r: { extension: 'R', mimeType: 'text/x-r' },
  bash: { extension: 'sh', mimeType: 'text/x-sh' },
  repl: { extension: 'txt', mimeType: 'text/plain' }
} satisfies Record<ArtifactCodeReconstruction['language'], { extension: string; mimeType: string }>

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const toNotebookOutput = (output: ProvenanceNotebookRun['outputs'][number]): NotebookOutput => {
  if (output.type === 'error') {
    return { ...output, traceback: output.traceback?.join('\n') ?? '' }
  }
  if (output.type === 'omitted-media') {
    return { type: 'text', text: `[omitted media: ${output.mimeType}]` }
  }
  if (output.type === 'table') {
    return {
      type: 'json',
      data: output.previewRows.map((row) =>
        Object.fromEntries(output.columns.map((column, index) => [column, row[index]]))
      )
    }
  }
  return { type: 'text', text: output.text }
}

const toNotebookRun = (
  record: ProvenanceNotebookRun
): { run: NotebookRunRecord; index: number } => {
  return {
    index: record.runIndex,
    run: {
      runId: record.runId,
      cellId: `provenance-${record.runId}`,
      source: 'agent',
      kernelKind: record.kernelKind,
      script: record.script,
      status: record.status,
      startedAt: Date.parse(record.startedAt) || 0,
      endedAt: record.completedAt ? Date.parse(record.completedAt) || undefined : undefined,
      executionCount: record.executionCount,
      environment: record.environmentName,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: record.outputs.map(toNotebookOutput),
      artifacts: [],
      workingFiles: []
    }
  }
}

const statusReason = (value: unknown): string | undefined => {
  const status = asRecord(value)
  return asString(status?.reason)
}

const codeReconstructionUnavailableLabel = (
  reason: Extract<ArtifactCodeReconstructionState, { state: 'unavailable' }>['reason'],
  t: TFunction
): string => {
  switch (reason) {
    case 'execution-unavailable':
      return t('A reconstruction needs an immutable Execution Log for this version.')
    case 'producer-unavailable':
      return t('The producer run could not be identified from the captured evidence.')
    case 'producer-script-missing':
      return t('The producer run did not retain a script to reconstruct.')
    case 'helper-evidence-incomplete':
      return t('Helper source evidence is incomplete for this version.')
    case 'supporting-code-incomplete':
      return t('Supporting code evidence is incomplete for this version.')
  }
}

const packageKey = (value: string): string =>
  value.normalize('NFC').toLocaleLowerCase('und').replace(/[-_.]/gu, '')

const packageNameFromSpec = (value: string): string | undefined =>
  value.trim().match(/^[A-Za-z0-9_.-]+/u)?.[0]

const environmentWarningLabel = (warning: string, t: TFunction): string => {
  switch (warning) {
    case 'inventory-cache-best-effort':
      return t('Inventory cache was reused without a full validation.')
    case 'environment-changed-during-run':
      return t('The Environment changed while the producer run was executing.')
    default:
      return warning
  }
}

const packageChangeLabel = (change: Record<string, unknown>, t: TFunction): string => {
  const name = asString(change.name) ?? t('Unknown package')
  const before = asString(change.before_version)
  const after = asString(change.after_version)
  switch (asString(change.change)) {
    case 'installed':
      return `${name} ${after ?? t('(version unavailable)')}`
    case 'updated':
      return `${name} ${before ?? '—'} → ${after ?? '—'}`
    case 'removed':
      return `${name} ${before ?? t('(version unavailable)')} → ${t('removed')}`
    case 'unchanged':
    case 'observed':
      return `${name} ${after ?? before ?? t('(version unavailable)')}`
    default:
      return name
  }
}

const toSourceLines = (source: string): string[] => source.match(/[^\n]*\n|[^\n]+$/gu) ?? []

const toNotebookOutputs = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) return []
  const outputs: Array<Record<string, unknown>> = []
  for (const candidate of value) {
    const output = asRecord(candidate)
    if (!output) continue
    const type = asString(output.type)
    if (type === 'error') {
      const traceback = Array.isArray(output.traceback)
        ? output.traceback.filter((line): line is string => typeof line === 'string')
        : []
      outputs.push({
        output_type: 'error',
        ename: asString(output.name) ?? 'Error',
        evalue: asString(output.message) ?? '',
        traceback
      })
      continue
    }
    if (type === 'omitted-media') {
      outputs.push({
        output_type: 'display_data',
        data: { 'text/plain': ['[Media omitted from immutable Provenance snapshot]'] },
        metadata: {}
      })
      continue
    }
    if (type === 'table') {
      outputs.push({
        output_type: 'display_data',
        data: { 'application/json': output.previewRows ?? [], 'text/plain': ['[Table preview]'] },
        metadata: {}
      })
      continue
    }
    const text = asString(output.text)
    if (text !== undefined) outputs.push({ output_type: 'stream', name: 'stdout', text })
  }
  return outputs
}

const buildExecutionNotebook = (
  runs: unknown[],
  kernel: 'python' | 'r',
  metadata: {
    artifactId: string
    versionId: string
    producerRunId?: string
    runtimeVersion?: string
  }
): Record<string, unknown> => ({
  cells: runs.flatMap((candidate) => {
    const run = asRecord(candidate)
    if (!run || asString(run.kernelKind) !== kernel) return []
    const script = asString(run.script)
    if (script === undefined) return []
    return [
      {
        cell_type: 'code',
        execution_count: typeof run.executionCount === 'number' ? run.executionCount : null,
        metadata: { open_science_run_id: asString(run.runId) },
        outputs: toNotebookOutputs(run.outputs),
        source: toSourceLines(script)
      }
    ]
  }),
  metadata: {
    kernelspec:
      kernel === 'python'
        ? { display_name: 'Python 3', language: 'python', name: 'python3' }
        : { display_name: 'R', language: 'R', name: 'ir' },
    language_info: {
      name: kernel,
      ...(metadata.runtimeVersion ? { version: metadata.runtimeVersion } : {})
    },
    open_science: {
      artifact_id: metadata.artifactId,
      artifact_version_id: metadata.versionId,
      producer_run_id: metadata.producerRunId,
      provenance_snapshot: true
    }
  },
  nbformat: 4,
  nbformat_minor: 5
})

type AvailableProvenanceMessages = Extract<
  ArtifactVersionProvenance['messages'],
  { state: 'available' }
>

const ignoreArtifactPreview = (): void => {}
const ignoreUploadPreview = (): void => {}
const ignoreSkillOpen = (): void => {}
const ignoreMentionPreview = (): void => {}

const toChatMessage = (message: ProvenanceMessage, sortIndex: number): ChatMessage => ({
  id: message.id,
  role: message.role,
  content: message.content,
  ...(message.attribution ? { attribution: message.attribution } : {}),
  status: 'complete',
  eventIds: [],
  createdAt: message.createdAt,
  updatedAt: message.createdAt,
  sortIndex
})

const toToolActivity = (activity: PersistedToolActivity): ToolActivity => {
  const { toolKind, toolContent, ...persisted } = activity
  return {
    ...persisted,
    ...(toolKind ? { toolKind: toolKind as ToolActivity['toolKind'] } : {}),
    ...(toolContent ? { toolContent: toolContent as ToolActivity['toolContent'] } : {})
  }
}

// Replays immutable Message evidence through the same leaf renderers as the live Session transcript.
// Generated cards and navigation stay disabled because a snapshot is evidence, not a second Session.
const ProvenanceMessagesTimeline = ({
  snapshot,
  projectId,
  sessionId
}: {
  snapshot: AvailableProvenanceMessages
  projectId: string
  sessionId: string
}): React.JSX.Element => {
  const { t } = useTranslation()

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})
  const projectedById = useMemo(
    () => new Map(snapshot.items.map((message) => [message.id, message])),
    [snapshot.items]
  )
  const conversationItems = useMemo(() => {
    const session: ChatSession = {
      id: sessionId,
      projectId,
      title: t('Provenance Messages'),
      cwd: '',
      status: 'idle',
      messages: snapshot.items.map(toChatMessage),
      activities: snapshot.activities.map(toToolActivity),
      activityGroups: snapshot.activityGroups,
      createdAt: snapshot.items[0]?.createdAt ?? 0,
      updatedAt: snapshot.items.at(-1)?.createdAt ?? 0
    }
    return createWorkspaceConversationTimeline(session)
  }, [projectId, sessionId, snapshot, t])
  const messageCreatedAtById = new Map(
    snapshot.items.map((message) => [message.id, message.createdAt])
  )

  return (
    <MessageScrollerProvider
      key={`${sessionId}:${snapshot.items.at(-1)?.id ?? 'empty'}`}
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <MessageScroller className="min-h-0 bg-bg-000">
        <MessageScrollerViewport aria-label={t('Provenance messages')}>
          <MessageScrollerContent className="gap-0 px-4">
            <div className="mx-auto w-full max-w-4xl pb-4">
              {conversationItems.map((conversationItem) => {
                if (conversationItem.type === 'message') {
                  return (
                    <WorkspaceMessageItem
                      key={conversationItem.id}
                      message={conversationItem.message}
                      staticParts={projectedById.get(conversationItem.message.id)?.parts}
                      onPreviewArtifact={ignoreArtifactPreview}
                      onPreviewUploadAttachment={ignoreUploadPreview}
                      onOpenSkillMention={ignoreSkillOpen}
                      onPreviewMentionArtifact={ignoreMentionPreview}
                      artifacts={[]}
                      showUserActions={false}
                      showAssistantFooter={conversationItem.message.role !== 'agent'}
                      contentPaddingClassName="px-0 md:px-0"
                    />
                  )
                }

                if (conversationItem.type === 'turn-completion') {
                  return (
                    <MessageScrollerItem
                      key={conversationItem.id}
                      messageId={conversationItem.id}
                      className="min-w-0"
                    >
                      <div className="pb-1">
                        <WorkspaceAssistantTurnCompletion
                          message={conversationItem.message}
                          turnStartedAt={
                            conversationItem.message.responseToMessageId
                              ? messageCreatedAtById.get(
                                  conversationItem.message.responseToMessageId
                                )
                              : undefined
                          }
                        />
                      </div>
                    </MessageScrollerItem>
                  )
                }

                // Artifact provenance builds its immutable transcript from persisted messages and
                // activities only, so no coordinator lifecycle or durable Subagent command rows
                // are supplied here. Derived config-change dividers are render-time annotations,
                // not provenance records, and are skipped as well.
                if (
                  conversationItem.type === 'handoff' ||
                  conversationItem.type === 'subagent-message' ||
                  conversationItem.type === 'session-config-change'
                )
                  return null

                if (conversationItem.type === 'plan-activity') {
                  return (
                    <WorkspacePlanActivityRecord
                      key={conversationItem.id}
                      activity={conversationItem.activity}
                      contentPaddingClassName="px-0 md:px-0"
                    />
                  )
                }

                if (conversationItem.type === 'compaction-activity') {
                  return (
                    <WorkspaceContextCompactionActivityRow
                      key={conversationItem.id}
                      activity={conversationItem.activity}
                      contentPaddingClassName="px-0 md:px-0"
                    />
                  )
                }

                if (conversationItem.type === 'activity') {
                  return (
                    <MessageScrollerItem
                      key={conversationItem.id}
                      messageId={conversationItem.id}
                      className="min-w-0"
                    >
                      <div className="py-3">
                        {conversationItem.activity.elicitation ? (
                          <WorkspaceElicitationCard
                            elicitation={conversationItem.activity.elicitation}
                          />
                        ) : null}
                      </div>
                    </MessageScrollerItem>
                  )
                }

                return (
                  <WorkspaceActivityGroup
                    key={conversationItem.id}
                    group={conversationItem}
                    isExpanded={!collapsedGroups.has(conversationItem.id)}
                    onToggleGroup={(groupId) =>
                      setCollapsedGroups((current) => {
                        const next = new Set(current)
                        if (next.has(groupId)) next.delete(groupId)
                        else next.add(groupId)
                        return next
                      })
                    }
                    expansionOverrides={expandedRows}
                    contentPaddingClassName="px-0 md:px-0"
                    onToggleRow={(activityId, nextExpanded) =>
                      setExpandedRows((current) => ({ ...current, [activityId]: nextExpanded }))
                    }
                  />
                )
              })}
            </div>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="z-10 border-border-200 bg-bg-000 shadow-card hover:bg-bg-200 data-[direction=end]:bottom-3" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

const ArtifactProvenancePanel = ({
  item,
  projectId,
  onClose,
  onVersionChange
}: ArtifactProvenancePanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const tabScrollFadeRef = useHorizontalScrollFade<HTMLDivElement>()
  const lineageKey = `${projectId}:${item.sessionId}:${item.artifactId ?? ''}`
  const [selectedVersion, setSelectedVersion] = useState<{
    artifactId: string
    versionId: string
  }>()
  const requestedVersionId =
    selectedVersion && selectedVersion.artifactId === item.artifactId
      ? selectedVersion.versionId
      : item.selectedVersionId
  const lineageRequestKey = `${lineageKey}:${requestedVersionId ?? ''}`
  const [lineageResult, setLineageResult] = useState<{
    key: string
    value?: ArtifactLineageProvenance
    unavailable?: boolean
    error?: ProvenanceReadFailure
  }>()
  const [provenanceResult, setProvenanceResult] = useState<{
    key: string
    value?: ArtifactVersionProvenance
    error?: ProvenanceReadFailure
  }>()
  const [activeTab, setActiveTab] = useState<ProvenanceTab>('code')
  const [deferredSectionResults, setDeferredSectionResults] = useState<
    Record<string, DeferredSectionResult>
  >({})
  const [codeReconstructionResults, setCodeReconstructionResults] = useState<
    Record<string, CodeReconstructionPanelState>
  >({})
  const [reviewRevision, setReviewRevision] = useState(0)
  const [lineageRetry, setLineageRetry] = useState(0)
  const [coreRetry, setCoreRetry] = useState(0)
  const [showAllPackagesKey, setShowAllPackagesKey] = useState<string>()
  const [exportingNotebook, setExportingNotebook] = useState(false)
  const [notebookExportFailure, setNotebookExportFailure] = useState<{
    key: string
    message: string
  }>()
  const [codeActionFailure, setCodeActionFailure] = useState<{
    key: string
    message: string
  }>()
  const initialLineage = lineageResult?.key === lineageRequestKey ? lineageResult.value : undefined
  const historyLineage = lineageResult?.key.startsWith(lineageKey + ':')
    ? lineageResult.value
    : undefined
  const history = useVersionHistoryPages({
    historyKey:
      lineageKey +
      ':' +
      (historyLineage?.headVersion?.versionId ?? historyLineage?.versions.at(-1)?.versionId ?? ''),
    initial: historyLineage,
    loadPage: async (cursor) => {
      const value = unwrapProvenanceRead(
        await window.api.artifacts.getLineage({
          projectId,
          appSessionId: item.sessionId,
          artifactId: item.artifactId!,
          versionId: item.selectedVersionId,
          cursor
        })
      )
      if (!value) throw new Error('Artifact history is unavailable.')
      return value
    }
  })
  const lineage = useMemo(
    () => (initialLineage ? { ...initialLineage, versions: history.versions } : undefined),
    [initialLineage, history.versions]
  )
  const lineageUnavailable =
    lineageResult?.key === lineageRequestKey && lineageResult.unavailable === true
  const selectedVersionDescriptor = lineage
    ? resolveArtifactVersionDescriptor(lineage, requestedVersionId)
    : undefined
  const selectedVersionId = lineage ? selectedVersionDescriptor?.versionId : requestedVersionId
  const isUserEdit = selectedVersionDescriptor?.originKind === 'user_edit'
  const isLegacyVersion = selectedVersionDescriptor?.originKind === 'legacy'
  const basedOnVersionId = selectedVersionDescriptor?.basedOnVersionId ?? undefined
  const basedOnVersionNumber =
    lineage?.versions.find((version) => version.versionId === basedOnVersionId)?.versionNumber ??
    (lineage?.basedOnVersion?.versionId === basedOnVersionId
      ? lineage?.basedOnVersion?.versionNumber
      : undefined)
  const selectedVersionUnavailable = Boolean(lineage && requestedVersionId && !selectedVersionId)
  const provenanceKey = `${lineageKey}:${selectedVersionId ?? ''}`
  const coreProvenance =
    provenanceResult?.key === provenanceKey ? provenanceResult.value : undefined
  const showAllPackages = showAllPackagesKey === provenanceKey
  const notebookExportError =
    notebookExportFailure?.key === provenanceKey ? notebookExportFailure.message : undefined
  const codeActionError =
    codeActionFailure?.key === provenanceKey ? codeActionFailure.message : undefined
  const codeReconstructionResult = codeReconstructionResults[provenanceKey]
  const error =
    (selectedVersionUnavailable
      ? {
          kind: 'load-failed' as const,
          message: t('The selected Artifact version is unavailable.')
        }
      : undefined) ??
    (lineageResult?.key === lineageRequestKey ? lineageResult.error : undefined) ??
    (provenanceResult?.key === provenanceKey ? provenanceResult.error : undefined)

  useEffect(() => {
    return window.api.reviewer.onUpdated((event: ReviewUpdateEvent) => {
      if (event.review.projectId === projectId && event.review.sessionId === item.sessionId) {
        setReviewRevision((revision) => revision + 1)
      }
    })
  }, [item.sessionId, projectId])

  useEffect(() => {
    let active = true
    if (!item.artifactId) return
    void window.api.artifacts
      .getLineage({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId,
        ...(requestedVersionId ? { versionId: requestedVersionId } : {})
      })
      .then(unwrapProvenanceRead)
      .then((value) => {
        if (!active) return
        setLineageResult({ key: lineageRequestKey, value, unavailable: value === undefined })
      })
      .catch((failure: unknown) => {
        if (active) {
          setLineageResult({
            key: lineageRequestKey,
            error: provenanceReadFailure(failure)
          })
        }
      })
    return () => {
      active = false
    }
  }, [
    item.artifactId,
    item.sessionId,
    lineageRequestKey,
    projectId,
    lineageRetry,
    requestedVersionId
  ])

  useEffect(() => {
    let active = true
    if (!item.artifactId || !selectedVersionId || !initialLineage || isUserEdit || isLegacyVersion)
      return
    void window.api.artifacts
      .getVersionProvenance({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId,
        versionId: selectedVersionId
      })
      .then(unwrapProvenanceRead)
      .then((value) => {
        if (active) setProvenanceResult({ key: provenanceKey, value })
      })
      .catch((failure: unknown) => {
        if (active) {
          setProvenanceResult({
            key: provenanceKey,
            error: provenanceReadFailure(failure)
          })
        }
      })
    return () => {
      active = false
    }
  }, [
    coreRetry,
    isUserEdit,
    isLegacyVersion,
    item.artifactId,
    item.sessionId,
    initialLineage,
    projectId,
    provenanceKey,
    selectedVersionId
  ])

  useEffect(() => {
    if (
      activeTab !== 'code' ||
      !item.artifactId ||
      !selectedVersionId ||
      !coreProvenance ||
      codeReconstructionResult
    ) {
      return
    }
    const request = {
      projectId,
      appSessionId: item.sessionId,
      artifactId: item.artifactId,
      versionId: selectedVersionId
    }
    setCodeReconstructionResults((current) => ({
      ...current,
      [provenanceKey]: { status: 'loading' }
    }))
    void window.api.artifacts
      .getCodeReconstruction(request)
      .then((value) => {
        setCodeReconstructionResults((current) => ({
          ...current,
          [provenanceKey]: { status: 'loaded', value }
        }))
      })
      .catch((failure: unknown) => {
        setCodeReconstructionResults((current) => ({
          ...current,
          [provenanceKey]: {
            status: 'error',
            message: failure instanceof Error ? failure.message : String(failure)
          }
        }))
      })
  }, [
    activeTab,
    codeReconstructionResult,
    coreProvenance,
    item.artifactId,
    item.sessionId,
    projectId,
    provenanceKey,
    selectedVersionId
  ])

  const reviewReloadKey = activeTab === 'review' ? reviewRevision : 0
  const deferredTab = (
    activeTab === 'execution' || activeTab === 'messages' || activeTab === 'review'
      ? activeTab
      : undefined
  ) as DeferredProvenanceTab | undefined
  const deferredSectionKey = deferredTab
    ? `${provenanceKey}:${deferredTab}:${deferredTab === 'review' ? reviewReloadKey : 0}`
    : undefined
  const deferredSectionResult = deferredSectionKey
    ? deferredSectionResults[deferredSectionKey]
    : undefined
  const deferredSectionState = deferredSectionResult?.state
  const provenance = useMemo(
    () =>
      coreProvenance && deferredSectionResult?.state === 'loaded'
        ? { ...coreProvenance, ...deferredSectionResult.section }
        : coreProvenance,
    [coreProvenance, deferredSectionResult]
  )
  const deferredTabLabel = deferredTab
    ? tabs.find((tab) => tab.id === deferredTab)?.label
    : undefined
  const translatedDeferredTabLabel = deferredTabLabel ? t(deferredTabLabel) : undefined
  const deferredSectionLoading = Boolean(deferredSectionKey && deferredSectionState === undefined)
  const deferredSectionReady = !deferredSectionKey || deferredSectionState === 'loaded'
  const hasLoadedProvenance = Boolean(coreProvenance)
  useEffect(() => {
    let active = true
    if (!item.artifactId || !selectedVersionId || !hasLoadedProvenance) {
      return
    }
    const request = {
      projectId,
      appSessionId: item.sessionId,
      artifactId: item.artifactId,
      versionId: selectedVersionId
    }
    if (deferredSectionState !== undefined) return
    const load =
      activeTab === 'execution'
        ? window.api.artifacts.getVersionExecution(request)
        : activeTab === 'messages'
          ? window.api.artifacts.getVersionMessages(request)
          : activeTab === 'review'
            ? window.api.artifacts.getVersionReview(request)
            : undefined
    if (!load) return
    const sectionKey = `${provenanceKey}:${activeTab}:${activeTab === 'review' ? reviewReloadKey : 0}`
    void load
      .then((value) => unwrapProvenanceRead<DeferredSection>(value))
      .then((section) => {
        if (!active) return
        setDeferredSectionResults((current) => ({
          ...current,
          [sectionKey]: { state: 'loaded', section }
        }))
      })
      .catch((failure: unknown) => {
        if (!active) return
        setDeferredSectionResults((current) => ({
          ...current,
          [sectionKey]: {
            state: 'error',
            ...provenanceReadFailure(failure)
          }
        }))
      })
    return () => {
      active = false
    }
  }, [
    activeTab,
    deferredSectionState,
    item.artifactId,
    item.sessionId,
    hasLoadedProvenance,
    projectId,
    provenanceKey,
    reviewReloadKey,
    selectedVersionId
  ])

  const diagnosticsFor = (failure: ProvenanceReadFailure, section: string): string =>
    JSON.stringify(
      {
        projectId,
        sessionId: item.sessionId,
        artifactId: item.artifactId,
        versionId: selectedVersionId,
        section,
        ...failure
      },
      null,
      2
    )
  const retryCore = (): void => {
    if (lineageResult?.error) {
      setLineageResult(undefined)
      setLineageRetry((value) => value + 1)
    } else {
      setProvenanceResult(undefined)
      setCoreRetry((value) => value + 1)
    }
  }

  const selectedIndex =
    lineage?.versions.findIndex((version) => version.versionId === selectedVersionId) ?? -1
  const evidence = provenance?.evidence
  const producer = asRecord(evidence?.producer)
  const environment = asRecord(evidence?.environment)
  const environmentPackages = Array.isArray(environment?.packages)
    ? environment.packages
        .map(asRecord)
        .filter((pkg): pkg is Record<string, unknown> => pkg !== undefined)
    : []
  const environmentOperations = Array.isArray(environment?.op_log)
    ? environment.op_log
        .map(asRecord)
        .filter((operation): operation is Record<string, unknown> => operation !== undefined)
    : []
  const operationLogTruncation = asRecord(environment?.op_log_truncation)
  const omittedOperationCount =
    typeof operationLogTruncation?.omitted_count === 'number'
      ? operationLogTruncation.omitted_count
      : 0
  const earliestRetainedOperationAt = asString(operationLogTruncation?.earliest_retained_at)
  const environmentWarnings = Array.isArray(environment?.warnings)
    ? environment.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  const requestedPackageKeys = new Set(
    environmentOperations.flatMap((operation) =>
      Array.isArray(operation.packages)
        ? operation.packages.flatMap((entry) => {
            const name = typeof entry === 'string' ? packageNameFromSpec(entry) : undefined
            return name ? [packageKey(name)] : []
          })
        : []
    )
  )
  const isPythonEnvironment = asString(environment?.kernel_kind) === 'python'
  const relevantEnvironmentPackages = isPythonEnvironment
    ? environmentPackages.filter((pkg) => {
        const state = asString(pkg.loaded_state)
        const name = asString(pkg.name)
        return (
          state === 'loaded' ||
          state === 'attached' ||
          (name !== undefined && requestedPackageKeys.has(packageKey(name)))
        )
      })
    : environmentPackages
  const filteredEnvironmentPackages =
    relevantEnvironmentPackages.length > 0 ? relevantEnvironmentPackages : environmentPackages
  const visibleEnvironmentPackages = showAllPackages
    ? environmentPackages
    : filteredEnvironmentPackages
  const hasFilteredEnvironmentPackages =
    filteredEnvironmentPackages.length < environmentPackages.length
  const rawExecutionRuns = Array.isArray(provenance?.execution?.runs)
    ? provenance.execution.runs
    : []
  const executionRuns = useMemo(
    () => (provenance?.execution?.runs ?? []).map(toNotebookRun),
    [provenance]
  )
  const executionTruncation = provenance?.execution?.truncation
  const reviewProjection =
    provenance?.review.state === 'available' ? provenance.review.value : undefined
  const reviewUnavailableReason =
    provenance?.review.state === 'unavailable' ? provenance.review.reason : undefined
  const reviewForCard = reviewProjection?.selectedVersionAssessment
  const executionKernels = [
    ...new Set(
      rawExecutionRuns
        .map((run) => asString(asRecord(run)?.kernelKind))
        .filter((kernel): kernel is 'python' | 'r' => kernel === 'python' || kernel === 'r')
    )
  ]
  const reproductionCode = provenance?.evidence.reproduction_code
  const producerInputs: NotebookInputFileSummary[] = (provenance?.evidence.inputs ?? []).map(
    (input) => ({
      inputFileVersionId: input.input_file_version_id,
      sourceKind: input.source_kind,
      sourceFileId: input.source_file_id,
      sourceVersionNumber: input.source_version_number,
      sourceCreatedAt: input.source_created_at,
      sourceProjectId: input.source_project_id,
      sourceSessionId: input.source_session_id,
      filename: input.filename,
      contentType: input.content_type,
      sizeBytes: input.size_bytes,
      checksum: input.checksum,
      association: input.strongest_association
    })
  )

  const openReviewTranscript = (intent: GoToTranscriptIntent): void => {
    usePreviewWorkbenchStore.getState().upsertAndActivateItem(
      createSessionReviewerPreviewItem({
        sessionId: item.sessionId,
        reviewId: intent.reviewId,
        findingId: intent.checkId ?? intent.findingId,
        locator: intent.locator
      })
    )
  }

  const selectVersion = (versionId: string): void => {
    if (!item.artifactId) return
    const version = lineage ? resolveArtifactVersionDescriptor(lineage, versionId) : undefined
    if (!version) return

    const nextItem = createPreviewFileItemForArtifactVersion({ item, version, projectId })
    const committed = onVersionChange
      ? onVersionChange(nextItem)
      : usePreviewWorkbenchStore.getState().upsertItem(nextItem)
    if (!committed) return
    setSelectedVersion({ artifactId: item.artifactId, versionId })
  }

  const downloadExecutionNotebook = async (): Promise<void> => {
    if (executionKernels.length === 0 || !item.artifactId || !selectedVersionId) return
    setExportingNotebook(true)
    setNotebookExportFailure(undefined)
    try {
      const baseName = item.name.replace(/\.[^.]+$/u, '') || 'artifact'
      const versionNumber = selectedVersionDescriptor?.versionNumber ?? 1
      for (const kernel of executionKernels) {
        const notebook = buildExecutionNotebook(rawExecutionRuns, kernel, {
          artifactId: item.artifactId,
          versionId: selectedVersionId,
          producerRunId: asString(producer?.producer_run_id),
          runtimeVersion:
            asString(environment?.kernel_kind) === kernel
              ? asString(environment?.runtime_version)
              : undefined
        })
        const bytes = new TextEncoder().encode(`${JSON.stringify(notebook, null, 2)}\n`)
        const data = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer
        const kernelSuffix = executionKernels.length > 1 ? `-${kernel}` : ''
        await window.api.saveBlobFile({
          suggestedName: `${baseName}-v${versionNumber}${kernelSuffix}.ipynb`,
          mimeType: 'application/x-ipynb+json',
          data
        })
      }
    } catch (failure) {
      setNotebookExportFailure({
        key: provenanceKey,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setExportingNotebook(false)
    }
  }

  const downloadScript = async (
    code: string,
    language: ArtifactCodeReconstruction['language']
  ): Promise<void> => {
    try {
      const bytes = new TextEncoder().encode(code)
      const data = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer
      const baseName = item.name.replace(/\.[^.]+$/u, '') || 'artifact'
      const versionNumber = selectedVersionDescriptor?.versionNumber ?? 1
      const format = scriptDownloadFormats[language]
      await window.api.saveBlobFile({
        suggestedName: `${baseName}-v${versionNumber}.${format.extension}`,
        mimeType: format.mimeType,
        data
      })
      setCodeActionFailure(undefined)
    } catch (failure) {
      setCodeActionFailure({
        key: provenanceKey,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    }
  }

  const downloadProducerCode = async (): Promise<void> => {
    if (!reproductionCode) return
    const evidenceProducer = provenance?.evidence.producer
    const language =
      evidenceProducer && isArtifactNotebookProducer(evidenceProducer)
        ? evidenceProducer.kernel_kind
        : 'repl'
    await downloadScript(reproductionCode, language)
  }

  const generateCodeReconstruction = async (): Promise<void> => {
    if (!item.artifactId || !selectedVersionId) return
    const previous =
      codeReconstructionResult?.status === 'loaded'
        ? codeReconstructionResult.value
        : codeReconstructionResult?.status === 'error'
          ? codeReconstructionResult.previous
          : undefined
    if (!previous || previous.state !== 'ready') return
    setCodeReconstructionResults((current) => ({
      ...current,
      [provenanceKey]: { status: 'generating', previous }
    }))
    try {
      const value = await window.api.artifacts.generateCodeReconstruction({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId,
        versionId: selectedVersionId
      })
      setCodeReconstructionResults((current) => ({
        ...current,
        [provenanceKey]: { status: 'loaded', value }
      }))
    } catch (failure) {
      setCodeReconstructionResults((current) => ({
        ...current,
        [provenanceKey]: {
          status: 'error',
          message: failure instanceof Error ? failure.message : String(failure),
          previous
        }
      }))
    }
  }

  const retryCodeReconstructionLookup = (): void => {
    setCodeReconstructionResults((current) => {
      const next = { ...current }
      delete next[provenanceKey]
      return next
    })
  }

  const codeReconstructionState =
    codeReconstructionResult?.status === 'loaded'
      ? codeReconstructionResult.value
      : codeReconstructionResult?.status === 'generating'
        ? codeReconstructionResult.previous
        : codeReconstructionResult?.status === 'error'
          ? codeReconstructionResult.previous
          : undefined
  const generatedCode =
    codeReconstructionState?.state === 'cached' ? codeReconstructionState.value : undefined

  return (
    <div className="flex size-full min-h-0 flex-col bg-bg-000" data-testid="artifact-provenance">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('Previous Artifact version')}
          disabled={selectedIndex <= 0 && !lineage?.previousVersion}
          onClick={() => {
            const versionId = (
              selectedIndex > 0 ? lineage?.versions[selectedIndex - 1] : lineage?.previousVersion
            )?.versionId
            if (versionId) selectVersion(versionId)
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="text-xs font-medium text-text-100">
          {selectedVersionDescriptor ? `v${selectedVersionDescriptor.versionNumber}` : t('Version')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('Next Artifact version')}
          disabled={
            !lineage ||
            ((selectedIndex < 0 || selectedIndex >= lineage.versions.length - 1) &&
              !lineage.nextVersion)
          }
          onClick={() => {
            const versionId = (
              selectedIndex >= 0
                ? (lineage?.versions[selectedIndex + 1] ?? lineage?.nextVersion)
                : lineage?.nextVersion
            )?.versionId
            if (versionId) selectVersion(versionId)
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-text-300">
          {lineage?.originSession.state === 'deleted'
            ? [
                t('Source session deleted'),
                lineage.originSession.title,
                lineage.originSession.deletedAt
                  ? formatDate(lineage.originSession.deletedAt, 'dateTime')
                  : undefined
              ]
                .filter(Boolean)
                .join(' · ')
            : lineage?.originSession.title}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('Close Provenance')}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <VersionHistoryLoadButton history={history} />
      {!isUserEdit && !isLegacyVersion ? (
        <div
          ref={tabScrollFadeRef}
          role="tablist"
          className="scroll-fade-x flex shrink-0 gap-1 overflow-x-auto border-b border-border-300/60 px-2 py-1"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`rounded px-2 py-1 text-xs ${activeTab === tab.id ? 'bg-bg-300 text-text-000' : 'text-text-200 hover:text-text-100'}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {t(tab.label)}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ProvenanceLoadNotice
            key={provenanceKey + ':core'}
            failure={error}
            diagnostics={diagnosticsFor(error, lineageResult?.error ? 'lineage' : 'core')}
            onRetry={
              selectedVersionUnavailable || error.kind === 'integrity-failed'
                ? undefined
                : retryCore
            }
          />
        ) : null}
        {!error && lineageUnavailable ? (
          <p className="p-5 text-sm text-text-300">
            {t('Provenance is not available for this legacy file.')}
          </p>
        ) : null}
        {!error && isUserEdit ? (
          <section className="p-5">
            <h2 className="text-sm font-medium text-text-100">{t('Edited in Open Science')}</h2>
            {basedOnVersionId && basedOnVersionNumber !== undefined ? (
              <button
                type="button"
                aria-label={t('Open source version v{{version}}', {
                  version: basedOnVersionNumber
                })}
                className="mt-1 text-sm text-primary hover:underline"
                onClick={() => selectVersion(basedOnVersionId)}
              >
                {t('Based on v{{version}}', { version: basedOnVersionNumber })}
              </button>
            ) : (
              <p className="mt-1 text-sm text-text-300">
                {t('Based on an earlier immutable version.')}
              </p>
            )}
          </section>
        ) : null}
        {!error && isLegacyVersion ? (
          <p className="p-5 text-sm text-text-300">
            {t('Provenance is not available for this legacy version.')}
          </p>
        ) : null}
        {!error && !lineageUnavailable && !isUserEdit && !isLegacyVersion && !provenance ? (
          <div className="flex h-full items-center justify-center text-text-300">
            <LoaderCircle className="size-4 animate-spin" aria-label={t('Loading Provenance')} />
          </div>
        ) : null}
        {provenance && translatedDeferredTabLabel && deferredSectionLoading ? (
          <div
            className="flex h-full items-center justify-center gap-2 text-sm text-text-300"
            aria-label={t('Loading {{label}}', { label: translatedDeferredTabLabel })}
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {t('Loading {{label}}', { label: translatedDeferredTabLabel })}
          </div>
        ) : null}
        {provenance && deferredSectionResult?.state === 'error' ? (
          <ProvenanceLoadNotice
            key={deferredSectionKey}
            failure={deferredSectionResult}
            diagnostics={diagnosticsFor(deferredSectionResult, activeTab)}
            onRetry={
              deferredSectionResult.kind === 'integrity-failed'
                ? undefined
                : () =>
                    setDeferredSectionResults((current) => {
                      const next = { ...current }
                      if (deferredSectionKey) delete next[deferredSectionKey]
                      return next
                    })
            }
          />
        ) : null}
        {provenance && activeTab === 'code' ? (
          <section>
            {provenance.contentStatus.state === 'unavailable' ? (
              <ProvenanceLoadNotice
                key={provenanceKey + ':content'}
                failure={{
                  kind: 'integrity-failed',
                  message: t(
                    'Artifact content is {{reason}}; captured provenance remains available.',
                    { reason: provenance.contentStatus.reason }
                  )
                }}
                diagnostics={diagnosticsFor(
                  { kind: 'integrity-failed', message: provenance.contentStatus.reason },
                  'content'
                )}
              />
            ) : null}
            <div className={tabActionBarClassName}>
              {generatedCode ? (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void downloadScript(generatedCode.code, generatedCode.language)}
                >
                  <Download aria-hidden="true" />
                  {t('Download script')}
                </Button>
              ) : codeReconstructionResult?.status === 'generating' ? (
                <Button type="button" size="sm" className="shrink-0 whitespace-nowrap" disabled>
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  {t('Generating…')}
                </Button>
              ) : codeReconstructionState?.state === 'ready' ? (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void generateCodeReconstruction()}
                >
                  {t('Generate script')}
                </Button>
              ) : codeReconstructionResult?.status === 'error' ? (
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() =>
                    codeReconstructionResult.previous?.state === 'ready'
                      ? void generateCodeReconstruction()
                      : retryCodeReconstructionLookup()
                  }
                >
                  {t('Retry')}
                </Button>
              ) : codeReconstructionState?.state === 'unavailable' ? (
                <Button type="button" size="sm" className="shrink-0 whitespace-nowrap" disabled>
                  {t('Generate script')}
                </Button>
              ) : (
                <LoaderCircle
                  className="size-4 animate-spin text-text-300 motion-reduce:animate-none"
                  aria-label={t('Checking for a generated script')}
                />
              )}
              {generatedCode ? (
                <div className="min-w-0 flex-1 truncate text-sm text-text-200">
                  {/* One sentence around the tab link, so each locale can place the link where its
                      own word order needs it. */}
                  <Trans
                    i18nKey={
                      generatedCode.origin === 'app-replay'
                        ? 'Reconstructed directly from the immutable Execution Log · see <logLink>Execution Log</logLink> for the raw record'
                        : 'LLM-generated reconstruction · see <logLink>Execution Log</logLink> for the raw record'
                    }
                    components={{
                      logLink: (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto whitespace-nowrap px-0 py-0 text-sm"
                          onClick={() => setActiveTab('execution')}
                        />
                      )
                    }}
                  />
                </div>
              ) : codeReconstructionResult?.status === 'error' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-danger-000" role="alert">
                  {codeReconstructionResult.message}
                </p>
              ) : codeReconstructionState?.state === 'unavailable' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-text-200">
                  {codeReconstructionUnavailableLabel(codeReconstructionState.reason, t)}
                </p>
              ) : codeReconstructionResult?.status === 'generating' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-text-200">
                  {codeReconstructionState?.state === 'ready' &&
                  codeReconstructionState.origin === 'app-replay'
                    ? t('Reconstructing directly from recorded helper and execution evidence.')
                    : t('Using the provider and model selected when generation started.')}
                </p>
              ) : codeReconstructionState?.state === 'ready' ? (
                <p className="min-w-0 flex-1 truncate text-sm text-text-200">
                  {codeReconstructionState.origin === 'app-replay'
                    ? t(
                        'This script can be reconstructed directly from the immutable Execution Log.'
                      )
                    : t(
                        'Generate a standalone script from the immutable Execution Log with your current provider and model.'
                      )}
                </p>
              ) : (
                <p className="min-w-0 flex-1 truncate text-sm text-text-200">
                  {t('Checking for a previously generated script…')}
                </p>
              )}
            </div>
            {producerInputs.length > 0 ? (
              <NotebookInputDataStrip
                inputFiles={producerInputs}
                label={t('Inputs')}
                className="border-b border-border-300/50 px-4 py-2"
              />
            ) : null}
            {generatedCode?.sourceTruncated ||
            (codeReconstructionState?.state === 'ready' &&
              codeReconstructionState.sourceTruncated) ? (
              <p className="border-b border-warning-100/50 bg-warning-100/10 px-4 py-2 text-xs text-text-200">
                {t(
                  'The immutable Execution Log was bounded; the reconstruction may include a provenance-gap comment.'
                )}
              </p>
            ) : null}
            {codeReconstructionResult?.status === 'generating' ? (
              <div
                className="flex min-h-48 items-center justify-center gap-2 px-4 py-8 text-sm text-text-300"
                role="status"
                aria-live="polite"
                aria-label={t('Generating reconstructed script')}
              >
                <LoaderCircle
                  className="size-5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <span>{t('Generating script…')}</span>
              </div>
            ) : generatedCode ? (
              <NotebookCodeBlock code={generatedCode.code} language={generatedCode.language} />
            ) : (
              <div className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-text-000">
                    {t('Captured producer block')}
                  </h3>
                  {reproductionCode ? (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void downloadProducerCode()}
                      >
                        <Download aria-hidden="true" />
                        {t('Download')}
                      </Button>
                    </div>
                  ) : null}
                </div>
                {reproductionCode ? (
                  <NotebookCodeBlock
                    code={reproductionCode}
                    language={
                      isArtifactNotebookProducer(provenance.evidence.producer)
                        ? provenance.evidence.producer.kernel_kind
                        : undefined
                    }
                  />
                ) : (
                  <p className="text-sm text-text-300">
                    {t('No producer block was recorded for this version.')} {statusReason(producer)}
                  </p>
                )}
              </div>
            )}
            {codeActionError ? (
              <p className="px-4 py-2 text-xs text-danger-000" role="alert">
                {codeActionError}
              </p>
            ) : null}
          </section>
        ) : null}
        {provenance && activeTab === 'execution' && deferredSectionReady ? (
          executionRuns.length > 0 ? (
            <div>
              {executionTruncation ? (
                <p className="border-b border-warning-100/50 bg-warning-100/10 px-4 py-2 text-xs text-text-200">
                  {t(
                    'Execution evidence was bounded for storage: omitted {{runs}} earlier runs, {{outputs}} outputs, and {{inputs}} inputs.',
                    {
                      runs: executionTruncation.omittedLeadingRunCount,
                      outputs: executionTruncation.omittedOutputCount,
                      inputs: executionTruncation.omittedInputCount
                    }
                  )}
                </p>
              ) : null}
              <div className={tabActionBarClassName}>
                <Button
                  type="button"
                  size="sm"
                  disabled={executionKernels.length === 0 || exportingNotebook}
                  onClick={() => void downloadExecutionNotebook()}
                >
                  {exportingNotebook ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Download aria-hidden="true" />
                  )}
                  {exportingNotebook
                    ? t('Preparing…')
                    : executionKernels.length > 1
                      ? t('Download notebooks')
                      : t('Download notebook')}
                </Button>
              </div>
              {notebookExportError ? (
                <p className="px-4 py-2 text-xs text-danger-000">{notebookExportError}</p>
              ) : null}
              <div className="divide-y divide-border-300/50">
                {executionRuns.map(({ run, index }) => (
                  <NotebookDialogCell key={run.runId} run={run} index={index} />
                ))}
              </div>
            </div>
          ) : (
            <p className="p-5 text-sm text-text-300">
              {t('Unable to determine the producer execution for this version.')}
            </p>
          )
        ) : null}
        {provenance && activeTab === 'messages' && deferredSectionReady ? (
          provenance.messages.state === 'available' ? (
            <ProvenanceMessagesTimeline
              key={provenanceKey}
              snapshot={provenance.messages}
              projectId={projectId}
              sessionId={item.sessionId}
            />
          ) : (
            <p className="p-5 text-sm text-text-300">
              {provenance.messages.reason === 'message-snapshot-unsupported'
                ? t(
                    'This message snapshot was created by a newer version of Open Science. Update the app to view it.'
                  )
                : t(
                    'The immutable message snapshot is not available for this version ({{reason}}).',
                    { reason: provenance.messages.reason }
                  )}
            </p>
          )
        ) : null}
        {provenance && activeTab === 'environment' ? (
          <section className="space-y-4 p-5 text-sm">
            <h3 className="font-semibold text-text-000">
              {asString(environment?.environment_name) ??
                provenance.descriptor.environment ??
                t('Environment unavailable')}
            </h3>
            {environment ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-text-300">{t('Runtime')}</dt>
                  <dd className="text-text-100">
                    {asString(environment.runtime_version) ?? t('Version unavailable')}
                  </dd>
                  <dt className="text-text-300">{t('Source')}</dt>
                  <dd className="text-text-100">
                    {asString(environment.runtime_source) ?? t('unknown')} ·{' '}
                    {asString(environment.kernel_kind) ?? t('unknown')}
                  </dd>
                  <dt className="text-text-300">{t('Capture')}</dt>
                  <dd className="text-text-100">
                    {asString(environment.capture_status) ?? t('partial')} ·{' '}
                    {t('{{count}} packages', { count: environmentPackages.length })}
                  </dd>
                </dl>
                {environmentWarnings.length > 0 ? (
                  <div
                    role="status"
                    className="rounded-md border border-warning-100/50 bg-warning-100/10 px-3 py-2 text-xs text-text-200"
                  >
                    <p className="font-medium text-text-100">{t('Partial capture details')}</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {environmentWarnings.map((warning) => (
                        <li key={warning}>{environmentWarningLabel(warning, t)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="overflow-hidden rounded-md border border-border-300/60">
                  <table className="w-full table-fixed text-left text-xs">
                    <thead className="bg-bg-100 text-text-300">
                      <tr>
                        <th className="w-1/2 px-3 py-2 font-medium">{t('Package')}</th>
                        <th className="w-1/4 px-3 py-2 font-medium">{t('Version')}</th>
                        <th className="w-1/4 px-3 py-2 font-medium">{t('State')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEnvironmentPackages.map((pkg) => (
                        <tr
                          key={`${asString(pkg.name)}:${asString(pkg.version)}`}
                          className="border-t border-border-300/40"
                        >
                          <td className="truncate px-3 py-2 text-text-100">
                            {asString(pkg.name) ?? t('Unknown package')}
                          </td>
                          <td className="px-3 py-2 text-text-300">
                            {asString(pkg.version) ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-text-300">
                            {asString(pkg.loaded_state) ?? t('unknown')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {hasFilteredEnvironmentPackages ? (
                  <button
                    type="button"
                    className="text-xs font-medium text-accent-000 hover:underline"
                    onClick={() =>
                      setShowAllPackagesKey((key) =>
                        key === provenanceKey ? undefined : provenanceKey
                      )
                    }
                  >
                    {showAllPackages
                      ? t('Show relevant {{count}} packages', {
                          count: filteredEnvironmentPackages.length
                        })
                      : t('Show all {{count}} packages', { count: environmentPackages.length })}
                  </button>
                ) : null}
                {omittedOperationCount > 0 ? (
                  <p className="rounded-md bg-bg-100 px-3 py-2 text-xs text-text-300">
                    {omittedOperationCount === 1
                      ? t('{{count}} earlier operation omitted from this bounded history.', {
                          count: omittedOperationCount
                        })
                      : t('{{count}} earlier operations omitted from this bounded history.', {
                          count: omittedOperationCount
                        })}
                    {earliestRetainedOperationAt
                      ? ` ${t('Retained entries begin {{time}}.', {
                          time: formatDate(earliestRetainedOperationAt, 'dateTime')
                        })}`
                      : ''}
                  </p>
                ) : null}
                {environmentOperations.length > 0 ? (
                  <div className="space-y-2">
                    <h4 className="font-semibold text-text-000">{t('Operations')}</h4>
                    <div className="overflow-hidden rounded-md border border-border-300/60">
                      <table className="w-full table-fixed text-left text-xs">
                        <thead className="bg-bg-100 text-text-300">
                          <tr>
                            <th className="w-[34%] break-words px-2 py-2 font-medium">
                              {t('Time')}
                            </th>
                            <th className="w-1/5 break-words px-2 py-2 font-medium">
                              {t('Operation')}
                            </th>
                            <th className="w-[28%] break-words px-2 py-2 font-medium">
                              {t('Packages')}
                            </th>
                            <th className="w-[18%] break-words px-2 py-2 font-medium">
                              {t('Result')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {environmentOperations.map((operation, index) => {
                            const timestamp = asString(operation.timestamp)
                            const rawPackageChanges = operation.package_changes
                            const hasPackageChanges = Array.isArray(rawPackageChanges)
                            const packageChanges = hasPackageChanges
                              ? rawPackageChanges
                                  .map(asRecord)
                                  .filter(
                                    (change): change is Record<string, unknown> =>
                                      change !== undefined
                                  )
                              : []
                            const requestedChanges = packageChanges.filter(
                              (change) => asString(change.relationship) === 'requested'
                            )
                            const dependencyChanges = packageChanges.filter(
                              (change) => asString(change.relationship) === 'dependency'
                            )
                            const unattributedChanges = packageChanges.filter(
                              (change) => asString(change.relationship) === 'unattributed'
                            )
                            const key = asString(operation.operation_id) ?? `operation-${index}`
                            return (
                              <Fragment key={key}>
                                <tr className="border-t border-border-300/40">
                                  <td className="align-top px-2 py-2 text-text-300">
                                    {timestamp ? (
                                      <time
                                        dateTime={timestamp}
                                        className="block whitespace-normal break-words tabular-nums leading-5"
                                      >
                                        {formatDate(timestamp, 'dateTime')}
                                      </time>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-100">
                                    {asString(operation.operation) ?? t('unknown')}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-300">
                                    {requestedChanges.length > 0
                                      ? requestedChanges
                                          .map((change) => packageChangeLabel(change, t))
                                          .join(', ')
                                      : Array.isArray(operation.packages)
                                        ? operation.packages
                                            .filter(
                                              (entry): entry is string => typeof entry === 'string'
                                            )
                                            .join(', ')
                                        : '—'}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-300">
                                    {asString(operation.result) ?? t('unknown')}
                                  </td>
                                </tr>
                                {hasPackageChanges ? (
                                  <tr className="border-t border-border-300/30 bg-bg-100/60">
                                    <td colSpan={4} className="px-2 py-2 text-text-300">
                                      {dependencyChanges.length > 0 ? (
                                        <div>
                                          <span className="font-medium text-text-200">
                                            {t('Dependency impact')}
                                          </span>
                                          <div className="mt-1 flex flex-wrap gap-1.5">
                                            {dependencyChanges.map((change, changeIndex) => (
                                              <span
                                                key={`${key}-dependency-${changeIndex}`}
                                                className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-[11px] text-text-200"
                                              >
                                                {packageChangeLabel(change, t)}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      {unattributedChanges.length > 0 ? (
                                        <div className={dependencyChanges.length > 0 ? 'mt-2' : ''}>
                                          <span className="font-medium text-text-200">
                                            {t(
                                              'Observed since the previous snapshot (not attributed to this operation)'
                                            )}
                                          </span>
                                          <div className="mt-1 flex flex-wrap gap-1.5">
                                            {unattributedChanges.map((change, changeIndex) => (
                                              <span
                                                key={`${key}-unattributed-${changeIndex}`}
                                                className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-[11px] text-text-200"
                                              >
                                                {packageChangeLabel(change, t)}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      {dependencyChanges.length === 0 &&
                                      unattributedChanges.length === 0 ? (
                                        <span>{t('No additional package version changes')}</span>
                                      ) : null}
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-text-300">
                {statusReason(evidence?.environment_status) ??
                  t('Environment evidence was not captured for this version.')}
              </p>
            )}
          </section>
        ) : null}
        {provenance && activeTab === 'review' && deferredSectionReady ? (
          reviewForCard ? (
            <section className="p-4">
              <ReviewerCard
                review={reviewForCard}
                defaultExpanded
                onGoToTranscript={openReviewTranscript}
              />
              {lineage?.originSession.state === 'deleted' ? (
                <p className="mt-3 text-xs text-text-300">
                  {t('Captured before source session deletion')}
                </p>
              ) : null}
            </section>
          ) : (
            <section className="flex gap-3 p-5">
              <Circle className="mt-0.5 size-4 text-text-300" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold text-text-000">
                  {reviewUnavailableReason === 'source-session-unavailable'
                    ? t('Review unavailable')
                    : t('No review for this version')}
                </h3>
                <p className="mt-1 text-sm text-text-300">
                  {reviewUnavailableReason === 'source-session-unavailable'
                    ? t(
                        'The active source session could not be loaded, so its saved review cannot be verified as current.'
                      )
                    : lineage?.originSession.state === 'deleted'
                      ? t(
                          'The source session was deleted before an applicable review was captured.'
                        )
                      : t('This version was generated without an applicable reviewer audit.')}
                </p>
                {reviewUnavailableReason !== 'source-session-unavailable' ? (
                  <p className="mt-3 text-xs text-text-300">{t('Model · not triggered')}</p>
                ) : null}
              </div>
            </section>
          )
        ) : null}
      </div>
    </div>
  )
}

export { ArtifactProvenancePanel, ProvenanceMessagesTimeline }
