import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { _electron } from '@playwright/test'
import { afterEach, expect, it } from 'vitest'

const enabled = process.env.RUN_BROWSER_RECORDING_ELECTRON === '1' && process.platform === 'darwin'
const soakMs = Math.min(900_000, Math.max(0, Number(process.env.BROWSER_RECORDING_SOAK_MS) || 0))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function serve(html: string): Promise<{ origin: string; requests: () => number }> {
  let requests = 0
  const server: Server = createServer((_req, response) => {
    requests++
    response.setHeader('Content-Type', 'text/html')
    response.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests: () => requests
  }
}

it.skipIf(!enabled)(
  'records the existing DOM and Canvas surface without reload, masks inputs, and discloses visibility gaps',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-recording-electron-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const project = await serve(
      `<!doctype html><style>html,body{margin:0;background:rgb(0,180,70);width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}button{position:absolute;left:12px;top:12px}input{position:absolute;left:12px;top:50px;width:160px;height:30px;border:0;background:white;color:red}</style><canvas width="640" height="360"></canvas><button>Click me</button><div id="scrollable" style="position:absolute;bottom:0;left:0;width:10px;height:10px;overflow:auto"><div style="height:1000px"></div></div><input value="must-never-record-this"><script>const canvas=document.querySelector('canvas'),c=canvas.getContext('2d');let f=0;function frame(){globalThis.animationFrames=f;c.fillStyle='rgb(0,180,70)';c.fillRect(0,0,640,360);c.fillStyle='rgb(220,20,20)';c.fillRect((f++*2)%560,140,80,80);requestAnimationFrame(frame)}frame();document.querySelector('button').onclick=e=>{e.target.textContent='Clicked';history.pushState({},'', '?run=fixture&tab=diagnostics&token=must-not-store');};</script>`
    )
    const viewer = await serve(
      `<!doctype html><style>html,body{margin:0;background:magenta;width:100%;height:100%}iframe{position:absolute;left:40px;top:42px;width:640px;height:360px;border:0}</style><iframe id="project" src="${project.origin}/" sandbox="allow-scripts allow-forms allow-same-origin"></iframe>`
    )
    const root = join(directory, 'index.html')
    await writeFile(
      root,
      `<!doctype html><style>html,body{margin:0;background:yellow;width:100%;height:100%}iframe{position:absolute;left:60px;top:40px;width:760px;height:470px;border:0}</style><iframe id="viewer" src="${viewer.origin}/"></iframe>`
    )
    const mediaDirectory = process.env.BROWSER_RECORDING_MEDIA_DIR ?? directory
    await mkdir(mediaDirectory, { recursive: true })
    const bundle = join(directory, 'driver.cjs')
    await build({
      entryPoints: ['src/main/browser-recordings/electron-surface-driver.ts'],
      outfile: bundle,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      external: ['electron'],
      logLevel: 'silent'
    })
    const main = join(directory, 'main.cjs')
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron');const {writeFile}=require('node:fs/promises');const {startElectronSurfaceRecording}=require(${JSON.stringify(bundle)});let window,handle,peer;const segments=[],events=[],gaps=[],resourceSamples=[],ended=[];let phase='baseline';const testStarted=Date.now();app.whenReady().then(async()=>{app.setActivationPolicy('regular');setInterval(()=>{const metrics=app.getAppMetrics();resourceSamples.push({offsetMs:Date.now()-testStarted,phase,processes:metrics.map(p=>({type:p.type,workingSetKiB:p.memory.workingSetSize,cpuPercent:p.cpu.percentCPUUsage})),workingSetKiB:metrics.reduce((n,p)=>n+p.memory.workingSetSize,0),cpuPercent:metrics.reduce((n,p)=>n+p.cpu.percentCPUUsage,0)});},1000).unref();window=new BrowserWindow({show:true,width:1220,height:920,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});await window.loadFile(${JSON.stringify(root)});window.webContents.setZoomFactor(1.25);app.focus({steal:true});window.show();window.focus();globalThis.startRecording=async()=>{ended.length=0;phase='recording';const id=String(window.webContents.id);handle=await startElectronSurfaceRecording({caller:{clientId:id,lifecycleClientId:'electron:'+id,leaseId:'electron:'+id,surface:'electron',location:'local',principalKind:'human',actionOrigin:'human',authorities:[],isAuthorizationCurrent:()=>true},viewerOrigin:${JSON.stringify(viewer.origin)},projectOrigin:${JSON.stringify(project.origin)},signal:new AbortController().signal,segmentDurationMs:2000,onSegment:async(segment)=>{await writeFile(${JSON.stringify(mediaDirectory)}+'/segment-'+segments.length+'.webm',segment.bytes);segments.push({...segment,bytes:segment.bytes.byteLength});},onEvent:event=>events.push(event),onGap:gap=>gaps.push(gap),onEnded:reason=>ended.push(reason)});};globalThis.control=async action=>{if(action==='hide')window.hide();else if(action==='show'){app.focus({steal:true});window.show();window.focus();}else if(action==='blur'){const b=window.getBounds();peer=new BrowserWindow({show:true,x:b.x+300,y:b.y+180,width:200,height:160,webPreferences:{sandbox:true,nodeIntegration:false}});await peer.loadURL('data:text/html,<body style="background:orange">Another application surface</body>');peer.focus();}else if(action==='focus'){peer?.destroy();window.focus();}else if(action==='resize'){const [w,h]=window.getContentSize();window.setContentSize(w+20,h);}else if(action==='remove')await window.webContents.executeJavaScript("document.querySelector('#viewer').remove()");else if(action!=='inspect')await handle[action]();return {segments,events,gaps,resourceSamples,ended,focused:window.isFocused(),diagnostics:handle.diagnostics()};};});app.on('window-all-closed',()=>app.quit());`
    )
    const app = await _electron.launch({ args: [main], cwd: process.cwd() })
    cleanups.push(() => app.close())
    const page = await app.firstWindow()
    await page
      .frameLocator('#viewer')
      .frameLocator('#project')
      .locator('button')
      .waitFor({ state: 'visible' })
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()))
      .toBe(true)
    const animation = (): Promise<{ frames: number; time: number }> =>
      page
        .frameLocator('#viewer')
        .frameLocator('#project')
        .locator('canvas')
        .evaluate(() => ({
          frames: (globalThis as unknown as { animationFrames: number }).animationFrames,
          time: performance.now()
        }))
    const baselineStart = await animation()
    await page.waitForTimeout(2000)
    const baselineEnd = await animation()
    const beforeRequests = project.requests()
    const navigation = await page
      .frameLocator('#viewer')
      .frameLocator('#project')
      .locator('canvas')
      .evaluate(() => performance.timeOrigin)
    await app.evaluate(async () =>
      (globalThis as unknown as { startRecording(): Promise<void> }).startRecording()
    )
    const recordingStart = await animation()
    await page.waitForTimeout(Math.max(2500, soakMs))
    const recordingEnd = await animation()
    await page.frameLocator('#viewer').frameLocator('#project').locator('button').click()
    await page.waitForTimeout(1800)
    const control = (
      action: string
    ): Promise<{
      segments: { bytes: number; startMs: number; endMs: number; width: number; height: number }[]
      events: unknown[]
      gaps: { reason: string; startMs: number; endMs: number }[]
      focused: boolean
      ended: string[]
      diagnostics: { presentedFrames: number; encodedFrames: number; droppedFrames: number }
    }> =>
      app.evaluate(
        async (_electron, action) =>
          (globalThis as unknown as { control(action: string): Promise<never> }).control(action),
        action
      )
    await control('pause')
    await page.frameLocator('#viewer').frameLocator('#project').locator('button').click()
    await page
      .frameLocator('#viewer')
      .frameLocator('#project')
      .locator('#scrollable')
      .evaluate((element) => {
        element.scrollTop = 25
        history.pushState({}, '', '?tab=paused&token=must-not-store')
      })
    await page.waitForTimeout(700)
    await control('resume')
    await page.waitForTimeout(1800)
    const blurred = await control('blur')
    expect(blurred.focused).toBe(false)
    await page.waitForTimeout(2100)
    const refocused = await control('focus')
    expect(
      refocused.diagnostics.encodedFrames - blurred.diagnostics.encodedFrames
    ).toBeGreaterThanOrEqual(15)
    await control('hide')
    await page
      .frameLocator('#viewer')
      .frameLocator('#project')
      .locator('#scrollable')
      .evaluate((element) => {
        element.scrollTop = 50
        history.pushState({}, '', '?tab=hidden&token=must-not-store')
      })
    await page.waitForTimeout(700)
    await control('show')
    await page.waitForTimeout(1600)
    const result = await control('stop')
    expect(project.requests()).toBe(beforeRequests)
    expect(
      await page
        .frameLocator('#viewer')
        .frameLocator('#project')
        .locator('canvas')
        .evaluate(() => performance.timeOrigin)
    ).toBe(navigation)
    expect(result.ended).toEqual([])
    expect(
      result.events.filter((event) => (event as { kind: string }).kind === 'click')
    ).toHaveLength(1)
    expect(
      result.events.filter((event) => (event as { kind: string }).kind === 'scroll')
    ).toHaveLength(0)
    expect(
      result.events.filter((event) => (event as { kind: string }).kind === 'navigation')
    ).toHaveLength(1)
    expect(JSON.stringify(result.events)).not.toContain('must-not-store')
    expect(result.segments.length, JSON.stringify(result)).toBeGreaterThanOrEqual(3)
    expect(
      result.segments.every(
        (segment) => segment.bytes > 1000 && segment.width === 1280 && segment.height === 720
      )
    ).toBe(true)
    for (const gap of result.gaps)
      expect(
        result.segments.some(
          (segment) => gap.startMs < segment.endMs && gap.endMs > segment.startMs
        )
      ).toBe(false)
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'click', source: 'browser-observed' }),
        expect.objectContaining({ kind: 'navigation', source: 'host-observed' })
      ])
    )
    expect(result.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'paused' })])
    )
    expect(result.gaps).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'hidden' })])
    )
    const media = (await readFile(join(mediaDirectory, 'segment-0.webm'))).toString('base64')
    const decoded = await page.evaluate(async (base64) => {
      const data = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([data], { type: 'video/webm' }))
      const video = document.createElement('video')
      video.muted = true
      video.src = url
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve()
        video.onerror = () => reject(new Error('decode failed'))
      })
      await video.play()
      await new Promise<void>((resolve) => setTimeout(resolve, 350))
      video.pause()
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')!
      context.drawImage(video, 0, 0)
      const pixel = (x: number, y: number): number[] =>
        Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
      const result = {
        width: canvas.width,
        height: canvas.height,
        private: pixel(80, 130),
        background: pixel(1200, 650)
      }
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      return result
    }, media)
    console.info('Decoded compositor pixels', JSON.stringify(decoded))
    expect(decoded.private.every((value) => value < 20)).toBe(true)
    expect(decoded.background[1]).toBeGreaterThan(150)
    expect(decoded.background[1] - decoded.background[0]).toBeGreaterThan(60)
    expect(decoded.background[1] - decoded.background[2]).toBeGreaterThan(60)
    if (process.env.BROWSER_RECORDING_EVIDENCE)
      await writeFile(
        process.env.BROWSER_RECORDING_EVIDENCE,
        JSON.stringify(
          {
            ...result,
            decoded,
            baselineAnimationFps:
              (1000 * (baselineEnd.frames - baselineStart.frames)) /
              (baselineEnd.time - baselineStart.time),
            recordingAnimationFps:
              (1000 * (recordingEnd.frames - recordingStart.frames)) /
              (recordingEnd.time - recordingStart.time),
            requests: project.requests(),
            unfocusedFrames: refocused.diagnostics.encodedFrames - blurred.diagnostics.encodedFrames
          },
          null,
          2
        )
      )
    for (const action of ['reload', 'resize', 'remove']) {
      await app.evaluate(async () =>
        (globalThis as unknown as { startRecording(): Promise<void> }).startRecording()
      )
      await page.waitForTimeout(450)
      const beforeDocument = await page
        .frameLocator('#viewer')
        .frameLocator('#project')
        .locator('canvas')
        .evaluate(() => performance.timeOrigin)
      if (action === 'reload')
        await page
          .frameLocator('#viewer')
          .frameLocator('#project')
          .locator('button')
          .evaluate(() => location.reload())
      else await control(action)
      await expect
        .poll(async () => (await control('inspect')).ended, { message: action, timeout: 5000 })
        .toEqual(['source-lost'])
      await control('stop')
      if (action === 'reload') {
        await page.frameLocator('#viewer').frameLocator('#project').locator('button').waitFor()
        expect(
          await page
            .frameLocator('#viewer')
            .frameLocator('#project')
            .locator('canvas')
            .evaluate(() => performance.timeOrigin)
        ).not.toBe(beforeDocument)
      }
    }
    console.info(
      'Browser recording real compositor evidence',
      JSON.stringify({ ...result, decoded })
    )
  },
  60_000 + soakMs
)
