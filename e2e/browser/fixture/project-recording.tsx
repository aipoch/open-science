import '@/assets/main.css'
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { ProjectReplay } from '@/pages/workspace/replay/ProjectReplay'
import { ResultsPanel } from '@/pages/workspace/replay/results/ResultsPanel'
import { recordedMediaResource, recordedResults } from '@/lib/replay/recorded-results'
import { projectRecordingToTrack } from '../../../src/shared/project-recording'
import {
  recordedFileSelectionForPayload,
  recordedProjectPayloadSchema,
  type RecordedObservationFileSelection,
  type RecordedProjectPayload
} from '../../../src/shared/run-observation-recorded'
import { ReplayViewerClient } from '../../../src/renderer/replay-viewer/client'

// This page deliberately creates no Notebook, Run, environment or service. All executable
// boundaries fail closed; the production reader still validates immutable media references.
const forbidden: string[] = []
const methods = (path: string[]): unknown =>
  new Proxy(() => undefined, {
    get: (_target, property) => methods([...path, String(property)]),
    apply: () => {
      forbidden.push(path.join('.'))
      throw Error('Unexpected runtime call')
    }
  })
window.api = methods([]) as typeof window.api
const statistics = { requests: [] as string[], forbidden }
Object.assign(window, { projectRecordingStatistics: statistics })

