import { ChevronLeft, ChevronRight, Circle, Copy, Download, LoaderCircle, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { ReviewerCard } from '@/components/ReviewerCard'
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
import type { PersistedToolActivity } from '../../../../shared/session-persistence'
import type { GoToTranscriptIntent, ReviewUpdateEvent } from '../../../../shared/reviewer'
import {
  createPreviewFileItemForArtifactVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { NotebookInputDataStrip } from './NotebookInputDataStrip'
import { NotebookDialogCell } from './SessionNotebookDialog'
import { WorkspaceActivityGroup } from './WorkspaceActivityGroup'
import { WorkspaceMessageItem } from './WorkspaceMessageItem'
import { createConversationItems } from './workspace-conversation-items'
import { groupConversationItems } from './workspace-tool-activity-groups'

type ProvenanceTab = 'code' | 'execution' | 'messages' | 'environment' | 'review'

type ArtifactProvenancePanelProps = {
  item: PreviewFileItem
  projectId: string
  onClose: () => void
  onVersionChange?: (item: PreviewFileItem) => void
}

const tabs: Array<{ id: ProvenanceTab; label: string }> = [
  { id: 'code', label: 'Code' },
  { id: 'execution', label: 'Execution Log' },
  { id: 'messages', label: 'Messages' },
  { id: 'environment', label: 'Environment' },
  { id: 'review', label: 'Review' }
]

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

const packageKey = (value: string): string =>
  value.normalize('NFC').toLocaleLowerCase('und').replace(/[-_.]/gu, '')

const packageNameFromSpec = (value: string): string | undefined =>
  value.trim().match(/^[A-Za-z0-9_.-]+/u)?.[0]

const packageChangeLabel = (change: Record<string, unknown>): string => {
  const name = asString(change.name) ?? 'unknown package'
  const before = asString(change.before_version)
  const after = asString(change.after_version)
  switch (asString(change.change)) {
    case 'installed':
      return `${name} ${after ?? '(version unavailable)'}`
    case 'updated':
      return `${name} ${before ?? '—'} → ${after ?? '—'}`
    case 'removed':
      return `${name} ${before ?? '(version unavailable)'} → removed`
    case 'unchanged':
    case 'observed':
      return `${name} ${after ?? before ?? '(version unavailable)'}`
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
      title: 'Provenance Messages',
      cwd: '',
      status: 'idle',
      messages: snapshot.items.map(toChatMessage),
      activities: snapshot.activities.map(toToolActivity),
      activityGroups: snapshot.activityGroups,
      createdAt: snapshot.items[0]?.createdAt ?? 0,
      updatedAt: snapshot.items.at(-1)?.createdAt ?? 0
    }
    return groupConversationItems(createConversationItems(session), snapshot.activityGroups)
  }, [projectId, sessionId, snapshot])

  return (
    <MessageScrollerProvider
      key={`${sessionId}:${snapshot.items.at(-1)?.id ?? 'empty'}`}
      autoScroll
      defaultScrollPosition="last-anchor"
      scrollPreviousItemPeek={64}
    >
      <MessageScroller className="min-h-0 bg-bg-000">
        <MessageScrollerViewport aria-label="Provenance messages">
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
                      contentPaddingClassName="px-0 md:px-0"
                    />
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
  const lineageKey = `${projectId}:${item.sessionId}:${item.artifactId ?? ''}`
  const [lineageResult, setLineageResult] = useState<{
    key: string
    value?: ArtifactLineageProvenance
    error?: string
  }>()
  const [selectedVersion, setSelectedVersion] = useState<{
    artifactId: string
    versionId: string
  }>()
  const [provenanceResult, setProvenanceResult] = useState<{
    key: string
    value?: ArtifactVersionProvenance
    error?: string
  }>()
  const [activeTab, setActiveTab] = useState<ProvenanceTab>('code')
  const [reviewRevision, setReviewRevision] = useState(0)
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
  const lineage = lineageResult?.key === lineageKey ? lineageResult.value : undefined
  const requestedVersionId =
    selectedVersion && selectedVersion.artifactId === item.artifactId
      ? selectedVersion.versionId
      : item.selectedVersionId
  const selectedVersionId = lineage
    ? resolveArtifactVersionDescriptor(lineage, requestedVersionId)?.versionId
    : requestedVersionId
  const provenanceKey = `${lineageKey}:${selectedVersionId ?? ''}`
  const provenance = provenanceResult?.key === provenanceKey ? provenanceResult.value : undefined
  const showAllPackages = showAllPackagesKey === provenanceKey
  const notebookExportError =
    notebookExportFailure?.key === provenanceKey ? notebookExportFailure.message : undefined
  const codeActionError =
    codeActionFailure?.key === provenanceKey ? codeActionFailure.message : undefined
  const error =
    (lineageResult?.key === lineageKey ? lineageResult.error : undefined) ??
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
      .getLineage({ projectId, appSessionId: item.sessionId, artifactId: item.artifactId })
      .then((value) => {
        if (!active) return
        setLineageResult({ key: lineageKey, value })
      })
      .catch((failure: unknown) => {
        if (active) {
          setLineageResult({
            key: lineageKey,
            error: failure instanceof Error ? failure.message : String(failure)
          })
        }
      })
    return () => {
      active = false
    }
  }, [item.artifactId, item.sessionId, lineageKey, projectId])

  useEffect(() => {
    let active = true
    if (!item.artifactId || !selectedVersionId) return
    void window.api.artifacts
      .getVersionProvenance({
        projectId,
        appSessionId: item.sessionId,
        artifactId: item.artifactId,
        versionId: selectedVersionId
      })
      .then((value) => {
        if (active) setProvenanceResult({ key: provenanceKey, value })
      })
      .catch((failure: unknown) => {
        if (active) {
          setProvenanceResult({
            key: provenanceKey,
            error: failure instanceof Error ? failure.message : String(failure)
          })
        }
      })
    return () => {
      active = false
    }
  }, [item.artifactId, item.sessionId, projectId, provenanceKey, selectedVersionId])

  const reviewReloadKey = activeTab === 'review' ? reviewRevision : 0
  const hasLoadedProvenance =
    provenanceResult?.key === provenanceKey && Boolean(provenanceResult.value)
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
    const load =
      activeTab === 'execution'
        ? window.api.artifacts.getVersionExecution(request)
        : activeTab === 'messages'
          ? window.api.artifacts.getVersionMessages(request)
          : activeTab === 'review'
            ? window.api.artifacts.getVersionReview(request)
            : undefined
    if (!load) return
    void load
      .then((section) => {
        if (!active) return
        setProvenanceResult((current) =>
          current?.key === provenanceKey && current.value
            ? { key: provenanceKey, value: { ...current.value, ...section } }
            : current
        )
      })
      .catch((failure: unknown) => {
        if (!active) return
        setProvenanceResult((current) => ({
          key: provenanceKey,
          value: current?.key === provenanceKey ? current.value : undefined,
          error: failure instanceof Error ? failure.message : String(failure)
        }))
      })
    return () => {
      active = false
    }
  }, [
    activeTab,
    item.artifactId,
    item.sessionId,
    hasLoadedProvenance,
    projectId,
    provenanceKey,
    reviewReloadKey,
    selectedVersionId
  ])

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
  const reviewProjection =
    provenance?.review.state === 'available' ? provenance.review.value : undefined
  const reviewAssessment = reviewProjection
    ? (reviewProjection.currentDirectAssessment ?? reviewProjection.latestChainReview)
    : undefined
  const reviewForCard =
    reviewAssessment && reviewProjection
      ? {
          ...reviewAssessment,
          checks: [...reviewProjection.selectedVersionChecks, ...reviewProjection.turnLevelChecks]
        }
      : undefined
  const executionKernel = [...rawExecutionRuns]
    .reverse()
    .map((run) => asString(asRecord(run)?.kernelKind))
    .find((kernel): kernel is 'python' | 'r' => kernel === 'python' || kernel === 'r')
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
        findingId: intent.findingId,
        locator: intent.locator
      })
    )
  }

  const selectVersion = (versionId: string): void => {
    if (!item.artifactId) return
    const version = lineage?.versions.find((candidate) => candidate.versionId === versionId)
    if (!version) return

    setSelectedVersion({ artifactId: item.artifactId, versionId })
    const nextItem = createPreviewFileItemForArtifactVersion({ item, version, projectId })
    if (onVersionChange) onVersionChange(nextItem)
    else usePreviewWorkbenchStore.getState().upsertItem(nextItem)
  }

  const downloadExecutionNotebook = async (): Promise<void> => {
    if (!executionKernel || !item.artifactId || !selectedVersionId) return
    setExportingNotebook(true)
    setNotebookExportFailure(undefined)
    try {
      const notebook = buildExecutionNotebook(rawExecutionRuns, executionKernel, {
        artifactId: item.artifactId,
        versionId: selectedVersionId,
        producerRunId: asString(producer?.producer_run_id),
        runtimeVersion: asString(environment?.runtime_version)
      })
      const bytes = new TextEncoder().encode(`${JSON.stringify(notebook, null, 2)}\n`)
      const data = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer
      const baseName = item.name.replace(/\.[^.]+$/u, '') || 'artifact'
      const versionNumber = lineage?.versions[selectedIndex]?.versionNumber ?? 1
      await window.api.saveBlobFile({
        suggestedName: `${baseName}-v${versionNumber}.ipynb`,
        mimeType: 'application/x-ipynb+json',
        data
      })
    } catch (failure) {
      setNotebookExportFailure({
        key: provenanceKey,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setExportingNotebook(false)
    }
  }

  const copyProducerCode = async (): Promise<void> => {
    if (!reproductionCode || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(reproductionCode)
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
    try {
      const bytes = new TextEncoder().encode(reproductionCode)
      const data = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer
      const baseName = item.name.replace(/\.[^.]+$/u, '') || 'artifact'
      const versionNumber = lineage?.versions[selectedIndex]?.versionNumber ?? 1
      const evidenceProducer = provenance?.evidence.producer
      const kernelKind =
        evidenceProducer?.state === 'available' ? evidenceProducer.kernel_kind : undefined
      const extension = kernelKind === 'python' ? 'py' : kernelKind === 'r' ? 'R' : 'txt'
      await window.api.saveBlobFile({
        suggestedName: `${baseName}-v${versionNumber}.${extension}`,
        mimeType: 'text/plain',
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

  return (
    <div className="flex size-full min-h-0 flex-col bg-bg-000" data-testid="artifact-provenance">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Previous Artifact version"
          disabled={selectedIndex <= 0}
          onClick={() => {
            const versionId = lineage?.versions[selectedIndex - 1]?.versionId
            if (versionId) selectVersion(versionId)
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="text-xs font-medium text-text-100">
          {selectedIndex >= 0 ? `v${lineage?.versions[selectedIndex]?.versionNumber}` : 'Version'}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Next Artifact version"
          disabled={!lineage || selectedIndex < 0 || selectedIndex >= lineage.versions.length - 1}
          onClick={() => {
            const versionId = lineage?.versions[selectedIndex + 1]?.versionId
            if (versionId) selectVersion(versionId)
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-text-300">
          {lineage?.originSession.state === 'deleted'
            ? [
                'Source session deleted',
                lineage.originSession.title,
                lineage.originSession.deletedAt
                  ? new Date(lineage.originSession.deletedAt).toLocaleString()
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
          aria-label="Close Provenance"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div
        role="tablist"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-300/60 px-2 py-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`rounded px-2 py-1 text-xs ${activeTab === tab.id ? 'bg-bg-300 text-text-000' : 'text-text-300 hover:text-text-100'}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? <p className="p-5 text-sm text-danger-000">{error}</p> : null}
        {!error && !provenance ? (
          <div className="flex h-full items-center justify-center text-text-300">
            <LoaderCircle className="size-4 animate-spin" aria-label="Loading Provenance" />
          </div>
        ) : null}
        {provenance && activeTab === 'code' ? (
          <section className="space-y-3 p-4">
            {provenance.contentStatus.state === 'unavailable' ? (
              <p className="rounded-md bg-warning-100 px-3 py-2 text-xs text-warning-900">
                Artifact content is {provenance.contentStatus.reason}; captured provenance remains
                available.
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text-000">Executed producer block</h3>
              {reproductionCode ? (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!navigator.clipboard?.writeText}
                    onClick={() => void copyProducerCode()}
                  >
                    <Copy aria-hidden="true" />
                    Copy
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void downloadProducerCode()}
                  >
                    <Download aria-hidden="true" />
                    Download
                  </Button>
                </div>
              ) : null}
            </div>
            <NotebookInputDataStrip
              inputFiles={producerInputs}
              label="Inputs"
              className="-mx-4 border-y border-border-300/50 px-4 py-2"
            />
            {reproductionCode ? (
              <pre className="overflow-x-auto rounded-md bg-bg-200 p-3 font-mono text-xs text-text-100">
                {reproductionCode}
              </pre>
            ) : (
              <p className="text-sm text-text-300">
                No producer block was recorded for this version. {statusReason(producer)}
              </p>
            )}
            {codeActionError ? <p className="text-xs text-danger-000">{codeActionError}</p> : null}
          </section>
        ) : null}
        {provenance && activeTab === 'execution' ? (
          executionRuns.length > 0 ? (
            <div>
              <div className="flex items-center border-b border-border-300/50 px-4 py-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!executionKernel || exportingNotebook}
                  onClick={() => void downloadExecutionNotebook()}
                >
                  {exportingNotebook ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Download aria-hidden="true" />
                  )}
                  {exportingNotebook ? 'Preparing…' : 'Download notebook'}
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
              Unable to determine the producer execution for this version.
            </p>
          )
        ) : null}
        {provenance && activeTab === 'messages' ? (
          provenance.messages.state === 'available' ? (
            <ProvenanceMessagesTimeline
              key={provenanceKey}
              snapshot={provenance.messages}
              projectId={projectId}
              sessionId={item.sessionId}
            />
          ) : (
            <p className="p-5 text-sm text-text-300">
              The immutable message snapshot is not available for this version (
              {provenance.messages.reason}).
            </p>
          )
        ) : null}
        {provenance && activeTab === 'environment' ? (
          <section className="space-y-4 p-5 text-sm">
            <h3 className="font-semibold text-text-000">
              {asString(environment?.environment_name) ??
                provenance.descriptor.environment ??
                'Environment unavailable'}
            </h3>
            {environment ? (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-text-300">Runtime</dt>
                  <dd className="text-text-100">
                    {asString(environment.runtime_version) ?? 'Version unavailable'}
                  </dd>
                  <dt className="text-text-300">Source</dt>
                  <dd className="text-text-100">
                    {asString(environment.runtime_source) ?? 'unknown'} ·{' '}
                    {asString(environment.kernel_kind) ?? 'unknown'}
                  </dd>
                  <dt className="text-text-300">Capture</dt>
                  <dd className="text-text-100">
                    {asString(environment.capture_status) ?? 'partial'} ·{' '}
                    {environmentPackages.length} packages
                  </dd>
                </dl>
                <div className="overflow-hidden rounded-md border border-border-300/60">
                  <table className="w-full table-fixed text-left text-xs">
                    <thead className="bg-bg-100 text-text-300">
                      <tr>
                        <th className="w-1/2 px-3 py-2 font-medium">Package</th>
                        <th className="w-1/4 px-3 py-2 font-medium">Version</th>
                        <th className="w-1/4 px-3 py-2 font-medium">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEnvironmentPackages.map((pkg) => (
                        <tr
                          key={`${asString(pkg.name)}:${asString(pkg.version)}`}
                          className="border-t border-border-300/40"
                        >
                          <td className="truncate px-3 py-2 text-text-100">
                            {asString(pkg.name) ?? 'Unknown package'}
                          </td>
                          <td className="px-3 py-2 text-text-300">
                            {asString(pkg.version) ?? '—'}
                          </td>
                          <td className="px-3 py-2 text-text-300">
                            {asString(pkg.loaded_state) ?? 'unknown'}
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
                      ? `Show relevant ${filteredEnvironmentPackages.length} packages`
                      : `Show all ${environmentPackages.length} packages`}
                  </button>
                ) : null}
                {environmentOperations.length > 0 ? (
                  <div className="space-y-2">
                    <h4 className="font-semibold text-text-000">Operations</h4>
                    <div className="overflow-hidden rounded-md border border-border-300/60">
                      <table className="w-full table-fixed text-left text-xs">
                        <thead className="bg-bg-100 text-text-300">
                          <tr>
                            <th className="w-[34%] break-words px-2 py-2 font-medium">Time</th>
                            <th className="w-1/5 break-words px-2 py-2 font-medium">Operation</th>
                            <th className="w-[28%] break-words px-2 py-2 font-medium">Packages</th>
                            <th className="w-[18%] break-words px-2 py-2 font-medium">Result</th>
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
                                        {new Date(timestamp).toLocaleString()}
                                      </time>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-100">
                                    {asString(operation.operation) ?? 'unknown'}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-300">
                                    {requestedChanges.length > 0
                                      ? requestedChanges.map(packageChangeLabel).join(', ')
                                      : Array.isArray(operation.packages)
                                        ? operation.packages
                                            .filter(
                                              (entry): entry is string => typeof entry === 'string'
                                            )
                                            .join(', ')
                                        : '—'}
                                  </td>
                                  <td className="whitespace-normal break-words px-2 py-2 align-top text-text-300">
                                    {asString(operation.result) ?? 'unknown'}
                                  </td>
                                </tr>
                                {hasPackageChanges ? (
                                  <tr className="border-t border-border-300/30 bg-bg-100/60">
                                    <td colSpan={4} className="px-2 py-2 text-text-300">
                                      {dependencyChanges.length > 0 ? (
                                        <div>
                                          <span className="font-medium text-text-200">
                                            Dependency impact
                                          </span>
                                          <div className="mt-1 flex flex-wrap gap-1.5">
                                            {dependencyChanges.map((change, changeIndex) => (
                                              <span
                                                key={`${key}-dependency-${changeIndex}`}
                                                className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-[11px] text-text-200"
                                              >
                                                {packageChangeLabel(change)}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      {unattributedChanges.length > 0 ? (
                                        <div className={dependencyChanges.length > 0 ? 'mt-2' : ''}>
                                          <span className="font-medium text-text-200">
                                            Other observed changes
                                          </span>
                                          <div className="mt-1 flex flex-wrap gap-1.5">
                                            {unattributedChanges.map((change, changeIndex) => (
                                              <span
                                                key={`${key}-unattributed-${changeIndex}`}
                                                className="rounded bg-bg-200 px-1.5 py-0.5 font-mono text-[11px] text-text-200"
                                              >
                                                {packageChangeLabel(change)}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                      {dependencyChanges.length === 0 &&
                                      unattributedChanges.length === 0 ? (
                                        <span>No additional package version changes</span>
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
                  'Environment evidence was not captured for this version.'}
              </p>
            )}
          </section>
        ) : null}
        {provenance && activeTab === 'review' ? (
          reviewForCard ? (
            <section className="p-4">
              <ReviewerCard
                review={reviewForCard}
                defaultExpanded
                onGoToTranscript={openReviewTranscript}
              />
              {lineage?.originSession.state === 'deleted' ? (
                <p className="mt-3 text-xs text-text-300">
                  Captured before source session deletion
                </p>
              ) : null}
            </section>
          ) : (
            <section className="flex gap-3 p-5">
              <Circle className="mt-0.5 size-4 text-text-300" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold text-text-000">No review for this version</h3>
                <p className="mt-1 text-sm text-text-300">
                  {lineage?.originSession.state === 'deleted'
                    ? 'The source session was deleted before an applicable review was captured.'
                    : 'This version was generated without an applicable reviewer audit.'}
                </p>
                <p className="mt-3 text-xs text-text-300">Model · not triggered</p>
              </div>
            </section>
          )
        ) : null}
      </div>
    </div>
  )
}

export { ArtifactProvenancePanel, ProvenanceMessagesTimeline }
