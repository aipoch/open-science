import { Tabs } from 'radix-ui'
import {
  createEnvironmentFromLock,
  describeEnvironmentLock,
  environmentLockKey,
  retainEnvironmentLocks,
  useArtifactEnvironmentLockStore
} from './artifact-environment-lock-store'
import { useVersionHistoryPages } from './use-version-history-pages'
import { ExecutionContextDetails } from './ExecutionContextDetails'
import { VersionHistoryLoadButton } from './VersionHistoryLoadButton'
import {
  provenanceReadFailure,
  unwrapProvenanceRead,
  type ProvenanceReadFailure
} from '../../../../shared/provenance-read-result'
import { ProvenanceLoadNotice } from './ProvenanceLoadNotice'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/* Hallmark · component: environment-lock-list · genre: modern-minimal · theme: existing system */
import {
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  Download,
  LoaderCircle,
  PackagePlus,
  X
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { EnvironmentPackageSearch } from './EnvironmentPackageSearch'
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
import type { PreviewFileItem, PreviewProvenanceTab } from '@/stores/preview-workbench-store'
import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import {
  createSessionReviewerPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type {
  ArtifactEnvironmentLockPackageManager,
  DescribeArtifactEnvironmentLockRequest
} from '../../../../shared/artifact-reproducibility'
import type {
  NotebookEnvironmentLockPartialReason,
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
import type { ArtifactLiteratureManifest } from '../../../../shared/artifact-literature'
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
import { ArtifactReproducibilityPanel } from './ArtifactReproducibilityPanel'
import { NotebookCodeBlock } from './notebook-code'
import { NotebookDialogCell } from './SessionNotebookDialog'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceContextCompactionActivityRow } from './WorkspaceContextCompactionActivityRow'
import { WorkspacePlanActivityRecord } from './WorkspacePlanActivityRecord'
import { WorkspaceElicitationCard } from './WorkspaceElicitationCard'
import { WorkspaceAssistantTurnCompletion, WorkspaceMessageItem } from './WorkspaceMessageItem'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { createWorkspaceConversationTimeline } from './workspace-conversation-timeline'
import { useHorizontalScrollFade } from './use-horizontal-scroll-fade'
import { ArtifactSourcesPanel } from './ArtifactSourcesPanel'

type ProvenanceTab = PreviewProvenanceTab
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
  initialTab?: ProvenanceTab
  selectedTab?: ProvenanceTab
  onTabChange?: (tab: ProvenanceTab) => void
  tooltipClassName?: string
}

const tabs: Array<{ id: ProvenanceTab; label: string }> = [
  { id: 'code', label: 'Code' },
  { id: 'reproducibility', label: 'Reproducibility' },
  { id: 'execution', label: 'Execution Log' },
  { id: 'messages', label: 'Messages' },
  { id: 'environment', label: 'Environment' },
  { id: 'review', label: 'Review' }
]
const sourcesTab = { id: 'sources', label: 'Literature' } as const

const tabActionBarClassName = 'flex items-center gap-3 border-b border-border-300/50 px-4 py-2'

const scriptDownloadFormats = {
  python: { extension: 'py', mimeType: 'text/x-python' },
  r: { extension: 'R', mimeType: 'text/x-r' },
  bash: { extension: 'sh', mimeType: 'text/x-sh' },
  repl: { extension: 'txt', mimeType: 'text/plain' }
} satisfies Record<ArtifactCodeReconstruction['language'], { extension: string; mimeType: string }>

type CapturedEnvironmentLock = {
  lockChecksum: string
  state: 'available' | 'partial'
  kernelKind: 'python' | 'r'
  environmentName?: string
  partialReasons?: NotebookEnvironmentLockPartialReason[]
}

const packageManagerLabel = (manager: ArtifactEnvironmentLockPackageManager): string => {
  if (manager === 'conda') return 'Conda'
  if (manager === 'poetry') return 'Poetry'
  return manager
}

const platformLabel = (platform: string | undefined): string => {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform ?? '—'
}

const partialEnvironmentLockSummary = (
  reasons: NotebookEnvironmentLockPartialReason[] | undefined,
  t: TFunction
): string => {
  const details = new Set<string>()
  for (const reason of reasons ?? []) {
    if (reason === 'environment-manifest-partial') {
      details.add(t('Package inventory was incomplete.'))
    } else if (
      reason === 'non-conda-package-detected' ||
      reason === 'non-conda-installer-detected'
    ) {
      details.add(t('Some packages are not covered by the exact Conda lock.'))
    } else if (reason === 'native-lock-file-best-effort') {
      details.add(t('A native package lock was captured on a best-effort basis.'))
    } else if (reason === 'native-lock-file-rejected') {
      details.add(t('A native package lock was rejected because it was unsafe or invalid.'))
    }
  }
  return [
    t('Inspection only; this partial lock cannot run a reproducibility check.'),
    ...details
  ].join(' ')
}

const capturedEnvironmentLocksForRuns = (
  runs: ProvenanceNotebookRun[],
  relevantRunIds?: Set<string>
): CapturedEnvironmentLock[] => {
  const locks = new Map<string, CapturedEnvironmentLock>()
  for (const run of runs) {
    if (relevantRunIds && !relevantRunIds.has(run.runId)) continue
    const lock = run.environmentLock
    if (
      (run.kernelKind !== 'python' && run.kernelKind !== 'r') ||
      (lock?.state !== 'available' && lock?.state !== 'partial')
    ) {
      continue
    }
    const previous = locks.get(lock.lockChecksum)
    if (previous?.state === 'partial' && lock.state === 'partial') {
      previous.partialReasons = [
        ...new Set([...(previous.partialReasons ?? []), ...(lock.partialReasons ?? [])])
      ]
      continue
    }
    if (!previous || (previous.state === 'partial' && lock.state === 'available')) {
      locks.set(lock.lockChecksum, {
        lockChecksum: lock.lockChecksum,
        state: lock.state,
        kernelKind: run.kernelKind,
        ...(run.environmentName ? { environmentName: run.environmentName } : {}),
        ...(lock.partialReasons ? { partialReasons: [...lock.partialReasons] } : {})
      })
    }
  }
  return [...locks.values()]
}

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
      return t(
        'Supporting code is incomplete. Failed or interrupted cells may have changed kernel state before stopping.'
      )
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
        data: {
          'application/json': {
            columns: output.columns,
            rowCount: output.rowCount,
            previewRows: output.previewRows
          },
          'text/plain': [
            `Table preview: showing first ${Array.isArray(output.previewRows) ? output.previewRows.length : 0} of ${output.rowCount} rows.\n`,
            ...(Array.isArray(output.columns) ? [output.columns.join('\t') + '\n'] : []),
            ...(Array.isArray(output.previewRows)
              ? output.previewRows.map((row) =>
                  Array.isArray(row)
                    ? row.map((cell) => JSON.stringify(cell)).join('\t') + '\n'
                    : ''
                )
              : [])
          ]
        },
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
  execution: NonNullable<ArtifactVersionProvenance['execution']>,
  kernel: 'python' | 'r',
  metadata: {
    artifactId: string
    versionId: string
    producerRunId?: string
    runtimeVersion?: string
  }
): Record<string, unknown> => {
  const kernels = [...new Set(execution.runs.map((run) => run.kernelKind))]
  const notices: string[] = []
  if (execution.truncation) {
    const { omittedLeadingRunCount, omittedOutputCount, omittedInputCount } = execution.truncation
    notices.push(
      `Execution evidence was bounded for storage: omitted ${omittedLeadingRunCount} earlier runs, ${omittedOutputCount} outputs, and ${omittedInputCount} inputs. Missing earlier code may define values used by retained cells.`
    )
  }
  if (kernels.length > 1) {
    notices.push(
      `This notebook contains only ${kernel} runs from a snapshot containing ${kernels.join(', ')} kernels. Omission counts describe the original snapshot, not this kernel alone.`
    )
  }
  return {
    cells: [
      ...(notices.length
        ? [{ cell_type: 'markdown', metadata: {}, source: toSourceLines(notices.join('\n\n')) }]
        : []),
      ...execution.runs.flatMap((candidate) => {
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
      })
    ],
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
        provenance_snapshot: true,
        ...(execution.truncation ? { truncation: execution.truncation } : {}),
        snapshot_scope: {
          created_at: execution.createdAt,
          root_frame_id: execution.rootFrameId,
          agent_frame_id: execution.agentFrameId,
          message_branch_id: execution.messageBranchId,
          terminal_prompt_message_id: execution.terminalPromptMessageId,
          producer_run_index: execution.producerRunIndex,
          retained_run_count: execution.runs.length,
          kernels
        },
        kernel_filter: kernel
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  }
}

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
    <TooltipProvider key={sessionId} delayDuration={200} skipDelayDuration={300}>
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
    </TooltipProvider>
  )
}

