import { describe, expect, it } from 'vitest'
import { createArtifactVersionLocator } from '../../../../../shared/artifact-provenance'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import {
  isRecordedObservationContent,
  recordedObservationTargetForFile
} from './recorded-file-entry'
const item: PreviewFileItem = {
  id: 'file',
  type: 'file',
  projectId: 'project',
  sessionId: 'current',
  title: 'renamed.json',
  name: 'renamed.json',
  source: 'artifact',
  format: 'json',
  artifactId: 'artifact',
  selectedVersionId: 'version',
  path: createArtifactVersionLocator({
    projectId: 'project',
    appSessionId: 'source-session',
    artifactId: 'artifact',
    versionId: 'version'
  })
}
describe('recorded Artifact preview discovery', () => {
  it('recognizes content without relying on a replay filename or granting access', () => {
    expect(
      isRecordedObservationContent('{"version":1,"format":"open-science-run-observation"}', true)
    ).toBe(true)
    expect(
      isRecordedObservationContent(
        '{"format":"open-science-run-observation","version":1,"records":[',
        false
      )
    ).toBe(true)
    expect(
      isRecordedObservationContent('{"other":{"format":"open-science-run-observation"}}', true)
    ).toBe(false)
    expect(isRecordedObservationContent('{"format":"other","version":1}', true)).toBe(false)
  })
  it('pins the receiving immutable Artifact and rejects path/Version/scope mismatches', () => {
    expect(recordedObservationTargetForFile(item)).toEqual({
      projectId: 'project',
      sessionId: 'source-session',
      artifactId: 'artifact',
      versionId: 'version'
    })
    expect(recordedObservationTargetForFile({ ...item, source: 'local' })).toBeUndefined()
    expect(
      recordedObservationTargetForFile({ ...item, selectedVersionId: undefined })
    ).toBeUndefined()
    expect(
      recordedObservationTargetForFile({ ...item, selectedVersionId: 'newer' })
    ).toBeUndefined()
    expect(recordedObservationTargetForFile({ ...item, projectId: 'foreign' })).toBeUndefined()
  })
})
