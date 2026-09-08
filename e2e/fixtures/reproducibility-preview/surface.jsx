import { forwardRef, useImperativeHandle } from 'react'
import { ArtifactReproducibilityPanel } from '../../../src/renderer/src/pages/workspace/ArtifactReproducibilityPanel'

// Only the file/backend boundary is replaced. The dialog, focus scope, panel, form,
// tooltips, selects and CSS are production components; no scientific files are read.
const projection = {
  completeness: 'complete',
  reasonCodes: [],
  targetEntityId: 'output',
  activities: [1, 2].map((n) => ({
    activityId: `run-${n}`,
    kind: 'notebook-run',
    sequence: n - 1,
    runIndex: n - 1,
    inclusion: 'target-closure',
    evidenceState: 'available'
  })),
  entities: [
    {
      entityId: 'output',
      kind: 'artifact-version',
      label: 'result.csv',
      checksum: 'a'.repeat(64),
      sizeBytes: 20
    }
  ],
  edges: [
    {
      kind: 'generated',
      activityId: 'run-2',
      entityId: 'output',
      authority: 'authoritative',
      evidenceSource: 'runtime-observation'
    }
  ],
  outputGroups: [],
  startFrontiers: [
    {
      frontierId: 'original-inputs',
      kind: 'original-inputs',
      claimScope: 'end-to-end',
      eligibility: 'available',
      crossingEntityIds: [],
      downstreamActivityIds: ['run-1', 'run-2'],
      reasonCodes: []
    },
    {
      frontierId: 'checkpoint:run-1',
      kind: 'checkpoint',
      claimScope: 'downstream-only',
      eligibility: 'available',
      afterActivityId: 'run-1',
      crossingEntityIds: [],
      downstreamActivityIds: ['run-2'],
      reasonCodes: []
    }
  ],
  executionRunCount: 2,
  includedNotebookRunCount: 2,
  skippedRunCount: 0
}

export const PreviewFileSurface = forwardRef(function Surface({ tooltipClassName }, ref) {
  useImperativeHandle(ref, () => ({
    requestLeave(action) {
      action()
      return true
    }
  }))
  return (
    <div className="min-w-0 w-full overflow-auto p-4 @container">
      <ArtifactReproducibilityPanel projection={projection} tooltipClassName={tooltipClassName} />
    </div>
  )
})
