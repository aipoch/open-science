import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { readFile, writeFile, mkdtemp, realpath, chmod, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import { it } from 'vitest'
import { ObservationViewers } from '../../main/run-observation/viewers'
import { RunObservationOwner, type RunObservationSource } from '../../main/run-observation/owner'
import { ManagedRuntimeViews } from '../../main/managed-runtime-views'
import { ReplayViewerHttpHost } from '../../main/replay-viewer/http-host'
import { createReplayViewerAssetReader } from '../../main/replay-viewer/assets'
import { createCallerContext } from '../../main/caller-context'
import {
  validateBrowserRecording,
  type RecordedBrowserPayload,
  type BrowserRecordingMoment,
  type BrowserRecordingStatus
} from '../../shared/browser-recording'

// npm run build:replay-viewer && RUN_REPLAY_VIEWER_BROWSER=1 npx vitest run <this file>
it.skipIf(process.env.RUN_REPLAY_VIEWER_BROWSER !== '1')(
  'plays real WebM across segments, seeks precisely and asks without creating a runtime',
  async () => {
    const browser = await chromium.launch({ headless: true })
    let host: ReplayViewerHttpHost | undefined, viewers: ObservationViewers | undefined
    try {
      const capture = await browser.newPage()
      const fixture = process.env.BROWSER_RECORDING_WEBM_FIXTURE
      const bytes = fixture
        ? await readFile(fixture)
        : Buffer.from(
            await capture.evaluate(async () => {
              const canvas = document.createElement('canvas')
              canvas.width = 640
              canvas.height = 360
              document.body.append(canvas)
              const context = canvas.getContext('2d')!
              const stream = canvas.captureStream(15)
              const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
              const chunks: Blob[] = []
              recorder.ondataavailable = (event) => chunks.push(event.data)
              const ended = new Promise<Blob>((done) => {
                recorder.onstop = () => done(new Blob(chunks, { type: 'video/webm' }))
              })
              let n = 0
              const paint = (): void => {
                context.fillStyle = '#184b6b'
                context.fillRect(0, 0, 640, 360)
                context.fillStyle = '#fff'
                context.fillRect((n++ * 10) % 600, 120, 40, 40)
              }
              paint()
              recorder.start()
              const timer = setInterval(paint, 66)
              await new Promise((done) => setTimeout(done, 1900))
              clearInterval(timer)
              recorder.stop()
              const blob = await ended
              stream.getTracks().forEach((track) => track.stop())
              return Array.from(new Uint8Array(await blob.arrayBuffer()))
            })
          )
      await capture.close()
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const recording = validateBrowserRecording({
        format: 'open-science-web-recording',
        version: 1,
        recordingId: 'browser-e2e',
        startedAt: 1000,
        durationMs: 6100,
        media: [0, 1, 2].map((n) => ({
          mediaKey: `clip-${n}`,
          name: `clip-${n}.webm`,
          mimeType: 'video/webm',
          checksum,
          sizeBytes: bytes.length,
          sourceVersionId: `source-${n}`
        })),
        segments: [0, 1, 2].map((n) => ({
          segmentId: `part-${n}`,
          mediaKey: `clip-${n}`,
          startMs: [0, 1900, 4200][n],
          endMs: [1900, 3800, 6100][n],
          width: 640,
          height: 360,
          codec: 'vp8',
          frameRate: 15
        })),
        events: [
          {
            eventId: 'event',
            offsetMs: 2400,
            kind: 'click',
            source: 'browser-observed',
            label: 'Recorded action'
          }
        ],
        coverage: {
          stopReason: 'stopped',
          gaps: [{ startMs: 3800, endMs: 4200, reason: 'paused' }],
          droppedFrames: 0
        }
      })
      const payload: RecordedBrowserPayload = {
        receiving: { projectId: 'p', sessionId: 's', artifactId: 'a', versionId: 'v' },
        indexChecksum: createHash('sha256').update(JSON.stringify(recording)).digest('hex'),
        recording,
        media: recording.media.map((media) => ({
          mediaKey: media.mediaKey,
          artifactId: `${media.mediaKey}-file`,
          versionId: `${media.mediaKey}-version`,
          checksum,
          sizeBytes: bytes.length
        }))
      }
      let liveCalls = 0,
        selections = 0,
        mediaReads = 0
      const mediaReadsByKey = new Map<string, number>()
      const forbidden = async (): Promise<never> => {
        liveCalls++
        throw new Error('Historical footage has no runtime')
      }
      const observer = new RunObservationOwner({ authorize: forbidden, read: forbidden })
      const moments = (offsetMs: number): BrowserRecordingMoment => {
        const segment = recording.segments.find(
          (item) => offsetMs >= item.startMs && offsetMs < item.endMs
        )!
        const media = payload.media.find((item) => item.mediaKey === segment.mediaKey)!
        const declared = recording.media.find((item) => item.mediaKey === segment.mediaKey)!
        return {
          kind: 'recorded-project-moment',
          selectionId: `selection-${++selections}`,
          selectedAt: Date.now(),
          receiving: payload.receiving,
          indexChecksum: payload.indexChecksum,
          recordingId: recording.recordingId,
          offsetMs,
          segmentId: segment.segmentId,
          segmentOffsetMs: offsetMs - segment.startMs,
          mediaKey: segment.mediaKey,
          resource: {
            ...payload.receiving,
            artifactId: media.artifactId,
            versionId: media.versionId,
            name: declared.name,
            mimeType: 'video/webm',
            checksum,
            sizeBytes: bytes.length
          }
        }
      }
      viewers = new ObservationViewers({
        observer,
        authorizeScope: forbidden,
        recorded: {
          authorizeScope: async () => undefined,
          read: forbidden,
          readBrowser: async () => payload,
          selectBrowserMoment: async (_, offsetMs) => moments(offsetMs)
        },
        onRevoked: (id) => host?.closeViewer(id)
      })
      host = new ReplayViewerHttpHost({
        viewers,
        projectViews: { open: forbidden, closeViewer: () => undefined },
        readAsset: createReplayViewerAssetReader(resolve('out/replay-viewer')),
        readRecordingMedia: async (_, mediaKey) => {
          expect(payload.media.some((item) => item.mediaKey === mediaKey)).toBe(true)
          mediaReads++
          mediaReadsByKey.set(mediaKey, (mediaReadsByKey.get(mediaKey) ?? 0) + 1)
          return { body: bytes, mimeType: 'video/webm' }
        }
      })
      const caller = createCallerContext({
        clientId: 'web-e2e',
        lifecycleClientId: 'web-e2e',
        leaseId: 'web-e2e',
        surface: 'task',
        location: 'local',
        principalKind: 'automation',
        actionOrigin: 'automation'
      })
      const access = await host.openRecorded(payload.receiving, caller, { format: 'web-recording' })
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const ranged: string[] = []
      page.on('response', (response) => {
        if (response.url().includes('/api/recording/media')) ranged.push(String(response.status()))
      })
      await page.goto(access.url)
      const video = page.getByLabel('Recorded webpage', { exact: true })
      await expect(video).toBeVisible()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2)
      const seek = async (value: number): Promise<void> => {
        await page.getByRole('slider').fill(String(value))
        await expect(page.getByRole('slider')).toHaveValue(String(value))
      }
      const initiallyPreloaded = await page
        .getByTestId('preloaded-recorded-segment')
        .elementHandle()
      await expect
        .poll(() => initiallyPreloaded!.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2)
      const initialNextReads = mediaReadsByKey.get('clip-1')
      await seek(2400)
      expect(
        await video.evaluate((element, preloaded) => element === preloaded, initiallyPreloaded)
      ).toBe(true)
      expect(mediaReadsByKey.get('clip-1')).toBe(initialNextReads)
      await expect(video).toHaveAttribute('src', '/api/recording/media?mediaKey=clip-1')
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => Math.round(element.currentTime * 1000))
        )
        .toBe(500)
      const dimensions = await video.evaluate((element: HTMLVideoElement) => ({
        width: element.videoWidth,
        height: element.videoHeight
      }))
      expect(dimensions.width).toBeGreaterThan(0)
      expect(dimensions.height).toBeGreaterThan(0)
      await page.getByRole('combobox', { name: 'Playback speed' }).selectOption('2')
      expect(await video.evaluate((element: HTMLVideoElement) => element.playbackRate)).toBe(2)
      await page.getByRole('button', { name: 'Ask about this moment', exact: true }).click()
      const reference = page.getByRole('textbox', { name: 'Recorded moment reference' })
      await expect(reference).toBeVisible()
      expect(JSON.parse(await reference.inputValue())).toMatchObject({
        offsetMs: 2400,
        segmentOffsetMs: 500,
        resource: { versionId: 'clip-1-version' },
        indexChecksum: payload.indexChecksum
      })
      if (process.env.BROWSER_RECORDING_VIEWER_EVIDENCE)
        await page.screenshot({
          path: process.env.BROWSER_RECORDING_VIEWER_EVIDENCE.replace(/\.json$/, '.png'),
          fullPage: true
        })
      await seek(4000)
      await expect(
        page.getByText('Recording was paused at this time.', { exact: true })
      ).toBeVisible()
      await expect(video).toHaveCount(0)
      await page.getByRole('button', { name: 'Go to next recorded moment' }).click()
      await expect(page.getByRole('slider')).toHaveValue('4200')
      // Intercept before seeking back: even paused players preload the next segment.
      const nextReadsBeforeTransition = mediaReadsByKey.get('clip-1') ?? 0
      let releaseNext: (() => void) | undefined
      let delayNext = true
      await page.route('**/api/recording/media?mediaKey=clip-1', async (route) => {
        if (delayNext) {
          delayNext = false
          await new Promise<void>((done) => {
            releaseNext = done
          })
        }
        await route.continue()
      })
      await seek(0)
      await expect(video).toBeVisible()
      const preloadedNext = await page.getByTestId('preloaded-recorded-segment').elementHandle()
      const surface = page.getByTestId('recorded-video-surface')
      const viewportBeforeTransition = await surface.boundingBox()
      await page.getByRole('button', { name: 'Play replay', exact: true }).click()
      await expect.poll(() => Boolean(releaseNext)).toBe(true)
      await expect(page.getByTestId('recorded-segment-loading')).toBeVisible()
      const held = page.getByTestId('held-recorded-frame')
      await expect(held).toBeVisible()
      const heldPixels = await held.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height
      }))
      expect(heldPixels.width).toBeGreaterThan(0)
      expect(heldPixels.width).toBeLessThanOrEqual(1280)
      expect(heldPixels.height).toBeLessThanOrEqual(720)
      const heldTime = await page.getByRole('slider').inputValue()
      await page.waitForTimeout(250)
      expect(await page.getByRole('slider').inputValue()).toBe(heldTime)
      expect(await surface.boundingBox()).toEqual(viewportBeforeTransition)
      // The retained canvas is real evidence; the action stays available during decoder handoff.
      await expect(page.getByRole('button', { name: 'Ask about this moment' })).toBeEnabled()
      if (process.env.BROWSER_RECORDING_VIEWER_EVIDENCE)
        await page.screenshot({
          path: process.env.BROWSER_RECORDING_VIEWER_EVIDENCE.replace(
            /\.json$/,
            '-segment-loading.png'
          ),
          fullPage: true
        })
      releaseNext!()

      await expect(video).toHaveAttribute('src', '/api/recording/media?mediaKey=clip-1', {
        timeout: 12000
      })
      await expect(video).toBeVisible()
      expect(
        await video.evaluate((element, preloaded) => element === preloaded, preloadedNext)
      ).toBe(true)
      expect(mediaReadsByKey.get('clip-1')).toBe(nextReadsBeforeTransition + 1)
      await expect(page.getByTestId('recorded-segment-loading')).toHaveCount(0)
      expect(await surface.boundingBox()).toEqual(viewportBeforeTransition)
      await expect(
        page.getByText('Recording was paused at this time.', { exact: true })
      ).toBeVisible({ timeout: 12000 })
      expect(liveCalls).toBe(0)
      expect(mediaReads).toBeGreaterThan(1)
      expect(ranged).toContain('206')
      expect(errors).toEqual([])
      if (process.env.BROWSER_RECORDING_VIEWER_EVIDENCE)
        await writeFile(
          process.env.BROWSER_RECORDING_VIEWER_EVIDENCE,
          JSON.stringify(
            {
              fixture: fixture ?? 'real-canvas-mediarecorder',
              bytes: bytes.length,
              checksum,
              dimensions,
              ranged,
              mediaReads,
              liveCalls,
              selections,
              crossSegmentPlayback: true,
              heldPixels,
              heldTime,
              viewportBeforeTransition,
              stableSegmentLoading: true,
              preloadedNodeReused: true,
              nextSegmentReadOnce: true,
              seekMs: 2400,
              segmentOffsetMs: 500,
              speed: 2,
              gapStopped: true,
              errors
            },
            null,
            2
          )
        )
    } finally {
      await browser.close()
      await host?.close()
      await viewers?.close()
    }
  },
  45000
)

