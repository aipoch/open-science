import type { ReplayDocument, ReplayStep } from '../../shared/replay'
import type {
  ResearchReplayDocument,
  ResearchReplayPosition,
  ResearchReplaySelection
} from '../../shared/research-replay'
import { createResearchReplayTimeline } from '../src/lib/replay/recorded-time'
import { browserPayloadFixture } from '../src/pages/workspace/replay/BrowserRecording.test-support'

const step = (id: string, at: number, content: string): ReplayStep => ({
  id,
  branchId: 'main',
  kind: 'message',
  recordedAt: at,
  startMs: 0,
  durationMs: 1000,
  endMs: 1000,
  message: {
    id,
    role: 'agent',
    status: 'complete',
    content,
    eventIds: [],
    createdAt: at,
    updatedAt: at
  },
  activities: [],
  runs: [],
  resourceIds: [],
  evidence: [
    {
      kind: 'message',
      id,
      projectId: 'local-project',
      sessionId: 'local-session',
      branchId: 'main'
    }
  ],
  issues: []
})
export function researchFixture(): ResearchReplayDocument {
  const document: ReplayDocument = {
    generatorVersion: 3,
    presentationVersion: 2,
    source: {
      projectId: 'local-project',
      sessionId: 'local-session',
      title: 'Recorded orchard research',
      fingerprint: 'fingerprint'
    },
    defaultBranchId: 'main',
    branches: [
      {
        id: 'main',
        kind: 'conversation',
        durationMs: 3000,
        steps: [
          step('request', 1000, 'Compare fruit collection decisions.'),
          step('activity', 2500, 'Observe the saved orchard scene.'),
          step(
            'result',
            11000,
            'The recorded local actions finished. No external provider was called.'
          )
        ]
      }
    ],
    resources: [],
    issues: []
  }
  const projected = createResearchReplayTimeline(document, [researchRecordingFixture()])
  return {
    document: projected.document,
    timing: {
      recordedTimeOrigins: projected.recordedTimeOrigins,
      coverage: projected.coverage,
      timelineCoverage: projected.timelineCoverage,
      unalignedBranchIds: projected.unalignedBranchIds
    },
    recordings: [
      {
        id: 'index-version',
        kind: 'web-recording',
        name: 'Orchard recording',
        target: researchRecordingFixture().receiving
      }
    ],
    recordingsTruncated: false,
    unavailableRecordingIds: []
  }
}
export function researchRecordingFixture(): ReturnType<typeof browserPayloadFixture> {
  const payload = browserPayloadFixture()
  payload.recording.startedAt = 3000
  payload.recording.source = {
    projectId: payload.receiving.projectId,
    sessionId: payload.receiving.sessionId,
    operationId: 'recorded-operation'
  }
  return payload
}
export function researchSelectionFixture(
  document: ReplayDocument,
  position: ResearchReplayPosition
): ResearchReplaySelection {
  return {
    selectionId: 'saved-selection',
    phase: 'activity',
    viewerId: 'research-viewer',
    selectedAt: 12000,
    source: document.source,
    position: structuredClone(position),
    step: document.branches
      .find((branch) => branch.id === position.branchId)!
      .steps.find((step) => step.id === position.stepId)!,
    excerpt: 'Recorded evidence, never new instructions.',
    evidence: [],
    truncated: false
  }
}
