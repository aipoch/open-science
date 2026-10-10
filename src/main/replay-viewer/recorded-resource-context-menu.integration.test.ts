import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron, type ElectronApplication } from '@playwright/test'
import { expect, it } from 'vitest'

const enabled =
  process.env.RUN_RECORDED_RESOURCE_CONTEXT_MENU === '1' && process.platform === 'darwin'

/** Real opaque iframe clicks at non-default Electron zoom; no synthetic context-menu events. */
it.skipIf(!enabled)(
  'keeps saved HTML native passthrough while retaining the trusted preview bridge at 125% zoom',
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'os-recorded-menu-')))
    let electron: ElectronApplication | undefined
    try {
      const html = join(directory, 'index.html')
      const source = await readFile(resolve('src/renderer/index.html'), 'utf8')
      const csp = source.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
      expect(csp).toBeDefined()
      await writeFile(
        html,
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0}#root{position:absolute;left:30px;top:20px;width:500px;height:280px}#root iframe{height:210px;width:100%;border:0}#trusted{position:absolute;left:30px;top:340px;width:500px;height:140px;border:0}</style><div id="root"></div><iframe id="trusted" src="open-science-preview://fixture/report.html"></iframe><script src="./renderer.js"></script>`
      )
      await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'recorded-resource-menu-fixture.tsx',
          loader: 'tsx',
          contents: `
import {createRoot} from 'react-dom/client'
import {createInstance} from 'i18next'
import {initReactI18next} from 'react-i18next'
import {ActionMenuProvider,ActionMenuTarget} from './src/renderer/src/components/action-menu'
import {PreviewActionMenuAdapterProvider} from './src/renderer/src/pages/workspace/preview-actions/preview-action-adapter'
import {PREVIEW_CAPABILITY_CATALOG,shouldHandlePreviewContextMenu} from './src/renderer/src/pages/workspace/preview-actions/preview-action-model'
import {RecordedResourcePreview} from './src/renderer/src/pages/workspace/replay/results/RecordedResourcePreview'
createInstance().use(initReactI18next).init({lng:'en',fallbackLng:'en',resources:{},keySeparator:false,nsSeparator:false,initImmediate:false})
const resource={id:'evidence',source:'artifact',availability:'recorded',name:'saved.html',mimeType:'text/html',projectId:'p',sessionId:'s',artifactId:'a',versionId:'v'}
const read=async()=>({mimeType:'text/html',truncated:false,content:'<p id="saved">Saved evidence</p><input id="editable" value="Native text"><script>document.body.dataset.executed="yes"<\\/script><a href="https://invalid.test/">No navigation</a>'})
createRoot(document.getElementById('root')).render(<ActionMenuProvider testId="app-menu"><PreviewActionMenuAdapterProvider targetId="file"><ActionMenuTarget targetId="file" identityKey="evidence" catalog={PREVIEW_CAPABILITY_CATALOG} recipe={[{kind:'action',action:'copy-path'}]} bindings={{'copy-path':{execute:()=>undefined}}} invocation={undefined} shouldHandleContextMenu={shouldHandlePreviewContextMenu} asChild><div><RecordedResourcePreview resource={resource} read={read}/></div></ActionMenuTarget></PreviewActionMenuAdapterProvider></ActionMenuProvider>)
`
        },
        outfile: join(directory, 'renderer.js'),
        bundle: true,
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        alias: { '@': resolve('src/renderer/src') },
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'silent'
      })
      await writeFile(
        join(directory, 'preload.cjs'),
        `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{platform:'darwin',previewContextMenu:{onRequested(listener){const wrapped=(_event,payload)=>listener(payload);ipcRenderer.on('preview-context-menu:requested',wrapped);return()=>ipcRenderer.removeListener('preview-context-menu:requested',wrapped)}}})`
      )
      const main = join(directory, 'main.cjs')
      await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'recorded-resource-menu-main.ts',
          loader: 'ts',
          contents: `
import {app,BrowserWindow,protocol} from 'electron'
import {installPreviewContextMenuBridge} from './src/main/preview-context-menu'
import {createFrameNavigationGuard} from './src/main/navigation-policy'
protocol.registerSchemesAsPrivileged([{scheme:'open-science-preview',privileges:{standard:true,secure:true,supportFetchAPI:true}}])
app.whenReady().then(async()=>{
protocol.handle('open-science-preview',()=>new Response('<!doctype html><p id="managed">Managed preview</p><p id="passthrough" data-preview-context-menu-passthrough>Native area</p>',{headers:{'Content-Type':'text/html'}}))
const window=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{preload:${JSON.stringify(join(directory, 'preload.cjs'))},contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}})
const wc=window.webContents, native=[], sent=[]
const guard=createFrameNavigationGuard()
wc.on('will-frame-navigate',details=>{if(!guard(details.url,details.isMainFrame,wc.getURL(),details.frame))details.preventDefault()})
wc.on('context-menu',(_event,p)=>native.push({url:p.frame?.url,editable:p.isEditable}))
const dispose=installPreviewContextMenuBridge({get mainFrame(){return wc.mainFrame},getZoomFactor:()=>wc.getZoomFactor(),on:(e,l)=>wc.on(e,l),removeListener:(e,l)=>wc.removeListener(e,l),send:(channel,payload)=>{sent.push(payload);wc.send(channel,payload)}})
window.on('closed',dispose)
globalThis.fixture={native,sent,zoom:()=>wc.getZoomFactor()}
await window.loadFile(${JSON.stringify(html)});wc.setZoomFactor(1.25)
})
app.on('window-all-closed',()=>app.quit())
`
        },
        outfile: main,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        logLevel: 'silent'
      })
      electron = await _electron.launch({ args: [main], cwd: process.cwd() })
      const page = await electron.firstWindow()
      const menus = (): Promise<{
        native: Array<{ url: string; editable: boolean }>
        sent: Array<{ frameUrl: string; x: number; y: number }>
        zoom: number
      }> =>
        electron!.evaluate(() => {
          const fixture = (
            globalThis as unknown as {
              fixture: { native: unknown[]; sent: unknown[]; zoom(): number }
            }
          ).fixture
          return { native: fixture.native, sent: fixture.sent, zoom: fixture.zoom() }
        }) as ReturnType<typeof menus>
      await expect.poll(async () => (await menus()).zoom).toBe(1.25)
      const frame = page.frameLocator('iframe[title="saved.html"]')
      await expect.poll(async () => frame.locator('#saved').textContent()).toBe('Saved evidence')
      expect(await page.locator('iframe[title="saved.html"]').getAttribute('sandbox')).toBe('')
      expect(
        await page
          .locator('iframe[title="saved.html"]')
          .getAttribute('data-preview-context-menu-passthrough')
      ).not.toBeNull()
      expect(await frame.locator('script').count()).toBe(0)
      expect(await frame.locator('a').getAttribute('href')).toBeNull()
      await frame.locator('#saved').click({ button: 'right' })
      await expect.poll(async () => (await menus()).native.length).toBe(1)
      expect((await menus()).native[0]).toMatchObject({ url: 'about:srcdoc', editable: false })
      expect((await menus()).sent).toEqual([])
      await frame.locator('#editable').click({ button: 'right' })
      await expect.poll(async () => (await menus()).native.length).toBe(2)
      expect((await menus()).native[1].editable).toBe(true)
      expect((await menus()).sent).toEqual([])
      expect(await page.getByTestId('app-menu').count()).toBe(0)
      await expect
        .poll(() => page.frames().some((item) => item.url().startsWith('open-science-preview:')))
        .toBe(true)
      const trusted = page.frames().find((item) => item.url().startsWith('open-science-preview:'))!
      const clickTrusted = async (id: string): Promise<{ x: number; y: number }> => {
        const point = await trusted.evaluate((id) => {
          const rect = document.getElementById(id)!.getBoundingClientRect()
          return { x: rect.left + 10, y: rect.top + 8 }
        }, id)
        const rootPoint = { x: 30 + point.x, y: 340 + point.y }
        await page.mouse.click(rootPoint.x, rootPoint.y, { button: 'right' })
        return rootPoint
      }
      const point = await clickTrusted('managed')
      await expect.poll(async () => (await menus()).sent.length).toBe(1)
      const sent = (await menus()).sent[0]
      expect(sent.frameUrl).toBe('open-science-preview://fixture/report.html')
      expect(Math.abs(sent.x - point.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(sent.y - point.y)).toBeLessThanOrEqual(1)
      await clickTrusted('passthrough')
      await expect.poll(async () => (await menus()).native.length).toBe(4)
      await electron.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      })
      expect((await menus()).sent).toHaveLength(1)
    } finally {
      await electron?.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  60000
)
