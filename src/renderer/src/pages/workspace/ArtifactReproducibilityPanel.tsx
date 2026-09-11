/* Hallmark · component: reproducibility panel · genre: modern-minimal · theme: Open-Science
 * Conclusion and next action first; details use existing tokens and controls.
 * States: default, hover, focus, active, unavailable, running, failed, reproduced.
 * Pre-emit critique: P5 H5 E4 S5 R5 V4; contrast checked on the revised summary.
 */
import {
  CheckElapsedTime,
  EnvironmentRestoreHint,
  ReproducibilityLogViewport
} from './ReproducibilityProgress'
import type { LucideIcon } from 'lucide-react'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  Clock3,
  Cpu,
  Download,
  File,
  FolderTree,
  History,
  Info,
  LoaderCircle,
  PackageCheck,
  Shrink,
  TerminalSquare,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { memo, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TransformComponent, TransformWrapper, useControls } from 'react-zoom-pan-pinch'

import { Button } from '@/components/ui/button'
import { ReproducibilityOutput } from './ReproducibilityOutput'
import { ReproducibilityOutputStorage } from './ReproducibilityOutputStorage'
import { OutputComparisonSettings } from './OutputComparison'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ReproducibilityStartPreview } from './ReproducibilityStartPreview'
import { previewNodeStart } from './artifact-reproducibility-start'
import { DEFAULT_OUTPUT_COMPARISON_POLICY } from '../../../../shared/output-comparison'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  ArtifactReproducibilityActivity,
  ArtifactReproducibilityBarrierReason,
  ArtifactReproducibilityEntity,
  ArtifactReproducibilityOutputGroup,
  ArtifactReproducibilityProjection,
  ArtifactAnalysisRevision,
  ArtifactReproducibilityRecipeBarrier,
  ArtifactReproducibilityStartFrontier,
  GetArtifactVersionProvenanceRequest,
  ProvenanceNotebookRun
} from '../../../../shared/artifact-provenance'
import type {
  ArtifactReproducibilityCheckLog,
  ArtifactReproducibilityCheckLogRecord,
  ArtifactReproducibilityCheckState,
  ArtifactReproducibilityFailedAttempt,
  ArtifactReproducibilityReceipt
} from '../../../../shared/artifact-reproducibility'
import type { ScientificOutputRisk } from '../../../../shared/execution-file-evidence'
import type {
  NotebookEnvironmentLockDiagnostic,
  NotebookRunEnvironmentLockCapture
} from '../../../../shared/notebook'
import {
  displayGraph,
  filterDisplayGraph,
  graphEdgeLabelPosition,
  graphEdgePath,
  graphNodeKey,
  layoutGraph,
  NODE_HEIGHT,
  NODE_ICON_SIZE,
  NODE_ICON_X,
  NODE_ICON_Y,
  NODE_WIDTH,
  relatedNodeKeys,
  scopedNodeKeys,
  type GraphNode,
  upstreamNodeKeys
} from './artifact-reproducibility-graph'

type ArtifactReproducibilityPanelProps = {
  projection?: ArtifactReproducibilityProjection
  analysisRevision?: ArtifactAnalysisRevision
  executionAvailable?: boolean
  artifactVersion?: GetArtifactVersionProvenanceRequest
  artifactName?: string
  tooltipClassName?: string
  environmentRuns?: ReadonlyArray<
    Pick<ProvenanceNotebookRun, 'runId' | 'runIndex' | 'environmentName' | 'environmentLock'>
  >
}

const environmentDiagnosticText = (
  diagnostic: NotebookEnvironmentLockDiagnostic,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  const packageName = diagnostic.packageName ?? t('Package')
  switch (diagnostic.reason) {
    case 'package-lock-missing':
      return t('No exact lock was captured for {{name}}.', {
        name: diagnostic.observedVersion
          ? `${packageName} (${diagnostic.observedVersion})`
          : packageName
      })
    case 'package-version-unresolved':
      return t('The lock does not pin one version of {{name}}.', { name: packageName })
    case 'package-version-mismatch':
      return t('{{name}}: installed {{installed}}, locked {{locked}}.', {
        name: packageName,
        installed: diagnostic.observedVersion ?? t('Unknown'),
        locked: diagnostic.lockedVersion ?? t('Unknown')
      })
    case 'package-not-captured':
      return t('{{name}} is in the lock but was not found in the captured environment.', {
        name: packageName
      })
    case 'source-unpinned':
      return t('The lock does not pin an exact package source.')
    case 'source-mismatch':
      return t('The captured package source differs from the lock.')
    case 'project-selection-unresolved':
      return t(
        'The project lock has optional dependencies or platform conditions without a captured selection. Create an exact requirements lock from the environment that ran the code.'
      )
  }
}

const environmentCaptureDetails = (
  capture: NotebookRunEnvironmentLockCapture,
  t: ReturnType<typeof useTranslation>['t']
): string[] => {
  if (capture.state === 'available') return []
  if (capture.state === 'unavailable') {
    switch (capture.reason) {
      case 'environment-not-managed':
      case 'conda-prefix-unavailable':
        return [t('Use a managed environment with locked dependencies, then create a new version.')]
      case 'micromamba-unavailable':
        return [t('The environment manager was unavailable when this version was captured.')]
      case 'environment-lock-publication-failed':
        return [t('The environment lock could not be saved when this version was captured.')]
      default:
        return [t('The saved environment lock could not be captured or validated.')]
    }
  }
  if (capture.diagnostics?.length)
    return capture.diagnostics.map((diagnostic) => environmentDiagnosticText(diagnostic, t))
  return [
    ...new Set(
      (capture.partialReasons ?? []).map((reason) => {
        switch (reason) {
          case 'environment-manifest-partial':
            return t('The installed package inventory was incomplete.')
          case 'native-lock-file-best-effort':
            return t(
              'The dependency file contains unpinned versions or conditions that have not been resolved.'
            )
          case 'native-lock-file-rejected':
            return t('A dependency lock file could not be safely captured.')
          default:
            return t(
              'Create a lock from the environment that ran the code, then rerun the code to create a new version.'
            )
        }
      })
    )
  ]
}

const CHECK_PHASES = [
  'loading-evidence',
  'materializing-inputs',
  'restoring-environments',
  'executing',
  'comparing'
] as const

const failedCheckDetail = (
  phase: ArtifactReproducibilityCheckState['phase'],
  t: ReturnType<typeof useTranslation>['t']
): string => {
  switch (phase) {
    case 'loading-evidence':
      return t(
        'Open-Science could not load the captured evidence. The original result was not changed.'
      )
    case 'materializing-inputs':
      return t(
        'Open-Science could not prepare the isolated inputs. The original result was not changed.'
      )
    case 'restoring-environments':
      return t(
        'Open-Science could not restore the captured environment. The original result was not changed.'
      )
    case 'executing':
      return t(
        'The isolated Notebook run stopped before comparison. The original result was not changed.'
      )
    case 'comparing':
      return t(
        'Open-Science could not compare the reproduced files. The original result was not changed.'
      )
    default:
      return t(
        'Open-Science could not record the check result. The original result was not changed.'
      )
  }
}

const receiptDate = (value: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  )

const logRecordedDay = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(value))

const logRecordedTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value))

const mergeReceipts = (
  ...groups: ReadonlyArray<ReadonlyArray<ArtifactReproducibilityReceipt>>
): ArtifactReproducibilityReceipt[] =>
  [...new Map(groups.flat().map((receipt) => [receipt.receiptChecksum, receipt])).values()].sort(
    (left, right) =>
      right.completedAt.localeCompare(left.completedAt) ||
      right.receiptId.localeCompare(left.receiptId)
  )

type ReproducibilityIssueReason =
  ArtifactReproducibilityBarrierReason | ArtifactReproducibilityRecipeBarrier

type ReproducibilityIssueCategory =
  | 'execution-record'
  | 'file-lineage'
  | 'notebook-state'
  | 'file-restore'
  | 'code-environment'
  | 'dependency-analysis'

const issueCategoryOrder: ReproducibilityIssueCategory[] = [
  'execution-record',
  'file-lineage',
  'notebook-state',
  'file-restore',
  'code-environment',
  'dependency-analysis'
]

const issueCategoryByReason: Record<ReproducibilityIssueReason, ReproducibilityIssueCategory> = {
  'activity-evidence-unavailable': 'execution-record',
  'activity-evidence-corrupt': 'execution-record',
  'activity-evidence-partial': 'execution-record',
  'target-generation-unavailable': 'execution-record',
  'file-reads-unavailable': 'file-lineage',
  'writer-attribution-unavailable': 'file-lineage',
  'absolute-path-unfrozen': 'file-restore',
  'kernel-epoch-unknown': 'notebook-state',
  'kernel-dependencies-unavailable': 'notebook-state',
  'kernel-epoch-conservative': 'notebook-state',
  'history-truncated': 'dependency-analysis',
  'graph-budget-exceeded': 'dependency-analysis',
  'dependency-cycle': 'dependency-analysis',
  'absolute-path-boundary': 'file-restore',
  'activity-evidence-not-complete': 'execution-record',
  'advisory-boundary': 'file-lineage',
  'ambiguous-activity-order': 'notebook-state',
  'target-graph-incomplete': 'dependency-analysis',
  'target-graph-conservative': 'dependency-analysis',
  'target-source-missing': 'execution-record',
  'required-run-missing': 'execution-record',
  'required-run-not-completed': 'execution-record',
  'required-source-truncated': 'code-environment',
  'unsupported-kernel-kind': 'code-environment',
  'environment-lock-missing': 'code-environment',
  'environment-lock-partial': 'code-environment',
  'helper-source-incomplete': 'code-environment',
  'execution-evidence-truncated': 'execution-record',
  'crossing-entity-unavailable': 'file-restore',
  'materialization-path-conflict': 'file-restore',
  'absolute-read-remapping-required': 'file-restore',
  'absolute-write-not-isolated': 'file-restore',
  'advisory-dependency': 'file-lineage',
  'compute-recipe-unavailable': 'code-environment',
  'recipe-budget-exceeded': 'dependency-analysis'
}

const issueCategoryCopy: Record<
  ReproducibilityIssueCategory,
  { label: string; description: string }
> = {
  'execution-record': {
    label: 'Execution record',
    description: 'Some execution details were not fully captured.'
  },
  'file-lineage': {
    label: 'File lineage',
    description: 'Some file inputs or outputs could not be confirmed.'
  },
  'notebook-state': {
    label: 'Notebook state',
    description: 'This result may depend on earlier Notebook state.'
  },
  'file-restore': {
    label: 'File restore',
    description: 'Some required files cannot be restored safely.'
  },
  'code-environment': {
    label: 'Code and environment',
    description: 'The original code or environment is not available for replay.'
  },
  'dependency-analysis': {
    label: 'Dependency analysis',
    description: 'The complete dependency path could not be reconstructed.'
  }
}

const summarizedIssues = (
  reasons: ReproducibilityIssueReason[],
  t: ReturnType<typeof useTranslation>['t']
): Array<{ category: ReproducibilityIssueCategory; label: string; description: string }> => {
  const categories = new Set(reasons.map((reason) => issueCategoryByReason[reason]))
  return issueCategoryOrder.flatMap((category) => {
    if (!categories.has(category)) return []
    const copy = issueCategoryCopy[category]
    return [{ category, label: t(copy.label), description: t(copy.description) }]
  })
}

const outputRiskCopy: Record<ScientificOutputRisk, string> = {
  'format-validity-not-verified': 'The output format has not been validated.',
  'multi-file-consistency-not-verified': 'Consistency across member files has not been verified.',
  'database-state-not-verified': 'The database state has not been validated.',
  'runtime-dependent-serialization': 'Reading this output may depend on its original runtime.'
}

const outputStorageShapeCopy: Record<ArtifactReproducibilityOutputGroup['storageShape'], string> = {
  'file-set': 'File set',
  'directory-tree': 'Directory tree'
}

const activityLabel = (
  activity: ArtifactReproducibilityActivity,
  t: ReturnType<typeof useTranslation>['t'],
  computeNumbers: ReadonlyMap<string, number>
): string => {
  if (activity.kind === 'artifact-publication') return t('Artifact publication')
  if (activity.kind === 'compute-job') {
    return t('Compute job {{number}}', {
      number: computeNumbers.get(activity.activityId) ?? 1
    })
  }
  return activity.runIndex === undefined
    ? t('Notebook run')
    : t('Notebook run {{number}}', { number: activity.runIndex + 1 })
}

const entityKindLabel = (
  entity: ArtifactReproducibilityEntity,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  if (entity.kind === 'registered-input-generation') return t('Captured input')
  if (entity.kind === 'artifact-version') return t('Artifact Version')
  return t('Generated file')
}

const fileLabelParts = (label: string): { directory?: string; filename: string } => {
  const separator = Math.max(label.lastIndexOf('/'), label.lastIndexOf('\\'))
  if (separator < 0 || separator >= label.length - 1) return { filename: label }
  return {
    directory: label.slice(0, separator + 1),
    filename: label.slice(separator + 1)
  }
}

