import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium, expect } from '@playwright/test'
import { it, vi } from 'vitest'
import { createCallerContext } from '../../main/caller-context'
import { ObservationViewers } from '../../main/run-observation/viewers'
import { RunObservationOwner } from '../../main/run-observation/owner'
import { ReplayViewerHttpHost } from '../../main/replay-viewer/http-host'
import { createReplayViewerAssetReader } from '../../main/replay-viewer/assets'
import { desktopObservationFrameRegistry } from '../../main/replay-viewer/desktop-frame-registry'
import {
  validateBrowserRecording,
  type RecordedBrowserPayload
} from '../../shared/browser-recording'

// npm run build:replay-viewer && RUN_REPLAY_VIEWER_BROWSER=1 npx vitest run <this file>
it.skipIf(process.env.RUN_REPLAY_VIEWER_BROWSER !== '1')(
  'shares one research clock across a real cross-origin viewer, segments, gaps and event seeks',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'os-recording-clock-'))
    const browser = await chromium.launch({ headless: true })
    let host: ReplayViewerHttpHost | undefined
    let viewers: ObservationViewers | undefined
    try {
      const capture = await browser.newPage()
      const bytes = Buffer.from(
        await capture.evaluate(async () => {
          const canvas = document.createElement('canvas')
          canvas.width = 640
          canvas.height = 360
          const context = canvas.getContext('2d')!
          const stream = canvas.captureStream(15)
          const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
          const chunks: Blob[] = []
          recorder.ondataavailable = (event) => chunks.push(event.data)
          const complete = new Promise<Blob>((done) => {
            recorder.onstop = () => done(new Blob(chunks, { type: 'video/webm' }))
          })
          let frame = 0
          const paint = (): void => {
            context.fillStyle = '#184b6b'
            context.fillRect(0, 0, 640, 360)
            context.fillStyle = '#fff'
            context.fillRect((frame++ * 10) % 600, 120, 40, 40)
          }
          paint()
          recorder.start()
          const timer = setInterval(paint, 66)
          await new Promise((done) => setTimeout(done, 3100))
          clearInterval(timer)
          recorder.stop()
          const blob = await complete
          stream.getTracks().forEach((track) => track.stop())
          return Array.from(new Uint8Array(await blob.arrayBuffer()))
        })
      )
      await capture.close()
      const checksum = createHash('sha256').update(bytes).digest('hex')
      const recording = validateBrowserRecording({
        format: 'open-science-web-recording',
        version: 1,
        recordingId: 'clock-e2e',
        startedAt: 100000,
        durationMs: 9500,
        media: [0, 1, 2].map((index) => ({
          mediaKey: `clip-${index}`,
          name: `clip-${index}.webm`,
          mimeType: 'video/webm',
          checksum,
          sizeBytes: bytes.length,
          sourceVersionId: `source-${index}`
        })),
        segments: [0, 1, 2].map((index) => ({
          segmentId: `part-${index}`,
          mediaKey: `clip-${index}`,
          startMs: [0, 3000, 6500][index],
          endMs: [3000, 6000, 9500][index],
          width: 640,
          height: 360,
          codec: 'vp8',
          frameRate: 15
        })),
        events: [
          {
            eventId: 'click',
            offsetMs: 4400,
            kind: 'click',
            source: 'browser-observed',
            label: 'Recorded action'
          }
        ],
        coverage: {
          stopReason: 'stopped',
          gaps: [{ startMs: 6000, endMs: 6500, reason: 'paused' }],
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
      let liveCalls = 0
      let mediaReads = 0
      const selectedOffsets: number[] = []
      let releaseFirstSelection: (() => void) | undefined
      const firstSelectionGate = new Promise<void>((resolve) => {
        releaseFirstSelection = resolve
      })
      const forbidden = async (): Promise<never> => {
        liveCalls += 1
        throw new Error('Historical playback never starts a runtime')
      }
      viewers = new ObservationViewers({
        observer: new RunObservationOwner({ authorize: forbidden, read: forbidden }),
        authorizeScope: forbidden,
        recorded: {
          authorizeScope: async () => undefined,
          read: forbidden,
          readBrowser: async () => payload,
          selectBrowserMoment: async (target, offsetMs) => {
            expect(target).toEqual(payload.receiving)
            selectedOffsets.push(offsetMs)
            if (selectedOffsets.length === 1) await firstSelectionGate
            const segment = recording.segments.find(
              (item) => item.startMs <= offsetMs && item.endMs > offsetMs
            )!
            const media = recording.media.find((item) => item.mediaKey === segment.mediaKey)!
            const resolved = payload.media.find((item) => item.mediaKey === segment.mediaKey)!
            return {
              kind: 'recorded-project-moment' as const,
              selectionId: randomUUID(),
              selectedAt: Date.now(),
              receiving: target,
              indexChecksum: payload.indexChecksum,
              recordingId: recording.recordingId,
              offsetMs,
              segmentId: segment.segmentId,
              mediaKey: segment.mediaKey,
              segmentOffsetMs: offsetMs - segment.startMs,
              resource: {
                ...target,
                artifactId: resolved.artifactId,
                versionId: resolved.versionId,
                name: media.name,
                mimeType: 'video/webm' as const,
                checksum,
                sizeBytes: bytes.length
              }
            }
          }
        },
        onRevoked: (id) => host?.closeViewer(id)
      })
      const selectionWrites = vi.spyOn(viewers, 'selectBrowserMoment')
      host = new ReplayViewerHttpHost({
        desktopFrames: desktopObservationFrameRegistry,
        viewers,
        projectViews: { open: forbidden, closeViewer: () => undefined },
        readAsset: createReplayViewerAssetReader(resolve('out/replay-viewer')),
        readRecordingMedia: async (_, mediaKey) => {
          expect(recording.media.some((item) => item.mediaKey === mediaKey)).toBe(true)
          mediaReads += 1
          return { body: bytes, mimeType: 'video/webm' }
        }
      })
      const caller = createCallerContext({
        clientId: '1',
        lifecycleClientId: 'recording-clock',
        leaseId: 'recording-clock',
        surface: 'electron',
        location: 'local',
        principalKind: 'human',
        actionOrigin: 'human'
      })
      const access = await host.openRecorded(payload.receiving, caller, {
        format: 'web-recording',
        desktopParent: 'file:'
      })
      const script = join(directory, 'parent.js')
      await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'recording-clock-parent.tsx',
          loader: 'tsx',
          contents: `
import {useEffect,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {useBrowserRecordingTransportHost} from './src/renderer/src/pages/workspace/replay/use-browser-recording-transport'
const viewerUrl=${JSON.stringify(access.url)}
const OriginalChannel=window.MessageChannel
window.__recordingPorts=[]
window.MessageChannel=class extends OriginalChannel {
 constructor(){
  super();window.__recordingPorts.push(this.port1)
  const post=this.port1.postMessage.bind(this.port1)
  this.port1.postMessage=(message,...rest)=>{
   if(message.type==='state')window.__recordingRevision=message.revision
   post(message,...rest)
  }
 }
}
function Bridge({iframeRef,playback,onLoad}){
 const bridge=useBrowserRecordingTransportHost({iframeRef,playback,origin:new URL(viewerUrl).origin,enabled:true})
 onLoad.current=bridge.onLoad
 window.__recordingAsk=bridge.ask
 return <div aria-label="Research footer">
  <button disabled={!bridge.action||bridge.action.disabled||bridge.action.pending} onClick={bridge.ask}>Ask moment in research</button>
  <output aria-label="Research ask pending">{bridge.action?.pending?'pending':'idle'}</output>
 </div>
}
function App(){
 const iframeRef=useRef(null),onLoad=useRef(()=>{}),[attached,setAttached]=useState(true)
 const [offset,setOffset]=useState(-500),[playing,setPlaying]=useState(false),[speed,setSpeed]=useState(1),[seeks,setSeeks]=useState(0)
 const seek=value=>{setPlaying(false);setOffset(value)}
 useEffect(()=>{
  if(!playing)return
  let previous,request
  const tick=now=>{if(previous!==undefined)setOffset(value=>value+(now-previous)*speed);previous=now;request=requestAnimationFrame(tick)}
  request=requestAnimationFrame(tick)
  return()=>cancelAnimationFrame(request)
 },[playing,speed])
 const playback={recordedAt:100000+offset,playing,speed,presentation:'research',onSeekRecordedAt:at=>{setSeeks(value=>value+1);seek(at-100000)}}
 return <>
  <button onClick={()=>setPlaying(value=>!value)}>{playing?'Pause research':'Play research'}</button>
  <select aria-label="Research speed" value={speed} onChange={event=>setSpeed(Number(event.target.value))}><option value="1">1x</option><option value="2">2x</option></select>
  <input aria-label="Research position" type="range" min="-1000" max="11000" step="1" value={offset} onChange={event=>seek(Number(event.target.value))}/>
  <output aria-label="Research offset">{Math.round(offset)}</output><output aria-label="Seek requests">{seeks}</output>
  <button onClick={()=>setAttached(false)}>Detach research clock</button>
  {attached?<Bridge iframeRef={iframeRef} playback={playback} onLoad={onLoad}/>:null}
  <iframe ref={iframeRef} name="open-science-research-clock" onLoad={()=>onLoad.current()} title="Project recording" src={viewerUrl} sandbox="allow-scripts allow-same-origin allow-forms" style={{display:'block',width:'100%',height:850,border:0}}/>
 </>
}
createRoot(document.getElementById('root')).render(<App/>)
`
        },
        outfile: script,
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
        '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="./parent.js"></script></body></html>'
      )
      const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const mainFrame = { frameTreeNodeId: 1, url: pathToFileURL(html).href, parent: null }
      const registeredFrame = { frameTreeNodeId: 2, url: 'about:blank', parent: mainFrame }
      const allowsNavigation = (url: string): boolean =>
        desktopObservationFrameRegistry.allows({
          url,
          webContentsId: 1,
          mainFrame,
          frame: registeredFrame
        })
      // Browser behavior alone cannot detect Electron's owner-bound navigation policy.
      // Exercise the actual registry populated by the HTTP host, without loosening it.
      expect(allowsNavigation(access.url + '#research-replay-clock')).toBe(false)
      expect(allowsNavigation(access.url)).toBe(true)
      expect(allowsNavigation(new URL('/', access.url).href)).toBe(false)
      await page.goto(pathToFileURL(html).href)
      const child = page.frameLocator('iframe')
      await expect(child.getByTestId('browser-recording-player')).toBeVisible()
      const actualFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!
      expect(new URL(actualFrame.url()).hash).toBe('')
      expect(await actualFrame.evaluate(() => window.name)).toBe('open-science-research-clock')
      expect(allowsNavigation(new URL('/', access.url).href)).toBe(true)
      // The presentation flag belongs to the frame, not an authenticated navigation URL.
      const previousPort = await page.evaluate(
        () => (window as unknown as { __recordingPorts: MessagePort[] }).__recordingPorts.length - 1
      )
      await actualFrame.goto(actualFrame.url())
      await expect(child.getByTestId('browser-recording-player')).toBeVisible()
      expect(await actualFrame.evaluate(() => window.name)).toBe('open-science-research-clock')
      expect(allowsNavigation(actualFrame.url())).toBe(true)
      await expect(child.getByRole('button', { name: 'Play replay', exact: true })).toHaveCount(0)
      await expect(child.getByRole('slider')).toHaveCount(0)
      await expect(
        child.getByRole('button', { name: 'Ask about this moment', exact: true })
      ).toHaveCount(0)
      const askInResearch = page.getByRole('button', {
        name: 'Ask moment in research',
        exact: true
      })
      await expect(askInResearch).toBeDisabled()
      await expect(child.getByRole('combobox', { name: 'Playback speed' })).toHaveCount(0)
      await expect(child.getByLabel('Recorded webpage', { exact: true })).toHaveCount(0)
      const seek = async (offset: number): Promise<void> => {
        await page.getByRole('slider', { name: 'Research position' }).fill(String(offset))
        await expect(page.getByLabel('Research offset')).toHaveText(String(offset))
      }
      await seek(3200)
      const video = child.getByLabel('Recorded webpage', { exact: true })
      await expect(video).toHaveAttribute('src', '/api/recording/media?mediaKey=clip-1')
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
        .toBeGreaterThanOrEqual(2)
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => Math.round(element.currentTime * 1000))
        )
        .toBe(200)
      await expect(askInResearch).toBeEnabled()
      // This channel belonged to the frame before its reload. Real closed MessagePorts must
      // never invoke a newly admitted frame's action, even while its current footer is enabled.
      await page.evaluate((index) => {
        const state = window as unknown as {
          __recordingPorts: MessagePort[]
          __recordingRevision: number
        }
        state.__recordingPorts[index].postMessage({
          channel: 'open-science-browser-recording-transport',
          version: 1,
          type: 'ask',
          revision: state.__recordingRevision
        })
      }, previousPort)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      expect(selectionWrites.mock.calls).toHaveLength(0)
      expect(selectedOffsets).toEqual([])
      await askInResearch.click()
      await expect.poll(() => selectedOffsets.length).toBe(1)
      expect(selectedOffsets).toEqual([3200])
      await expect(page.getByLabel('Research ask pending')).toHaveText('pending')
      await expect(askInResearch).toBeDisabled()
      // A direct repeat bypasses the fixture button but still cannot bypass the receiver's
      // current pending action. It must not issue a second evidence-selection request.
      await page.evaluate(() =>
        (window as unknown as { __recordingAsk: () => void }).__recordingAsk()
      )
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      expect(selectedOffsets).toEqual([3200])
      releaseFirstSelection!()
      await expect(page.getByLabel('Research ask pending')).toHaveText('idle')
      await expect(askInResearch).toBeEnabled()
      expect(selectionWrites.mock.calls).toHaveLength(1)
      const captured = await viewers.browserMomentSelection(access.viewerId, { caller })
      // Reading the immutable reference revalidates its media, but does not write a selection.
      expect(selectedOffsets).toEqual([3200, 3200])
      expect(captured).toMatchObject({
        offsetMs: 3200,
        segmentId: 'part-1',
        segmentOffsetMs: 200,
        resource: { artifactId: 'clip-1-file', versionId: 'clip-1-version' }
      })
      await expect(
        child.getByRole('button', { name: 'Ask about this moment', exact: true })
      ).toHaveCount(0)
      await page.getByRole('combobox', { name: 'Research speed' }).selectOption('2')
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.playbackRate))
        .toBe(2)
      await page.getByRole('button', { name: 'Play research', exact: true }).click()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(false)
      await expect
        .poll(async () => Number(await page.getByLabel('Research offset').textContent()))
        .toBeGreaterThan(3600)
      await page.getByRole('button', { name: 'Pause research', exact: true }).click()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(true)
      const pausedAt = Number(await page.getByLabel('Research offset').textContent())
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => Math.round(element.currentTime * 1000))
        )
        .toBe(pausedAt - 3000)
      await seek(2800)
      await expect(video).toHaveAttribute('src', '/api/recording/media?mediaKey=clip-0')
      await page.getByRole('button', { name: 'Play research', exact: true }).click()
      await expect(video).toHaveAttribute('src', '/api/recording/media?mediaKey=clip-1')
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(false)
      await child.getByText('Recorded actions and events', { exact: true }).click()
      await child.getByRole('button', { name: /Recorded action/ }).click()
      await expect(page.getByLabel('Research offset')).toHaveText('4400')
      await expect(page.getByLabel('Seek requests')).toHaveText('2')
      await expect(page.getByRole('button', { name: 'Play research', exact: true })).toBeVisible()
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => Math.round(element.currentTime * 1000))
        )
        .toBe(1400)
      await seek(6200)
      await expect(
        child.getByText('Recording was paused at this time.', { exact: true })
      ).toBeVisible()
      await expect(video).toHaveCount(0)
      await expect(askInResearch).toBeDisabled()
      await page.getByRole('button', { name: 'Play research', exact: true }).click()
      await expect(video).toHaveAttribute('src', '/api/recording/media?mediaKey=clip-2')
      await expect(page.getByRole('button', { name: 'Pause research', exact: true })).toBeVisible()
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
        .toBe(false)
      await page.getByRole('button', { name: 'Detach research clock', exact: true }).click()
      await expect(video).toHaveCount(0)
      await expect(askInResearch).toHaveCount(0)
      await page.evaluate(() => {
        const state = window as unknown as {
          __recordingAsk: () => void
          __recordingPorts: MessagePort[]
          __recordingRevision: number
        }
        state.__recordingAsk()
        for (const port of state.__recordingPorts)
          port.postMessage({
            channel: 'open-science-browser-recording-transport',
            version: 1,
            type: 'ask',
            revision: state.__recordingRevision
          })
      })
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      expect(selectionWrites.mock.calls).toHaveLength(1)
      expect(selectedOffsets).toEqual([3200, 3200])
      await expect(child.getByRole('button', { name: 'Play replay', exact: true })).toHaveCount(0)
      expect(liveCalls).toBe(0)
      expect(mediaReads).toBeGreaterThan(2)
      expect(errors).toEqual([])
      const standaloneAccess = await host.openRecorded(payload.receiving, caller, {
        format: 'web-recording'
      })
      const standalone = await browser.newPage()
      await standalone.goto(standaloneAccess.url)
      await expect(
        standalone.getByRole('button', { name: 'Play replay', exact: true })
      ).toBeVisible()
      await expect(standalone.getByRole('slider')).toBeVisible()
      if (process.env.BROWSER_RECORDING_TRANSPORT_EVIDENCE)
        await writeFile(
          process.env.BROWSER_RECORDING_TRANSPORT_EVIDENCE,
          JSON.stringify(
            {
              oneTransport: true,
              bootstrapPreservesFrameName: true,
              reloadPreservesFrameName: true,
              originalUrlPassesDesktopRegistry: true,
              urlHashRejectedByDesktopRegistry: true,
              exactCrossSegmentSeek: true,
              masterPlayPauseAndSpeed: true,
              gapContinuesOnMaster: true,
              recordedEventSeeksMaster: true,
              detachmentClearsVideo: true,
              parentFooterSelectsDecodedMoment: true,
              noDuplicateChildAsk: true,
              pendingSelectionDisablesFooter: true,
              stalePortCannotAskNewFrame: true,
              detachedAskIgnored: true,
              selectedOffsetMs: captured?.offsetMs,
              selectionWrites: selectionWrites.mock.calls.length,
              standaloneRetainsControls: true,
              liveCalls,
              mediaReads,
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
      await rm(directory, { recursive: true, force: true })
    }
  },
  60000
)
