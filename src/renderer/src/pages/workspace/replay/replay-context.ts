import { presentReviewSubmission } from '@/lib/reviewer-submission-presentation'
import type {
  ReplayDocument,
  ReplayEvidenceReference,
  ReplayScene,
  ReplayNotebookRunDetails
} from '../../../../../shared/replay'
import type { ReplayResourceMap } from './replay-resources'
import { replayText, replayNotebookText, replayToolOutputs } from './replay-content'
import { REPLAY_ACTIVITY_LIMIT } from '@/lib/replay/scene'
import { projectReplayScene } from '@/lib/replay/scene'
import {
  projectReplayNotebookInspection,
  projectReplayStepInspection
} from '@/lib/replay/inspection'

import {
  REPLAY_CAPTURE_RECORD_LIMIT,
  REPLAY_CAPTURE_TOTAL_LIMIT,
  type ReplayCapturedRecord,
  type SessionDiscussionSnapshot
} from '../../../../../shared/session-replay'

export type SessionDiscussionCapture = {
  scope?: 'step' | 'session'
  notebookInspection?: { runId: string; timeMs: number }
  stepInspection?: { timeMs: number; mode: 'visible' | 'saved-history' }
  phase?: ReplayScene['phase']
  stepTitle?: string
  branchIndex?: number
  stepNumber?: number
  records?: ReplayCapturedRecord[]
  projectId: string
  sourceSessionId: string
  sourceTitle: string
  fingerprint: string
  branchId: string
  stepId: string
  stepOffsetMs: number
  recordedAt?: number
  evidence: ReplayEvidenceReference[]
  excerpt: string
}

export const captureDiscussionSession = (
  document: ReplayDocument
): SessionDiscussionCapture | undefined => {
  const branch =
    document.branches.find((item) => item.id === document.defaultBranchId && item.steps.length) ??
    document.branches.find((item) => item.steps.length)
  if (!branch) return undefined
  const context = captureDiscussionStep(
    document,
    projectReplayScene(document, branch.id, branch.steps[0].startMs)
  )
  return { ...context, scope: 'session', stepTitle: undefined, stepNumber: undefined }
}

export const captureDiscussionStep = (
  document: ReplayDocument,
  scene: ReplayScene,
  runDetails: Readonly<Record<string, ReplayNotebookRunDetails>> = {},
  resources: ReplayResourceMap = {}
): SessionDiscussionCapture => {
  const step = scene.step
  if (!step) throw new Error('Replay step unavailable')
  const records: ReplayCapturedRecord[] = []
  let remaining = REPLAY_CAPTURE_TOTAL_LIMIT
  const add = (
    id: string,
    scope: 'step' | 'background',
    title: string,
    text: string,
    available = true,
    sourceTruncated = false
  ): void => {
    const limit = Math.min(REPLAY_CAPTURE_RECORD_LIMIT, remaining)
    const captured = text.slice(0, limit)
    remaining -= captured.length
    records.push({
      id,
      scope,
      title: title.slice(0, 240),
      text: captured,
      status: available ? 'recorded' : 'unavailable',
      truncated: sourceTruncated || text.length > captured.length
    })
  }
  const activityText = (activity: (typeof step.activities)[number], results: boolean): string =>
    [
      activity.title,
      replayText(activity.rawInput),
      activity.elicitation?.message,
      ...(results
        ? [
            ...replayToolOutputs(activity).map((output) => output.text),
            replayText(activity.elicitation?.answers),
            activity.elicitation?.draftAnswers?.length
              ? `Unsubmitted draft: ${replayText(activity.elicitation.draftAnswers)}`
              : '',
            activity.toolDisposition,
            activity.terminalExitCode === undefined ? '' : `Exit code: ${activity.terminalExitCode}`
          ]
        : [])
    ]
      .filter(Boolean)
      .join('\n')
  const stepText = [
    step.message?.content.slice(0, scene.messageCharacters),
    ...step.activities
      .slice(0, REPLAY_ACTIVITY_LIMIT)
      .map((activity) => activityText(activity, scene.showResults)),
    ...(scene.showResults && step.review
      ? [
          step.review.lifecycle,
          step.review.outcome,
          ...presentReviewSubmission(step.review).map(
            (check) => `${check.status}: ${check.claim} — ${check.evidence}`
          )
        ]
      : [])
  ]
    .filter(Boolean)
    .join('\n')
  const stepTitle = (step.title || step.message?.content || step.kind)
    .replace(/[\r\n]/g, ' ')
    .slice(0, 240)
  add('step', 'step', stepTitle, stepText)
  // Quote only the selected step; material retained on screen from earlier steps is navigation state.
  const belongsToStep = (reference: ReplayEvidenceReference): boolean =>
    step.evidence.some((item) => item.kind === reference.kind && item.id === reference.id) ||
    (reference.kind === 'notebook-run' && step.runs.some((run) => run.runId === reference.id)) ||
    step.resourceIds.includes(reference.id)
  const material = scene.visibleEvidence.filter((reference) =>
    ['notebook-run', 'artifact-version', 'upload-version'].includes(reference.kind)
  )
  for (const reference of material.filter(belongsToStep)) {
    const id = `${reference.kind}:${reference.id}`
    if (records.some((record) => record.id === id)) continue
    if (reference.kind === 'notebook-run') {
      const detail = runDetails[reference.id]
      const run = detail?.status === 'ready' ? detail.run : undefined
      add(
        id,
        'step',
        `Notebook · ${run?.kernelKind ?? reference.id}`,
        run
          ? [run.script, ...(reference.part === 'input' ? [] : replayNotebookText(run))].join('\n')
          : '',
        Boolean(run),
        reference.part !== 'input' && Boolean(run?.truncated)
      )
    } else {
      const resource = document.resources.find(
        (candidate) =>
          candidate.id === reference.id ||
          (reference.versionId && candidate.versionId === reference.versionId)
      )
      const prepared = resource && resources[resource.id]
      const text = prepared?.status === 'ready' && prepared.kind !== 'image' ? prepared.content : ''
      add(
        id,
        'step',
        resource?.name ?? reference.id,
        [resource?.name, reference.versionId ? `Version: ${reference.versionId}` : '', text]
          .filter(Boolean)
          .join('\n'),
        prepared?.status === 'ready' && prepared.kind !== 'image',
        prepared?.status === 'ready' && prepared.truncated
      )
    }
  }
  return {
    projectId: document.source.projectId,
    sourceSessionId: document.source.sessionId,
    sourceTitle: document.source.title,
    fingerprint: document.source.fingerprint,
    branchId: step.branchId,
    branchIndex: document.branches.findIndex((branch) => branch.id === step.branchId),
    stepId: step.id,
    stepOffsetMs: Math.max(0, scene.positionMs - step.startMs),
    recordedAt: step.recordedAt,
    evidence: structuredClone(scene.visibleEvidence.filter(belongsToStep)),
    stepTitle,
    stepNumber: scene.stepIndex + 1,
    phase: scene.phase,
    records,
    excerpt: records
      .filter((record) => record.scope === 'step')
      .map((record) => record.text)
      .join('\n')
      .slice(0, 1800)
  }
}