const html = `<div id="passthrough" data-preview-context-menu-passthrough style="min-height:500px"><h1>Saved result</h1>
<p>Static project report</p>
<a id="external-link" href="https://untrusted.invalid/navigation">External link</a>
<img src="https://untrusted.invalid/image" onerror="parent.postMessage('executed','*')">
<style>body { font-family: sans-serif; } #passthrough { min-height: 60px; }
body { background-image:url(https://untrusted.invalid/style); }</style>
<script>parent.postMessage('executed','*');fetch('https://untrusted.invalid/script')</script></div>`
const textFiles = [
  { mediaKey: 'report', name: 'final.html', mimeType: 'text/html', text: html },
  { mediaKey: 'data', name: 'values.csv', mimeType: 'text/csv', text: 'trial,value\n1,42\n' },
  { mediaKey: 'summary', name: 'summary.json', mimeType: 'application/json', text: '{"value":42}' }
]
const bytesByVersion = new Map<string, { bytes: Uint8Array; mimeType: string }>()
const hash = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
const makePayload = async (revision: string): Promise<RecordedProjectPayload> => {
  const images = ['one', 'two'].map((mediaKey, index) => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')!
    context.fillStyle = revision === 'a' ? '#065f46' : '#1e40af'
    context.fillRect(0, 0, 320, 180)
    context.fillStyle = 'white'
    context.font = '24px sans-serif'
    context.fillText(`${revision}: frame ${index + 1}`, 24, 95)
    const encoded = canvas.toDataURL('image/png').split(',')[1]
    return {
      mediaKey,
      name: `${mediaKey}.png`,
      mimeType: 'image/png',
      bytes: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    }
  })
  const files = [
    ...images,
    ...textFiles.map(({ text, ...item }) => ({ ...item, bytes: new TextEncoder().encode(text) }))
  ]
  const media = await Promise.all(
    files.map(async (file) => {
      const versionId = `${revision}-${file.mediaKey}-version`
      bytesByVersion.set(versionId, file)
      return {
        mediaKey: file.mediaKey,
        name: file.name,
        mimeType: file.mimeType,
        checksum: await hash(file.bytes),
        sizeBytes: file.bytes.byteLength,
        sourceVersionId: `author-${file.mediaKey}`
      }
    })
  )
  return recordedProjectPayloadSchema.parse({
    receiving: {
      projectId: `receiver-${revision}`,
      sessionId: `session-${revision}`,
      artifactId: `index-${revision}`,
      versionId: `index-${revision}-version`
    },
    recording: {
      format: 'open-science-project-recording',
      version: 1,
      recordingId: 'same-recording',
      startedAt: 100,
      endedAt: 300,
      media,
      frames: images.map((item, index) => ({
        frameId: `frame-${index}`,
        sequence: index,
        recordedAt: 100 + index * 100,
        mediaKey: item.mediaKey,
        provenance: {
          kind: 'capture',
          source: 'project-export',
          startedAt: 100,
          finishedAt: 100 + index * 100,
          width: 320,
          height: 180
        }
      })),
      states: [],
      events: [],
      coverage: {
        kind: 'sampled-project-recording',
        stopReason: 'finished',
        failures: 0,
        unchangedSamples: 0,
        droppedSamples: 0,
        missingMediaKeys: []
      }
    },
    media: media.map((item) => ({
      mediaKey: item.mediaKey,
      artifactId: `${revision}-${item.mediaKey}`,
      versionId: `${revision}-${item.mediaKey}-version`,
      checksum: item.checksum,
      sizeBytes: item.sizeBytes
    }))
  })
}
export const App = ({ payloads }: { payloads: RecordedProjectPayload[] }): React.JSX.Element => {
  const [revision, setRevision] = useState(0)
  const [showProject, setShowProject] = useState(true)
  const [selected, setSelected] = useState<RecordedObservationFileSelection>()
  const payload = payloads[revision]
  const track = useMemo(() => projectRecordingToTrack(payload.recording), [payload])
  const client = useMemo(
    () =>
      new ReplayViewerClient(async (input, init) => {
        const url = new URL(String(input), 'http://fixture.invalid')
        statistics.requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
        if (url.pathname === '/api/recording/file-selection' && init?.method === 'POST') {
          const { mediaKey } = JSON.parse(String(init.body))
          return new Response(
            JSON.stringify({
              ...recordedFileSelectionForPayload(payload, mediaKey),
              selectionId: 'selection',
              selectedAt: 400
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.pathname !== '/api/recording/media') throw Error('Unexpected endpoint')
        const resolved = payload.media.find(
          (item) => item.mediaKey === url.searchParams.get('mediaKey')
        )
        const file = resolved && bytesByVersion.get(resolved.versionId)
        if (!file) return new Response(null, { status: 404 })
        return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
          headers: { 'content-type': file.mimeType }
        })
      }),
    [payload]
  )
  const read = useMemo(
    () => (resource: Parameters<typeof client.recordedMedia>[1], signal?: AbortSignal) =>
      client.recordedMedia(payload, resource, signal),
    [payload, client]
  )
  const readImage = useMemo(
    () =>
      async (key: string, signal: AbortSignal): Promise<string | null> => {
        // Exercise a delayed replacement with identical recording and frame IDs.
        if (revision) await new Promise((resolve) => setTimeout(resolve, 600))
        const result = await read(recordedMediaResource(payload, key), signal)
        return `data:${result.mimeType};base64,${result.content}`
      },
    [read, payload, revision]
  )
  return (
    <main style={{ padding: 16 }}>
      <button onClick={() => setRevision((value) => 1 - value)}>Switch receiving source</button>
      <button onClick={() => setShowProject((value) => !value)}>Toggle project module</button>
      <output data-testid="receiving-source">{payload.receiving.projectId}</output>
      <div style={{ display: 'flex', height: 650, gap: 16 }}>
        {showProject ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ProjectReplay track={track} readImage={readImage} />
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ResultsPanel
            entries={recordedResults(payload)}
            read={read}
            onAskFile={async (entry) =>
              setSelected(await client.selectRecordingFile(payload, entry.mediaKey!))
            }
          />
        </div>
      </div>
      <output data-testid="file-reference">{selected ? JSON.stringify(selected) : ''}</output>
    </main>
  )
}
initI18n('en')
void Promise.all([makePayload('a'), makePayload('b')]).then((payloads) =>
  createRoot(document.getElementById('root')!).render(<App payloads={payloads} />)
)