const graphNodeIcon = (node: GraphNode, isTarget: boolean): LucideIcon => {
  if (node.kind === 'output-group') return FolderTree
  if (node.kind === 'entity') return isTarget ? PackageCheck : File
  if (node.value.kind === 'compute-job') return Cpu
  return BookOpen
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const PanelTooltip = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <TooltipProvider delayDuration={350} skipDelayDuration={100}>
    <Tooltip>{children}</Tooltip>
  </TooltipProvider>
)

const GraphZoomControls = (): React.JSX.Element => {
  const { t } = useTranslation()
  const { zoomIn, zoomOut, resetTransform } = useControls()
  const reduceMotion = prefersReducedMotion()
  const actions = [
    { label: t('Zoom in'), icon: ZoomIn, onClick: () => zoomIn() },
    { label: t('Zoom out'), icon: ZoomOut, onClick: () => zoomOut() },
    {
      label: t('Reset zoom'),
      icon: Shrink,
      onClick: () => resetTransform(reduceMotion ? 0 : undefined)
    }
  ]

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {actions.map(({ label, icon: Icon, onClick }) => (
        <PanelTooltip key={label}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={label}
              className="text-text-200 hover:text-text-000 [@media(pointer:coarse)]:size-11"
              onClick={onClick}
            >
              <Icon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </PanelTooltip>
      ))}
    </div>
  )
}

const frontierTitle = (
  frontier: ArtifactReproducibilityStartFrontier,
  activities: Map<string, ArtifactReproducibilityActivity>,
  computeNumbers: ReadonlyMap<string, number>,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  if (frontier.kind === 'original-inputs') return t('Original captured inputs')
  const activity = frontier.afterActivityId ? activities.get(frontier.afterActivityId) : undefined
  return t('After {{activity}}', {
    activity: activity ? activityLabel(activity, t, computeNumbers) : t('captured activity')
  })
}

const runnableActivityCount = (
  frontier: ArtifactReproducibilityStartFrontier,
  activities: ReadonlyMap<string, ArtifactReproducibilityActivity>
): number =>
  frontier.downstreamActivityIds.filter((activityId) => {
    const kind = activities.get(activityId)?.kind
    return kind === 'notebook-run' || kind === 'compute-job'
  }).length

type DependencyGraphCanvasProps = {
  graph: ReturnType<typeof layoutGraph>
  display: ReturnType<typeof displayGraph>
  markerId: string
  graphViewportX: number
  graphViewportWidth: number
  graphCanvasHeight: number
  graphViewportHeight: number
  positionedNodes: ReadonlyMap<string, ReturnType<typeof layoutGraph>['nodes'][number]>
  activeNodeKeys: ReadonlySet<string>
  emphasizedNodeKeys: ReadonlySet<string>
  emphasizedNodeKey?: string
  effectiveSelectedNodeKey?: string
  targetEntityId: string
  computeNumbers: ReadonlyMap<string, number>
  setHoveredNodeKey: (key: string | undefined) => void
  setFocusedNodeKey: (key: string | undefined) => void
  setSelectedNodeKey: (key: string) => void
}