it.skipIf(process.env.RUN_REPLAY_VIEWER_BROWSER !== '1' || process.platform === 'win32')(
  'keeps the live project capture rectangle stable while recording controls wrap and change state',
  async () => {
    const cleanups: Array<() => Promise<unknown> | void> = []
    const root = await realpath(await mkdtemp(join(tmpdir(), 'os-service-controls-run-')))
    await chmod(root, 0o700)
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    try {
      const scope = {
        projectId: 'controls-project',
        sessionId: 'controls-session',
        runId: 'controls-run',
        environmentId: 'controls-environment',
        generationId: randomUUID()
      }
      const target = { projectId: scope.projectId, sessionId: scope.sessionId, runId: scope.runId }
      const proof = randomBytes(32).toString('hex'),
        proofPath = '/__recording_controls_proof'
      let pageLoads = 0
      const project = createServer((request, response) => {
        if (request.url === proofPath) {
          response.end(proof)
          return
        }
        pageLoads++
        response.setHeader('content-type', 'text/html')
        response.end('<!doctype html><h1>Stable capture target</h1>')
      })
      const socketPath = join(root, 'service.sock')
      await new Promise<void>((done, fail) => {
        project.once('error', fail)
        project.listen(socketPath, done)
      })
      cleanups.push(
        () =>
          new Promise<void>((done) => {
            project.closeAllConnections()
            project.close(() => done())
          })
      )
      const projectViews = new ManagedRuntimeViews()
      cleanups.push(() => projectViews.close())
      projectViews.register({
        scope,
        declaration: { title: 'Stable capture target' },
        socketPath,
        proof: { path: proofPath, value: proof },
        logicalPort: 4173,
        signal: new AbortController().signal
      })
      const source: RunObservationSource = {
        identity: target,
        phase: 'running',
        artifacts: [],
        run: {
          runId: target.runId,
          cellId: 'cell',
          source: 'agent',
          kernelKind: 'bash',
          script: '',
          status: 'running',
          startedAt: Date.now(),
          text: { stdout: 'Project ready', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        }
      }
      const observer: RunObservationOwner = new RunObservationOwner({
        authorize: (requested, viewer) => viewers.assertViewer(requested, viewer),
        read: async () => source
      })
      const viewers: ObservationViewers = new ObservationViewers({
        observer,
        authorizeScope: async () => undefined,
        onRevoked: (viewerId) => host.closeViewer(viewerId)
      })
      cleanups.push(() => viewers.close())
      let status: BrowserRecordingStatus = {
        state: 'idle',
        elapsedMs: 0,
        segments: 0,
        bytes: 0,
        droppedFrames: 0
      }
      const host: ReplayViewerHttpHost = new ReplayViewerHttpHost({
        viewers,
        projectViews,
        recordingStatus: async () => ({ target, state: 'not-recorded' }),
        readAsset: createReplayViewerAssetReader(resolve('out/replay-viewer')),
        browserRecording: async (method) => {
          if (method === 'inspect') return { supported: true, active: status }
          if (method === 'status') return status
          status = {
            ...status,
            recordingId: 'controls-recording',
            elapsedMs: 61000,
            state: method === 'pause' ? 'paused' : method === 'stop' ? 'partial' : 'recording',
            ...(method === 'stop'
              ? {
                  target: {
                    projectId: scope.projectId,
                    sessionId: scope.sessionId,
                    artifactId: 'saved',
                    versionId: 'v1'
                  }
                }
              : {})
          }
          return status
        }
      })
      cleanups.push(() => host.close())
      const caller = createCallerContext({
        clientId: 'controls-browser',
        lifecycleClientId: 'controls-browser',
        leaseId: 'controls-browser',
        surface: 'electron',
        location: 'local',
        principalKind: 'human',
        actionOrigin: 'human'
      })
      const access = await host.open(target, caller, {
        allowInteraction: true,
        allowRecording: true
      })
      const browser = await chromium.launch({ headless: true })
      cleanups.push(() => browser.close())
      const page = await browser.newPage({ viewport: { width: 560, height: 1000 } })
      await page.goto(access.url)
      await expect(page.getByText('Project ready', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Project interface', exact: true }).click()
      await expect(
        page.frameLocator('iframe[title="Stable capture target"]').getByRole('heading')
      ).toHaveText('Stable capture target')
      const frame = page.locator('iframe[title="Stable capture target"]')
      const initial = await frame.boundingBox()
      expect(initial).not.toBeNull()
      const assertStable = async (): Promise<void> => {
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))
            )
        )
        expect(await frame.boundingBox()).toEqual(initial)
        expect((await page.getByTestId('browser-recording-controls').boundingBox())?.height).toBe(
          112
        )
        expect(pageLoads).toBe(1)
      }
      await assertStable()
      await page.getByRole('button', { name: 'Record webpage', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Pause recording', exact: true })).toBeVisible()
      await assertStable()
      await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
      await expect(
        page.getByRole('button', { name: 'Resume recording', exact: true })
      ).toBeVisible()
      await assertStable()
      await page.getByRole('button', { name: 'Resume recording', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Pause recording', exact: true })).toBeVisible()
      await assertStable()
      await page.getByRole('button', { name: 'Stop and save recording', exact: true }).click()
      await expect(
        page.getByText(
          'Recording ended early. Saved footage remains available. You can start a new recording.',
          { exact: true }
        )
      ).toBeVisible()
      await assertStable()
    } finally {
      for (const close of cleanups.reverse()) await close()
    }
  },
  30000
)

it.skipIf(process.env.RUN_REPLAY_VIEWER_BROWSER !== '1')(
  'fits real landscape, portrait and ultrawide research footage without changing its clock or leaking scroll outside the stage',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'os-recording-viewport-'))
    const browser = await chromium.launch({ headless: true })
    let host: ReplayViewerHttpHost | undefined, viewers: ObservationViewers | undefined
    try {
      const sizes = [
        { width: 1280, height: 720 },
        { width: 540, height: 960 },
        { width: 1920, height: 480 },
        { width: 1920, height: 480 }
      ]
      const capture = await browser.newPage()
      const clips = await Promise.all(
        sizes.map(async (size, index) =>
          Buffer.from(
            await capture.evaluate(
              async ({ width, height, index }) => {
                const canvas = document.createElement('canvas')
                canvas.width = width
                canvas.height = height
                const context = canvas.getContext('2d')!
                const stream = canvas.captureStream(10)
                const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
                const chunks: Blob[] = []
                recorder.ondataavailable = (event) => chunks.push(event.data)
                const finished = new Promise<Blob>((done) => {
                  recorder.onstop = () => done(new Blob(chunks, { type: 'video/webm' }))
                })
                let tick = 0
                const paint = (): void => {
                  context.fillStyle = index === 3 ? '#b02a2a' : '#184b6b'
                  context.fillRect(0, 0, width, height)
                  context.fillStyle = '#fff'
                  context.fillRect((tick++ * 30) % (width - 50), Math.round(height / 2), 40, 40)
                }
                paint()
                recorder.start()
                const timer = setInterval(paint, 100)
                await new Promise((done) => setTimeout(done, 1200))
                clearInterval(timer)
                recorder.stop()
                const blob = await finished
                stream.getTracks().forEach((track) => track.stop())
                return Array.from(new Uint8Array(await blob.arrayBuffer()))
              },
              { ...size, index }
            )
          )
        )
      )
      await capture.close()
      const recording = validateBrowserRecording({
        format: 'open-science-web-recording',
        version: 1,
        recordingId: 'viewport-e2e',
        startedAt: 100000,
        durationMs: 4130,
        media: clips.map((bytes, index) => ({
          mediaKey: `clip-${index}`,
          name: `clip-${index}.webm`,
          mimeType: 'video/webm',
          checksum: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: bytes.length,
          sourceVersionId: `source-${index}`
        })),
        segments: sizes.map((size, index) => ({
          ...size,
          segmentId: `segment-${index}`,
          mediaKey: `clip-${index}`,
          startMs: index * 1000 + (index === 3 ? 130 : 0),
          endMs: (index + 1) * 1000 + (index === 3 ? 130 : 0),
          codec: 'vp8',
          frameRate: 10
        })),
        events: [],
        coverage: { stopReason: 'finished', gaps: [], droppedFrames: 0 }
      })
      const payload: RecordedBrowserPayload = {
        receiving: {
          projectId: 'viewport',
          sessionId: 'session',
          artifactId: 'recording',
          versionId: 'index-v1'
        },
        indexChecksum: createHash('sha256').update(JSON.stringify(recording)).digest('hex'),
        recording,
        media: recording.media.map((media) => ({
          mediaKey: media.mediaKey,
          artifactId: media.mediaKey,
          versionId: `${media.mediaKey}-v1`,
          checksum: media.checksum,
          sizeBytes: media.sizeBytes
        }))
      }
      let liveCalls = 0
      const forbidden = async (): Promise<never> => {
        liveCalls++
        throw new Error('Sizing saved footage has no runtime')
      }
      viewers = new ObservationViewers({
        observer: new RunObservationOwner({ authorize: forbidden, read: forbidden }),
        authorizeScope: forbidden,
        recorded: {
          authorizeScope: async () => undefined,
          read: forbidden,
          readBrowser: async () => payload
        },
        onRevoked: (id) => host?.closeViewer(id)
      })
      host = new ReplayViewerHttpHost({
        viewers,
        projectViews: { open: forbidden, closeViewer: () => undefined },
        readAsset: createReplayViewerAssetReader(resolve('out/replay-viewer')),
        readRecordingMedia: async (_, mediaKey) => {
          const index = recording.media.findIndex((media) => media.mediaKey === mediaKey)
          expect(index).toBeGreaterThanOrEqual(0)
          return { body: clips[index], mimeType: 'video/webm' }
        }
      })
      const caller = createCallerContext({
        clientId: '2',
        lifecycleClientId: 'viewport-browser',
        leaseId: 'viewport-browser',
        surface: 'electron',
        location: 'local',
        principalKind: 'human',
        actionOrigin: 'human'
      })
      const access = await host.openRecorded(payload.receiving, caller, {
        format: 'web-recording',
        desktopParent: 'file:'
      })
      await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'viewport-parent.tsx',
          loader: 'tsx',
          contents: `
import {useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {useBrowserRecordingTransportHost} from './src/renderer/src/pages/workspace/replay/use-browser-recording-transport'
const url=${JSON.stringify(access.url)}
function App(){
 const iframeRef=useRef(null),[offset,setOffset]=useState(500),[playing,setPlaying]=useState(false)
 window.setResearchPlayback=(value,isPlaying)=>{setOffset(value);setPlaying(isPlaying)}
 const playback={recordedAt:100000+offset,playing,speed:1,presentation:'research',onSeekRecordedAt:at=>setOffset(at-100000)}
 const bridge=useBrowserRecordingTransportHost({iframeRef,playback,enabled:true,origin:new URL(url).origin})
 return <main style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
 <input aria-label="Research position" type="range" min="0" max="4129" value={offset} onChange={event=>{setPlaying(false);setOffset(Number(event.target.value))}} style={{flexShrink:0,height:32,margin:0}}/>
 <output aria-label="Research reference state">{!bridge.action||bridge.action.disabled?'disabled':'enabled'}</output>
 <iframe ref={iframeRef} name="open-science-research-clock" onLoad={bridge.onLoad} title="Research recording" src={url} sandbox="allow-scripts allow-same-origin allow-forms" style={{display:'block',width:'100%',flex:1,minHeight:0,border:0}}/>
 </main>
}
createRoot(document.getElementById('root')).render(<App/> )`
        },
        outfile: join(directory, 'parent.js'),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'silent'
      })
      const html = join(directory, 'index.html')
      await writeFile(
        html,
        '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script src="./parent.js"></script></body></html>'
      )
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(pathToFileURL(html).href)
      const child = page.frameLocator('iframe')
      const video = child.getByLabel('Recorded webpage', { exact: true })
      await expect(video).toBeVisible()
      await expect(child.getByRole('button', { name: 'Play replay', exact: true })).toHaveCount(0)
      const initialPlayer = await child.getByTestId('browser-recording-player').elementHandle()
      const stage = child.getByTestId('recorded-media-scroll')
      const surface = child.getByTestId('recorded-video-surface')
      for (const [index, size] of sizes.entries()) {
        await page
          .getByRole('slider', { name: 'Research position' })
          .fill(String(recording.segments[index].startMs + 500))
        await expect(video).toHaveAttribute('src', `/api/recording/media?mediaKey=clip-${index}`)
        await expect
          .poll(() =>
            video.evaluate((element: HTMLVideoElement) => ({
              width: element.videoWidth,
              height: element.videoHeight,
              time: Math.round(element.currentTime * 1000),
              ready: element.readyState >= 2
            }))
          )
          .toEqual({ ...size, time: 500, ready: true })
        if (index > 0) {
          await expect(stage).toHaveAttribute('data-size-mode', 'actual')
          await expect
            .poll(async () => {
              const box = await surface.boundingBox()
              return box && { width: box.width, height: box.height }
            })
            .toEqual(size)
        }
        const decoder = await video.elementHandle()
        for (const width of [360, 480, 720, 1200]) {
          await page.setViewportSize({ width, height: 800 })
          await expect
            .poll(() =>
              page.locator('iframe').evaluate((element) => element.getBoundingClientRect().width)
            )
            .toBe(width)
          await page.evaluate(
            () =>
              new Promise<void>((done) =>
                requestAnimationFrame(() => requestAnimationFrame(() => done()))
              )
          )
          // The compact research toolbar offers one toggle for the next sizing action.
          // Its initial state already fits; later iterations retain the chosen native size.
          if ((await stage.getAttribute('data-size-mode')) === 'actual')
            await child.getByRole('button', { name: 'Fit to window', exact: true }).click()
          await expect(stage).toHaveAttribute('data-size-mode', 'fit')
          await expect(
            child.getByRole('button', { name: 'Actual size (100%)', exact: true })
          ).toBeVisible()
          await expect
            .poll(async () => {
              const box = await surface.boundingBox(),
                bounds = await stage.boundingBox()
              if (!box || !bounds) return false
              return (
                box.x >= bounds.x - 1 &&
                box.y >= bounds.y - 1 &&
                box.x + box.width <= bounds.x + bounds.width + 1 &&
                box.y + box.height <= bounds.y + bounds.height + 1 &&
                Math.abs(box.width / box.height - size.width / size.height) < 0.01
              )
            })
            .toBe(true)
          const frame = page.frames().find((item) => item.parentFrame() === page.mainFrame())!
          const fitOverflow = await frame.evaluate(() => ({
            width: document.documentElement.scrollWidth - innerWidth,
            height: document.documentElement.scrollHeight - innerHeight
          }))
          expect(fitOverflow.width).toBeLessThanOrEqual(1)
          expect(fitOverflow.height).toBeLessThanOrEqual(1)
          await child.getByRole('button', { name: 'Actual size (100%)', exact: true }).click()
          await expect(stage).toHaveAttribute('data-size-mode', 'actual')
          await expect(
            child.getByRole('button', { name: 'Fit to window', exact: true })
          ).toBeVisible()
          await expect
            .poll(async () => {
              const box = await surface.boundingBox()
              return box && { width: box.width, height: box.height }
            })
            .toEqual(size)
          const nativeOverflow = await frame.evaluate(() => ({
            width: document.documentElement.scrollWidth - innerWidth,
            height: document.documentElement.scrollHeight - innerHeight
          }))
          expect(nativeOverflow.width).toBeLessThanOrEqual(1)
          expect(nativeOverflow.height).toBeLessThanOrEqual(1)
          expect(
            await decoder!.evaluate((element) => element === document.querySelector('video'))
          ).toBe(true)
          expect(
            await video.evaluate((element: HTMLVideoElement) =>
              Math.round(element.currentTime * 1000)
            )
          ).toBe(500)
          expect(await page.getByRole('slider', { name: 'Research position' }).inputValue()).toBe(
            String(recording.segments[index].startMs + 500)
          )
        }
        expect(
          await initialPlayer!.evaluate(
            (element) =>
              element === document.querySelector('[data-testid="browser-recording-player"]')
          )
        ).toBe(true)
        await decoder?.dispose()
      }
      // A real 130ms segment hole keeps the last real pixels and the same viewport size.
      if ((await stage.getAttribute('data-size-mode')) === 'actual')
        await child.getByRole('button', { name: 'Fit to window', exact: true }).click()
      const clock = async (offset: number, playing: boolean): Promise<void> => {
        await page.evaluate(
          ({ offset, playing }) => {
            ;(
              window as unknown as {
                setResearchPlayback: (offset: number, playing: boolean) => void
              }
            ).setResearchPlayback(offset, playing)
          },
          { offset, playing }
        )
      }
      await clock(2950, false)
      await expect(video).toBeVisible()
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => Math.round(element.currentTime * 1000))
        )
        .toBe(950)
      const nextDecoder = await child.getByTestId('preloaded-recorded-segment').elementHandle()
      await expect
        .poll(() => nextDecoder!.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2)
      const beforeHole = await surface.boundingBox()
      await clock(2950, true)
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(false)
      await clock(3010, true)
      await expect(child.getByTestId('recorded-segment-gap')).toHaveCount(0)
      const held = child.getByTestId('held-recorded-frame')
      await expect(held).toBeVisible()
      const heldPixels = await held.evaluate((canvas: HTMLCanvasElement) => ({
        width: canvas.width,
        height: canvas.height,
        rgba: [...canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data]
      }))
      expect({ width: heldPixels.width, height: heldPixels.height }).toEqual({
        width: 1280,
        height: 320
      })
      // VP8/scaling can round opacity by one. Assert actual opaque blue prior footage,
      // not an empty canvas or the red future segment that is already preloaded.
      expect(heldPixels.rgba[3]).toBeGreaterThanOrEqual(250)
      expect(heldPixels.rgba[2] - heldPixels.rgba[0]).toBeGreaterThan(40)
      expect(await surface.boundingBox()).toEqual(beforeHole)
      await expect(video).toHaveCount(0)
      await expect(page.getByLabel('Research reference state')).toHaveText('enabled')
      await clock(3130 + 20, true)
      await expect(video).toBeVisible()
      expect(await video.evaluate((element, preloaded) => element === preloaded, nextDecoder)).toBe(
        true
      )
      expect(await surface.boundingBox()).toEqual(beforeHole)
      await expect(child.getByTestId('recorded-segment-gap')).toHaveCount(0)
      await expect(page.getByLabel('Research reference state')).toHaveText('enabled')
      await clock(3010, false)
      await expect(
        child.getByText('No webpage footage was recorded at this time.', { exact: true })
      ).toBeVisible()
      await expect(held).toBeHidden()
      expect(await held.evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(0)
      expect(liveCalls).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await browser.close()
      await host?.close()
      await viewers?.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  45000
)
