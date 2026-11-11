import { presentReviewSubmission } from '@/lib/reviewer-submission-presentation'
import type {
  ReplayDocument,
  ReplayEvidenceReference,
  ReplayScene,
  ReplayNotebookRunDetails
} from '../../../../../shared/replay'
import type { ReplayResourceMap } from './replay-resources'
import { replayExcerpt, replayText, replayNotebookText, replayToolOutputs } from './replay-content'
import { REPLAY_ACTIVITY_LIMIT } from '@/lib/replay/scene'
import { projectReplayScene } from '@/lib/replay/scene'

import {
  REPLAY_CAPTURE_RECORD_LIMIT,
  REPLAY_CAPTURE_TOTAL_LIMIT,
  type ReplayCapturedRecord
} from '../../../../../shared/session-replay'

type TemporaryDiscussionInspection = {
  notebookInspection?: unknown
  stepInspection?: unknown
}

export type SessionDiscussionCapture = {
  scope?: 'step' | 'session'
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

// Replay inspection state belongs to the mounted renderer only. Keep it out of the persisted
// snapshot contract even when a caller forwards a capture object with temporary fields attached.
export const persistedDiscussionCapture = (
  capture: SessionDiscussionCapture & TemporaryDiscussionInspection
): SessionDiscussionCapture => {
  const persisted = structuredClone(capture)
  delete persisted.notebookInspection
  delete persisted.stepInspection
  return persisted
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
  resources: ReplayResourceMap = {},
  selectedRun?: { id: string; title: string }
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
  const stepTitle =
    selectedRun?.title ??
    (step.title || step.message?.content || step.kind).replace(/[\r\n]/g, ' ').slice(0, 240)
  if (!selectedRun) {
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
    add('step', 'step', stepTitle, stepText)
  }
  // Quote only the selected step; material retained on screen from earlier steps is navigation state.
  const belongsToStep = (reference: ReplayEvidenceReference): boolean =>
    step.evidence.some((item) => item.kind === reference.kind && item.id === reference.id) ||
    (reference.kind === 'notebook-run' && step.runs.some((run) => run.runId === reference.id)) ||
    step.resourceIds.includes(reference.id)
  const evidence: ReplayEvidenceReference[] = selectedRun
    ? step.evidence
        .filter((ref) => ref.kind === 'notebook-run' && ref.id === selectedRun.id)
        .map((ref) => ({ ...ref, part: scene.showResults ? 'record' : 'input' }))
    : scene.visibleEvidence.filter(belongsToStep)
  const material = evidence.filter((reference) =>
    ['notebook-run', 'artifact-version', 'upload-version'].includes(reference.kind)
  )
  for (const reference of material) {
    const id = `${reference.kind}:${reference.id}`
    if (records.some((record) => record.id === id)) continue
    if (reference.kind === 'notebook-run') {
      const detail = runDetails[reference.id]
      const run = detail?.status === 'ready' ? detail.run : undefined
      const output = run && reference.part !== 'input' ? replayNotebookText(run) : []
      const parts = run ? [run.script, ...(selectedRun ? output.slice(0, 12) : output)] : []
      const quoted = selectedRun ? parts.map((part) => replayExcerpt(part)) : parts
      add(
        id,
        'step',
        selectedRun?.title ?? `Notebook (${run?.kernelKind ?? reference.id})`,
        quoted.join('\n'),
        Boolean(run),
        (reference.part !== 'input' && Boolean(run?.truncated)) ||
          Boolean(
            selectedRun && (output.length > 12 || quoted.some((part, i) => part !== parts[i]))
          )
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
    evidence: structuredClone(evidence),
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

export const REPLAY_SEEK_EVENT = 'open-science:replay-seek'
export type ReplaySeekTarget = Pick<
  SessionDiscussionCapture,
  'projectId' | 'sourceSessionId' | 'branchId' | 'stepId'
> & { stepOffsetMs?: number; runId?: string }

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

export const requestReplaySeek = (
  target: ReplaySeekTarget & Partial<Pick<SessionDiscussionCapture, 'evidence' | 'records'>>
): void => {
  // Whole-step snapshots also include a 'step' record, even for standalone Notebook steps.
  const run = target.evidence?.length === 1 ? target.evidence[0] : undefined
  const runId =
    run?.kind === 'notebook-run' &&
    target.records?.length === 1 &&
    target.records[0].id === `notebook-run:${run.id}`
      ? run.id
      : undefined
  const { projectId, sourceSessionId, branchId, stepId, stepOffsetMs } = target
  const copy = { projectId, sourceSessionId, branchId, stepId, stepOffsetMs, runId }
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
