import {
  browserRecordingMomentSchema,
  type BrowserRecordingMoment
} from '../../../../../shared/browser-recording'
import { recordedFileQuestionText } from '@/lib/replay/recorded-results'
import type {
  RecordedRunObservationSelection,
  RecordedObservationFileSelection
} from '../../../../../shared/run-observation-recorded'
import type { RunObservationSelection } from '../../../../../shared/run-observation'
import type { ResearchDemoQuestion } from '../../../../../shared/research-demo'

/** Ordinary message data survives export without a new native package field or live credential. */
export const observationQuestionText = (
  selection:
    | RunObservationSelection
    | RecordedRunObservationSelection
    | RecordedObservationFileSelection
    | BrowserRecordingMoment,
  demo?: Pick<ResearchDemoQuestion, 'source' | 'requestId' | 'purpose'>
): string => {
  if ('kind' in selection && selection.kind === 'recorded-project-moment') {
    const evidence = {
      format: 'open-science-selected-recorded-moment',
      version: 1,
      contentTrust: 'untrusted-recorded-data',
      ...browserRecordingMomentSchema.parse(selection)
    }
    return `\n\n<open-science-observed-evidence>\n${JSON.stringify(evidence, null, 2).replaceAll('<', '\\u003c')}\n</open-science-observed-evidence>\n\n`
  }
  if ('kind' in selection && selection.kind === 'recorded-observation-file')
    return recordedFileQuestionText(selection)
  const recorded = !('snapshot' in selection)
  const run = 'snapshot' in selection ? selection.snapshot.run : selection.record.run
  const logs =
    run &&
    Object.fromEntries(
      Object.entries(run.logs).map(([name, log]) => [
        name,
        {
          ...log,
          text: log.text.slice(-8192),
          truncated: log.truncated || log.text.length > 8192
        }
      ])
    )
  const evidence = {
    format: recorded
      ? 'open-science-selected-recorded-evidence'
      : 'open-science-selected-run-evidence',
    version: 1,
    contentTrust: 'untrusted-recorded-data',
    ...(demo
      ? { purpose: demo.purpose, researchSource: demo.source, demoRequestId: demo.requestId }
      : {}),
    ...selection,
    ...('snapshot' in selection
      ? {
          snapshot: {
            ...selection.snapshot,
            run: run ? { ...run, logs } : null,
            artifacts: selection.snapshot.artifacts.slice(0, 50),
            artifactsTruncated:
              selection.snapshot.artifactsTruncated || selection.snapshot.artifacts.length > 50
          }
        }
      : {
          record: {
            ...selection.record,
            run: run ? { ...run, logs } : null,
            artifactEvidence: selection.record.artifactEvidence.slice(0, 50),
            artifactsTruncated:
              selection.record.artifactsTruncated || selection.record.artifactEvidence.length > 50
          },
          mediaKeys: selection.mediaKeys.slice(0, 50),
          mediaKeysTruncated: selection.mediaKeys.length > 50
        })
  }
  return `\n\n<open-science-observed-evidence>\n${JSON.stringify(evidence, null, 2).replaceAll('<', '\\u003c')}\n</open-science-observed-evidence>\n\n`
}