export const captureDiscussionInspectedStep = (
  document: ReplayDocument,
  scene: ReplayScene,
  stepId: string,
  savedHistory = false,
  recordedTimeOrigin?: number,
  runDetails: Readonly<Record<string, ReplayNotebookRunDetails>> = {},
  resources: ReplayResourceMap = {}
): SessionDiscussionCapture | undefined => {
  const inspected = projectReplayStepInspection(
    document,
    scene.branchId,
    stepId,
    scene.positionMs,
    recordedTimeOrigin,
    savedHistory
  )
  if (!inspected) return undefined
  return {
    ...captureDiscussionStep(document, inspected, runDetails, resources),
    stepInspection: { timeMs: scene.positionMs, mode: savedHistory ? 'saved-history' : 'visible' },
    ...(recordedTimeOrigin === undefined
      ? {}
      : { recordedAt: recordedTimeOrigin + scene.positionMs })
  }
}

/** Capture the inspected cell, including only output visible at the current clock. */
export const captureDiscussionNotebookRun = (
  document: ReplayDocument,
  scene: ReplayScene,
  stepId: string,
  runId: string,
  recordedTimeOrigin?: number,
  runDetails: Readonly<Record<string, ReplayNotebookRunDetails>> = {},
  resources: ReplayResourceMap = {}
): SessionDiscussionCapture | undefined => {
  const inspected = projectReplayNotebookInspection(
    document,
    scene.branchId,
    stepId,
    runId,
    scene.positionMs,
    recordedTimeOrigin
  )
  if (!inspected) return undefined
  return {
    ...captureDiscussionStep(document, inspected, runDetails, resources),
    notebookInspection: { runId, timeMs: scene.positionMs },
    ...(recordedTimeOrigin === undefined
      ? {}
      : { recordedAt: recordedTimeOrigin + scene.positionMs })
  }
}

/** View-only inspection hints never change the persisted discussion/package schema. */
export const toSessionDiscussionSnapshot = (
  context: SessionDiscussionCapture,
  id: string
): SessionDiscussionSnapshot => {
  const captured = structuredClone(context)
  delete captured.notebookInspection
  delete captured.stepInspection
  return { ...captured, id }
}

export const REPLAY_SEEK_EVENT = 'open-science:replay-seek'
export type ReplaySeekTarget = Pick<
  SessionDiscussionCapture,
  'projectId' | 'sourceSessionId' | 'branchId' | 'stepId'
> & { stepOffsetMs?: number }

// Navigation may mount the panel after the click. Keep only the most recent target per source.
const pendingSeeks = new Map<string, ReplaySeekTarget>()
const sourceKey = (projectId: string, sessionId: string): string =>
  JSON.stringify([projectId, sessionId])
export const consumeReplaySeek = (
  projectId: string,
  sessionId: string
): ReplaySeekTarget | undefined => {
  const key = sourceKey(projectId, sessionId)
  const target = pendingSeeks.get(key)
  pendingSeeks.delete(key)
  return target
}

export const requestReplaySeek = (target: ReplaySeekTarget): void => {
  const copy = structuredClone(target)
  const key = sourceKey(target.projectId, target.sourceSessionId)
  pendingSeeks.delete(key)
  pendingSeeks.set(key, copy)
  if (pendingSeeks.size > 32) pendingSeeks.delete(pendingSeeks.keys().next().value!)
  window.dispatchEvent(new CustomEvent<ReplaySeekTarget>(REPLAY_SEEK_EVENT, { detail: copy }))
}

export const subscribeReplaySeek = (listener: (target: ReplaySeekTarget) => void): (() => void) => {
  const receive = (event: Event): void => {
    const target = (event as CustomEvent<ReplaySeekTarget>).detail
    if (
      !target ||
      !['projectId', 'sourceSessionId', 'branchId', 'stepId'].every(
        (key) => typeof target[key as keyof ReplaySeekTarget] === 'string'
      )
    )
      return
    listener(target)
  }
  window.addEventListener(REPLAY_SEEK_EVENT, receive)
  return () => window.removeEventListener(REPLAY_SEEK_EVENT, receive)
}
