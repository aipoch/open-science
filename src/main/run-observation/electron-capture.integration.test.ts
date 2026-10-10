import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { _electron } from '@playwright/test'
import { afterEach, expect, it } from 'vitest'

const enabled =
  process.env.RUN_OBSERVATION_ELECTRON_CAPTURE === '1' && process.platform === 'darwin'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function serve(html: string): Promise<string> {
  const server: Server = createServer((_req, response) => {
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
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

it.skipIf(!enabled)(
  'calibrates real Electron frame pixels at non-100% zoom and enforces the foreground gate',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'observation-visible-capture-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const project = await serve(
      `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(0,180,70)}#left{position:absolute;inset:0 auto 0 0;width:20%;background:rgb(220,20,20)}#right{position:absolute;inset:0 0 0 auto;width:20%;background:rgb(20,30,220)}</style></head><body><div id="left"></div><div id="right"></div></body></html>`
    )
    const viewer = await serve(
      `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:magenta}iframe{position:absolute;left:40px;top:72px;width:320px;height:180px;border:0}</style></head><body><iframe id="project" src="${project}/" sandbox="allow-scripts allow-same-origin"></iframe></body></html>`
    )
    const html = join(directory, 'index.html')
    await writeFile(
      html,
      `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:yellow}iframe{position:absolute;left:80px;top:60px;width:600px;height:400px;border:0}</style></head><body><iframe id="viewer" src="${viewer}/"></iframe></body></html>`
    )
    const bundle = join(directory, 'capture.cjs')
    await build({
      entryPoints: ['src/main/run-observation/electron-capture.ts'],
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
      `const {app,BrowserWindow,nativeImage,webContents}=require('electron');
    const {captureElectronObservationView,createElectronProjectCapture}=require(${JSON.stringify(bundle)});
    let w; app.whenReady().then(async()=>{app.setActivationPolicy('regular'); w=new BrowserWindow({show:true,width:1100,height:850,
      webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
      await w.loadFile(${JSON.stringify(html)}); w.webContents.setZoomFactor(1.25); app.focus({steal:true}); w.show(); w.focus();
      const testWindow={isDestroyed:()=>w.isDestroyed(),isVisible:()=>w.isVisible(),isMinimized:()=>w.isMinimized(),isFocused:()=>true};
      const calibrate=createElectronProjectCapture({fromId:id=>webContents.fromId(id),windowFor:()=>testWindow});
      globalThis.captureVisibleProject=async(mode)=>{
        const id=String(w.webContents.id);
        const capture=mode==='calibrate'?calibrate:captureElectronObservationView;
        const {bytes}=await capture({caller:{clientId:id,lifecycleClientId:'electron:'+id,leaseId:'electron:'+id,
          surface:'electron',location:'local',principalKind:'human',actionOrigin:'human',authorities:[],isAuthorizationCurrent:()=>true},
          viewerOrigin:${JSON.stringify(viewer)},projectOrigin:${JSON.stringify(project)},signal:new AbortController().signal});
        const image=nativeImage.createFromBuffer(Buffer.from(bytes)); const size=image.getSize(); const bitmap=image.toBitmap();
        const sample=(x,y)=>{const i=(Math.floor(y)*size.width+Math.floor(x))*4;return [bitmap[i+2],bitmap[i+1],bitmap[i]]};
        return {size,left:sample(size.width*0.1,size.height/2),middle:sample(size.width/2,size.height/2),right:sample(size.width*0.9,size.height/2)};
      };
    }); app.on('window-all-closed',()=>app.quit());`
    )
    const app = await _electron.launch({ args: [main], cwd: process.cwd() })
    cleanups.push(() => app.close())
    const page = await app.firstWindow()
    await page
      .frameLocator('#viewer')
      .frameLocator('#project')
      .locator('#right')
      .waitFor({ state: 'visible' })
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (globalThis as unknown as { captureVisibleProject?: unknown })
              .captureVisibleProject
        )
      )
      .toBe('function')
    let mode: 'strict' | 'calibrate' = 'strict'
    const capture = (): Promise<unknown> =>
      app.evaluate(
        async (_electron, mode) =>
          (
            globalThis as unknown as { captureVisibleProject(mode: string): Promise<unknown> }
          ).captureVisibleProject(mode),
        mode
      )
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0].show()
      BrowserWindow.getAllWindows()[0].focus()
    })
    if (process.env.RUN_OBSERVATION_CAPTURE_WAIT_FOR_FOCUS === '1') {
      await expect
        .poll(
          () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
          { timeout: 60_000 }
        )
        .toBe(true)
    }
    const visible = await app.evaluate(({ BrowserWindow }) => ({
      visible: BrowserWindow.getAllWindows()[0].isVisible(),
      focused: BrowserWindow.getAllWindows()[0].isFocused()
    }))
    expect(visible.visible).toBe(true)
    if (!visible.focused) {
      await expect(capture()).rejects.toThrow('Visible project frame')
      // Some CI/remote macOS desktops prohibit foreground activation. Keep the production
      // denial verified; only compositor-coordinate calibration uses a test foreground predicate.
      mode = 'calibrate'
      console.warn(
        'Electron foreground activation unavailable: real pixels/DOM/zoom are verified with an injected foreground predicate; production foreground acceptance remains outstanding.'
      )
    }
    const observed = (await capture()) as {
      size: { width: number; height: number }
      left: number[]
      middle: number[]
      right: number[]
    }
    expect(observed.size.width / observed.size.height).toBeCloseTo(320 / 180, 2)
    // Compositor color-profile conversion can round a channel by one or two levels.
    for (const [actual, expected] of [
      [observed.left, [220, 20, 20]],
      [observed.middle, [0, 180, 70]],
      [observed.right, [20, 30, 220]]
    ]) {
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(2)
    }
    for (const frame of [page, page.frames().find((frame) => frame.url().startsWith(viewer))!]) {
      await frame.evaluate(() => {
        const cover = document.createElement('div')
        cover.id = 'cover'
        cover.style.cssText =
          'position:fixed;inset:0;background:red;z-index:99999;pointer-events:none'
        document.body.append(cover)
      })
      await expect(capture()).rejects.toThrow()
      await frame.evaluate(async () => {
        document.getElementById('cover')!.remove()
        // DOM removal precedes compositor submission. Let the actual frame paint again
        // before asserting restored pixels; capture must still reject the overlays above.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      })
    }
    expect(await capture()).toEqual(observed)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    await expect(capture()).rejects.toThrow()
    await writeFile(
      join(tmpdir(), 'open-science-observation-capture-acceptance.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          mode,
          productionForegroundVerified: mode === 'strict',
          zoomFactor: 1.25,
          webSecurity: true,
          realCompositorPixelsVerified: true,
          rootAndViewerPointerTransparentOverlaysRejected: true,
          hiddenWindowRejected: true,
          observed
        },
        null,
        2
      )
    )
  },
  90_000
)