const ArtifactProvenancePanel = ({
  item,
  projectId,
  onClose,
  onVersionChange,
  initialTab,
  selectedTab,
  onTabChange,
  tooltipClassName
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
    !onVersionChange && selectedVersion && selectedVersion.artifactId === item.artifactId
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
  const [requestedTab, setRequestedTab] = useState<ProvenanceTab | undefined>(initialTab)
  const setActiveTab = (tab: ProvenanceTab): void => {
    setRequestedTab(tab)
    onTabChange?.(tab)
  }
  const [literatureResult, setLiteratureResult] = useState<{
    key: string
    value?: ArtifactLiteratureManifest
    error?: ProvenanceReadFailure
  }>()
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
  const [packageSearch, setPackageSearch] = useState({ key: '', query: '' })
  const [exportingNotebook, setExportingNotebook] = useState(false)
  const [exportingEnvironmentLockChecksum, setExportingEnvironmentLockChecksum] = useState<string>()
  const [environmentLockExportFailure, setEnvironmentLockExportFailure] = useState<{
    key: string
    message: string
  }>()
  const environmentLockEntries = useArtifactEnvironmentLockStore((state) => state.entries)
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
  const searchPackages = useCallback(
    (query: string) => setPackageSearch({ key: provenanceKey, query }),
    [provenanceKey]
  )
  const coreProvenance =
    provenanceResult?.key === provenanceKey ? provenanceResult.value : undefined
  const activeTab =
    selectedTab ??
    requestedTab ??
    (selectedVersionDescriptor?.hasLiterature || coreProvenance?.literature ? 'sources' : 'code')
  const showAllPackages = showAllPackagesKey === provenanceKey
  const notebookExportError =
    notebookExportFailure?.key === provenanceKey ? notebookExportFailure.message : undefined
  const environmentLockExportError =
    environmentLockExportFailure?.key === provenanceKey
      ? environmentLockExportFailure.message
      : undefined
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
    (literatureResult?.key === provenanceKey ? literatureResult.error : undefined) ??
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

  useEffect(() => {
    if (!isUserEdit || !selectedVersionDescriptor?.hasLiterature || !selectedVersionId) return
    let active = true
    void window.api.artifacts
      .getVersionLiterature({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId!,
        versionId: selectedVersionId
      })
      .then(
        (value) => {
          if (active) setLiteratureResult({ key: provenanceKey, value })
        },
        (failure: unknown) => {
          if (active) {
            setLiteratureResult({
              key: provenanceKey,
              error: provenanceReadFailure(failure)
            })
          }
        }
      )
    return () => {
      active = false
    }
  }, [
    coreRetry,
    isUserEdit,
    item.artifactId,
    item.sessionId,
    projectId,
    provenanceKey,
    selectedVersionDescriptor?.hasLiterature,
    selectedVersionId
  ])

  const reviewReloadKey = activeTab === 'review' ? reviewRevision : 0
  const deferredTab = (
    activeTab === 'reproducibility' || activeTab === 'environment'
      ? 'execution'
      : activeTab === 'execution' || activeTab === 'messages' || activeTab === 'review'
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
  const retryDeferredSection = (): void => {
    setDeferredSectionResults((current) => {
      if (!deferredSectionKey || !current[deferredSectionKey]) return current
      const next = { ...current }
      delete next[deferredSectionKey]
      return next
    })
  }
  // Pending is a successful read of temporary unavailability, not an immutable snapshot.
  // Recheck on tab navigation or file refresh; a ready snapshot keeps its version cache.
  useEffect(() => {
    const key = `${provenanceKey}:messages:0`
    setDeferredSectionResults((current) => {
      const result = current[key]
      if (
        result?.state !== 'loaded' ||
        !('messages' in result.section) ||
        result.section.messages?.state !== 'unavailable' ||
        result.section.messages.reason !== 'message-snapshot-pending'
      )
        return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }, [activeTab, item.mtimeMs, item.versionNumber, provenanceKey])
  const provenance = useMemo(
    () =>
      coreProvenance && deferredSectionResult?.state === 'loaded'
        ? { ...coreProvenance, ...deferredSectionResult.section }
        : coreProvenance,
    [coreProvenance, deferredSectionResult]
  )
  const literature = isUserEdit
    ? literatureResult?.key === provenanceKey
      ? literatureResult.value
      : undefined
    : provenance?.literature
  const visibleTabs = isUserEdit
    ? literature
      ? [sourcesTab]
      : []
    : literature
      ? [tabs[0]!, sourcesTab, ...tabs.slice(1)]
      : tabs
  useEffect(() => {
    if ((selectedTab ?? requestedTab) === 'sources' && provenance && !provenance.literature) {
      setRequestedTab(undefined)
      if (selectedTab === 'sources') onTabChange?.('code')
    }
  }, [selectedTab, requestedTab, provenance, onTabChange])
  const deferredTabLabel = deferredTab ? tabs.find((tab) => tab.id === activeTab)?.label : undefined
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
      deferredTab === 'execution'
        ? window.api.artifacts.getVersionExecution(request)
        : deferredTab === 'messages'
          ? window.api.artifacts.getVersionMessages(request)
          : deferredTab === 'review'
            ? window.api.artifacts.getVersionReview(request)
            : undefined
    if (!load) return
    const sectionKey = `${provenanceKey}:${deferredTab}:${deferredTab === 'review' ? reviewReloadKey : 0}`
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
    deferredTab,
    deferredSectionState,
    item.mtimeMs,
    item.versionNumber,
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
      setLiteratureResult(undefined)
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
  // Cache reuse is informational only when capture itself is complete. The same legacy
  // warning can also accompany an unverified fingerprint; do not hide that partial capture.
  const isInventoryNote = (warning: string): boolean =>
    warning === 'inventory-cache-best-effort' && environment?.capture_status === 'complete'
  const captureProblems = environmentWarnings.filter((warning) => !isInventoryNote(warning))
  const inventoryNotes = environmentWarnings.filter(isInventoryNote)
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
  const packageQuery = packageSearch.key === provenanceKey ? packageSearch.query : ''
  const normalizedPackageQuery = packageQuery.trim().toLocaleLowerCase()
  const visibleEnvironmentPackages = normalizedPackageQuery
    ? environmentPackages.filter((pkg) =>
        (asString(pkg.name) ?? '').toLocaleLowerCase().includes(normalizedPackageQuery)
      )
    : showAllPackages
      ? environmentPackages
      : filteredEnvironmentPackages
  const hasFilteredEnvironmentPackages =
    filteredEnvironmentPackages.length < environmentPackages.length
  const rawExecutionRuns = useMemo(
    () => (Array.isArray(provenance?.execution?.runs) ? provenance.execution.runs : []),
    [provenance?.execution?.runs]
  )
  const capturedEnvironmentLocks = useMemo(() => {
    const activities = provenance?.execution?.reproducibility?.activities
    const relevantRunIds = activities
      ? new Set(
          activities
            .filter((activity) => activity.kind === 'notebook-run')
            .map((activity) => activity.activityId)
        )
      : undefined
    return capturedEnvironmentLocksForRuns(rawExecutionRuns, relevantRunIds)
  }, [provenance?.execution?.reproducibility?.activities, rawExecutionRuns])
  const lockRequest = (lock: CapturedEnvironmentLock): DescribeArtifactEnvironmentLockRequest => ({
    projectId,
    appSessionId: item.sessionId,
    artifactId: item.artifactId!,
    versionId: selectedVersionId!,
    lockChecksum: lock.lockChecksum
  })
  const creatingEnvironment = capturedEnvironmentLocks.some(
    (lock) =>
      environmentLockEntries.get(environmentLockKey(lockRequest(lock)))?.creation?.status ===
      'pending'
  )
  useEffect(() => {
    if (
      activeTab !== 'environment' ||
      !window.api?.artifacts.describeEnvironmentLock ||
      !item.artifactId ||
      !selectedVersionId
    )
      return
    const artifactId = item.artifactId
    const requests = capturedEnvironmentLocks.map((lock) => ({
      projectId,
      appSessionId: item.sessionId,
      artifactId,
      versionId: selectedVersionId,
      lockChecksum: lock.lockChecksum
    }))
    const release = retainEnvironmentLocks(requests)
    for (const request of requests) void describeEnvironmentLock(request)
    return release
  }, [
    activeTab,
    capturedEnvironmentLocks,
    item.artifactId,
    item.sessionId,
    projectId,
    selectedVersionId
  ])
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
      association: input.strongest_association,
      accessEvidence: input.access_evidence
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
    if (!onVersionChange) setSelectedVersion({ artifactId: item.artifactId, versionId })
  }

  const downloadExecutionNotebook = async (): Promise<void> => {
    if (
      executionKernels.length === 0 ||
      !item.artifactId ||
      !selectedVersionId ||
      !provenance?.execution
    )
      return
    setExportingNotebook(true)
    setNotebookExportFailure(undefined)
    try {
      const baseName = item.name.replace(/\.[^.]+$/u, '') || 'artifact'
      const versionNumber = selectedVersionDescriptor?.versionNumber ?? 1
      for (const kernel of executionKernels) {
        const notebook = buildExecutionNotebook(provenance.execution, kernel, {
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

  const downloadEnvironmentLock = async (lock: CapturedEnvironmentLock): Promise<void> => {
    const exportEnvironmentLock = window.api?.artifacts.exportEnvironmentLock
    if (!item.artifactId || !selectedVersionId || !exportEnvironmentLock) return
    setExportingEnvironmentLockChecksum(lock.lockChecksum)
    setEnvironmentLockExportFailure(undefined)
    try {
      await exportEnvironmentLock({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId,
        versionId: selectedVersionId,
        lockChecksum: lock.lockChecksum
      })
    } catch {
      setEnvironmentLockExportFailure({
        key: provenanceKey,
        message: t('Environment lock could not be exported.')
      })
    } finally {
      setExportingEnvironmentLockChecksum(undefined)
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

  const editSummary = isUserEdit ? (
    <div className="space-y-1.5 text-xs text-text-300">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{t('Edited in Open Science')}</span>
        {basedOnVersionId && basedOnVersionNumber !== undefined ? (
          <button
            type="button"
            aria-label={t('Open source version v{{version}}', { version: basedOnVersionNumber })}
            className="rounded text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => selectVersion(basedOnVersionId)}
          >
            {t('View source provenance · v{{version}}', { version: basedOnVersionNumber })}
          </button>
        ) : (
          <span>{t('Based on an earlier immutable version.')}</span>
        )}
      </div>
      <p>
        {t(
          'This edited version has no new agent execution. View the source version for its code, messages and execution evidence.'
        )}
      </p>
    </div>
  ) : undefined

  return (
    <Tabs.Root
      value={isUserEdit && literature ? 'sources' : activeTab}
      activationMode="manual"
      onValueChange={(value) => setActiveTab(value as ProvenanceTab)}
      className="flex size-full min-h-0 flex-col bg-bg-000"
      data-testid="artifact-provenance"
    >
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
      {(!isUserEdit || literature) && !isLegacyVersion ? (
        <Tabs.List
          ref={tabScrollFadeRef}
          aria-label={t('Provenance')}
          className="scroll-fade-x flex shrink-0 gap-1 overflow-hidden border-b border-border-300/60 px-2 py-1"
        >
          {visibleTabs.map((tab) => (
            <Tabs.Trigger
              key={tab.id}
              value={tab.id}
              title={t(tab.label)}
              onClick={() => setActiveTab(tab.id)}
              className={`min-w-0 truncate whitespace-nowrap rounded px-2 py-1 text-xs ${isUserEdit || activeTab === tab.id ? 'bg-bg-300 text-text-000' : 'text-text-200 hover:text-text-100'}`}
            >
              {t(tab.label)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      ) : null}

      {(!isUserEdit || literature) && !isLegacyVersion
        ? visibleTabs
            .filter((tab) => tab.id !== (isUserEdit && literature ? 'sources' : activeTab))
            .map((tab) => <Tabs.Content key={tab.id} value={tab.id} />)
        : null}
      <Tabs.Content
        value={isUserEdit && literature ? 'sources' : activeTab}
        role={(!isUserEdit || literature) && !isLegacyVersion ? 'tabpanel' : 'region'}
        {...((!isUserEdit || literature) && !isLegacyVersion
          ? {}
          : { 'aria-labelledby': undefined })}
        className="min-h-0 flex-1 overflow-y-auto"
      >
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
        {!error && isUserEdit && !literature ? (
          <section className="px-4 py-3">{editSummary}</section>
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
        {!error &&
        isUserEdit &&
        selectedVersionDescriptor?.hasLiterature &&
        literatureResult?.key !== provenanceKey ? (
          <div className="flex justify-center p-5 text-text-300">
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
              deferredSectionResult.kind === 'integrity-failed' ? undefined : retryDeferredSection
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  disabled
                >
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
                <TooltipProvider delayDuration={100}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        role="status"
                        tabIndex={0}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-status-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-status-warning-dark-foreground"
                      >
                        <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                        <p className="min-w-0 truncate text-xs leading-5">
                          {codeReconstructionUnavailableLabel(codeReconstructionState.reason, t)}
                        </p>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start">
                      {codeReconstructionUnavailableLabel(codeReconstructionState.reason, t)}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
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
        {literature && (isUserEdit || activeTab === 'sources') ? (
          <ArtifactSourcesPanel
            key={selectedVersionId}
            literature={literature}
            versionSummary={editSummary}
            formatContext={
              item.artifactId &&
              selectedVersionId &&
              (lineage?.headVersion?.versionId ?? lineage?.versions.at(-1)?.versionId) &&
              item.name.toLowerCase().endsWith('.docx')
                ? {
                    projectId,
                    sessionId: item.sessionId,
                    artifactId: item.artifactId,
                    versionId: selectedVersionId,
                    expectedHeadVersionId:
                      lineage.headVersion?.versionId ?? lineage.versions.at(-1)!.versionId
                  }
                : undefined
            }
          />
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
                    <LoaderCircle
                      className="animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
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
                {executionRuns.map(({ run, index }, runOffset) => (
                  <div key={run.runId}>
                    {rawExecutionRuns[runOffset]?.outputs.map((output, outputIndex) =>
                      output.type === 'table' ? (
                        <p key={outputIndex} className="px-4 py-2 text-xs text-text-200">
                          {t('Table preview: showing first {{shown}} of {{total}} rows.', {
                            shown: output.previewRows.length,
                            total: output.rowCount
                          })}
                        </p>
                      ) : null
                    )}
                    <NotebookDialogCell run={run} index={index} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="p-5 text-sm text-text-300">
              {t('Unable to determine the producer execution for this version.')}
            </p>
          )
        ) : null}
        {provenance && activeTab === 'reproducibility' && deferredSectionReady ? (
          <ArtifactReproducibilityPanel
            key={provenanceKey}
            projection={provenance.execution?.reproducibility}
            analysisRevision={provenance.execution?.analysisRevision}
            environmentRuns={provenance.execution?.runs}
            executionAvailable={provenance.execution !== undefined}
            artifactName={item.name}
            artifactVersion={
              item.artifactId && selectedVersionId
                ? {
                    projectId,
                    appSessionId: item.sessionId,
                    artifactId: item.artifactId,
                    versionId: selectedVersionId
                  }
                : undefined
            }
            tooltipClassName={tooltipClassName}
          />
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
            <div className="space-y-3 p-5 text-sm text-text-300">
              <p>
                {provenance.messages.reason === 'message-snapshot-unsupported'
                  ? t(
                      'This message snapshot was created by a newer version of Open Science. Update the app to view it.'
                    )
                  : t(
                      'The immutable message snapshot is not available for this version ({{reason}}).',
                      { reason: provenance.messages.reason }
                    )}
              </p>
              {provenance.messages.reason === 'message-snapshot-pending' ? (
                <Button type="button" size="sm" variant="outline" onClick={retryDeferredSection}>
                  {t('Recheck message snapshot')}
                </Button>
              ) : null}
            </div>
          )
        ) : null}
        {provenance && activeTab === 'environment' && deferredSectionReady ? (
          <section className="min-w-0 space-y-5 p-4 text-sm">
            <header className="space-y-1">
              <h3 className="break-words font-semibold text-text-000">
                {asString(environment?.environment_name) ??
                  provenance.descriptor.environment ??
                  t('Environment unavailable')}
              </h3>
              {environment ? (
                <p className="text-xs text-text-200">
                  {asString(environment.kernel_kind) === 'r'
                    ? 'R'
                    : asString(environment.kernel_kind) === 'python'
                      ? 'Python'
                      : t('Runtime')}{' '}
                  {asString(environment.runtime_version) ?? t('Version unavailable')}
                </p>
              ) : null}
            </header>
            <section
              aria-labelledby="captured-environment-locks"
              className="@container/environment-lock space-y-2"
            >
              <h4 id="captured-environment-locks" className="text-xs font-medium text-text-200">
                {t('Captured environment locks')}
              </h4>
              {capturedEnvironmentLocks.length > 0 ? (
                <ul className="divide-y divide-border-300/50 overflow-hidden rounded-md border border-border-300/60">
                  {capturedEnvironmentLocks.map((lock) => {
                    const lockName = lock.kernelKind === 'python' ? t('Python lock') : t('R lock')
                    const exporting = exportingEnvironmentLockChecksum === lock.lockChecksum
                    const entry = environmentLockEntries.get(environmentLockKey(lockRequest(lock)))
                    const creating = entry?.creation?.status === 'pending'
                    const created =
                      entry?.creation?.status === 'ready' ? entry.creation.value : undefined
                    const details =
                      entry?.details?.status === 'ready' ? entry.details.value : undefined
                    return (
                      <li key={lock.lockChecksum} className="min-w-0 space-y-3 p-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="truncate font-medium text-text-100">{lockName}</span>
                            <span className="rounded bg-bg-100 px-2 py-0.5 text-xs text-text-200">
                              {lock.state === 'available' ? t('Complete lock') : t('Partial lock')}
                            </span>
                          </div>
                          {lock.environmentName &&
                          lock.environmentName !==
                            (asString(environment?.environment_name) ??
                              provenance.descriptor.environment) ? (
                            <p className="mt-1 break-words text-xs text-text-200">
                              {lock.environmentName}
                            </p>
                          ) : null}
                          {details ? (
                            <p className="mt-1 text-xs text-text-300">
                              {platformLabel(details.platform)} · {details.architecture ?? '—'} ·{' '}
                              {details.packageManagers.map(packageManagerLabel).join(', ')}
                            </p>
                          ) : (
                            <p className="mt-1 text-xs text-text-300">
                              {entry?.details?.status === 'error'
                                ? t('Unavailable')
                                : t('Loading…')}
                            </p>
                          )}
                          {lock.state === 'partial' ? (
                            <p className="mt-1 text-xs leading-5 text-status-warning-foreground dark:text-status-warning-dark-foreground">
                              {partialEnvironmentLockSummary(lock.partialReasons, t)}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          {window.api?.artifacts.exportEnvironmentLock ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="max-w-full whitespace-nowrap text-xs"
                              disabled={
                                exportingEnvironmentLockChecksum !== undefined ||
                                details === undefined
                              }
                              aria-label={t('Download {{name}}', { name: lockName })}
                              onClick={() => void downloadEnvironmentLock(lock)}
                            >
                              {exporting ? (
                                <LoaderCircle
                                  className="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Download aria-hidden="true" />
                              )}
                              {exporting ? t('Preparing…') : t('Download bundle')}
                            </Button>
                          ) : null}
                          {lock.state === 'available' &&
                          window.api?.artifacts.createEnvironmentFromLock ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="max-w-full whitespace-nowrap text-xs"
                              aria-label={t('Create reusable environment')}
                              disabled={creatingEnvironment || details === undefined}
                              onClick={() => void createEnvironmentFromLock(lockRequest(lock))}
                            >
                              {creating ? (
                                <LoaderCircle
                                  className="animate-spin motion-reduce:animate-none"
                                  aria-hidden="true"
                                />
                              ) : (
                                <PackagePlus aria-hidden="true" />
                              )}
                              {creating ? t('Creating…') : t('Reuse environment')}
                            </Button>
                          ) : null}
                        </div>
                        {entry?.details?.status === 'error' ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void describeEnvironmentLock(lockRequest(lock), true)}
                          >
                            {t('Retry')}
                          </Button>
                        ) : null}
                        {entry?.creation?.status === 'error' ? (
                          <p className="text-xs text-danger-000" role="alert">
                            {t('Reusable environment could not be created.')}
                          </p>
                        ) : created ? (
                          <p
                            className="text-xs text-status-info-foreground dark:text-status-info-dark-foreground"
                            role="status"
                          >
                            {created.reused
                              ? t('Environment {{name}} is already available.', {
                                  name: created.environmentName
                                })
                              : t('Reusable environment created as {{name}}.', {
                                  name: created.environmentName
                                })}
                          </p>
                        ) : null}
                        <details className="text-xs text-text-300">
                          <summary className="w-fit cursor-pointer rounded-sm text-text-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            {t('Lock details')}
                          </summary>
                          <div className="mt-2 space-y-2">
                            <p className="select-text break-all font-mono text-[11px]">
                              sha256-{lock.lockChecksum}
                            </p>
                            <p>
                              {t(
                                'Downloads include Open Science metadata and tool-native lock files.'
                              )}
                            </p>
                          </div>
                        </details>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="rounded-md border border-border-300/60 px-3 py-2.5 text-xs text-text-300">
                  {t('No downloadable Environment lock was captured for this Artifact version.')}
                </p>
              )}
              {environmentLockExportError ? (
                <p className="text-xs text-danger-000" role="alert">
                  {environmentLockExportError}
                </p>
              ) : null}
            </section>
            {environment ? (
              <>
                <ExecutionContextDetails value={environment.execution_context} />
                {captureProblems.length > 0 ? (
                  <div
                    role="status"
                    className="rounded-md border border-status-warning-foreground/20 bg-status-warning-surface/40 px-3 py-2 text-xs text-status-warning-foreground dark:border-status-warning-dark-foreground/20 dark:bg-status-warning-dark-surface/40 dark:text-status-warning-dark-foreground"
                  >
                    <p className="font-medium">{t('Partial capture details')}</p>
                    <ul className="mt-1 list-disc space-y-1 pl-4">
                      {captureProblems.map((warning) => (
                        <li key={warning}>{environmentWarningLabel(warning, t)}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <details className="border-b border-border-300/60 pb-3 text-xs">
                  <summary className="w-fit cursor-pointer rounded-sm font-medium text-text-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t('Capture details')}
                  </summary>
                  <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
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
                      {t('{{count}} packages', {
                        count: environmentPackages.length,
                        defaultValue_one: '{{count}} package'
                      })}
                    </dd>
                  </dl>
                  {inventoryNotes.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-text-300">
                      {inventoryNotes.map((warning) => (
                        <li key={warning}>{environmentWarningLabel(warning, t)}</li>
                      ))}
                    </ul>
                  ) : null}
                </details>
                <details className="group/packages min-w-0">
                  <summary className="w-fit cursor-pointer rounded-sm font-medium text-text-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t('Packages')}{' '}
                    <span className="ml-2 text-xs font-normal text-text-300">
                      {environmentPackages.length}
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <EnvironmentPackageSearch
                      key={provenanceKey}
                      initialQuery={packageQuery}
                      onSearch={searchPackages}
                    />
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
                          {visibleEnvironmentPackages.length === 0 ? (
                            <tr>
                              <td colSpan={3} className="px-3 py-4 text-center text-text-300">
                                {t('No matching packages')}
                              </td>
                            </tr>
                          ) : null}
                          {visibleEnvironmentPackages.map((pkg) => (
                            <tr
                              key={`${asString(pkg.name)}:${asString(pkg.version)}`}
                              className="border-t border-border-300/40"
                            >
                              <td className="break-words px-3 py-2 text-text-100">
                                {asString(pkg.name) ?? t('Unknown package')}
                              </td>
                              <td className="break-words px-3 py-2 text-text-300">
                                {asString(pkg.version) ?? '—'}
                              </td>
                              <td className="break-words px-3 py-2 text-text-300">
                                {pkg.loaded_state === 'loaded'
                                  ? t('Loaded')
                                  : pkg.loaded_state === 'attached'
                                    ? t('Attached')
                                    : pkg.loaded_state === 'installed-only'
                                      ? t('Installed only')
                                      : t('unknown')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {hasFilteredEnvironmentPackages && !normalizedPackageQuery ? (
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
                  </div>
                </details>
                {environmentOperations.length > 0 || omittedOperationCount > 0 ? (
                  <details className="min-w-0 space-y-3 border-t border-border-300/60 pt-3">
                    <summary className="w-fit cursor-pointer rounded-sm font-medium text-text-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {t('Operations')}{' '}
                      <span className="ml-2 text-xs font-normal text-text-300">
                        {environmentOperations.length}
                      </span>
                    </summary>
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
                  </details>
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
      </Tabs.Content>
    </Tabs.Root>
  )
}

export { ArtifactProvenancePanel, ProvenanceMessagesTimeline }
