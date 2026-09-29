import type {
  ReplayDocument,
  ReplayEvidenceReference,
  ReplayScene,
  ReplayNotebookRunDetails
} from '../../../../../shared/replay'
import type { ReplayResourceMap } from './replay-resources'
import { replayText, replayNotebookText, replayToolOutputs } from './replay-content'
import { REPLAY_ACTIVITY_LIMIT, REPLAY_TRANSCRIPT_STEP_LIMIT } from '@/lib/replay/scene'

export type ReplayStepContext = {
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

export const captureReplayStepContext = (
  document: ReplayDocument,
  scene: ReplayScene,
  runDetails: Readonly<Record<string, ReplayNotebookRunDetails>> = {},
  resources: ReplayResourceMap = {}
): ReplayStepContext => {
  const step = scene.step
  if (!step) throw new Error('Replay step unavailable')
  return {
    projectId: document.source.projectId,
    sourceSessionId: document.source.sessionId,
    sourceTitle: document.source.title,
    fingerprint: document.source.fingerprint,
    branchId: step.branchId,
    stepId: step.id,
    stepOffsetMs: Math.max(0, scene.positionMs - step.startMs),
    recordedAt: step.recordedAt,
    evidence: structuredClone(scene.visibleEvidence),
    excerpt: [
      step.message?.content.slice(0, scene.messageCharacters).slice(0, 480),
      ...step.activities
        .slice(0, REPLAY_ACTIVITY_LIMIT)
        .flatMap((activity) => [
          activity.title,
          replayText(activity.rawInput).slice(0, 240),
          activity.elicitation?.message.slice(0, 240),
          ...(scene.showResults
            ? [
                ...replayToolOutputs(activity).map((output) => output.text.slice(0, 240)),
                replayText(
                  activity.elicitation?.answers ?? activity.elicitation?.draftAnswers
                ).slice(0, 240),
                activity.toolDisposition,
                activity.terminalExitCode === undefined ? '' : String(activity.terminalExitCode)
              ]
            : [])
        ]),
      ...scene.visibleEvidence
        .filter((reference) => reference.kind === 'notebook-run')
        .flatMap((reference) => {
          const detail = runDetails[reference.id]
          if (detail?.status !== 'ready') return []
          return [
            detail.run.script.slice(0, 360),
            reference.part === 'input'
              ? ''
              : replayNotebookText(detail.run).join('\n').slice(0, 360)
          ]
        }),
      ...scene.visibleEvidence
        .filter(
          (reference) =>
            reference.kind === 'artifact-version' || reference.kind === 'upload-version'
        )
        .flatMap((reference) => {
          const resource = document.resources.find(
            (candidate) =>
              candidate.id === reference.id ||
              (reference.versionId && candidate.versionId === reference.versionId)
          )
          if (!resource) return []
          const prepared = resources[resource.id]
          return [
            resource.name,
            prepared?.status === 'ready' && prepared.kind !== 'image'
              ? prepared.content.slice(0, 360)
              : ''
          ]
        }),
      ...scene.visibleSteps
        .slice(-REPLAY_TRANSCRIPT_STEP_LIMIT)
        .filter((previous) => previous.id !== step.id)
        .flatMap((previous) => [
          previous.message?.content.slice(0, 240),
          ...previous.activities
            .slice(0, REPLAY_ACTIVITY_LIMIT)
            .flatMap((activity) => [
              activity.title,
              replayText(activity.rawInput).slice(0, 160),
              ...replayToolOutputs(activity).map((output) => output.text.slice(0, 160))
            ])
        ])
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1800)
  }
}

export const REPLAY_SEEK_EVENT = 'open-science:replay-seek'
export type ReplaySeekTarget = Pick<
  ReplayStepContext,
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
