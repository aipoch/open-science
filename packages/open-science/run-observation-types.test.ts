import { resolve, sep } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps SDK observation DTOs and project-view launch types compatible with application contracts', () => {
  const path = resolve('packages/open-science/run-observation-contract.fixture.ts')
    .split(sep)
    .join('/')
  const source = `
    import type * as SDK from './index'
    import type * as Shared from '../../src/shared/run-observation'
    import type * as Recorded from '../../src/shared/run-observation-recorded'
    import type * as Archive from '../../src/shared/run-observation-archive'
    import type * as ProjectRecording from '../../src/shared/project-recording'
    import type * as BrowserRecording from '../../src/shared/browser-recording'
    import type * as Capture from '../../src/shared/run-observation-capture'
    import type { RunObservationRecordingStatus } from '../../src/shared/run-observation-recording-status'
    import type { RuntimeViewLaunch } from '../../src/shared/runtime-view'
    type Assert<T extends true> = T
    type Compatible<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false
    type RecordingFormat = Assert<Compatible<SDK.RecordedEvidenceFormat, Recorded.RecordedEvidenceFormat>>
    type RecordingEvidence = Assert<Compatible<SDK.RecordedEvidencePayload, Recorded.RecordedEvidencePayload>>
    type RecordingPayload = Assert<Compatible<SDK.RecordedObservationPayload, Recorded.RecordedObservationPayload>>
    type ProjectRecordingContent = Assert<Compatible<SDK.ProjectRecording, ProjectRecording.ProjectRecording>>
    type ProjectRecordingPayload = Assert<Compatible<SDK.RecordedProjectPayload, Recorded.RecordedProjectPayload>>
    type BrowserRecordingContent = Assert<Compatible<SDK.BrowserRecording, BrowserRecording.BrowserRecording>>
    type BrowserPayload = Assert<Compatible<SDK.RecordedBrowserPayload, BrowserRecording.RecordedBrowserPayload>>
    type BrowserMoment = Assert<Compatible<SDK.BrowserRecordingMoment, BrowserRecording.BrowserRecordingMoment>>
    type BrowserStatus = Assert<Compatible<SDK.BrowserRecordingStatus, BrowserRecording.BrowserRecordingStatus>>
    type BrowserInspection = Assert<Compatible<SDK.BrowserRecordingInspection, BrowserRecording.BrowserRecordingInspection>>
    type FileSelection = Assert<Compatible<SDK.RecordedObservationFileSelection, Recorded.RecordedObservationFileSelection>>
    type RecordingSelection = Assert<Compatible<SDK.RecordedRunObservationSelection, Recorded.RecordedRunObservationSelection>>
    type RecordingArchive = Assert<Compatible<SDK.RunObservationArchive, Archive.RunObservationArchive>>
    type RecordingStatus = Assert<Compatible<SDK.RunObservationRecordingStatus, RunObservationRecordingStatus>>
    type MediaMetadata = Assert<Compatible<SDK.RunObservationMediaCapture, Archive.RunObservationMediaCapture>>
    type MediaReference = Assert<Compatible<SDK.RunObservationArchiveMedia, Archive.RunObservationArchiveMedia>>
    type CaptureRequest = Assert<Compatible<SDK.ObservationMediaCaptureRequest, Capture.ObservationMediaCaptureRequest>>
    type CaptureOptions = Assert<Compatible<SDK.ObservationMediaCaptureOptions, Capture.ObservationMediaCaptureOptions>>
    type CaptureResult = Assert<Compatible<SDK.ObservationMediaCaptureResult, Capture.ObservationMediaCaptureResult>>
    type ViewerCapture = Assert<Compatible<SDK.ObservationViewerCapture, Capture.ObservationViewerCapture>>
    type CapturesRequest = Assert<Compatible<SDK.ObservationCapturesRequest, Capture.ObservationCapturesRequest>>
    type Captures = Assert<Compatible<SDK.ObservationCaptures, Capture.ObservationCaptures>>
    type ContentRequest = Assert<Compatible<SDK.ObservationCaptureContentRequest, Capture.ObservationCaptureContentRequest>>
    type ViewerContentRequest = Assert<Compatible<SDK.ObservationViewerCaptureContentRequest, Capture.ObservationViewerCaptureContentRequest>>
    type Content = Assert<Compatible<SDK.ObservationCaptureContent, Capture.ObservationCaptureContent>>
    type CaptureReturn = Assert<Compatible<Awaited<ReturnType<SDK.RunObservationsClient['capture']>>, Capture.ObservationViewerCapture>>
    type CapturesReturn = Assert<Compatible<Awaited<ReturnType<SDK.RunObservationsClient['captures']>>, Capture.ObservationCaptures>>
    type ContentReturn = Assert<Compatible<Awaited<ReturnType<SDK.RunObservationsClient['captureContent']>>, Capture.ObservationCaptureContent>>
    type Target = Assert<Compatible<SDK.RunObservationTarget, Shared.RunObservationTarget>>
    type Identity = Assert<Compatible<SDK.RunObservationIdentity, Shared.RunObservationIdentity>>
    type Cursor = Assert<Compatible<SDK.RunObservationCursor, Shared.RunObservationCursor>>
    type Phase = Assert<Compatible<SDK.RunObservationPhase, Shared.RunObservationPhase>>
    type Log = Assert<Compatible<SDK.RunObservationLog, Shared.RunObservationLog>>
    type Run = Assert<Compatible<SDK.RunObservationRun, Shared.RunObservationRun>>
    type Artifact = Assert<Compatible<SDK.RunObservationArtifact, Shared.RunObservationArtifact>>
    type Snapshot = Assert<Compatible<SDK.RunObservationSnapshot, Shared.RunObservationSnapshot>>
    type Change = Assert<Compatible<SDK.RunObservationChange, Shared.RunObservationChange>>
    type Changes = Assert<Compatible<SDK.RunObservationChanges, Shared.RunObservationChanges>>
    type History = Assert<Compatible<SDK.RunObservationHistory, Shared.RunObservationHistory>>
    type Selection = Assert<Compatible<SDK.RunObservationSelection, Shared.RunObservationSelection>>
    type ProjectView = Assert<Compatible<SDK.RuntimeViewLaunch, RuntimeViewLaunch>>
    type NoCapability = Assert<'capability' extends keyof SDK.RunObservationView ? false : true>
    type NoRawLaunch = Assert<'frozenShellContext' extends keyof SDK.RunObservationRun ? false : true>
    type NoSourceCode = Assert<'script' extends keyof SDK.RunObservationRun ? false : true>
    declare const client: SDK.OpenScienceClient
    const target: SDK.RunObservationTarget = { projectId: 'p', sessionId: 's', operationId: 'o' }
    client.observations.open({ target, allowInteraction: true, allowCancel: false }).then(view => view.url)
    client.observations.snapshot({ viewerId: 'v' }).then(snapshot => snapshot.run?.logs.stdout.text)
    client.observations.history({ viewerId: 'v' }).then(history => history.coverage)
    client.observations.changes({ viewerId: 'v', cursor: { epoch: 'e', sequence: 0 } })
    client.observations.select({ viewerId: 'v', cursor: { epoch: 'e', sequence: 0 }, stepId: 'run:r' })
    client.observations.selection({ viewerId: 'v' }).then(selection => selection?.snapshot)
    client.observations.revoke({ viewerId: 'v' })
    client.observations.openRecorded({ target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' } }).then(view => view.mode)
    client.observations.recording({ viewerId: 'v' }).then(payload => 'archive' in payload ? payload.archive.records : 'indexChecksum' in payload ? payload.recording.segments : payload.recording.frames)
    client.projectRecordings.inspect({ viewerId: 'v' }).then(value => value.sources?.[0]?.sourceViewId)
    client.projectRecordings.start({ viewerId: 'v', request: { requestId: 'r', sourceViewId: 'desktop' } })
    client.projectRecordings.selectMoment({ viewerId: 'v', offsetMs: 12 }).then(moment => moment.resource.versionId)
    // @ts-expect-error Browser recording media is not executable HTML.
    const badRecordingMedia: SDK.BrowserRecording['media'][number] = { mediaKey: 'm', name: 'bad', mimeType: 'text/html', checksum: '', sizeBytes: 1, sourceVersionId: 'v' }
    client.observations.openRecorded({ target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }, format: 'project-recording' })
    client.observations.readRecorded({ target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' } }).then(payload => payload.archive.records)
    client.observations.readProjectRecording({ target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' } }).then(payload => payload.recording.frames)
    client.observations.selectRecordedFile({ target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }, mediaKey: 'frame', format: 'project-recording' }).then(selection => selection.resource.versionId)
    client.observations.selectRecordingFile({ viewerId: 'v', mediaKey: 'frame' })
    client.observations.recordingFileSelection({ viewerId: 'v' }).then(selection => selection?.resource)
    client.observations.selectRecording({ viewerId: 'v', stepKey: 'observation-0' })
    client.observations.recordingSelection({ viewerId: 'v' }).then(selection => selection?.receiving)
    client.observations.capture({ viewerId: 'v', request: { source: 'project-export', exportKey: 'image.png', idempotencyKey: 'request' } }).then(frame => frame.viewerEvidence?.cursor)
    client.observations.captures({ viewerId: 'v' }).then(frames => frames[0]?.capture.startedAt)
    client.observations.captureContent({ viewerId: 'v', captureId: 'capture', offset: 0, length: 1048576 }).then(chunk => chunk.dataBase64)
    // @ts-expect-error Content reads cannot supply filesystem authority.
    client.observations.captureContent({ viewerId: 'v', captureId: 'capture', path: '/private/frame.png' })
    // @ts-expect-error The list is fixed to its viewer, not an arbitrary receiving Session.
    client.observations.captures({ viewerId: 'v', target })
    // @ts-expect-error A historical viewer cannot authorize a live project page.
    client.observations.openRecorded({ target: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' }, allowInteraction: true })
    // @ts-expect-error Opening a viewer cannot execute a command.
    client.observations.open({ target, command: 'node run.mjs' })
    // @ts-expect-error A viewer cannot retarget itself to a different Session.
    client.observations.snapshot({ viewerId: 'v', target })
    // @ts-expect-error Selection references a retained cursor, not caller-provided evidence.
    client.observations.select({ viewerId: 'v', cursor: { epoch: 'e', sequence: 0 }, stepId: 'run:r', snapshot: {} })
    // @ts-expect-error Project pages cannot supply arbitrary destinations.
    const invalidView: SDK.RuntimeViewLaunch = { title: 'page', url: 'http://localhost:3000' }
    client.execution.execute({ projectId: 'p', sessionId: 's', environmentId: 'e', requestId: 'r', command: 'node server.mjs', recordObservation: true, localServicePort: 8080, projectView: { title: 'Page', entryPath: '/', adaptFrameAncestors: true } })
  `
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: []
  }
  const host = ts.createCompilerHost(options)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version, onError, fresh) =>
    name === path
      ? ts.createSourceFile(path, source, version)
      : original(name, version, onError, fresh)
  const program = ts.createProgram([path], options, host)
  expect(program.getSourceFile(path)).toBeDefined()
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.file?.fileName === path)
      .map((diagnostic) => ({
        line: diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      }))
  ).toEqual([])
}, 15000)