// Streaming progress must not rebuild thousands of unchanged SVG nodes and edges.
const DependencyGraphCanvas = memo(function DependencyGraphCanvas({
  graph,
  display,
  markerId,
  graphViewportX,
  graphViewportWidth,
  graphCanvasHeight,
  graphViewportHeight,
  positionedNodes,
  activeNodeKeys,
  emphasizedNodeKeys,
  emphasizedNodeKey,
  effectiveSelectedNodeKey,
  targetEntityId,
  computeNumbers,
  setHoveredNodeKey,
  setFocusedNodeKey,
  setSelectedNodeKey
}: DependencyGraphCanvasProps): React.JSX.Element {
  const { t } = useTranslation()
  const outgoingNodeKeys = new Set<string>()
  const incomingNodeKeys = new Set<string>()
  for (const edge of display?.edges ?? []) {
    outgoingNodeKeys.add(edge.sourceKey)
    incomingNodeKeys.add(edge.targetKey)
  }
  const nodeFullLabel = (node: GraphNode): string =>
    node.kind === 'activity' ? activityLabel(node.value, t, computeNumbers) : node.value.label
  const nodeDetailLabel = (node: GraphNode): string => {
    if (node.kind === 'activity') return t('Activity')
    if (node.kind === 'output-group') return t('Logical output')
    return node.value.entityId === targetEntityId
      ? t('Comparison target')
      : entityKindLabel(node.value, t)
  }

  return (
    <div className="relative min-h-0 overflow-hidden bg-bg-200/20">
      <TransformWrapper
        minScale={1}
        maxScale={4}
        centerOnInit
        zoomAnimation={{ disabled: prefersReducedMotion() }}
        doubleClick={
          prefersReducedMotion() ? { mode: 'reset', animationTime: 0 } : { mode: 'reset' }
        }
        panning={{ velocityDisabled: true }}
        wheel={{
          step: 0.2,
          activationKeys: (keys) => keys.includes('Control') || keys.includes('Meta')
        }}
      >
        <div style={{ height: graphCanvasHeight }}>
          <TransformComponent
            wrapperClass="!size-full cursor-grab active:cursor-grabbing"
            contentClass="!size-full"
          >
            <svg
              viewBox={`${graphViewportX} ${-(graphViewportHeight - graph.height) / 2} ${graphViewportWidth} ${graphViewportHeight}`}
              data-graph-content-width={graph.width}
              data-graph-viewport-width={graphViewportWidth}
              data-graph-canvas-height={graphCanvasHeight}
              data-graph-viewport-height={graphViewportHeight}
              data-graph-orientation={graph.orientation}
              role="group"
              aria-label={t('Dependency graph for this Artifact Version')}
              className="size-full select-none"
              preserveAspectRatio="xMidYMid meet"
            >
              <defs>
                <pattern
                  id={`${markerId}-grid`}
                  width="20"
                  height="20"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="1" cy="1" r="0.7" className="fill-border-300/35" />
                </pattern>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-text-100" />
                </marker>
                <marker
                  id={`${markerId}-muted`}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-border-300" />
                </marker>
              </defs>
              <rect
                x={graphViewportX}
                y={-(graphViewportHeight - graph.height) / 2}
                width={graphViewportWidth}
                height={graphViewportHeight}
                fill={`url(#${markerId}-grid)`}
              />
              {(display?.edges ?? []).map((edge) => {
                const source = positionedNodes.get(edge.sourceKey)
                const target = positionedNodes.get(edge.targetKey)
                if (!source || !target) return null
                const active =
                  activeNodeKeys.has(source.key) &&
                  activeNodeKeys.has(target.key) &&
                  emphasizedNodeKeys.has(source.key) &&
                  emphasizedNodeKeys.has(target.key)
                const mutedOpacity = emphasizedNodeKey ? 0.14 : 0.3
                const labelPosition =
                  edge.relation === 'publication'
                    ? graphEdgeLabelPosition(source, target, graph.orientation)
                    : undefined
                return (
                  <g key={edge.key} opacity={active ? 1 : mutedOpacity}>
                    <path
                      data-graph-edge={edge.key}
                      data-graph-relation={edge.relation}
                      d={graphEdgePath(source, target, graph.orientation)}
                      fill="none"
                      className={
                        edge.relation === 'contains'
                          ? 'stroke-border-200'
                          : active
                            ? 'stroke-text-100/75'
                            : 'stroke-border-300'
                      }
                      strokeWidth={edge.relation === 'contains' ? 1.2 : active ? 1.8 : 1.2}
                      strokeLinecap="round"
                      strokeDasharray={
                        edge.authority === 'advisory' || edge.conservative ? '5 4' : undefined
                      }
                      markerEnd={
                        edge.relation === 'contains'
                          ? undefined
                          : `url(#${active ? markerId : `${markerId}-muted`})`
                      }
                    />
                    {labelPosition ? (
                      <g
                        data-graph-publication-boundary
                        transform={`translate(${labelPosition.x} ${labelPosition.y})`}
                        className="pointer-events-none"
                      >
                        <rect
                          x="-40"
                          y="-11"
                          width="80"
                          height="22"
                          rx="2"
                          className="fill-bg-000"
                        />
                        <text
                          textAnchor="middle"
                          dominantBaseline="central"
                          className="fill-text-200 text-[10px] font-medium"
                        >
                          {t('Published as')}
                        </text>
                      </g>
                    ) : null}
                  </g>
                )
              })}
              {graph.nodes.map((node) => {
                const isTarget = node.kind === 'entity' && node.value.entityId === targetEntityId
                const selected = node.key === effectiveSelectedNodeKey
                const active = activeNodeKeys.has(node.key) && emphasizedNodeKeys.has(node.key)
                const label =
                  node.kind === 'activity'
                    ? activityLabel(node.value, t, computeNumbers)
                    : node.value.label
                const detail = nodeDetailLabel(node)
                const Icon = graphNodeIcon(node, isTarget)
                const displayLabel =
                  node.kind === 'activity' ? label : fileLabelParts(label).filename
                return (
                  <g
                    key={node.key}
                    data-graph-node={node.key}
                    transform={`translate(${node.x} ${node.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${detail}: ${label}`}
                    aria-pressed={selected}
                    className="group cursor-pointer outline-none transition-opacity duration-150 motion-reduce:transition-none"
                    opacity={active ? 1 : emphasizedNodeKey ? 0.16 : 0.34}
                    onMouseEnter={() => setHoveredNodeKey(node.key)}
                    onMouseLeave={() => setHoveredNodeKey(undefined)}
                    onFocus={() => setFocusedNodeKey(node.key)}
                    onBlur={() => setFocusedNodeKey(undefined)}
                    onClick={() => setSelectedNodeKey(node.key)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      setSelectedNodeKey(node.key)
                    }}
                  >
                    <title>{`${detail}: ${label}`}</title>
                    <rect
                      x="-4"
                      y="-4"
                      width={NODE_WIDTH + 8}
                      height={NODE_HEIGHT + 8}
                      rx="10"
                      className="fill-none stroke-transparent group-focus-visible:stroke-ring"
                      strokeWidth="2"
                    />
                    <rect
                      width={NODE_WIDTH}
                      height={NODE_HEIGHT}
                      rx="7"
                      className={
                        selected
                          ? 'fill-bg-000 stroke-primary group-active:fill-bg-200'
                          : isTarget
                            ? 'fill-bg-000 stroke-primary/55 transition-colors duration-150 group-hover:stroke-primary group-active:fill-bg-200 motion-reduce:transition-none'
                            : 'fill-bg-000 stroke-border-300 transition-colors duration-150 group-hover:stroke-text-100 group-active:fill-bg-200 motion-reduce:transition-none'
                      }
                      strokeWidth={selected ? 1.75 : 1}
                    />
                    <g data-graph-node-icon transform={`translate(${NODE_ICON_X} ${NODE_ICON_Y})`}>
                      <rect
                        width={NODE_ICON_SIZE}
                        height={NODE_ICON_SIZE}
                        rx="8"
                        className={
                          node.kind === 'activity'
                            ? 'fill-bg-200'
                            : node.kind === 'output-group'
                              ? 'fill-bg-200'
                              : isTarget
                                ? 'fill-primary/10'
                                : 'fill-bg-200'
                        }
                      />
                      <Icon
                        aria-hidden="true"
                        x="7"
                        y="7"
                        width="14"
                        height="14"
                        className={isTarget ? 'stroke-primary' : 'stroke-text-200'}
                        strokeWidth="1.8"
                      />
                    </g>
                    <foreignObject x="50" y="8" width={NODE_WIDTH - 66} height="40">
                      <div className="flex h-full min-w-0 flex-col justify-center overflow-hidden">
                        <div
                          data-graph-node-label-primary
                          className="truncate text-[13px] font-semibold leading-5 text-text-000"
                          title={label}
                        >
                          {displayLabel}
                        </div>
                        <div className="truncate text-[11px] leading-4 text-text-200">{detail}</div>
                      </div>
                    </foreignObject>
                    {node.kind === 'activity' && node.value.evidenceState !== 'available' ? (
                      <circle
                        cx={NODE_WIDTH - 10}
                        cy="10"
                        r="3"
                        className="fill-status-warning-foreground dark:fill-status-warning-dark-foreground"
                      />
                    ) : null}
                    {incomingNodeKeys.has(node.key) ? (
                      <circle
                        data-graph-port="incoming"
                        cx={graph.orientation === 'vertical' ? NODE_WIDTH / 2 : 0}
                        cy={graph.orientation === 'vertical' ? 0 : NODE_HEIGHT / 2}
                        r="2.5"
                        className="fill-bg-000 stroke-text-100/60"
                        strokeWidth="1"
                      />
                    ) : null}
                    {outgoingNodeKeys.has(node.key) ? (
                      <circle
                        data-graph-port="outgoing"
                        cx={graph.orientation === 'vertical' ? NODE_WIDTH / 2 : NODE_WIDTH}
                        cy={graph.orientation === 'vertical' ? NODE_HEIGHT : NODE_HEIGHT / 2}
                        r="2.5"
                        className="fill-bg-000 stroke-text-100/60"
                        strokeWidth="1"
                      />
                    ) : null}
                  </g>
                )
              })}
            </svg>
          </TransformComponent>
        </div>
        <div
          data-dependency-toolbar
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border-300/40 bg-bg-000 px-3 py-1.5"
        >
          <div
            data-dependency-evidence-legend
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-200"
            aria-label={t('Dependency evidence')}
          >
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden="true" className="block w-5 border-t border-text-100/75" />
              {t('Confirmed')}
            </span>
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                aria-hidden="true"
                className="block w-5 border-t border-dashed border-text-100/75"
              />
              {t('Inferred')}
            </span>
          </div>
          <GraphZoomControls />
        </div>
      </TransformWrapper>
      <div data-dependency-lineage-summary className="sr-only">
        <ol aria-label={t('Dependency')}>
          {graph.nodes.map((node) => (
            <li key={node.key}>
              {nodeDetailLabel(node)}: {nodeFullLabel(node)}
            </li>
          ))}
        </ol>
        <ul aria-label={t('Dependency')}>
          {(display?.edges ?? []).map((edge) => {
            const source = positionedNodes.get(edge.sourceKey)
            const target = positionedNodes.get(edge.targetKey)
            if (!source || !target) return null
            return (
              <li key={edge.key}>
                {nodeFullLabel(source)} → {nodeFullLabel(target)} (
                {edge.authority === 'advisory' || edge.conservative
                  ? t('Inferred')
                  : t('Confirmed')}
                )
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
})

export const ArtifactReproducibilityPanel = ({
  projection,
  analysisRevision,
  executionAvailable = false,
  artifactVersion,
  artifactName,
  tooltipClassName,
  environmentRuns = []
}: ArtifactReproducibilityPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const markerId = useId().replace(/:/g, '')
  const panelRef = useRef<HTMLDivElement>(null)
  const [selectedFrontierId, setSelectedFrontierId] = useState('original-inputs')
  const [comparisonPolicy, setComparisonPolicy] = useState(DEFAULT_OUTPUT_COMPARISON_POLICY)
  const [pendingComparisonRules, setPendingComparisonRules] = useState(false)
  const [selectedNodeKey, setSelectedNodeKey] = useState<string>()
  const [expandedOutputIds, setExpandedOutputIds] = useState<Set<string>>(() => new Set())
  const [showFullGraph, setShowFullGraph] = useState(false)
  const [hoveredNodeKey, setHoveredNodeKey] = useState<string>()
  const [focusedNodeKey, setFocusedNodeKey] = useState<string>()
  const [panelWidth, setPanelWidth] = useState(0)
  const [storedCheckState, setCheckState] = useState<ArtifactReproducibilityCheckState>()
  const [resolvedCheckKey, setResolvedCheckKey] = useState<string>()
  const [receiptHistory, setReceiptHistory] = useState<{
    artifactVersionKey?: string
    receipts: ArtifactReproducibilityReceipt[]
    latestFailedAttempt?: ArtifactReproducibilityFailedAttempt
    nextCursor?: string
    loadingMore?: boolean
    error?: boolean
  }>({ receipts: [] })
  const [persistedCheckLogs, setPersistedCheckLogs] = useState<
    Record<
      string,
      { loading?: boolean; error?: boolean; record?: ArtifactReproducibilityCheckLogRecord }
    >
  >({})
  const [startError, setStartError] = useState(false)
  const [exportError, setExportError] = useState<string>()
  const historyRef = useRef<HTMLDetailsElement>(null)
  const [exportingReceiptChecksum, setExportingReceiptChecksum] = useState<string>()
  const [starting, setStarting] = useState(false)
  const startPendingRef = useRef<{ active: boolean } | undefined>(undefined)
  const [cancelling, setCancelling] = useState(false)
  const [historyRetry, setHistoryRetry] = useState(0)
  const [retryingHistory, setRetryingHistory] = useState(false)
  const checkScopeRef = useRef({ active: true })
  const artifactVersionKey = artifactVersion
    ? [
        artifactVersion.projectId,
        artifactVersion.appSessionId,
        artifactVersion.artifactId,
        artifactVersion.versionId
      ].join('\0')
    : undefined
  const [checkStateKey, setCheckStateKey] = useState(artifactVersionKey)
  // Reset view state before rendering another version; the main-process attempt keeps running.
  if (checkStateKey !== artifactVersionKey) {
    setCheckStateKey(artifactVersionKey)
    setCheckState(undefined)
    setRetryingHistory(false)
    setResolvedCheckKey(undefined)
    setStarting(false)
    setCancelling(false)
    setStartError(false)
    setComparisonPolicy(DEFAULT_OUTPUT_COMPARISON_POLICY)
    setPendingComparisonRules(false)
  }
  const checkState =
    artifactVersion &&
    storedCheckState &&
    storedCheckState.request.projectId === artifactVersion.projectId &&
    storedCheckState.request.appSessionId === artifactVersion.appSessionId &&
    storedCheckState.request.artifactId === artifactVersion.artifactId &&
    storedCheckState.request.versionId === artifactVersion.versionId
      ? storedCheckState
      : undefined
  const restoringCheck = Boolean(
    artifactVersion &&
    window.api?.artifacts.getReproducibilityCheck &&
    resolvedCheckKey !== artifactVersionKey
  )
  // Both reads contribute to the conclusion. An empty initial state is not evidence that this is
  // a first check; keep the action neutral until the snapshot and durable history have settled.
  const restoringSummary =
    restoringCheck ||
    Boolean(
      artifactVersion &&
      window.api?.artifacts.listReproducibilityReceipts &&
      receiptHistory.artifactVersionKey !== artifactVersionKey
    )
  const receipts =
    receiptHistory.artifactVersionKey === artifactVersionKey ? receiptHistory.receipts : []
  const receiptError =
    receiptHistory.artifactVersionKey === artifactVersionKey ? receiptHistory.error : undefined
  const latestFailedAttempt =
    receiptHistory.artifactVersionKey === artifactVersionKey
      ? receiptHistory.latestFailedAttempt
      : undefined
  const checkApiAvailable = Boolean(
    artifactVersion &&
    window.api?.artifacts.startReproducibilityCheck &&
    window.api.artifacts.cancelReproducibilityCheck &&
    window.api.artifacts.onReproducibilityCheckChanged
  )
  const exportApiAvailable = Boolean(
    artifactVersion && artifactName && window.api?.artifacts.exportReproducibilityReceipt
  )
  const activities = useMemo(
    () => new Map(projection?.activities.map((activity) => [activity.activityId, activity])),
    [projection]
  )
  const computeNumbers = useMemo(
    () =>
      new Map(
        (projection?.activities ?? [])
          .filter((activity) => activity.kind === 'compute-job')
          .map((activity, index) => [activity.activityId, index + 1])
      ),
    [projection]
  )
  const entities = useMemo(
    () => new Map(projection?.entities.map((entity) => [entity.entityId, entity])),
    [projection]
  )
  const selectableFrontiers = useMemo(
    () =>
      (projection?.startFrontiers ?? []).filter(
        (frontier) =>
          frontier.eligibility !== 'blocked' &&
          (frontier.kind === 'original-inputs' || runnableActivityCount(frontier, activities) > 0)
      ),
    [activities, projection]
  )
  const selectedFrontier =
    selectableFrontiers.find((frontier) => frontier.frontierId === selectedFrontierId) ??
    selectableFrontiers[0]
  const blockedFrontier =
    projection?.startFrontiers.find((frontier) => frontier.kind === 'original-inputs') ??
    projection?.startFrontiers[0]
  const applyCheckState = (next: ArtifactReproducibilityCheckState): void => {
    if (
      !artifactVersion ||
      next.request.projectId !== artifactVersion.projectId ||
      next.request.appSessionId !== artifactVersion.appSessionId ||
      next.request.artifactId !== artifactVersion.artifactId ||
      next.request.versionId !== artifactVersion.versionId
    ) {
      return
    }
    setCheckState((current) => {
      if (current?.attemptId === next.attemptId && current.revision > next.revision) return current
      return next
    })
    if (next.status === 'running') {
      setSelectedFrontierId(next.request.frontierId)
      setComparisonPolicy(next.request.comparisonPolicy ?? DEFAULT_OUTPUT_COMPARISON_POLICY)
      setPendingComparisonRules(false)
    }
    if (next.receipt) {
      setReceiptHistory((current) => {
        const currentReceipts =
          current.artifactVersionKey === artifactVersionKey ? current.receipts : []
        return {
          artifactVersionKey,
          receipts: mergeReceipts(currentReceipts, [next.receipt!]),
          ...(current.artifactVersionKey === artifactVersionKey && current.latestFailedAttempt
            ? { latestFailedAttempt: current.latestFailedAttempt }
            : {}),
          ...(current.artifactVersionKey === artifactVersionKey && current.nextCursor
            ? { nextCursor: current.nextCursor }
            : {})
        }
      })
    }
    if (next.status !== 'running') setCancelling(false)
  }
  const exportReceipt = async (receipt: ArtifactReproducibilityReceipt): Promise<void> => {
    if (
      !artifactVersion ||
      !artifactName ||
      !window.api?.artifacts.exportReproducibilityReceipt ||
      exportingReceiptChecksum
    ) {
      return
    }
    setExportError(undefined)
    setExportingReceiptChecksum(receipt.receiptChecksum)
    try {
      await window.api.artifacts.exportReproducibilityReceipt({
        ...artifactVersion,
        receiptChecksum: receipt.receiptChecksum,
        suggestedName: artifactName
      })
    } catch {
      setExportError(t('Verification record could not be exported.'))
    } finally {
      setExportingReceiptChecksum(undefined)
    }
  }
  const loadPersistedCheckLog = async (
    key: string,
    selector: { receiptChecksum: string } | { attemptId: string }
  ): Promise<void> => {
    if (
      !artifactVersion ||
      !window.api?.artifacts.getReproducibilityCheckLog ||
      persistedCheckLogs[key]?.loading ||
      persistedCheckLogs[key]?.record
    ) {
      return
    }
    setPersistedCheckLogs((current) => ({ ...current, [key]: { loading: true } }))
    try {
      const record = await window.api.artifacts.getReproducibilityCheckLog({
        ...artifactVersion,
        ...selector
      })
      setPersistedCheckLogs((current) => ({
        ...current,
        [key]: record ? { record } : { error: true }
      }))
    } catch {
      setPersistedCheckLogs((current) => ({ ...current, [key]: { error: true } }))
    }
  }
  const loadMoreReceipts = async (): Promise<void> => {
    if (
      !artifactVersion ||
      !receiptHistory.nextCursor ||
      receiptHistory.loadingMore ||
      !window.api?.artifacts.listReproducibilityReceipts
    ) {
      return
    }
    const cursor = receiptHistory.nextCursor
    setReceiptHistory((current) =>
      current.artifactVersionKey === artifactVersionKey
        ? { ...current, loadingMore: true, error: false }
        : current
    )
    try {
      const page = await window.api.artifacts.listReproducibilityReceipts({
        ...artifactVersion,
        cursor
      })
      setReceiptHistory((current) =>
        current.artifactVersionKey === artifactVersionKey && current.nextCursor === cursor
          ? {
              artifactVersionKey,
              receipts: mergeReceipts(current.receipts, page.receipts),
              ...(current.latestFailedAttempt
                ? { latestFailedAttempt: current.latestFailedAttempt }
                : {}),
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
            }
          : current
      )
    } catch {
      setReceiptHistory((current) =>
        current.artifactVersionKey === artifactVersionKey && current.nextCursor === cursor
          ? { ...current, loadingMore: false, error: true }
          : current
      )
    }
  }
  useEffect(() => {
    if (!artifactVersion || !window.api?.artifacts.onReproducibilityCheckChanged) return
    let active = true
    let receivedEvent = false
    // Subscribe before reading the snapshot: progress may advance while IPC is in flight.
    const unsubscribe = window.api.artifacts.onReproducibilityCheckChanged((state) => {
      if (
        !active ||
        state.request.projectId !== artifactVersion.projectId ||
        state.request.appSessionId !== artifactVersion.appSessionId ||
        state.request.artifactId !== artifactVersion.artifactId ||
        state.request.versionId !== artifactVersion.versionId
      )
        return
      receivedEvent = true
      applyCheckState(state)
    })
    if (window.api.artifacts.getReproducibilityCheck) {
      void window.api.artifacts
        .getReproducibilityCheck(artifactVersion)
        .then((state) => {
          if (active && !receivedEvent && state) applyCheckState(state)
        })
        .catch(() => undefined)
        .finally(() => {
          if (active) setResolvedCheckKey(artifactVersionKey)
        })
    }
    return () => {
      active = false
      unsubscribe()
    }
    // The key resets the subscription's identity guard without making the object reference an API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactVersionKey])
  useEffect(() => {
    if (!artifactVersion || !window.api?.artifacts.listReproducibilityReceipts) return
    let active = true
    void window.api.artifacts
      .listReproducibilityReceipts(artifactVersion)
      .then((page) => {
        if (active) {
          setReceiptHistory((current) => ({
            artifactVersionKey,
            receipts: mergeReceipts(
              page.receipts,
              current.artifactVersionKey === artifactVersionKey ? current.receipts : []
            ),
            ...(page.latestFailedAttempt
              ? { latestFailedAttempt: page.latestFailedAttempt }
              : current.artifactVersionKey === artifactVersionKey && current.latestFailedAttempt
                ? { latestFailedAttempt: current.latestFailedAttempt }
                : {}),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
          }))
        }
      })
      .catch(() => {
        if (active) {
          setReceiptHistory((current) => ({
            artifactVersionKey,
            receipts: current.artifactVersionKey === artifactVersionKey ? current.receipts : [],
            ...(current.artifactVersionKey === artifactVersionKey && current.latestFailedAttempt
              ? { latestFailedAttempt: current.latestFailedAttempt }
              : {}),
            error: true
          }))
        }
      })
      .finally(() => {
        if (active) setRetryingHistory(false)
      })
    return () => {
      active = false
    }
    // The stable key prevents a parent object refresh from re-reading immutable receipt history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactVersionKey, historyRetry])
  useEffect(() => {
    const scope = { active: true }
    checkScopeRef.current = scope
    return () => {
      scope.active = false
    }
  }, [artifactVersionKey])
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const update = (): void => {
      setPanelWidth(panel.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])
  const completeDisplay = useMemo(
    () => (projection ? displayGraph(projection, expandedOutputIds) : undefined),
    [expandedOutputIds, projection]
  )
  const targetNodeKey = projection ? graphNodeKey('entity', projection.targetEntityId) : undefined
  const artifactLineageKeys = useMemo(
    () =>
      completeDisplay && targetNodeKey
        ? upstreamNodeKeys(completeDisplay, targetNodeKey)
        : new Set<string>(),
    [completeDisplay, targetNodeKey]
  )
  const additionalNodeCount = useMemo(
    () => completeDisplay?.nodes.filter((node) => !artifactLineageKeys.has(node.key)).length ?? 0,
    [artifactLineageKeys, completeDisplay]
  )
  const display = useMemo(() => {
    if (!completeDisplay || showFullGraph) return completeDisplay
    return filterDisplayGraph(completeDisplay, artifactLineageKeys)
  }, [artifactLineageKeys, completeDisplay, showFullGraph])
  const horizontalGraph = useMemo(
    () => (display ? layoutGraph(display, 'horizontal') : undefined),
    [display]
  )
  // Keep short paths legible before switching to a horizontal overview. Large graphs
  // still use the bounded canvas and zoom rather than forcing an ever-taller column.
  const compactGraph =
    panelWidth > 0 && panelWidth < Math.min(1040, (horizontalGraph?.width ?? 0) * 0.8 + 40)
  const graph = useMemo(
    () => (display && compactGraph ? layoutGraph(display, 'vertical') : horizontalGraph),
    [compactGraph, display, horizontalGraph]
  )
  const graphViewportWidth = graph ? Math.max(graph.width, Math.max(0, panelWidth - 40)) : 0
  const graphViewportX = graph ? -(graphViewportWidth - graph.width) / 2 : 0
  const simpleGraph = (graph?.nodes.length ?? 0) <= 4
  const graphCanvasHeight = graph
    ? compactGraph
      ? Math.min(420, Math.max(180, graph.height))
      : simpleGraph
        ? Math.max(168, graph.height + 32)
        : Math.min(showFullGraph ? 480 : 340, Math.max(200, graph.height + 40))
    : 0
  // Padding belongs to the viewport: fitting a short path must never enlarge its nodes.
  const graphViewportHeight = Math.max(graph?.height ?? 0, graphCanvasHeight)
  const positionedNodes = useMemo(
    () => new Map(graph?.nodes.map((node) => [node.key, node])),
    [graph]
  )
  const activeNodeKeys = useMemo(
    () => (projection ? scopedNodeKeys(projection, selectedFrontier) : new Set<string>()),
    [projection, selectedFrontier]
  )
  const emphasizedNodeKey = hoveredNodeKey ?? focusedNodeKey
  const emphasizedNodeKeys = useMemo(
    () =>
      display && emphasizedNodeKey
        ? relatedNodeKeys(display, emphasizedNodeKey)
        : new Set(display?.nodes.map((node) => node.key) ?? []),
    [display, emphasizedNodeKey]
  )
  const effectiveSelectedNodeKey =
    selectedNodeKey && positionedNodes.has(selectedNodeKey) ? selectedNodeKey : undefined
  useEffect(() => {
    if (effectiveSelectedNodeKey) {
      panelRef.current
        ?.querySelector<HTMLButtonElement>('[data-dependency-inspector] button')
        ?.focus()
    }
  }, [effectiveSelectedNodeKey])
  const selectedNode = effectiveSelectedNodeKey
    ? positionedNodes.get(effectiveSelectedNodeKey)
    : undefined
  const nodeStartPreview = useMemo(
    () => (projection && selectedNode ? previewNodeStart(projection, selectedNode) : undefined),
    [projection, selectedNode]
  )

  const startCheck = async (frontierId = selectedFrontier?.frontierId): Promise<void> => {
    const frontier = projection?.startFrontiers.find((item) => item.frontierId === frontierId)
    if (
      startPendingRef.current === checkScopeRef.current ||
      checkState?.status === 'running' ||
      !artifactVersion ||
      restoringSummary ||
      pendingComparisonRules ||
      !frontier ||
      frontier.eligibility !== 'available' ||
      !window.api?.artifacts.startReproducibilityCheck
    ) {
      return
    }
    const scope = checkScopeRef.current
    startPendingRef.current = scope
    setSelectedFrontierId(frontier.frontierId)
    setStarting(true)
    setStartError(false)
    try {
      const state = await window.api.artifacts.startReproducibilityCheck({
        ...artifactVersion,
        frontierId: frontier.frontierId,
        comparisonPolicy
      })
      if (!scope.active) return
      applyCheckState(state)
    } catch {
      if (scope.active) setStartError(true)
    } finally {
      if (startPendingRef.current === scope) startPendingRef.current = undefined
      if (scope.active) setStarting(false)
    }
  }

  const cancelCheck = async (): Promise<void> => {
    if (checkState?.status !== 'running' || !window.api?.artifacts.cancelReproducibilityCheck)
      return
    setCancelling(true)
    const scope = checkScopeRef.current
    try {
      await window.api.artifacts.cancelReproducibilityCheck({ attemptId: checkState.attemptId })
    } catch {
      if (scope.active) {
        setStartError(true)
        setCancelling(false)
      }
    }
  }

  const reproducibilityLogEntry = (
    entry: ArtifactReproducibilityCheckLog,
    index: number,
    exposeSource = false
  ): React.JSX.Element => (
    <div
      key={`${entry.source}:${entry.source === 'notebook' ? entry.stepId : entry.requirementId}:${entry.stream}:${index}`}
      className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3"
      data-reproducibility-check-log-entry={exposeSource ? entry.source : undefined}
    >
      {entry.recordedAt ? (
        <time
          dateTime={entry.recordedAt}
          className="flex min-w-0 flex-col border-r border-border-300/50 pr-3 tabular-nums text-text-300"
        >
          <span>{logRecordedDay(entry.recordedAt)}</span>
          <span>{logRecordedTime(entry.recordedAt)}</span>
        </time>
      ) : (
        <span aria-hidden="true" className="border-r border-border-300/50 pr-3 text-text-400">
          —
        </span>
      )}
      <div className="min-w-0">
        <div className="mb-0.5 flex flex-wrap items-center gap-x-1.5 text-text-400">
          <span>
            {entry.source === 'notebook'
              ? t('Notebook run {{number}}', { number: entry.runIndex + 1 })
              : t('Environment {{current}} of {{total}}', {
                  current: entry.environmentIndex + 1,
                  total: entry.environmentTotal
                })}
          </span>
          <span aria-hidden="true">·</span>
          <span>{entry.kernelKind === 'r' ? 'R' : 'Python'}</span>
          <span aria-hidden="true">·</span>
          <span>{entry.stream === 'stdout' ? t('stdout') : t('stderr')}</span>
          {entry.truncated ? <span className="ml-auto">{t('Output truncated')}</span> : null}
        </div>
        <pre
          className={cn(
            'whitespace-pre-wrap break-words text-text-100',
            entry.stream === 'stderr' &&
              'text-status-warning-foreground dark:text-status-warning-dark-foreground'
          )}
        >
          {entry.text}
        </pre>
      </div>
    </div>
  )

  const persistedLogContent = (key: string): React.JSX.Element => {
    const state = persistedCheckLogs[key]
    return (
      <section className="mt-3 overflow-hidden rounded-lg border border-border-300/60 bg-bg-100/55">
        <div className="flex items-center gap-2 border-b border-border-300/50 px-3 py-2">
          <TerminalSquare className="size-3.5" aria-hidden="true" />
          <h5 className="text-xs font-medium text-text-100">{t('Log')}</h5>
        </div>
        <div className="max-h-52 space-y-3 overflow-auto px-3 py-2.5 font-mono text-[11px] leading-5">
          {state?.loading ? <p className="text-text-400">{t('Loading…')}</p> : null}
          {state?.error ? (
            <p className="text-danger-000">{t('Check log could not be loaded.')}</p>
          ) : null}
          {state?.record?.truncated ? (
            <p className="text-text-400">{t('Output truncated')}</p>
          ) : null}
          {state?.record?.entries.map((entry, index) => reproducibilityLogEntry(entry, index))}
        </div>
      </section>
    )
  }

  if (!projection) {
    return (
      <div className="space-y-2 p-5 text-sm">
        <h3 className="font-semibold text-text-000">{t('Reproducibility')}</h3>
        <p className="text-text-300">
          {t('Dependency graph was not captured for this Artifact Version.')}
        </p>
        <p className="text-xs text-text-300">
          {executionAvailable
            ? t(
                'The Execution Log remains available, but safe starting points cannot be determined.'
              )
            : t('Execution evidence is unavailable, so safe starting points cannot be determined.')}
        </p>
      </div>
    )
  }

  const blockedCheckReasonCodes: ReproducibilityIssueReason[] =
    !selectedFrontier && blockedFrontier
      ? [...blockedFrontier.reasonCodes, ...(blockedFrontier.checkReasonCodes ?? [])]
      : []
  const captureReasonCodes: ReproducibilityIssueReason[] = [
    ...projection.reasonCodes,
    ...blockedCheckReasonCodes,
    ...(projection.checkReasonCodes ?? []).filter(
      (reason) => reason !== 'target-graph-incomplete' && reason !== 'target-graph-conservative'
    )
  ]
  const captureIssues = summarizedIssues(captureReasonCodes, t)
  const captureCompleteness =
    projection.completeness === 'complete' && captureIssues.length > 0
      ? 'incomplete'
      : projection.completeness
  const statusLabel =
    captureCompleteness === 'complete'
      ? t('Complete capture')
      : captureCompleteness === 'conservative'
        ? t('Conservative capture')
        : t('Incomplete capture')
  const checkIssues = summarizedIssues([...captureReasonCodes, ...blockedCheckReasonCodes], t)
  const requiredRunIncomplete = captureReasonCodes.includes('required-run-not-completed')
  const environmentLockMissing = blockedCheckReasonCodes.includes('environment-lock-missing')
  const environmentLockPartial = blockedCheckReasonCodes.includes('environment-lock-partial')
  const environmentDetails = environmentRuns
    .filter(
      (run) =>
        blockedFrontier?.downstreamActivityIds.includes(run.runId) &&
        run.environmentLock &&
        run.environmentLock.state !== 'available'
    )
    .map((run) => ({
      run,
      details: environmentCaptureDetails(run.environmentLock!, t)
    }))
  const checkUnavailable =
    !artifactVersion || !checkApiAvailable || selectedFrontier?.eligibility !== 'available'
  const checkUnavailableMessage = !artifactVersion
    ? t('Execution evidence is unavailable, so safe starting points cannot be determined.')
    : !checkApiAvailable
      ? t('Reproducibility checks are available in the desktop app.')
      : t('Recipe and environment lock required')
  const checkUnavailableDetail =
    !artifactVersion || !checkApiAvailable
      ? checkUnavailableMessage
      : requiredRunIncomplete
        ? t('A required run did not complete. Rerun it successfully, then regenerate this result.')
        : environmentLockMissing || environmentLockPartial
          ? t(
              'A valid environment lock is required. Rerun with locked dependencies to create a new version.'
            )
          : checkIssues.length > 0
            ? t('Execution evidence is missing. Rerun the required code to create a new version.')
            : checkUnavailableMessage
  const checkBlockerId = `${markerId}-reproducibility-check-blocker`
  const latestReceipt = receipts[0]
  const latestHistoryIsFailure = Boolean(
    latestFailedAttempt &&
    (!latestReceipt || latestFailedAttempt.completedAt > latestReceipt.completedAt)
  )
  const visibleFailedAttempt = latestHistoryIsFailure ? latestFailedAttempt : undefined
  const checkLogs = checkState?.logs ?? []
  const summaryStatus = starting
    ? 'running'
    : (checkState?.status ?? (visibleFailedAttempt ? 'failed' : latestReceipt?.outcome))
  const summaryReceipt = starting
    ? undefined
    : checkState
      ? checkState.receipt
      : !visibleFailedAttempt
        ? latestReceipt
        : undefined
  const summaryClaimScope =
    summaryReceipt?.frontier.claimScope ??
    (checkState?.status === 'matched' || checkState?.status === 'different'
      ? projection.startFrontiers?.find(
          (frontier) => frontier.frontierId === checkState.request.frontierId
        )?.claimScope
      : undefined)
  const summaryCompletedAt =
    summaryReceipt?.completedAt ??
    (!checkState && !starting ? visibleFailedAttempt?.completedAt : undefined)
  const checkTitle =
    summaryStatus === 'matched'
      ? t('Result reproduced')
      : summaryStatus === 'different'
        ? t('Result differs')
        : summaryStatus === 'cancelled'
          ? t('Check cancelled')
          : summaryStatus === 'failed'
            ? t('Check stopped')
            : summaryStatus === 'running'
              ? t('Reproducibility check')
              : t('Not verified yet')
  const visibleCheckComparisons =
    summaryStatus === 'different'
      ? (checkState?.comparisons ?? summaryReceipt?.comparisons ?? []).filter(
          (comparison) => comparison.status === 'different'
        )
      : summaryStatus === 'matched'
        ? []
        : (checkState?.comparisons ?? [])
  const checkPhaseIndex = checkState?.phase
    ? CHECK_PHASES.indexOf(checkState.phase)
    : starting
      ? 0
      : -1
  const environmentLanguage = checkState?.activeEnvironment?.kernelKind === 'r' ? 'R' : 'Python'
  const runningAction =
    checkState?.status !== 'running'
      ? undefined
      : checkState.phase === 'loading-evidence'
        ? t('Loading captured evidence…')
        : checkState.phase === 'materializing-inputs'
          ? t('Preparing isolated inputs…')
          : checkState.phase === 'restoring-environments'
            ? checkState.activeEnvironment?.stage === 'validating-lock'
              ? t('Verifying the {{language}} environment lock…', {
                  language: environmentLanguage
                })
              : checkState.activeEnvironment?.stage === 'verifying-runtime'
                ? t('Verifying the {{language}} runtime…', { language: environmentLanguage })
                : checkState.activeEnvironment
                  ? t('Restoring the {{language}} environment…', {
                      language: environmentLanguage
                    })
                  : t('Restoring the captured environment…')
            : checkState.phase === 'comparing'
              ? t('Comparing generated files…')
              : t('Running Notebook…')
  const runningDetail =
    checkState?.status !== 'running'
      ? undefined
      : checkState.phase === 'restoring-environments' && checkState.activeEnvironment
        ? t('Environment {{current}} of {{total}}', {
            current: checkState.activeEnvironment.index + 1,
            total: checkState.activeEnvironment.total
          })
        : checkState.phase === 'executing'
          ? t('{{completed}} of {{total}} runs complete', {
              completed: checkState.completedSteps,
              total: checkState.totalSteps
            })
          : checkState.phase === 'comparing'
            ? t('File {{current}} of {{total}}', {
                current: checkState.comparisons.length,
                total: checkState.totalComparisons
              })
            : t('Step {{current}} of {{total}}', {
                current: Math.max(1, checkPhaseIndex + 1),
                total: CHECK_PHASES.length
              })
  const runningProgress =
    checkState?.status === 'running' && checkState.phase === 'executing'
      ? { value: checkState.completedSteps, total: checkState.totalSteps }
      : checkState?.status === 'running' && checkState.phase === 'comparing'
        ? { value: checkState.comparisons.length, total: checkState.totalComparisons }
        : undefined
  const checkStageLabels = [
    t('Load evidence'),
    t('Prepare inputs'),
    t('Restore environment'),
    t('Run Notebook'),
    t('Compare files')
  ]
  const visibleCheckPhase =
    checkState?.status === 'matched' || checkState?.status === 'different'
      ? CHECK_PHASES.length
      : Math.max(0, checkPhaseIndex + 1)
  const checkRailProgress =
    visibleCheckPhase <= 1 ? 0 : (visibleCheckPhase - 1) / (CHECK_PHASES.length - 1)

  const selectedActivity = selectedNode?.kind === 'activity' ? selectedNode.value : undefined
  const selectedEntity = selectedNode?.kind === 'entity' ? selectedNode.value : undefined
  const selectedOutputGroup = selectedNode?.kind === 'output-group' ? selectedNode.value : undefined
  const selectedInputs = selectedActivity
    ? projection.edges
        .flatMap((edge) =>
          edge.kind === 'used' && edge.activityId === selectedActivity.activityId
            ? [entities.get(edge.entityId)?.label]
            : []
        )
        .filter((label): label is string => Boolean(label))
    : []
  const selectedOutputs = selectedActivity
    ? projection.edges
        .flatMap((edge) =>
          edge.kind === 'generated' && edge.activityId === selectedActivity.activityId
            ? [entities.get(edge.entityId)?.label]
            : []
        )
        .filter((label): label is string => Boolean(label))
    : []
  const nodeDisplayLabel = (node: GraphNode): string =>
    node.kind === 'activity'
      ? activityLabel(node.value, t, computeNumbers)
      : fileLabelParts(node.value.label).filename
  const selectedIncomingEdges = (display?.edges ?? []).filter(
    (edge) => edge.targetKey === effectiveSelectedNodeKey
  )
  const selectedOutgoingEdges = (display?.edges ?? []).filter(
    (edge) => edge.sourceKey === effectiveSelectedNodeKey
  )
  const selectedIncomingLabels = [
    ...new Set(
      selectedIncomingEdges.flatMap((edge) => {
        const node = positionedNodes.get(edge.sourceKey)
        return node ? [nodeDisplayLabel(node)] : []
      })
    )
  ]
  const selectedPublishedLabels = [
    ...new Set(
      selectedOutgoingEdges.flatMap((edge) => {
        if (edge.relation !== 'publication') return []
        const node = positionedNodes.get(edge.targetKey)
        return node ? [nodeDisplayLabel(node)] : []
      })
    )
  ]
  const selectedOutgoingLabels = [
    ...new Set(
      selectedOutgoingEdges.flatMap((edge) => {
        if (edge.relation === 'publication') return []
        const node = positionedNodes.get(edge.targetKey)
        return node ? [nodeDisplayLabel(node)] : []
      })
    )
  ]
  const selectedDependencyEdges = [...selectedIncomingEdges, ...selectedOutgoingEdges]
  const selectedDependencyIsInferred = selectedDependencyEdges.some(
    (edge) => edge.authority === 'advisory' || edge.conservative
  )
  const selectedActivityEvidence = selectedActivity
    ? selectedActivity.evidenceState === 'available'
      ? t('Available evidence')
      : selectedActivity.evidenceState === 'partial'
        ? t('Partial evidence')
        : t('Unavailable evidence')
    : undefined
  const selectedEntityPath = selectedEntity ? fileLabelParts(selectedEntity.label) : undefined
  const closeNodeDetails = (): void => {
    const node = Array.from(
      panelRef.current?.querySelectorAll<SVGGElement>('[data-graph-node]') ?? []
    ).find((element) => element.dataset.graphNode === effectiveSelectedNodeKey)
    setSelectedNodeKey(undefined)
    node?.focus()
  }
  const selectedDetails = (
    <>
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-semibold text-text-000">{t('Details')}</h4>
        <PanelTooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('Close details')}
              className="shrink-0 text-text-300 hover:text-text-000"
              onClick={closeNodeDetails}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('Close details')}</TooltipContent>
        </PanelTooltip>
      </div>
      {nodeStartPreview ? (
        <ReproducibilityStartPreview
          key={`${artifactVersionKey}:${selectedNode?.key}`}
          preview={nodeStartPreview}
          activityLabel={(activity) => activityLabel(activity, t, computeNumbers)}
          frontierLabel={(frontier) => frontierTitle(frontier, activities, computeNumbers, t)}
          issues={summarizedIssues(
            [
              ...(nodeStartPreview.requested?.reasonCodes ?? []),
              ...(nodeStartPreview.requested?.checkReasonCodes ?? [])
            ],
            t
          ).map((issue) => issue.description)}
          busy={starting || checkState?.status === 'running'}
          disabledReason={
            restoringSummary
              ? t('Loading…')
              : pendingComparisonRules
                ? t('Apply comparison rules before starting a check.')
                : !checkApiAvailable
                  ? t(
                      'Execution evidence is unavailable, so safe starting points cannot be determined.'
                    )
                  : undefined
          }
          error={startError}
          onStart={startCheck}
        />
      ) : null}
      {selectedActivity ? (
        <div className="mt-3 space-y-4">
          <div>
            <p className="text-xs text-text-300">{t('Activity')}</p>
            <p className="mt-0.5 break-words font-medium text-text-000">
              {activityLabel(selectedActivity, t, computeNumbers)}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-2 rounded-md bg-bg-200/55 p-2.5 tabular-nums">
            <div>
              <dt className="text-[11px] text-text-300">{t('Inputs')}</dt>
              <dd className="mt-0.5 text-base font-semibold text-text-000">
                {selectedInputs.length}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-text-300">{t('Outputs')}</dt>
              <dd className="mt-0.5 text-base font-semibold text-text-000">
                {selectedOutputs.length}
              </dd>
            </div>
          </dl>
          <dl className="space-y-3 border-t border-border-300/40 pt-3">
            <div className="min-w-0">
              <dt className="flex items-center justify-between gap-2 text-xs font-medium text-text-200">
                <span>{t('Inputs')}</span>
                <span className="tabular-nums text-text-300">{selectedInputs.length}</span>
              </dt>
              <dd className="mt-1.5">
                {selectedInputs.length > 0 ? (
                  <ul className="space-y-1.5 text-xs leading-4 text-text-100">
                    {selectedInputs.map((input) => (
                      <li key={input} className="[overflow-wrap:anywhere]">
                        {input}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-text-300">—</span>
                )}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="flex items-center justify-between gap-2 text-xs font-medium text-text-200">
                <span>{t('Outputs')}</span>
                <span className="tabular-nums text-text-300">{selectedOutputs.length}</span>
              </dt>
              <dd className="mt-1.5">
                {selectedOutputs.length > 0 ? (
                  <ul className="space-y-1.5 text-xs leading-4 text-text-100">
                    {selectedOutputs.map((output) => (
                      <li key={output} className="[overflow-wrap:anywhere]">
                        {output}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-text-300">—</span>
                )}
              </dd>
            </div>
          </dl>
          <dl className="space-y-2 border-t border-border-300/40 pt-3 text-xs">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-text-300">{t('Evidence status')}</dt>
              <dd className="text-right font-medium text-text-100">{selectedActivityEvidence}</dd>
            </div>
          </dl>
          {selectedActivity.inclusion === 'kernel-epoch-conservative' ? (
            <p className="text-xs font-medium text-status-warning-foreground dark:text-status-warning-dark-foreground">
              {t('Included conservatively')}
            </p>
          ) : null}
        </div>
      ) : selectedEntity ? (
        <div className="mt-3 space-y-4">
          <div>
            <p className="text-xs text-text-300">
              {selectedEntity.entityId === projection.targetEntityId
                ? t('Comparison target')
                : entityKindLabel(selectedEntity, t)}
            </p>
            <p className="mt-0.5 break-words font-medium text-text-000">
              {selectedEntityPath?.filename}
            </p>
          </div>
          <dl className="space-y-3 border-t border-border-300/40 pt-3 text-xs">
            {selectedEntityPath?.directory ? (
              <div className="min-w-0">
                <dt className="text-text-300">{t('Location')}</dt>
                <dd className="mt-1 break-all font-mono text-[11px] leading-4 text-text-100">
                  {selectedEntityPath.directory}
                </dd>
              </div>
            ) : null}
            <div className="min-w-0">
              <dt className="text-text-300">{t('Checksum')}</dt>
              <dd className="mt-1 break-all font-mono text-[11px] leading-4 text-text-100">
                {selectedEntity.checksum}
              </dd>
            </div>
            {selectedDependencyEdges.length > 0 ? (
              <div className="flex items-start justify-between gap-3">
                <dt className="text-text-300">{t('Dependency evidence')}</dt>
                <dd className="text-right font-medium text-text-100">
                  {selectedDependencyIsInferred ? t('Inferred') : t('Confirmed')}
                </dd>
              </div>
            ) : null}
          </dl>
          {selectedIncomingLabels.length > 0 ? (
            <div className="border-t border-border-300/40 pt-3">
              <p className="text-xs font-medium text-text-200">
                {selectedEntity.entityId === projection.targetEntityId
                  ? t('Published from')
                  : t('Produced by')}
              </p>
              <ul className="mt-1.5 space-y-1 text-xs text-text-100">
                {selectedIncomingLabels.map((label) => (
                  <li key={label} className="break-words">
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {selectedOutgoingLabels.length > 0 ? (
            <div className="border-t border-border-300/40 pt-3">
              <p className="text-xs font-medium text-text-200">{t('Used by')}</p>
              <ul className="mt-1.5 space-y-1 text-xs text-text-100">
                {selectedOutgoingLabels.map((label) => (
                  <li key={label} className="break-words">
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {selectedPublishedLabels.length > 0 ? (
            <div className="border-t border-border-300/40 pt-3">
              <p className="text-xs font-medium text-text-200">{t('Published as')}</p>
              <ul className="mt-1.5 space-y-1 text-xs text-text-100">
                {selectedPublishedLabels.map((label) => (
                  <li key={label} className="break-words">
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {selectedEntity.pathPortability === 'absolute' ? (
            <p className="text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
              {t('Absolute path hidden')}
            </p>
          ) : null}
        </div>
      ) : selectedOutputGroup ? (
        <div className="mt-2.5 space-y-3">
          <div>
            <p className="text-xs text-text-300">{t('Logical output')}</p>
            <p className="break-words font-medium text-text-000">{selectedOutputGroup.label}</p>
            <p className="mt-0.5 text-xs text-text-300">
              {selectedOutputGroup.formatHint ??
                t(outputStorageShapeCopy[selectedOutputGroup.storageShape])}
              {' · '}
              {t('{{count}} files', { count: selectedOutputGroup.memberEntityIds.length })}
            </p>
          </div>
          <p className="text-xs leading-5 text-text-200">
            {t(
              'This display group summarizes related files. File-level provenance remains authoritative.'
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full whitespace-nowrap"
            aria-expanded={expandedOutputIds.has(selectedOutputGroup.outputId)}
            onClick={() => {
              setExpandedOutputIds((current) => {
                const next = new Set(current)
                if (next.has(selectedOutputGroup.outputId))
                  next.delete(selectedOutputGroup.outputId)
                else next.add(selectedOutputGroup.outputId)
                return next
              })
            }}
          >
            {expandedOutputIds.has(selectedOutputGroup.outputId)
              ? t('Collapse files')
              : t('Expand files')}
          </Button>
          <div className="border-t border-border-300/40 pt-2.5">
            <p className="text-xs font-medium text-text-200">{t('Member files')}</p>
            <ul className="mt-1.5 space-y-1 text-xs text-text-300">
              {selectedOutputGroup.memberEntityIds.map((entityId) => (
                <li key={entityId} className="break-words">
                  {entities.get(entityId)?.label ?? entityId}
                </li>
              ))}
            </ul>
          </div>
          {selectedOutputGroup.riskCodes.length > 0 ? (
            <div className="border-t border-border-300/40 pt-2.5">
              <p className="text-xs font-medium text-text-200">{t('Evidence limits')}</p>
              <ul className="mt-1.5 space-y-1 text-xs leading-5 text-text-300">
                {selectedOutputGroup.riskCodes.map((risk) => (
                  <li key={risk}>{t(outputRiskCopy[risk])}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )

  return (
    <div ref={panelRef} className="space-y-3.5 p-4 text-sm sm:p-5">
      <section aria-labelledby="reproducibility-check-title">
        <div
          data-reproducibility-check-state={checkState?.status ?? (starting ? 'starting' : 'idle')}
          className={cn(
            'overflow-hidden rounded-xl border bg-bg-000',
            checkUnavailable && !starting
              ? 'border-border-300/60'
              : !checkState || checkState.status === 'running'
                ? 'border-primary/30'
                : 'border-border-300/60'
          )}
        >
          <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span
                className={cn(
                  'flex size-9 shrink-0 items-center justify-center rounded-lg',
                  summaryStatus === 'failed' || summaryStatus === 'different'
                    ? 'bg-status-warning-surface text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground'
                    : summaryStatus === 'matched'
                      ? 'bg-bg-200 text-primary'
                      : checkUnavailable
                        ? 'bg-bg-200 text-text-000/70'
                        : 'bg-primary/10 text-primary'
                )}
              >
                {starting || checkState?.status === 'running' ? (
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : summaryStatus === 'matched' ? (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                ) : summaryStatus ? (
                  <AlertCircle className="size-4" aria-hidden="true" />
                ) : (
                  <PackageCheck className="size-4" aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3
                    id="reproducibility-check-title"
                    className="min-w-0 break-words text-base font-semibold text-text-000 [overflow-wrap:anywhere]"
                    aria-live="polite"
                  >
                    {checkTitle}
                  </h3>
                  {checkState?.status === 'running' ? (
                    <CheckElapsedTime key={checkState.attemptId} startedAt={checkState.startedAt} />
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-text-000/75" aria-live="polite">
                  <p>
                    {summaryStatus === 'running' ? (
                      <>
                        <span className="font-medium text-text-100">
                          {starting ? t('Starting…') : runningAction}
                        </span>{' '}
                        {runningDetail}
                      </>
                    ) : summaryStatus === 'matched' ? (
                      t('All selected outputs match the captured result.')
                    ) : summaryStatus === 'different' ? (
                      t('At least one selected output does not match the captured result.')
                    ) : summaryStatus === 'cancelled' ? (
                      t('The isolated check stopped without changing the original result.')
                    ) : summaryStatus === 'failed' ? (
                      failedCheckDetail(checkState?.phase ?? visibleFailedAttempt?.phase, t)
                    ) : checkUnavailable ? null : (
                      t('Runs in an isolated workspace. Original files and results stay unchanged.')
                    )}
                  </p>
                  {summaryClaimScope || summaryCompletedAt ? (
                    <p
                      data-reproducibility-check-conclusion
                      className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-text-000/75"
                    >
                      {summaryClaimScope ? (
                        <span className="font-medium">
                          {summaryClaimScope === 'end-to-end'
                            ? t('End-to-end claim')
                            : t('Downstream-only claim')}
                        </span>
                      ) : null}
                      {summaryCompletedAt ? (
                        <time dateTime={summaryCompletedAt}>
                          {t('Last checked {{date}}', { date: receiptDate(summaryCompletedAt) })}
                        </time>
                      ) : null}
                    </p>
                  ) : null}
                  {summaryStatus === 'different' && summaryReceipt ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        const history = historyRef.current
                        const entry = Array.from(
                          history?.querySelectorAll<HTMLDetailsElement>(
                            '[data-receipt-checksum]'
                          ) ?? []
                        ).find(
                          (item) => item.dataset.receiptChecksum === summaryReceipt.receiptChecksum
                        )
                        if (!history || !entry) return
                        history.open = true
                        entry.open = true
                        entry.querySelector('summary')?.focus()
                        entry.scrollIntoView({ block: 'nearest' })
                      }}
                    >
                      {t('View details')}
                    </Button>
                  ) : null}
                  {checkState?.status === 'running' &&
                  checkState.phase === 'restoring-environments' &&
                  checkState.activeEnvironment?.stage === 'restoring-packages' ? (
                    <EnvironmentRestoreHint
                      key={checkState.attemptId}
                      startedAt={checkState.startedAt}
                    />
                  ) : null}
                  {startError ? (
                    <p className="mt-1.5 text-danger-000" role="alert">
                      {t('The check could not start. The original result was not changed.')}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
            {checkState?.status === 'running' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9 shrink-0 whitespace-nowrap self-start sm:self-auto [@media(pointer:coarse)]:min-h-11"
                disabled={cancelling}
                onClick={() => void cancelCheck()}
              >
                {cancelling ? t('Cancelling…') : t('Cancel')}
              </Button>
            ) : (
              (() => {
                if (checkUnavailable && !starting) {
                  return (
                    <PanelTooltip>
                      <TooltipTrigger asChild>
                        <span
                          data-reproducibility-check-unavailable
                          aria-describedby={checkBlockerId}
                          tabIndex={0}
                          className="inline-flex h-7 shrink-0 self-start items-center gap-1.5 rounded-full border border-border-300/70 bg-bg-100 px-2.5 text-[11px] font-medium text-text-000/70 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <CircleSlash2 className="size-3.5" aria-hidden="true" />
                          {t('Unavailable')}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        align="end"
                        className={cn('max-w-80 space-y-1 px-3 py-2.5 leading-5', tooltipClassName)}
                      >
                        <p>{checkUnavailableDetail}</p>
                      </TooltipContent>
                    </PanelTooltip>
                  )
                }
                const action = (
                  <Button
                    type="button"
                    variant={
                      restoringSummary ||
                      summaryStatus === 'matched' ||
                      summaryStatus === 'different'
                        ? 'outline'
                        : 'default'
                    }
                    size="sm"
                    className="min-h-9 shrink-0 whitespace-nowrap self-start sm:self-auto [@media(pointer:coarse)]:min-h-11"
                    disabled={starting || restoringSummary || pendingComparisonRules}
                    aria-busy={starting || restoringSummary}
                    onClick={() => void startCheck()}
                  >
                    {starting ? (
                      <LoaderCircle
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                    {starting
                      ? t('Starting…')
                      : restoringSummary
                        ? t('Loading…')
                        : summaryStatus === 'failed'
                          ? t('Retry check')
                          : checkState || latestReceipt
                            ? t('Check again')
                            : t('Check reproducibility')}
                  </Button>
                )
                return action
              })()
            )}
          </div>
          {visibleCheckComparisons.length ? (
            <ul
              data-reproducibility-check-comparisons
              className="mx-4 grid gap-1.5 border-t border-border-300/50 py-3 sm:grid-cols-2"
            >
              {visibleCheckComparisons.map((comparison, index) => (
                <li
                  key={`${comparison.relativePath}:${index}`}
                  className="flex min-w-0 items-center gap-2 text-xs"
                >
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      comparison.status === 'matched'
                        ? 'bg-status-info-foreground dark:bg-status-info-dark-foreground'
                        : 'bg-status-warning-foreground dark:bg-status-warning-dark-foreground'
                    )}
                  />
                  <span className="truncate text-text-000/75" title={comparison.relativePath}>
                    {comparison.relativePath}
                  </span>
                  <span className="ml-auto shrink-0 text-text-000/70">
                    {comparison.status === 'matched' ? t('Matched') : t('Different')}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {selectedFrontier ? (
            <fieldset
              className="min-w-0 space-y-1.5 border-t border-border-300/50 px-4 py-3"
              disabled={starting || checkState?.status === 'running'}
            >
              <legend className="flex items-center gap-1.5 font-semibold text-text-000">
                <span>
                  {summaryStatus && summaryStatus !== 'running' ? t('Next check') : t('Start from')}
                </span>
                <PanelTooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t(
                        'Preview a safe starting point. No files or results will be changed.'
                      )}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-text-000/70 outline-none hover:bg-bg-200 hover:text-text-000 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <Info aria-hidden="true" className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className={cn('max-w-72 px-3 py-2 leading-5', tooltipClassName)}
                  >
                    {t('Preview a safe starting point. No files or results will be changed.')}
                  </TooltipContent>
                </PanelTooltip>
              </legend>
              {selectableFrontiers.length > 1 ? (
                <Select
                  value={selectedFrontier?.frontierId}
                  onValueChange={setSelectedFrontierId}
                  disabled={starting || checkState?.status === 'running'}
                >
                  <SelectTrigger
                    data-start-frontier-selector
                    aria-label={t('Start from')}
                    className="h-9 min-w-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    className={cn(
                      'max-w-[calc(100vw-2rem)] [&_[data-slot=select-item]]:break-words [&_[data-slot=select-item]]:whitespace-normal',
                      tooltipClassName
                    )}
                  >
                    {selectableFrontiers.map((frontier) => (
                      <SelectItem key={frontier.frontierId} value={frontier.frontierId}>
                        {frontierTitle(frontier, activities, computeNumbers, t)} ·{' '}
                        {t('Runs to execute: {{runs}}', {
                          runs: runnableActivityCount(frontier, activities)
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {selectedFrontier ? (
                <div
                  data-start-frontier-summary={selectedFrontier.frontierId}
                  className="flex max-w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-2"
                >
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <p className="truncate font-medium text-text-000">
                        {frontierTitle(selectedFrontier, activities, computeNumbers, t)}
                      </p>
                      <p className="shrink-0 text-xs text-text-000/70">
                        {selectedFrontier.claimScope === 'end-to-end'
                          ? t('End-to-end claim')
                          : t('Downstream-only claim')}
                      </p>
                    </div>
                  </div>
                  <dl className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-[11px] text-text-000/70">{t('Runs to execute')}</dt>
                      <dd className="text-xs font-semibold text-text-000">
                        {runnableActivityCount(selectedFrontier, activities)}
                      </dd>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-[11px] text-text-000/70">{t('Frozen files')}</dt>
                      <dd className="text-xs font-semibold text-text-000">
                        {selectedFrontier.crossingEntityIds.length}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : null}
              <OutputComparisonSettings
                key={artifactVersionKey}
                value={comparisonPolicy}
                onChange={setComparisonPolicy}
                onPendingChange={setPendingComparisonRules}
                overlayClassName={tooltipClassName}
                disabled={starting || checkState?.status === 'running'}
              />
            </fieldset>
          ) : null}

          {checkUnavailable && !starting ? (
            <div
              id={checkBlockerId}
              data-reproducibility-check-blocker
              role="status"
              className="flex flex-col gap-2 border-t border-border-300/50 bg-bg-100/45 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-start gap-2 text-xs leading-5 text-text-000/75">
                <Info className="mt-0.5 size-3.5 shrink-0 text-text-000/70" aria-hidden="true" />
                <p>{checkUnavailableDetail}</p>
              </div>
              {checkIssues.length > 0 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="self-start whitespace-nowrap sm:self-auto"
                    >
                      {t('View details')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    data-capture-issue-details
                    aria-label={t('Areas needing attention')}
                    side="top"
                    align="end"
                    collisionPadding={8}
                    className={cn(
                      'z-50 max-h-80 max-w-[min(20rem,calc(100vw-1rem))] space-y-2.5 overflow-y-auto px-3 py-2.5',
                      tooltipClassName
                    )}
                  >
                    <p className="font-medium">{t('Areas needing attention')}</p>
                    <ul className="space-y-2.5">
                      {environmentDetails.map(({ run, details }) => (
                        <li key={run.runId} data-environment-lock-details className="break-words">
                          <p className="font-medium leading-4">
                            {t('Notebook run {{number}}', { number: run.runIndex + 1 })}
                            {run.environmentName ? ` · ${run.environmentName}` : ''}
                          </p>
                          {details.map((detail, index) => (
                            <p key={index} className="mt-1 leading-4 text-bg-000/75">
                              {detail}
                            </p>
                          ))}
                        </li>
                      ))}
                      {checkIssues.map((issue) => (
                        <li key={issue.category} data-capture-issue={issue.category}>
                          <p className="font-medium leading-4">{issue.label}</p>
                          <p className="mt-0.5 leading-4 text-bg-000/75">{issue.description}</p>
                        </li>
                      ))}
                    </ul>
                  </PopoverContent>
                </Popover>
              ) : null}
            </div>
          ) : null}
          {starting ||
          checkState?.status === 'running' ||
          checkState?.status === 'failed' ||
          checkState?.status === 'cancelled' ? (
            <>
              <div
                data-reproducibility-check-progress-summary
                className="flex flex-wrap items-center justify-between gap-2 border-t border-border-300 bg-bg-000 px-4 pt-3 text-xs"
              >
                <span className="font-medium text-text-000/75">
                  {t('Reproducibility check progress')}
                </span>
                <span
                  data-reproducibility-check-progress-count
                  className="tabular-nums text-text-000/70"
                >
                  {t('Step {{current}} of {{total}}', {
                    current: visibleCheckPhase,
                    total: CHECK_PHASES.length
                  })}
                </span>
              </div>
              <div data-reproducibility-check-progress-track className="relative bg-bg-000">
                <span
                  data-reproducibility-check-mobile-rail
                  aria-hidden="true"
                  className="absolute bottom-6 left-[27px] top-5 w-0.5 overflow-hidden rounded-full bg-border-300 sm:hidden"
                >
                  <span
                    className="block h-full origin-top bg-primary transition-transform duration-300 motion-reduce:transition-none"
                    style={{ transform: `scaleY(${checkRailProgress})` }}
                  />
                </span>
                <span
                  data-reproducibility-check-rail
                  aria-hidden="true"
                  className="absolute left-[10%] right-[10%] top-[19px] hidden h-0.5 overflow-hidden rounded-full bg-border-300 sm:block"
                >
                  <span
                    data-reproducibility-check-rail-progress
                    className="block h-full origin-left bg-primary transition-transform duration-300 motion-reduce:transition-none"
                    style={{ transform: `scaleX(${checkRailProgress})` }}
                  />
                </span>
                <ol
                  className="relative grid grid-cols-1 gap-2 px-4 pb-3 pt-2 sm:grid-cols-5 sm:gap-0"
                  aria-label={t('Reproducibility check progress')}
                >
                  {checkStageLabels.map((label, index) => {
                    const completed =
                      checkState?.status === 'matched' ||
                      checkState?.status === 'different' ||
                      index < checkPhaseIndex
                    const current =
                      index === checkPhaseIndex &&
                      (starting ||
                        checkState?.status === 'running' ||
                        checkState?.status === 'failed' ||
                        checkState?.status === 'cancelled')
                    const failed = current && checkState?.status === 'failed'
                    const cancelled = current && checkState?.status === 'cancelled'
                    return (
                      <li
                        key={label}
                        data-reproducibility-check-stage={CHECK_PHASES[index]}
                        data-reproducibility-check-stage-state={
                          completed
                            ? 'completed'
                            : failed
                              ? 'failed'
                              : cancelled
                                ? 'cancelled'
                                : current
                                  ? 'current'
                                  : 'pending'
                        }
                        className="relative flex min-w-0 items-center gap-2 sm:flex-col sm:gap-2 sm:text-center"
                        aria-current={current ? 'step' : undefined}
                      >
                        <span
                          data-reproducibility-check-stage-marker
                          aria-hidden="true"
                          className={cn(
                            'relative z-10 grid size-6 shrink-0 place-items-center rounded-full border bg-bg-000 text-[10px] font-medium tabular-nums',
                            completed && 'border-primary bg-primary text-primary-foreground',
                            current &&
                              !failed &&
                              !cancelled &&
                              'border-primary bg-primary font-semibold text-primary-foreground ring-4 ring-primary/10',
                            failed &&
                              'border-status-warning-foreground bg-status-warning-surface text-status-warning-foreground dark:border-status-warning-dark-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground',
                            cancelled && 'border-border-300 bg-bg-200 text-text-000/70',
                            !completed && !current && 'border-border-300 text-text-000/70'
                          )}
                        >
                          {completed ? (
                            <CheckCircle2 className="size-4" />
                          ) : failed ? (
                            <AlertCircle className="size-4" />
                          ) : cancelled ? (
                            <X className="size-4" />
                          ) : (
                            index + 1
                          )}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 text-xs leading-4 sm:min-h-8 sm:w-full sm:px-1 sm:text-[11px]',
                            current
                              ? 'font-semibold text-primary'
                              : completed
                                ? 'font-medium text-text-100'
                                : 'text-text-000/70'
                          )}
                        >
                          {label}
                        </span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            </>
          ) : null}
          <div className="px-4">
            {checkState?.status === 'running' && runningProgress && runningProgress.total > 0 ? (
              <div
                className="my-3 h-1 max-w-md overflow-hidden rounded-full bg-bg-300"
                role="progressbar"
                aria-label={t('Reproducibility check progress')}
                aria-valuemin={0}
                aria-valuemax={runningProgress.total}
                aria-valuenow={runningProgress.value}
              >
                <div
                  className="h-full origin-left rounded-full bg-primary transition-transform duration-300 motion-reduce:transition-none"
                  style={{
                    transform: `scaleX(${Math.min(
                      1,
                      Math.max(0, runningProgress.value / runningProgress.total)
                    )})`
                  }}
                />
              </div>
            ) : null}
            {checkState?.status === 'running' || checkLogs.length > 0 ? (
              <details
                key={checkState?.status === 'running' ? 'running-log' : 'completed-log'}
                open={checkState?.status === 'running' ? true : undefined}
                data-reproducibility-check-log
                className="my-3 overflow-hidden rounded-lg border border-border-300/60 bg-bg-100/55"
                aria-labelledby="reproducibility-check-log-title"
              >
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none hover:bg-bg-200 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <TerminalSquare className="size-3.5 text-text-000/70" aria-hidden="true" />
                  <h4
                    id="reproducibility-check-log-title"
                    className="text-xs font-medium text-text-100"
                  >
                    {t('Log')}
                  </h4>
                  <ChevronDown className="ml-auto size-3.5" aria-hidden="true" />
                </summary>
                <ReproducibilityLogViewport key={checkState?.attemptId} logs={checkLogs}>
                  {checkState?.logsTruncated ? (
                    <p className="text-text-000/65">{t('Output truncated')}</p>
                  ) : null}
                  {checkLogs.length === 0 && runningAction ? (
                    <p className="text-text-000/65">{runningAction}</p>
                  ) : null}
                  {checkLogs.map((entry, index) => reproducibilityLogEntry(entry, index, true))}
                </ReproducibilityLogViewport>
              </details>
            ) : null}
          </div>
        </div>
        {receipts.length > 0 || visibleFailedAttempt || receiptError ? (
          <details
            data-reproducibility-history
            ref={historyRef}
            className="group/history mt-3 rounded-lg border border-border-300/60 bg-bg-000"
          >
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-3 text-sm outline-none hover:bg-bg-200/50 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50">
              <History aria-hidden="true" className="size-4 shrink-0 text-text-300" />
              <span className="font-medium text-text-000">{t('Verification history')}</span>
              {receipts.length > 0 || visibleFailedAttempt ? (
                <span className="rounded-full bg-bg-200 px-2 py-0.5 text-[11px] tabular-nums text-text-300">
                  {receipts.length + (visibleFailedAttempt ? 1 : 0)}
                  {receiptHistory.nextCursor ? '+' : null}
                </span>
              ) : null}
              <ChevronDown
                aria-hidden="true"
                className="ml-auto size-4 shrink-0 text-text-300 transition-transform duration-200 group-open/history:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <div className="border-t border-border-300/50">
              <ReproducibilityOutputStorage
                key={artifactVersionKey}
                scope={artifactVersion}
                receiptKey={receipts.map((receipt) => receipt.receiptChecksum).join(':')}
                running={starting || checkState?.status === 'running'}
              >
                {receiptError ? (
                  <div className="flex items-center justify-between gap-3 px-3.5 py-3">
                    <p className="text-xs text-danger-000" role="alert">
                      {t('Verification history could not be loaded.')}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={retryingHistory || receiptHistory.loadingMore}
                      onClick={() => {
                        if (receiptHistory.nextCursor) {
                          void loadMoreReceipts()
                          return
                        }
                        setRetryingHistory(true)
                        setHistoryRetry((revision) => revision + 1)
                      }}
                    >
                      {retryingHistory || receiptHistory.loadingMore ? t('Loading…') : t('Retry')}
                    </Button>
                  </div>
                ) : null}
                {exportError ? (
                  <p
                    role="alert"
                    className="border-b border-border-300/40 px-3.5 py-3 text-xs text-danger-000"
                  >
                    {exportError}
                  </p>
                ) : null}
                {receipts.length > 0 || visibleFailedAttempt ? (
                  <ol className="divide-y divide-border-300/50">
                    {visibleFailedAttempt ? (
                      <li>
                        <details
                          data-reproducibility-history-entry="failed"
                          className="group/history-item"
                          onToggle={(event) => {
                            if (
                              event.currentTarget.open &&
                              (visibleFailedAttempt.checkLog.entryCount > 0 ||
                                visibleFailedAttempt.checkLog.truncated)
                            ) {
                              void loadPersistedCheckLog(
                                `attempt:${visibleFailedAttempt.attemptId}`,
                                { attemptId: visibleFailedAttempt.attemptId }
                              )
                            }
                          }}
                        >
                          <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 outline-none hover:bg-bg-200/35 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50">
                            <span className="flex min-w-0 items-center gap-2.5">
                              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-status-warning-surface/55 text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground">
                                <AlertCircle className="size-4" aria-hidden="true" />
                              </span>
                              <span className="min-w-0 font-medium text-text-000">
                                {t('Check failed')}
                              </span>
                            </span>
                            <span className="flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-300/70 bg-bg-000 px-2.5 text-xs font-medium text-text-200">
                              <TerminalSquare className="size-3.5" aria-hidden="true" />
                              {t('View log')}
                              <ChevronDown
                                className="size-3.5 text-text-300 transition-transform duration-200 group-open/history-item:rotate-180 motion-reduce:transition-none"
                                aria-hidden="true"
                              />
                            </span>
                          </summary>
                          <div className="px-3.5 pb-3.5">
                            <p className="text-xs leading-5 text-text-300">
                              {failedCheckDetail(visibleFailedAttempt.phase, t)}
                            </p>
                            {visibleFailedAttempt.checkLog.entryCount > 0 ||
                            visibleFailedAttempt.checkLog.truncated
                              ? persistedLogContent(`attempt:${visibleFailedAttempt.attemptId}`)
                              : null}
                            <div className="mt-3 flex items-center gap-1.5 border-t border-border-300/40 pt-3 text-xs text-text-300">
                              <Clock3 className="size-3.5" aria-hidden="true" />
                              <span>{t('Completed')}</span>
                              <time
                                dateTime={visibleFailedAttempt.completedAt}
                                className="tabular-nums"
                              >
                                {receiptDate(visibleFailedAttempt.completedAt)}
                              </time>
                            </div>
                          </div>
                        </details>
                      </li>
                    ) : null}
                    {receipts.map((receipt, receiptIndex) => {
                      const hasLog = Boolean(
                        receipt.checkLog &&
                        (receipt.checkLog.entryCount > 0 || receipt.checkLog.truncated)
                      )
                      const allBytesMatch =
                        receipt.comparisons.length > 0 &&
                        receipt.comparisons.every((comparison) => comparison.status === 'matched')
                      const allContentMatches =
                        receipt.comparisons.length > 0 &&
                        receipt.comparisons.every(
                          (comparison) =>
                            comparison.status === 'matched' ||
                            comparison.contentComparison?.outcome === 'equal' ||
                            comparison.contentComparison?.outcome === 'within-tolerance'
                        )
                      const comparisonTitle = allBytesMatch
                        ? t('Byte-for-byte match')
                        : allContentMatches
                          ? receipt.comparisons.some(
                              (comparison) =>
                                comparison.contentComparison?.outcome === 'within-tolerance'
                            )
                            ? t('Content is within the selected tolerance')
                            : t('Decoded content is identical')
                          : receipt.comparisons.length === 0 ||
                              receipt.comparisons.some(
                                (comparison) =>
                                  comparison.status === 'different' &&
                                  comparison.reason !== 'size-mismatch' &&
                                  comparison.reason !== 'checksum-mismatch'
                              )
                            ? t('Output comparison incomplete')
                            : t('Result differs')
                      return (
                        <li key={receipt.receiptChecksum}>
                          <details
                            data-reproducibility-history-entry={receipt.outcome}
                            data-receipt-checksum={receipt.receiptChecksum}
                            className="group/history-item"
                            open={receiptIndex === 0}
                          >
                            <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 outline-none hover:bg-bg-200/35 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50">
                              <span className="flex min-w-0 items-center gap-2.5">
                                <span
                                  data-verification-result-icon={receipt.outcome}
                                  className={cn(
                                    'grid size-8 shrink-0 place-items-center rounded-md',
                                    receipt.outcome === 'matched'
                                      ? 'bg-bg-200 text-primary'
                                      : 'bg-status-warning-surface/55 text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground'
                                  )}
                                >
                                  {receipt.outcome === 'matched' ? (
                                    <CheckCircle2 className="size-4" aria-hidden="true" />
                                  ) : (
                                    <AlertCircle className="size-4" aria-hidden="true" />
                                  )}
                                </span>
                                <span className="min-w-0">
                                  <span className="block font-medium text-text-000">
                                    {comparisonTitle}
                                  </span>
                                  <span className="mt-0.5 flex flex-wrap gap-x-1 text-xs text-text-300">
                                    {receipt.frontier.claimScope === 'end-to-end'
                                      ? t('End-to-end claim')
                                      : t('Downstream-only claim')}
                                    {' · '}
                                    {t('{{count}} runs', {
                                      count: receipt.completedStepIds.length,
                                      defaultValue_one: '{{count}} run'
                                    })}
                                    {' · '}
                                    {t('{{count}} output comparisons', {
                                      count: receipt.comparisons.length,
                                      defaultValue_one: '{{count}} output comparison'
                                    })}
                                  </span>
                                </span>
                              </span>
                              <span className="flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-300/70 bg-bg-000 px-2.5 text-xs font-medium text-text-200">
                                <Info className="size-3.5" aria-hidden="true" />
                                {t('View comparison')}
                                <ChevronDown
                                  className="size-3.5 text-text-300 transition-transform duration-200 group-open/history-item:rotate-180 motion-reduce:transition-none"
                                  aria-hidden="true"
                                />
                              </span>
                            </summary>
                            <div className="px-3.5 pb-3.5">
                              {receipt.comparisons.length > 0 ? (
                                <ul className="mt-3 space-y-1 border-t border-border-300/40 pt-3 text-xs">
                                  {receipt.comparisons.map((comparison) => (
                                    <li
                                      key={`${receipt.receiptChecksum}:${comparison.entityId}`}
                                      className="min-w-0 rounded-md border border-border-300/50 p-3"
                                    >
                                      <div className="flex min-w-0 items-center gap-2">
                                        <span
                                          className={
                                            comparison.status === 'different'
                                              ? 'size-1.5 shrink-0 rounded-full bg-status-warning-foreground dark:bg-status-warning-dark-foreground'
                                              : 'size-1.5 shrink-0 rounded-full bg-primary'
                                          }
                                        />
                                        <span
                                          className="truncate text-text-200"
                                          title={comparison.relativePath}
                                        >
                                          {comparison.relativePath}
                                        </span>
                                        <span className="ml-auto shrink-0 text-text-300">
                                          {comparison.status === 'matched'
                                            ? t('Byte-for-byte match')
                                            : comparison.reason === 'size-mismatch' ||
                                                comparison.reason === 'checksum-mismatch'
                                              ? t('Bytes differ')
                                              : t('Not compared')}
                                        </span>
                                      </div>
                                      <ReproducibilityOutput
                                        receipt={receipt}
                                        comparison={comparison}
                                      />
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              {hasLog ? (
                                <details
                                  data-receipt-log
                                  className="mt-3 text-xs text-text-300"
                                  onToggle={(event) => {
                                    if (
                                      event.target !== event.currentTarget ||
                                      !event.currentTarget.open
                                    )
                                      return
                                    void loadPersistedCheckLog(
                                      `receipt:${receipt.receiptChecksum}`,
                                      {
                                        receiptChecksum: receipt.receiptChecksum
                                      }
                                    )
                                  }}
                                >
                                  <summary className="cursor-pointer py-2">{t('View log')}</summary>
                                  {persistedLogContent(`receipt:${receipt.receiptChecksum}`)}
                                </details>
                              ) : null}
                              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-300/40 pt-3">
                                <span className="flex items-center gap-1.5 text-xs text-text-300">
                                  <Clock3 className="size-3.5" aria-hidden="true" />
                                  <span>{t('Checked at')}</span>
                                  <time dateTime={receipt.completedAt} className="tabular-nums">
                                    {receiptDate(receipt.completedAt)}
                                  </time>
                                </span>
                                {exportApiAvailable ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="whitespace-nowrap"
                                    disabled={exportingReceiptChecksum !== undefined}
                                    aria-label={t('Export verification record')}
                                    title={t(
                                      'Includes the report, logs, and retained differing outputs. Source data is not included.'
                                    )}
                                    onClick={() => void exportReceipt(receipt)}
                                  >
                                    {exportingReceiptChecksum === receipt.receiptChecksum ? (
                                      <LoaderCircle
                                        className="animate-spin motion-reduce:animate-none"
                                        aria-hidden="true"
                                      />
                                    ) : (
                                      <Download aria-hidden="true" />
                                    )}
                                    {exportingReceiptChecksum === receipt.receiptChecksum
                                      ? t('Exporting…')
                                      : t('Export verification record')}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </details>
                        </li>
                      )
                    })}
                  </ol>
                ) : null}
                {receiptHistory.nextCursor ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="m-3.5"
                    disabled={receiptHistory.loadingMore}
                    onClick={() => void loadMoreReceipts()}
                  >
                    {receiptHistory.loadingMore ? (
                      <LoaderCircle
                        className="animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                    {receiptHistory.loadingMore ? t('Loading…') : t('Load more')}
                  </Button>
                ) : null}
              </ReproducibilityOutputStorage>
            </div>
          </details>
        ) : null}
      </section>

      <section
        className="border-b border-border-300/50 pb-3"
        aria-labelledby="reproducibility-evidence-title"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <div className="flex shrink-0 items-center gap-1.5">
              <h3 id="reproducibility-evidence-title" className="font-semibold text-text-000">
                {t('Captured evidence')}
              </h3>
            </div>
            <PanelTooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="max-w-full truncate text-xs text-text-300">
                  {analysisRevision
                    ? t('Analysis rules: {{revision}}', {
                        revision: [
                          analysisRevision.dependencyAnalyzer?.revision,
                          analysisRevision.lineageBuilder.revision
                        ]
                          .filter(Boolean)
                          .join(' / ')
                      })
                    : t('Analysis rules were not recorded for this version.')}
                </span>
              </TooltipTrigger>
              <TooltipContent className={tooltipClassName}>
                {t(
                  'Recorded when this Artifact Version was created. Later analysis updates do not change this verification evidence.'
                )}
              </TooltipContent>
            </PanelTooltip>
            <p className="min-w-0 text-xs text-text-300">
              {t(
                '{{included}} of {{total}} Notebook runs are required for this Artifact Version.',
                {
                  included: projection.includedNotebookRunCount,
                  total: projection.executionRunCount
                }
              )}
              {projection.skippedRunCount > 0
                ? ` ${t('{{skipped}} unrelated runs can be skipped.', {
                    skipped: projection.skippedRunCount
                  })}`
                : ''}
            </p>
          </div>
          <PanelTooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={
                  captureIssues.length > 0
                    ? `${statusLabel}: ${captureIssues.map((issue) => issue.label).join(', ')}`
                    : statusLabel
                }
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border-300/60 bg-bg-200/60 px-2.5 text-[11px] font-medium text-text-100 outline-none hover:bg-bg-300 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${
                    captureCompleteness === 'complete'
                      ? 'bg-status-info-foreground dark:bg-status-info-dark-foreground'
                      : 'bg-status-warning-foreground dark:bg-status-warning-dark-foreground'
                  }`}
                />
                {statusLabel}
                {captureIssues.length > 0 ? (
                  <span className="rounded-full bg-bg-000 px-1.5 tabular-nums text-text-200">
                    {captureIssues.length}
                  </span>
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="end"
              className={cn('max-w-80 px-3 py-2.5', tooltipClassName)}
            >
              {captureIssues.length > 0 ? (
                <div className="space-y-2.5">
                  <p className="font-medium">{t('Areas needing attention')}</p>
                  <ul className="space-y-2.5">
                    {captureIssues.map((issue) => (
                      <li key={issue.category} data-capture-issue={issue.category}>
                        <p className="font-medium leading-4">{issue.label}</p>
                        <p className="mt-0.5 leading-4 text-bg-000/75">{issue.description}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : environmentLockMissing || environmentLockPartial ? (
                t(
                  'The execution path was captured, but its environment lock is not ready for verification.'
                )
              ) : (
                t('The required execution path was captured.')
              )}
            </TooltipContent>
          </PanelTooltip>
        </div>
      </section>

      <section
        className="overflow-hidden rounded-lg border border-border-300/60 bg-bg-000"
        aria-labelledby="dependency-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && selectedNode) {
            event.preventDefault()
            event.stopPropagation()
            closeNodeDetails()
          }
        }}
      >
        <div
          data-dependency-header
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-300/50 px-4 py-3"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 id="dependency-title" className="font-semibold text-text-000">
                {t('Dependency')}
              </h3>
              {(projection.outputGroups?.length ?? 0) > 0 ? (
                <PanelTooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t(
                        'Logical outputs group related files and can be expanded for inspection.'
                      )}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-text-300 outline-none hover:bg-bg-200 hover:text-text-000 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      <Info aria-hidden="true" className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className={cn('max-w-72 px-3 py-2 leading-5', tooltipClassName)}
                  >
                    {t('Logical outputs group related files and can be expanded for inspection.')}
                  </TooltipContent>
                </PanelTooltip>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-text-200">{t('Select a node to view details.')}</p>
          </div>
          {additionalNodeCount > 0 ? (
            <div className="flex min-w-0">
              <div
                role="group"
                aria-label={t('Dependency')}
                className="inline-flex max-w-full flex-wrap rounded-md bg-bg-200 p-0.5"
              >
                <PanelTooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-graph-view="lineage"
                      aria-pressed={!showFullGraph}
                      className={`h-8 whitespace-nowrap px-2.5 text-xs [@media(pointer:coarse)]:h-11 ${
                        showFullGraph
                          ? 'text-text-200 hover:bg-bg-300 hover:text-text-000'
                          : 'bg-bg-000 text-text-000 shadow-sm hover:bg-bg-000'
                      }`}
                      onClick={() => setShowFullGraph(false)}
                    >
                      {t('Artifact lineage')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn('max-w-72 px-3 py-2 leading-5', tooltipClassName)}
                  >
                    {t('Show only work that contributed to this Artifact Version.')}
                  </TooltipContent>
                </PanelTooltip>
                <PanelTooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-graph-view="full"
                      aria-label={`${t('Full capture')}, ${t('{{count}} additional nodes', {
                        count: additionalNodeCount,
                        defaultValue_one: '{{count}} additional node'
                      })}`}
                      aria-pressed={showFullGraph}
                      className={`h-8 whitespace-nowrap px-2.5 text-xs [@media(pointer:coarse)]:h-11 ${
                        showFullGraph
                          ? 'bg-bg-000 text-text-000 shadow-sm hover:bg-bg-000'
                          : 'text-text-200 hover:bg-bg-300 hover:text-text-000'
                      }`}
                      onClick={() => setShowFullGraph(true)}
                    >
                      {t('Full capture')}
                      <span
                        className="rounded bg-bg-200 px-1 text-[10px] tabular-nums text-text-200"
                        aria-hidden="true"
                      >
                        {`+${additionalNodeCount}`}
                      </span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn('max-w-72 px-3 py-2 leading-5', tooltipClassName)}
                  >
                    {t(
                      'Show all captured dependency branches, including branches unrelated to this Artifact Version.'
                    )}
                  </TooltipContent>
                </PanelTooltip>
              </div>
            </div>
          ) : null}
        </div>

        <div data-dependency-canvas-frame className="relative min-w-0 overflow-hidden">
          {graph && display ? (
            <DependencyGraphCanvas
              graph={graph}
              display={display}
              markerId={markerId}
              graphViewportX={graphViewportX}
              graphViewportWidth={graphViewportWidth}
              graphCanvasHeight={graphCanvasHeight}
              graphViewportHeight={graphViewportHeight}
              positionedNodes={positionedNodes}
              activeNodeKeys={activeNodeKeys}
              emphasizedNodeKeys={emphasizedNodeKeys}
              emphasizedNodeKey={emphasizedNodeKey}
              effectiveSelectedNodeKey={effectiveSelectedNodeKey}
              targetEntityId={projection.targetEntityId}
              computeNumbers={computeNumbers}
              setHoveredNodeKey={setHoveredNodeKey}
              setFocusedNodeKey={setFocusedNodeKey}
              setSelectedNodeKey={setSelectedNodeKey}
            />
          ) : null}

          {selectedNode ? (
            <aside
              data-dependency-inspector="selected-node"
              className="max-h-[min(70vh,40rem)] overflow-auto border-t border-border-300/60 bg-bg-000 p-4"
              aria-label={t('Details')}
            >
              {selectedDetails}
            </aside>
          ) : null}
        </div>
      </section>
    </div>
  )
}
