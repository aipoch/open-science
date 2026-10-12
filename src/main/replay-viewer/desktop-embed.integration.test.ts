import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { _electron, type ElectronApplication } from '@playwright/test'
import { expect, it } from 'vitest'

const enabled = process.env.RUN_OBSERVATION_DESKTOP_EMBED === '1' && process.platform === 'darwin'

it.skipIf(!enabled)(
  'binds an independent Node viewer to the actual desktop document UUID across refresh and revocation',
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'os-service-run-')))
    let electron: ElectronApplication | undefined
    try {
      const html = join(directory, 'index.html')
      const source = await readFile(resolve('src/renderer/index.html'), 'utf8')
      const csp = source.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
      expect(csp).toBeDefined()
      await writeFile(
        html,
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body style="margin:0"><iframe id="viewer" title="Node viewer" sandbox="allow-scripts allow-same-origin allow-forms" style="display:block;border:0;margin:2px;width:calc(100% - 4px);height:45vh"></iframe><iframe id="trusted" title="Existing preview" src="open-science-preview://fixture/report.html" style="border:0;position:absolute;left:30px;top:550px;width:700px;height:100px"></iframe></body></html>`
      )
      await writeFile(
        join(directory, 'preload.cjs'),
        "const {ipcRenderer}=require('electron');window.addEventListener('DOMContentLoaded',()=>ipcRenderer.invoke('projects:list'))"
      )
      const backend = join(directory, 'backend.cjs')
      await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'independent-viewer-backend.ts',
          loader: 'ts',
          contents: `
import {createServer} from 'node:http'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createDesktopObservationBridge} from './src/main/observation-desktop/bridge'
import {parseRpcJson,stringifyRpcJson} from './src/main/rpc-json'
import {ReplayViewerHttpHost} from './src/main/replay-viewer/http-host'
import {createReplayViewerAssetReader} from './src/main/replay-viewer/assets'
import {ManagedRuntimeViews} from './src/main/managed-runtime-views'
import {RuntimeViewOwner} from './src/main/runtime-view/owner'
import {RunObservationOwner} from './src/main/run-observation/owner'
import {ObservationViewers} from './src/main/run-observation/viewers'
import {createCallerContext} from './src/main/caller-context'
let sequence=0
const pending=new Map(), callers=new Map(), projectOrigins=new Map()
const send=message=>{if(process.connected)process.send(stringifyRpcJson(message))}
const bridge=createDesktopObservationBridge((operation,clientId,signal)=>new Promise((resolve,reject)=>{
 const id=++sequence
 const aborted=()=>{pending.delete(id);reject(new Error('native request aborted'))}
 signal?.addEventListener('abort',aborted,{once:true})
 pending.set(id,{resolve:value=>{signal?.removeEventListener('abort',aborted);resolve(value)},reject:error=>{signal?.removeEventListener('abort',aborted);reject(error)}})
 send({kind:'native',id,operation,clientId})
}))
const scope={projectId:'node-project',sessionId:'node-session',runId:'run',environmentId:'environment',generationId:randomUUID()}
const target={projectId:scope.projectId,sessionId:scope.sessionId,runId:scope.runId}
const socketPath=join(${JSON.stringify(directory)},'service.sock'), lifetime=new AbortController()
const project=createServer((request,response)=>{
 if(request.url==='/__proof'){response.end('a'.repeat(64));return}
 response.setHeader('content-type','text/html')
 response.end('<!doctype html><p id="ready">Independent Node project</p><a id="next" href="/next">Next recorded page</a>')
})
const projectViews=new ManagedRuntimeViews(new RuntimeViewOwner({},bridge.frames))
const openProject=projectViews.open.bind(projectViews)
projectViews.open=async(...args)=>{try{const result=await openProject(...args);projectOrigins.set(args[1],new URL(result.url).origin);return result}catch(error){send({kind:'error',message:String(error)});throw error}}
const observation=new RunObservationOwner({authorize:(target,viewer)=>viewers.assertViewer(target,viewer),read:async()=>({identity:target,phase:'running',artifacts:[],run:{runId:'run',cellId:'cell',source:'agent',kernelKind:'bash',script:'printf observed',status:'running',startedAt:1,text:{stdout:'ready',stderr:'',traceback:'',plain:[]},outputs:[],workingFiles:[]}})})
const viewers=new ObservationViewers({observer:observation,authorizeScope:async()=>undefined,onRevoked:id=>host.closeViewer(id)})
const host=new ReplayViewerHttpHost({viewers,projectViews,desktopFrames:bridge.frames,desktopLocale:()=> 'en',readAsset:createReplayViewerAssetReader(${JSON.stringify(resolve('out/replay-viewer'))})})
const ready=new Promise(resolve=>project.listen(socketPath,resolve)).then(()=>projectViews.register({scope,declaration:{title:'Node project',entryPath:'/',adaptFrameAncestors:true},socketPath,proof:{path:'/__proof',value:'a'.repeat(64)},logicalPort:4173,signal:lifetime.signal}))
const close=async()=>{await host.close();await viewers.close();await projectViews.close();observation.close();bridge.close();lifetime.abort();project.closeAllConnections();project.close(()=>process.exit(0))}
process.once('disconnect',()=>{void close()})
process.on('message',async encoded=>{
 const message=parseRpcJson(encoded)
 try{
  if(message.kind==='native-result'){const request=pending.get(message.id);pending.delete(message.id);if(message.error)request?.reject(new Error(message.error));else request?.resolve(message.result);return}
  if(message.kind==='release'){const state=callers.get(message.clientId);if(state)state.current=false;return}
  if(message.kind==='open'){
   await ready
   const state={current:true};callers.set(message.clientId,state)
   const caller=createCallerContext({clientId:message.clientId,lifecycleClientId:message.clientId,leaseId:message.clientId,surface:'electron',location:'local',principalKind:'human',actionOrigin:'human',isAuthorizationCurrent:()=>state.current})
   const access=await host.open(target,caller,{allowInteraction:true,desktopParent:'file:'});state.caller=caller;state.access=access
   send({kind:'opened',clientId:message.clientId,url:access.url,pid:process.pid});return
  }
  if(message.kind==='capture'){
   try{const state=callers.get(message.clientId);const result=await bridge.capture({caller:state.caller,viewerOrigin:new URL(state.access.url).origin,projectOrigin:projectOrigins.get(state.access.viewerId),signal:new AbortController().signal});if(!(result.bytes instanceof Uint8Array))throw new Error('Binary bytes were not preserved');const bytes=Buffer.from(result.bytes);send({kind:'captured',id:message.id,sizeBytes:bytes.length,signature:bytes.subarray(0,8).toString('hex'),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)})}catch(error){send({kind:'captured',id:message.id,error:String(error)})}
  }
  if(message.kind==='close')await close()
 }catch(error){send({kind:'error',message:String(error)})}
})
`
        },
        outfile: backend,
        platform: 'node',
        format: 'cjs',
        bundle: true,
        logLevel: 'silent'
      })
      const main = join(directory, 'main.cjs')
      await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'independent-viewer-desktop.ts',
          loader: 'ts',
          contents: `
import {app,BrowserWindow,protocol,webFrameMain,ipcMain} from 'electron'
import {configureIpcHandlerRegistry} from './src/main/ipc-handler-registry'
import {initLogger} from './src/main/logger'
import {fork} from 'node:child_process'
import {parseRpcJson,stringifyRpcJson} from './src/main/rpc-json'
import {installDesktopRuntimeElectronAdapter} from './src/main/desktop-runtime-electron-adapter'
import {createDesktopObservationNativeHandler} from './src/main/observation-desktop/electron'
import {desktopObservationFrameRegistry} from './src/main/replay-viewer/desktop-frame-registry'
import {createFrameNavigationGuard} from './src/main/navigation-policy'
import {installPreviewContextMenuBridge} from './src/main/preview-context-menu'
protocol.registerSchemesAsPrivileged([{scheme:'open-science-preview',privileges:{standard:true,secure:true,supportFetchAPI:true}}])
const windows=[],menus=[],nativeMenus=[],decisions=[],errors=[],opens=[],released=[]
let relay,child,native,owner
const waiting=new Map()
function createWindow(preload){
 const window=new BrowserWindow({show:false,width:1200,height:950,webPreferences:{...(preload?{preload:${JSON.stringify(join(directory, 'preload.cjs'))}}:{}),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}})
 windows.push(window)
 const wc=window.webContents
 const guard=createFrameNavigationGuard((url,frame)=>desktopObservationFrameRegistry.allows({url,frame,webContentsId:wc.id,mainFrame:wc.mainFrame}))
 const enforce=(details,processId,routingId)=>{const frame=details.frame?.frameTreeNodeId!==undefined?details.frame:webFrameMain.fromId(details.processId??processId,details.routingId??routingId);const allowed=guard(details.url,details.isMainFrame,wc.getURL(),frame);decisions.push({allowed,windowId:wc.id,url:details.url.split('?')[0]});if(!allowed)details.preventDefault()}
 wc.on('will-frame-navigate',details=>enforce(details))
 wc.on('will-redirect',(details,_url,_inPlace,_main,processId,routingId)=>enforce(details,processId,routingId))
 wc.on('context-menu',(_event,params)=>nativeMenus.push({url:params.frame?.url,editable:params.isEditable}))
 const dispose=installPreviewContextMenuBridge({get mainFrame(){return wc.mainFrame},getZoomFactor:()=>wc.getZoomFactor(),on:(e,l)=>wc.on(e,l),removeListener:(e,l)=>wc.removeListener(e,l),send:(channel,payload)=>{menus.push(payload);wc.send(channel,payload)}})
 window.on('closed',dispose)
 return window
}
app.whenReady().then(async()=>{
 initLogger({logDir:${JSON.stringify(directory)},mirrorToConsole:true})
 protocol.handle('open-science-preview',()=>new Response('<!doctype html><p id="managed">Managed preview</p><p id="passthrough" data-preview-context-menu-passthrough>Native menu area</p>',{headers:{'content-type':'text/html'}}))
 child=fork(${JSON.stringify(backend)},[],{execPath:${JSON.stringify(process.execPath)},stdio:['ignore','pipe','pipe','ipc']})
 const send=message=>child.send(stringifyRpcJson(message))
 child.stderr.on('data',data=>{errors.push(String(data));console.error(String(data))})
 native=createDesktopObservationNativeHandler({documentFor:id=>relay?.documentFor(id)})
 child.on('message',async encoded=>{
  const message=parseRpcJson(encoded)
  if(message.kind==='native'){try{const result=await native.handle({clientId:message.clientId,request:message.operation.request},new AbortController().signal);send({kind:'native-result',id:message.id,result})}catch(error){send({kind:'native-result',id:message.id,error:String(error)})}return}
  if(message.kind==='opened'){opens.push(message);const resolve=waiting.get(message.clientId);waiting.delete(message.clientId);resolve?.(message);return}
  if(message.kind==='captured'){const resolve=waiting.get(message.id);waiting.delete(message.id);resolve?.(message);return}
  if(message.kind==='error'){errors.push(message.message);console.error(message.message)}
 })
 configureIpcHandlerRegistry(ipcMain)
 relay=installDesktopRuntimeElectronAdapter({commandNames:()=>['projects:list'],invoke:async(clientId)=>{const opened=new Promise(resolve=>waiting.set(clientId,resolve));send({kind:'open',clientId});const access=await opened;const wc=relay.documentFor(clientId);if(wc)await wc.executeJavaScript('document.getElementById("viewer").src='+JSON.stringify(access.url));return []},release:clientId=>{released.push(clientId);send({kind:'release',clientId})}},sender=>windows.some(window=>!window.isDestroyed()&&window.webContents===sender))
 owner=createWindow(true)
 globalThis.fixture={errors,opens,released,decisions,menus,nativeMenus,desktopPid:process.pid,show:async()=>{await owner.webContents.executeJavaScript('document.getElementById("viewer").style.height="calc(100vh - 4px)";document.getElementById("trusted").style.display="none"');app.setActivationPolicy('regular');owner.show();app.focus({steal:true});owner.focus()},focused:()=>owner.isFocused(),capture:()=>new Promise(resolve=>{const id='capture-'+Date.now();waiting.set(id,resolve);send({kind:'capture',id,clientId:opens[opens.length-1].clientId})}),zoom:async()=>{await owner.webContents.executeJavaScript('document.getElementById("viewer").style.height="45vh";document.getElementById("trusted").style.display="block"');owner.webContents.setZoomFactor(1.25)},other:async()=>{const other=createWindow(false);await other.loadFile(${JSON.stringify(html)});await other.webContents.executeJavaScript('document.getElementById("viewer").src='+JSON.stringify(new URL(opens[opens.length-1].url).origin+'/'));return other.webContents.id},oldDocumentAvailable:id=>!!relay.documentFor(id),reattach:async()=>{await native.close();native=createDesktopObservationNativeHandler({documentFor:id=>relay.documentFor(id)})},captureOld:async id=>{try{await native.handle({clientId:id,request:{method:'capture',viewerOrigin:new URL(opens[0].url).origin,projectOrigin:'http://rv-old.localhost:4173'}},new AbortController().signal);return 'unexpected-success'}catch{return 'rejected'}},close:async()=>{relay.uninstall();await native.close();send({kind:'close'});await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve()},2000);child.once('exit',()=>{clearTimeout(timer);resolve()})});for(const window of windows)if(!window.isDestroyed())window.destroy()}}
 await owner.loadFile(${JSON.stringify(html)})
}).catch(error=>{console.error(error);app.exit(1)})
app.on('window-all-closed',()=>app.quit())
`
        },
        outfile: main,
        platform: 'node',
        format: 'cjs',
        bundle: true,
        external: ['electron'],
        logLevel: 'silent'
      })
      electron = await _electron.launch({ args: [main], cwd: process.cwd() })
      const page = await electron.firstWindow()
      page.setDefaultTimeout(10_000)
      type State = {
        errors: string[]
        opens: Array<{ clientId: string; url: string; pid: number }>
        released: string[]
        desktopPid: number
        decisions: Array<{ allowed: boolean; windowId: number; url: string }>
        menus: Array<{ frameUrl: string; x: number; y: number }>
        nativeMenus: Array<{ url: string }>
        show(): void
        focused(): boolean
        capture(): Promise<{
          error?: string
          signature: string
          width: number
          height: number
          sizeBytes: number
        }>
        zoom(): void
        other(): Promise<number>
        oldDocumentAvailable(id: string): boolean
        reattach(): Promise<void>
        captureOld(id: string): Promise<string>
        close(): Promise<void>
      }
      const state = (): Promise<State> =>
        electron!.evaluate(() => {
          const { errors, opens, released, desktopPid, decisions, menus, nativeMenus } = (
            globalThis as unknown as { fixture: State }
          ).fixture
          return { errors, opens, released, desktopPid, decisions, menus, nativeMenus }
        }) as Promise<State>
      await expect
        .poll(async () => ({
          errors: (await state()).errors,
          opened: (await state()).opens.length
        }))
        .toEqual({ errors: [], opened: 1 })
      const viewer = page.frameLocator('#viewer')
      await viewer.getByRole('button', { name: 'Project interface', exact: true }).click()
      const project = viewer.frameLocator('iframe[title="Node project"]')
      await project.locator('#ready').waitFor()
      const initial = await state()
      expect(initial.errors).toEqual([])
      expect(initial.opens[0].clientId).toMatch(/^[0-9a-f-]{36}$/)
      expect(initial.opens[0].pid).not.toBe(initial.desktopPid)
      await project.locator('#next').click()
      await project.locator('#ready').waitFor()
      const actualViewer = page.frames().find((frame) => /^http:\/\/viewer-/.test(frame.url()))!
      await actualViewer.evaluate(() => location.reload())
      await viewer.getByRole('button', { name: 'Project interface', exact: true }).click()
      await project.locator('#ready').waitFor()
      expect((await state()).opens).toHaveLength(1)
      await electron.evaluate(() => (globalThis as unknown as { fixture: State }).fixture.show())
      await expect
        .poll(() =>
          electron!.evaluate(() => (globalThis as unknown as { fixture: State }).fixture.focused())
        )
        .toBe(true)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )

      const capture = await electron.evaluate(() =>
        (globalThis as unknown as { fixture: State }).fixture.capture()
      )
      expect(capture.error).toBeUndefined()
      expect(capture.signature).toBe('89504e470d0a1a0a')
      expect(capture.width).toBeGreaterThan(100)
      expect(capture.height).toBeGreaterThan(50)
      expect(capture.sizeBytes).toBeGreaterThan(32)
      const other = await electron.evaluate(() =>
        (globalThis as unknown as { fixture: State }).fixture.other()
      )
      await expect
        .poll(async () =>
          (await state()).decisions.some((entry) => entry.windowId === other && !entry.allowed)
        )
        .toBe(true)
      await electron.evaluate(() => (globalThis as unknown as { fixture: State }).fixture.zoom())
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      const trusted = page
        .frames()
        .find((frame) => frame.url().startsWith('open-science-preview:'))!
      const point = await trusted.evaluate(() => {
        const rect = document.getElementById('managed')!.getBoundingClientRect()
        return { x: 30 + rect.left + 10, y: 550 + rect.top + 8 }
      })
      await trusted.locator('#managed').click({ button: 'right', position: { x: 10, y: 8 } })
      await expect.poll(async () => (await state()).menus.length).toBe(1)
      const menu = (await state()).menus[0]
      expect(menu.frameUrl).toBe('open-science-preview://fixture/report.html')
      expect(Math.abs(menu.x - point.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(menu.y - point.y)).toBeLessThanOrEqual(1)
      const nativeCount = (await state()).nativeMenus.length
      await trusted.locator('#passthrough').click({ button: 'right' })
      await expect.poll(async () => (await state()).nativeMenus.length).toBe(nativeCount + 1)
      expect((await state()).menus).toHaveLength(1)
      await electron.evaluate(() =>
        (globalThis as unknown as { fixture: State }).fixture.reattach()
      )
      await page.reload()
      await viewer.getByRole('button', { name: 'Project interface', exact: true }).click()
      await project.locator('#ready').waitFor()
      const refreshed = await state()
      expect(refreshed.released).toContain(initial.opens[0].clientId)
      expect(refreshed.opens.at(-1)!.clientId).not.toBe(initial.opens[0].clientId)
      expect(
        await electron.evaluate(
          (_electron, id) =>
            (globalThis as unknown as { fixture: State }).fixture.oldDocumentAvailable(id),
          initial.opens[0].clientId
        )
      ).toBe(false)
      expect(
        await electron.evaluate(
          (_electron, id) => (globalThis as unknown as { fixture: State }).fixture.captureOld(id),
          initial.opens[0].clientId
        )
      ).toBe('rejected')
      expect(refreshed.errors).toEqual([])
      await electron.evaluate(() => (globalThis as unknown as { fixture: State }).fixture.close())
    } finally {
      await electron?.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  },
  90_000
)

/** Uses the production root CSP, production navigation guard, real registry and both actual HTTP
 * owners. A bare file:// iframe fixture cannot detect privileged desktop embedding regressions. */
it
  .skipIf(!enabled)
  .each([
    'production',
    'small-pane-capture',
    'workspace-shaped-capture',
    'catalog-load-failure',
    'legacy-upgrade-absolute-redirect'
  ] as const)(
  'checks real owner-bound desktop embedding: %s',
  async (policy) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'os-service-run-')))
    let electron: ElectronApplication | undefined
    try {
      const source = await readFile(resolve('src/renderer/index.html'), 'utf8')
      const productionCsp = source.match(
        /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
      )?.[1]
      expect(productionCsp).toBeDefined()
      // Reproduce the removed policy too: even an absolute HTTP Location is rewritten, so
      // changing redirect spelling cannot exempt the scoped local viewer from global upgrades.
      const csp =
        productionCsp +
        (policy === 'legacy-upgrade-absolute-redirect' ? '; upgrade-insecure-requests' : '')
      const html = join(directory, 'index.html')
      const workspaceCapture = policy === 'workspace-shaped-capture'
      const viewerHtml = await readFile(resolve('out/replay-viewer/index.html'), 'utf8')
      const stylePath = viewerHtml.match(/href="([^"]+\.css)"/)?.[1]
      expect(stylePath).toBeDefined()
      const stylesheet = pathToFileURL(
        resolve('out/replay-viewer', stylePath!.replace(/^\//, ''))
      ).href
      const layoutSource = await readFile(
        resolve('src/renderer/src/pages/workspace/workspace-panel-layout.tsx'),
        'utf8'
      )
      const handleClass = layoutSource.match(
        /const WORKSPACE_RESIZE_HANDLE_CLASS_NAME =\s*'([^']+)'/
      )?.[1]
      const previewSource = await readFile(
        resolve('src/renderer/src/pages/workspace/RunObservationPreview.tsx'),
        'utf8'
      )
      const previewContainerClass = previewSource.match(
        /<div className="([^"]+)" hidden={!props.isActive}>/
      )?.[1]
      expect(handleClass).toBeDefined()
      expect(previewContainerClass).toBeDefined()
      const noticesScript = join(directory, 'notices.js')
      if (workspaceCapture)
        await build({
          stdin: {
            resolveDir: process.cwd(),
            sourcefile: 'desktop-notices-fixture.tsx',
            loader: 'tsx',
            contents: `
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {createInstance} from 'i18next'
import {initReactI18next} from 'react-i18next'
createInstance().use(initReactI18next).init({lng:'en',fallbackLng:'en',resources:{},keySeparator:false,nsSeparator:false,initImmediate:false})
import {ActionToast,ActionToastStack,BottomNoticeStack} from './src/renderer/src/components/ActionToast'
import {EnvStatusBanner} from './src/renderer/src/pages/workspace/EnvStatusBanner'
import {PermissionUndoSnackbar} from './src/renderer/src/components/PermissionUndoSnackbar'
import {SessionPersistenceAlert} from './src/renderer/src/components/SessionPersistenceAlert'
import {useSettingsUndoPortal} from './src/renderer/src/components/use-settings-undo-portal'
import {useArchiveUndoStore} from './src/renderer/src/stores/archive-undo-store'
import {ResizablePanelGroup,ResizablePanel,ResizableHandle} from './src/renderer/src/components/ui/resizable'
import {ReplaySourceBar} from './src/renderer/src/pages/workspace/replay/ReplaySourceBar'
import {useSessionStore} from './src/renderer/src/stores/session-store'
import {useNavigationStore} from './src/renderer/src/stores/navigation-store'
import {useProjectStore} from './src/renderer/src/stores/project-store'
window.api={platform:'darwin'}
const fixtureReplayItem={id:'fixture-live-replay',type:'tool',toolKind:'replay',projectId:'desktop-project',sessionId:'desktop-session',title:'Bound experiment',replayRunTarget:{projectId:'desktop-project',sessionId:'desktop-session',runId:'run'}}
useSessionStore.setState({sessions:[{id:'desktop-session',projectId:'desktop-project',title:'Bound experiment source',status:'idle',messages:[],cwd:'',createdAt:1,updatedAt:1},{id:'another-session',projectId:'desktop-project',title:'Current discussion',status:'idle',messages:[],cwd:'',createdAt:1,updatedAt:1}],selectedSessionId:'another-session'})
useNavigationStore.setState({activeProjectId:'desktop-project'})
useProjectStore.setState({projects:[{id:'desktop-project',name:'Fixture project',cwd:'',createdAt:1,updatedAt:1}]})
function Empty(){return null}
function Notices(){
 const [mode,setMode]=useState('empty'),[settings,setSettings]=useState(false)
 const portal=useSettingsUndoPortal(<PermissionUndoSnackbar allowsArchiveShortcut={()=>false}/>)
 globalThis.fixtureNotices={setMode,setSettings,setUndo:active=>useArchiveUndoStore.setState({notices:active?[{key:'project:fixture:1',kind:'project',projectId:'fixture',archivedAt:1,revision:0,expiresAt:Date.now()+60000,messageKey:'Archived project “{{name}}”.',messageParams:{name:'Fixture archive receipt'}}]:[]})}
 return <><ActionToastStack>{null}{[false,null]}<Empty/>{mode==='normal'||mode==='compact'?<ActionToast title="A real visible notice" detail={mode==='normal'?'This notice must block a screenshot of the area it covers.':undefined} dismissLabel="Close" onDismiss={()=>setMode('empty')}/>:null}{mode==='alert'?<SessionPersistenceAlert title="Saved conversations could not be loaded" message="Fixture recovery notice"/>:null}{portal.background}</ActionToastStack>{settings?<ActionToastStack ref={portal.settingsHostRef}/>:null}<BottomNoticeStack><div style={{display:'contents'}}><EnvStatusBanner ui={{kind:'ready'}}/></div></BottomNoticeStack></>
}
function Workspace(){return <main style={{boxSizing:'border-box',height:'100vh',overflow:'hidden',padding:10}}><div style={{position:'relative',display:'flex',height:'100%'}}><ResizablePanelGroup orientation="horizontal" resizeTargetMinimumSize={{coarse:20,fine:20}} className="-mr-[10px] min-w-0 flex-1"><ResizablePanel id="left-panel" defaultSize="0%" minSize="0%" collapsible collapsedSize="0%"><div>Sidebar</div></ResizablePanel><ResizableHandle disabled aria-hidden className={${JSON.stringify(handleClass + ' pointer-events-none opacity-0')}}/><ResizablePanel defaultSize="60%" minSize="20%">Conversation</ResizablePanel><ResizableHandle aria-label="Resize right panel" className={${JSON.stringify(handleClass + ' bg-border shadow-[1px_0_3px_rgba(30,28,24,0.08)] opacity-100')}}/><ResizablePanel defaultSize="40%" minSize="30%"><aside id="right-panel" style={{position:'relative',boxSizing:'border-box',display:'flex',flexDirection:'column',height:'100%',minWidth:0,width:'100%',overflow:'hidden',padding:'.7px 0'}}><div style={{display:'flex',flexShrink:0,height:40}}>Notebook / Replay</div><div style={{minHeight:0,minWidth:0,flex:1}}><section hidden><div style={{height:'100%'}}>Inactive Notebook content</div></section><section role="tabpanel" style={{height:'100%',minHeight:0,width:'100%',overflowY:'auto'}}><div data-testid="preview-replay-wrapper" className="flex h-full min-h-0 flex-col"><ReplaySourceBar item={fixtureReplayItem}/><div className="min-h-0 flex-1"><div id="viewer-container" className={${JSON.stringify(previewContainerClass)}}><iframe id="viewer" title="Replay" sandbox="allow-scripts allow-same-origin allow-forms" style={{border:0,minHeight:0,width:'100%',flex:1}}/></div></div></div></section></div></aside></ResizablePanel></ResizablePanelGroup><button style={{position:'absolute',right:8,top:0,width:28,height:28}}>×</button></div></main>}
createRoot(document.getElementById('workspace')).render(<Workspace/>)
createRoot(document.getElementById('notices')).render(<Notices/>)
`
          },
          outfile: noticesScript,
          bundle: true,
          format: 'iife',
          platform: 'browser',
          jsx: 'automatic',
          alias: { '@': resolve('src/renderer/src') },
          define: { 'process.env.NODE_ENV': '"production"' },
          logLevel: 'silent'
        })
      // Mount the real resizable group and both separators: their 20px pseudo-element hit
      // areas overlap adjacent panels, which plain flex divs cannot represent. Other ancestors
      // retain WorkspacePage's p10, the compensating -mr10 and PreviewPanel's fractional padding.
      const frame = `<iframe id="viewer" title="Replay" sandbox="allow-scripts allow-same-origin allow-forms" style="border:0;${workspaceCapture ? 'min-height:0;width:100%;flex:1' : policy === 'small-pane-capture' ? 'position:absolute;right:10px;top:120px;width:40vw;height:460px' : 'width:100vw;height:100vh'}"></iframe>`
      const content = workspaceCapture ? '<div id="workspace"></div>' : frame
      await writeFile(
        html,
        `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${workspaceCapture ? `<link rel="stylesheet" href="${stylesheet}">` : ''}</head><body style="margin:0">${content}${workspaceCapture ? `<div id="notices" style="display:contents"></div><script src="${pathToFileURL(noticesScript).href}"></script>` : ''}</body></html>`
      )
      const main = join(directory, 'main.cjs')
      await build({
        stdin: {
          resolveDir: process.cwd(),
          sourcefile: 'desktop-embed-fixture.ts',
          loader: 'ts',
          contents: `
import { app, BrowserWindow, webFrameMain, protocol, nativeImage } from 'electron'
import { createServer, ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createFrameNavigationGuard } from './src/main/navigation-policy'
import { installPreviewContextMenuBridge } from './src/main/preview-context-menu'
import { desktopObservationFrameRegistry } from './src/main/replay-viewer/desktop-frame-registry'
import { ReplayViewerHttpHost } from './src/main/replay-viewer/http-host'
import { createReplayViewerAssetReader } from './src/main/replay-viewer/assets'
import { ManagedRuntimeViews } from './src/main/managed-runtime-views'
import { RuntimeViewOwner } from './src/main/runtime-view/owner'
import { RunObservationOwner } from './src/main/run-observation/owner'
import { ObservationViewers } from './src/main/run-observation/viewers'
import { createCallerContext } from './src/main/caller-context'
import { captureElectronObservationView } from './src/main/run-observation/electron-capture'
const entry = ${JSON.stringify(html)}
const directory = ${JSON.stringify(directory)}
const root = ${JSON.stringify(process.cwd())}
const decisions = []
const diagnostics = []
const menus = []
const nativeMenus = []
const capturePane = ${JSON.stringify(policy)}.endsWith('capture')
const captures = []
let observationRevision = 0
if (${JSON.stringify(policy)} === 'legacy-upgrade-absolute-redirect') {
  const writeHead = ServerResponse.prototype.writeHead
  ServerResponse.prototype.writeHead = function(status,headers) {
    if (status === 303 && headers?.location?.startsWith('/')) {
      headers = {...headers,location:'http://'+this.req.headers.host+headers.location}
      diagnostics.push({absoluteRedirectOrigin:new URL(headers.location).origin})
    }
    return writeHead.call(this,status,headers)
  }
}
const windows = []
let unauthorizedRequests = 0
protocol.registerSchemesAsPrivileged(['open-science-preview','open-science-office-preview'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true}})))
function windowWithProductionNavigation() {
  const window = new BrowserWindow({show:capturePane,width:capturePane?1024:1200,height:capturePane?768:1000,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}})
  windows.push(window)
  window.webContents.on('console-message', details=>diagnostics.push(String(details.message).replace(/grant=[a-f0-9]+/g,'grant=REDACTED')))
  window.webContents.on('did-fail-load',(_event,code,description,url)=>diagnostics.push({code,description,url:url.split('?')[0]}))
  const guard = createFrameNavigationGuard((url,frame) => desktopObservationFrameRegistry.allows({
    url,frame,webContentsId:window.webContents.id,mainFrame:window.webContents.mainFrame
  }))
  const enforce = (details,processId,routingId) => {
    const frame = details.frame && typeof details.frame.frameTreeNodeId === 'number'
      ? details.frame : webFrameMain.fromId(details.processId ?? processId, details.routingId ?? routingId)
    const allowed = guard(details.url,details.isMainFrame,window.webContents.getURL(),frame)
    const url = new URL(details.url)
    decisions.push({allowed,origin:url.origin,path:url.pathname,windowId:window.webContents.id})
    if (!allowed) details.preventDefault()
  }
  window.webContents.on('will-frame-navigate', details => enforce(details))
  window.webContents.on('will-redirect',(details,_url,_inPlace,_main,processId,routingId)=>enforce(details,processId,routingId))
  const contents = window.webContents
  contents.on('context-menu',(_event,params)=>nativeMenus.push({url:params.frame?.url.split('?')[0],editable:params.isEditable}))
  const disposeMenuBridge = installPreviewContextMenuBridge({
    get mainFrame(){return contents.mainFrame},getZoomFactor:()=>contents.getZoomFactor(),
    on:(event,listener)=>contents.on(event,listener),removeListener:(event,listener)=>contents.removeListener(event,listener),
    send:(channel,payload)=>{menus.push(payload);contents.send(channel,payload)}
  })
  window.on('closed',disposeMenuBridge)
  return window
}
app.whenReady().then(async () => {
  for (const scheme of ['open-science-preview','open-science-office-preview'])
    protocol.handle(scheme,()=>new Response('<!doctype html><p id="legacy-preview">Existing managed preview</p><p id="passthrough" data-preview-context-menu-passthrough>Native menu area</p><input id="editable" value="Editable area">',{headers:{'Content-Type':'text/html'}}))
  const owner = windowWithProductionNavigation()
  await owner.loadFile(entry)
  await owner.webContents.executeJavaScript('new Promise((resolve,reject)=>{const deadline=Date.now()+5000;function check(){if(document.getElementById("viewer"))resolve();else if(Date.now()>deadline)reject(new Error("fixture viewer did not mount"));else requestAnimationFrame(check)}check()})')
  if(capturePane) {app.setActivationPolicy('regular');app.focus({steal:true});owner.show();owner.focus()}
  const caller = createCallerContext({clientId:String(owner.webContents.id),
    lifecycleClientId:'electron:'+owner.webContents.id,leaseId:'electron:'+owner.webContents.id,
    surface:'electron',location:'local',principalKind:'human',actionOrigin:'human',
    isAuthorizationCurrent:()=>!owner.isDestroyed()})
  const scope = {projectId:'desktop-project',sessionId:'desktop-session',runId:'run',
    environmentId:'desktop-environment',generationId:randomUUID()}
  const proof = randomBytes(32).toString('hex')
  const proofPath = '/__proof_'+randomBytes(16).toString('hex')
  const socketPath = join(directory,'service.sock')
  const project = createServer((request,response) => {
    if (request.url === proofPath) {response.end(proof);return}
    response.setHeader('Content-Type','text/html; charset=utf-8')
    response.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'")
    response.end('<!doctype html><html><head><style>body{margin:0;background:rgb(0,180,70)}#project-ready{font-size:16px;margin:0}#internal-scroll{height:30px;overflow:auto}#scroll-content{height:200px}</style></head><body><h1 id="project-ready">Real bound project</h1><a id="project-next" href="/next">Next page</a><div id="internal-scroll"><div id="scroll-content">Native scroll content</div></div></body></html>')
  })
  await new Promise(resolve=>project.listen(socketPath,resolve))
  const rogue = createServer((_request,response)=>{unauthorizedRequests++;response.end('unauthorized')})
  await new Promise(resolve=>rogue.listen(0,'127.0.0.1',resolve))
  const rogueOrigin = 'http://unregistered.localhost:'+rogue.address().port
  const lifetime = new AbortController()
  const projectViews = new ManagedRuntimeViews(new RuntimeViewOwner({}, desktopObservationFrameRegistry))
  const openProject = projectViews.open.bind(projectViews)
  projectViews.open = async (...args) => {try {return await openProject(...args)} catch(error) {diagnostics.push(String(error));throw error}}
  projectViews.register({scope,declaration:{title:'Bound project',entryPath:'/',adaptFrameAncestors:true},
    socketPath,proof:{path:proofPath,value:proof},logicalPort:4173,signal:lifetime.signal})
  const target = {projectId:scope.projectId,sessionId:scope.sessionId,runId:scope.runId}
  const observation = new RunObservationOwner({
    authorize:(target,viewer)=>viewers.assertViewer(target,viewer),
    read:async()=>({identity:target,phase:'running',artifacts:[],run:{
      runId:scope.runId,cellId:'cell',source:'agent',kernelKind:'bash',script:'printf observed',
      status:'running',startedAt:1,text:{stdout:'project ready '+observationRevision,stderr:'',traceback:'',plain:[]},outputs:[],workingFiles:[]}})
  })
  const viewers = new ObservationViewers({observer:observation,authorizeScope:async()=>undefined,
    onRevoked:viewerId=>host.closeViewer(viewerId)})
  const readAsset = createReplayViewerAssetReader(join(root,'out/replay-viewer'))
  const host = new ReplayViewerHttpHost({viewers,projectViews,desktopFrames:desktopObservationFrameRegistry,
    desktopLocale:()=> capturePane?'en':'de',
    recordingStatus:async()=>({target,state:'recording'}),
    captureOptions:async(_target,hostViewAvailable)=>({hostView:hostViewAvailable,projectExports:[]}),
    capture:async input=>{
      input.assertAuthorized()
      const startedAt=Date.now()
      const {bytes}=await captureElectronObservationView({...input.host,signal:input.signal}).catch(error=>{diagnostics.push('capture: '+String(error));throw error})
      input.assertAuthorized()
      const image=nativeImage.createFromBuffer(Buffer.from(bytes));const size=image.getSize();const bitmap=image.toBitmap()
      const index=(Math.floor(size.height*.9)*size.width+Math.floor(size.width/2))*4
      captures.push({size,middle:[bitmap[index+2],bitmap[index+1],bitmap[index]],focused:owner.isFocused()})
      return {created:true,result:{captureId:'capture-'+captures.length,recordingId:'recording',stepKey:'observation-'+randomUUID()+'-00000042',artifactId:'fixture-artifact',versionId:'fixture-version',
        checksum:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,mimeType:'image/png',publication:'awaiting-publication',
        capture:{source:'host-view',association:'current-observation',startedAt,finishedAt:Date.now(),observedAt:startedAt,width:size.width,height:size.height}}}
    },
    readAsset:path=>${JSON.stringify(policy)} === 'catalog-load-failure' && path.startsWith('assets/de-') && path.endsWith('.js')
      ? Promise.resolve(undefined) : readAsset(path)})
  const access = await host.open(target,caller,{allowInteraction:true,allowCapture:capturePane,desktopParent:'file:'})
  await owner.webContents.executeJavaScript('document.getElementById("viewer").src='+JSON.stringify(access.url))
  globalThis.fixture = {
    ownerId:owner.webContents.id,viewerOrigin:new URL(access.url).origin,rogueOrigin,
    decisions,diagnostics,menus,nativeMenus,captures,requests:()=>unauthorizedRequests,
    nextObservation:()=>observationRevision++,
    zoom:value=>owner.webContents.setZoomFactor(value),
    other:async()=>{const other=windowWithProductionNavigation();await other.loadFile(entry);
      await other.webContents.executeJavaScript('document.getElementById("viewer").src='+JSON.stringify(new URL(access.url).origin+'/'));return other.webContents.id},
    endRun:()=>lifetime.abort(),
    revoke:()=>viewers.revoke(access.viewerId,{caller}),
    close:async()=>{await viewers.close();await host.close();await projectViews.close();observation.close();
      rogue.closeAllConnections();rogue.close();project.closeAllConnections();project.close();for(const window of windows)if(!window.isDestroyed())window.destroy()}
  }
}).catch(error=>{console.error(error);app.exit(1)})
app.on('window-all-closed',()=>app.quit())
`
        },
        outfile: main,
        platform: 'node',
        format: 'cjs',
        bundle: true,
        external: ['electron'],
        logLevel: 'silent'
      })
      electron = await _electron.launch({ args: [main], cwd: process.cwd() })
      const page = await electron.firstWindow()
      if (policy === 'legacy-upgrade-absolute-redirect') {
        await expect
          .poll(() =>
            electron!.evaluate(() => {
              const fixture = (
                globalThis as unknown as {
                  fixture?: {
                    decisions: Array<{ allowed: boolean; origin: string }>
                    diagnostics: Array<unknown>
                  }
                }
              ).fixture
              return (
                fixture && {
                  bootstrapAllowed: fixture.decisions.some(
                    (item) => item.allowed && item.origin.startsWith('http://viewer-')
                  ),
                  upgradedRejected: fixture.decisions.some(
                    (item) => !item.allowed && item.origin.startsWith('https://viewer-')
                  ),
                  absoluteRedirect: fixture.diagnostics.some(
                    (item) =>
                      typeof item === 'object' && item !== null && 'absoluteRedirectOrigin' in item
                  )
                }
              )
            })
          )
          .toEqual({ bootstrapAllowed: true, upgradedRejected: true, absoluteRedirect: true })
        return
      }
      const failures: string[] = []
      page.on('pageerror', (error) => failures.push(error.message))
      const redirects: string[] = []
      page.on('response', (response) => {
        if (response.status() === 303) redirects.push(new URL(response.url()).pathname)
      })
      const viewer = page.frameLocator('#viewer')
      const projectLabel =
        policy === 'production'
          ? JSON.parse(await readFile(resolve('src/shared/i18n/locales/de.json'), 'utf8')).renderer[
              'Project interface'
            ]
          : 'Project interface'
      await viewer
        .getByRole('button', { name: projectLabel, exact: true })
        .click({ timeout: 20_000 })
      const project = viewer.frameLocator('iframe[title="Bound project"]')
      await project.locator('#project-ready').waitFor({ state: 'visible', timeout: 8000 })
      // The first wide-layout measurement can open the existing files column. Child locators
      // alone only stabilize the project's local box, not the moving parent iframe.
      await viewer.locator('iframe[title="Bound project"]').evaluate(async () => {
        await document.fonts.ready
      })
      await (await viewer
        .locator('iframe[title="Bound project"]')
        .elementHandle())!.waitForElementState('stable')
      await project.locator('#project-next').click()
      await project.locator('#project-ready').waitFor({ state: 'visible' })
      if (policy === 'small-pane-capture' || workspaceCapture) {
        type CaptureFixture = {
          captures: Array<{
            size: { width: number; height: number }
            middle: number[]
            focused: boolean
          }>
          nextObservation(): void
        }
        const actualViewer = page.frames().find((frame) => /^http:\/\/viewer-/.test(frame.url()))!
        const projectElement = viewer.locator('iframe[title="Bound project"]')
        // Exercise the production headers, recording row, action bar and footer; a flat iframe
        // fixture misses their consumption of the actual remaining stage height.
        await viewer.getByRole('button', { name: 'Save project screenshot' }).waitFor()
        const initialHeight = await projectElement.evaluate(
          (frame) => frame.getBoundingClientRect().height
        )
        expect(initialHeight).toBeGreaterThan(100)
        if (workspaceCapture) {
          const sourceBar = page.getByTestId('replay-source-bar')
          await sourceBar.getByText('Source: Bound experiment source', { exact: true }).waitFor()
          expect(await sourceBar.textContent()).toContain('Run observation')
          expect(await sourceBar.textContent()).toContain('Reference from another conversation')
          expect(
            await sourceBar.getByRole('button', { name: 'Open source record' }).isEnabled()
          ).toBe(true)
          const sourceGeometry = await page.evaluate(() => {
            const wrapper = document
              .querySelector('[data-testid="preview-replay-wrapper"]')!
              .getBoundingClientRect()
            const bar = document
              .querySelector('[data-testid="replay-source-bar"]')!
              .getBoundingClientRect()
            const viewer = document.getElementById('viewer')!.getBoundingClientRect()
            return { wrapper: wrapper.toJSON(), bar: bar.toJSON(), viewer: viewer.toJSON() }
          })
          expect(sourceGeometry.bar.height).toBeGreaterThan(30)
          expect(sourceGeometry.viewer.top).toBeGreaterThanOrEqual(sourceGeometry.bar.bottom)
          expect(sourceGeometry.viewer.height).toBeLessThan(sourceGeometry.wrapper.height - 30)
          expect(sourceGeometry.viewer.bottom).toBeLessThanOrEqual(
            sourceGeometry.wrapper.bottom + 1
          )
        }
        await expect
          .poll(() =>
            electron!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())
          )
          .toBe(true)
        const captureResponse = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/capture'
        )
        await viewer.getByRole('button', { name: 'Save project screenshot' }).click()
        const response = await captureResponse
        if (response.status() !== 200 && workspaceCapture)
          console.error(
            'Workspace capture geometry',
            await page.locator('#viewer').evaluate((frame) => {
              const bounds = frame.getBoundingClientRect()
              const parents = []
              for (let element = frame.parentElement; element; element = element.parentElement) {
                const b = element.getBoundingClientRect(),
                  s = getComputedStyle(element)
                parents.push({
                  tag: element.tagName,
                  bounds: b.toJSON(),
                  clientWidth: element.clientWidth,
                  clientHeight: element.clientHeight,
                  overflow: [s.overflowX, s.overflowY]
                })
              }
              return {
                bounds: bounds.toJSON(),
                viewport: [innerWidth, innerHeight],
                points: [
                  bounds.left + 0.5,
                  bounds.left + bounds.width / 2,
                  bounds.right - 0.5
                ].flatMap((x) =>
                  [bounds.top + 0.5, bounds.top + bounds.height / 2, bounds.bottom - 0.5].map(
                    (y) => ({
                      x,
                      y,
                      hit: document.elementFromPoint(x, y)?.tagName,
                      slot: document.elementFromPoint(x, y)?.getAttribute('data-slot'),
                      matches: document.elementFromPoint(x, y) === frame
                    })
                  )
                ),
                parents
              }
            })
          )
        expect(response.status()).toBe(200)
        if (workspaceCapture) {
          expect(
            await page
              .locator('[data-action-toast-stack]')
              .evaluate((element) => element.getBoundingClientRect().height)
          ).toBe(0)
          expect(await page.locator('[data-testid="permission-undo-stack"]').count()).toBe(1)
          expect(await page.locator('[data-testid="env-status-ready-announcement"]').count()).toBe(
            1
          )
        }
        await viewer.getByText('This captured image is awaiting archive publication.').waitFor()
        const captured = await electron.evaluate(
          () => (globalThis as unknown as { fixture: CaptureFixture }).fixture.captures[0]
        )
        expect(captured.focused).toBe(true)
        expect(captured.size.width).toBeGreaterThan(200)
        expect(captured.size.height).toBeGreaterThan(120)
        for (const [channel, value] of captured.middle.entries())
          expect(Math.abs(value - [0, 180, 70][channel])).toBeLessThanOrEqual(2)
        const node = await projectElement.elementHandle()
        const geometry = await projectElement.evaluate((frame) => {
          const bounds = frame.getBoundingClientRect()
          return {
            top: bounds.top,
            bottom: bounds.bottom,
            height: bounds.height,
            viewportHeight: innerHeight
          }
        })
        if (!workspaceCapture) expect(geometry.height).toBeLessThan(384)
        expect(geometry.height).toBe(initialHeight)
        expect(geometry.top).toBeGreaterThan(0)
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
        // Keep the original small pane for a second real capture. Long step IDs and precise
        // timestamps must not grow the feedback region or consume the project viewport.
        const secondResponse = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/capture'
        )
        await viewer.getByRole('button', { name: 'Save project screenshot' }).click()
        expect((await secondResponse).status()).toBe(200)
        await viewer.getByText('This captured image is awaiting archive publication.').waitFor()
        expect(await projectElement.evaluate((frame) => frame.getBoundingClientRect().height)).toBe(
          initialHeight
        )
        if (workspaceCapture) {
          const separator = page.getByRole('separator', { name: 'Resize right panel' })
          const bounds = (await separator.boundingBox())!
          const previousWidth = await page
            .locator('#viewer')
            .evaluate((element) => element.getBoundingClientRect().width)
          // Start in the real 20px drag corridor, beyond the separator's 1px layout box.
          // Reserving space for it must keep edge dragging usable without overlapping the iframe.
          const dragX = bounds.x + bounds.width / 2 + 7
          const dragY = bounds.y + bounds.height / 2
          expect(
            await page.evaluate(
              ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-slot'),
              { x: dragX, y: dragY }
            )
          ).toBe('resizable-handle')
          await page.mouse.move(dragX, dragY)
          await page.mouse.down()
          await page.mouse.move(dragX - 70, dragY, { steps: 8 })
          await page.mouse.up()
          await expect
            .poll(() =>
              page.locator('#viewer').evaluate((element) => element.getBoundingClientRect().width)
            )
            .toBeGreaterThan(previousWidth + 40)
          await (await page.locator('#viewer').elementHandle())!.waitForElementState('stable')
          expect(
            await page.locator('#viewer').evaluate((frame) => {
              const bounds = frame.getBoundingClientRect()
              return [bounds.top + 0.5, bounds.top + bounds.height / 2, bounds.bottom - 0.5].every(
                (y) => document.elementFromPoint(bounds.left + 0.5, y) === frame
              )
            })
          ).toBe(true)
          const draggedResponse = page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/capture'
          )
          await viewer.getByRole('button', { name: 'Save project screenshot' }).click()
          expect((await draggedResponse).status()).toBe(200)
        }
        // Native project controls retain their own state while more evidence arrives and the
        // actual right pane changes height. Neither path reloads or scrolls the interactive page.
        const previousCursor = await actualViewer
          .locator('[data-observation-record]')
          .getAttribute('data-observation-record')
        await project.locator('#internal-scroll').evaluate((element) => {
          element.scrollTop = 65
        })
        await electron.evaluate(() =>
          (globalThis as unknown as { fixture: CaptureFixture }).fixture.nextObservation()
        )
        await expect
          .poll(() =>
            actualViewer
              .locator('[data-observation-record]')
              .getAttribute('data-observation-record')
          )
          .not.toBe(previousCursor)
        if (workspaceCapture) {
          await electron.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].setSize(1101, 801)
          )
        } else {
          await page.locator('#viewer').evaluate((frame) => {
            frame.style.height = '500px'
          })
        }
        await expect
          .poll(() => projectElement.evaluate((frame) => frame.getBoundingClientRect().height))
          .toBeGreaterThan(geometry.height)
        expect(
          await node!.evaluate(
            (frame) => frame === document.querySelector('iframe[title="Bound project"]')
          )
        ).toBe(true)
        expect(
          await project.locator('#internal-scroll').evaluate((element) => element.scrollTop)
        ).toBe(65)
        const resizedResponse = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/api/capture'
        )
        await viewer.getByRole('button', { name: 'Save project screenshot' }).click()
        const resized = await resizedResponse
        if (resized.status() !== 200)
          console.error(
            'Root overlap candidates',
            await page.locator('#viewer').evaluate((frame) => {
              const b = frame.getBoundingClientRect()
              return [...document.querySelectorAll('body *')]
                .filter((e) => e !== frame && !e.contains(frame))
                .map((e) => ({
                  tag: e.tagName,
                  testId: e.getAttribute('data-testid'),
                  classes: e.className,
                  rect: e.getBoundingClientRect().toJSON(),
                  clip: getComputedStyle(e).clip,
                  clipPath: getComputedStyle(e).clipPath,
                  position: getComputedStyle(e).position,
                  transform: getComputedStyle(e).transform,
                  filter: getComputedStyle(e).filter,
                  overflow: getComputedStyle(e).overflow,
                  display: getComputedStyle(e).display,
                  opacity: getComputedStyle(e).opacity
                }))
                .filter(
                  (e) =>
                    e.rect.width > 0 &&
                    e.rect.height > 0 &&
                    e.rect.right > b.left &&
                    e.rect.bottom > b.top &&
                    e.rect.left < b.right &&
                    e.rect.top < b.bottom
                )
            })
          )
        expect(resized.status()).toBe(200)
        if (workspaceCapture) {
          type NoticesFixture = {
            setMode(mode: string): void
            setUndo(active: boolean): void
            setSettings(open: boolean): void
          }
          const setMode = (mode: string): Promise<void> =>
            page.evaluate(
              (mode) =>
                (
                  globalThis as unknown as { fixtureNotices: NoticesFixture }
                ).fixtureNotices.setMode(mode),
              mode
            )
          const rootStack = await page.locator('[data-action-toast-stack]').elementHandle()
          const assertDeniedAndRecover = async (clear: () => Promise<void>): Promise<void> => {
            const denied = page.waitForResponse(
              (response) => new URL(response.url()).pathname === '/api/capture'
            )
            await viewer.getByRole('button', { name: 'Save project screenshot' }).click()
            expect((await denied).status()).toBe(503)
            await clear()
            await expect
              .poll(() =>
                page
                  .locator('[data-action-toast-stack]')
                  .first()
                  .evaluate((element) => element.getBoundingClientRect().height)
              )
              .toBe(0)
            const recovered = page.waitForResponse(
              (response) => new URL(response.url()).pathname === '/api/capture'
            )
            await viewer.getByRole('button', { name: 'Retry', exact: true }).click()
            expect((await recovered).status()).toBe(200)
          }
          for (const mode of ['normal', 'compact', 'alert']) {
            await setMode(mode)
            await expect
              .poll(() =>
                page
                  .locator('[data-action-toast-stack]')
                  .evaluate((element) => element.getBoundingClientRect().height)
              )
              .toBeGreaterThan(0)
            await assertDeniedAndRecover(() => setMode('empty'))
          }
          await page.evaluate(() =>
            (globalThis as unknown as { fixtureNotices: NoticesFixture }).fixtureNotices.setUndo(
              true
            )
          )
          const receipt = await page
            .locator('[data-testid="archive-undo-snackbar"]')
            .elementHandle()
          expect(receipt).not.toBeNull()
          await page.evaluate(() =>
            (
              globalThis as unknown as { fixtureNotices: NoticesFixture }
            ).fixtureNotices.setSettings(true)
          )
          await expect.poll(() => page.locator('[data-action-toast-stack]').count()).toBe(2)
          expect(
            await receipt!.evaluate((element) =>
              document.querySelectorAll('[data-action-toast-stack]')[1].contains(element)
            )
          ).toBe(true)
          await page.evaluate(() =>
            (
              globalThis as unknown as { fixtureNotices: NoticesFixture }
            ).fixtureNotices.setSettings(false)
          )
          await expect.poll(() => page.locator('[data-action-toast-stack]').count()).toBe(1)
          expect(
            await receipt!.evaluate((element) =>
              document.querySelector('[data-action-toast-stack]')!.contains(element)
            )
          ).toBe(true)
          // The source bar moves the viewer below this short Undo receipt. Its visible box
          // must not block unrelated pixels; then move the fixture host into the project area
          // to keep exercising denial for an actual occluding notice after the portal round trip.
          expect(
            await page.evaluate(() => {
              const notice = document
                .querySelector('[data-action-toast-stack]')!
                .getBoundingClientRect()
              const frame = document.getElementById('viewer')!.getBoundingClientRect()
              return notice.bottom <= frame.top
            })
          ).toBe(true)
          const unobstructed = page.waitForResponse(
            (response) => new URL(response.url()).pathname === '/api/capture'
          )
          await viewer.getByRole('button', { name: 'Save project screenshot' }).click()
          expect((await unobstructed).status()).toBe(200)
          await page.locator('[data-action-toast-stack]').evaluate((element) => {
            const frame = document.getElementById('viewer')!.getBoundingClientRect()
            ;(element as HTMLElement).style.top = `${frame.top + frame.height / 2}px`
          })
          await assertDeniedAndRecover(() =>
            page.evaluate(() =>
              (globalThis as unknown as { fixtureNotices: NoticesFixture }).fixtureNotices.setUndo(
                false
              )
            )
          )
          expect(
            await rootStack!.evaluate(
              (element) => element === document.querySelector('[data-action-toast-stack]')
            )
          ).toBe(true)
        }
        await writeFile(
          join(
            tmpdir(),
            workspaceCapture
              ? 'open-science-production-workspace-capture.json'
              : 'open-science-production-small-pane-capture.json'
          ),
          JSON.stringify(
            {
              window: { width: 1024, height: 768 },
              pane: workspaceCapture
                ? {
                    width: '40%',
                    workspaceRootPadding: 10,
                    groupRightMargin: -10,
                    previewPaddingY: 0.7,
                    viewerInset: { left: 10, top: 1, right: 1, bottom: 1 },
                    resizedWindow: { width: 1101, height: 801 }
                  }
                : { width: '40%', initialHeight: 420, rightInset: 10 },
              productionViewer: true,
              strictForeground: true,
              actualScreenshotButton: true,
              consecutiveCapturesAtOriginalSize: 2,
              scope:
                'production layout and native capture; fixture Artifact IDs, no Artifact publication',
              projectIframePreservedAfterResize: true,
              internalScrollPreserved: true,
              ...(workspaceCapture
                ? {
                    actualResizableComponents: true,
                    realDividerEdgeDragAndCapture: true,
                    actualNoticeComponents: true,
                    actualReplaySourceBar: true,
                    viewerFitsBelowSourceBar: true,
                    emptyNoticeHostsHaveNoBox: true,
                    visibleNoticesRejected: true,
                    nonOverlappingUndoAllowed: true,
                    undoPortalIdentityPreserved: true
                  }
                : {}),
              capture: captured,
              geometry,
              scientificTrials: 0,
              providerCalls: 0
            },
            null,
            2
          )
        )
        return
      }
      expect(page.url()).toMatch(/^file:/)
      const viewerFrame = page.frames().find((frame) => /^http:\/\/viewer-/.test(frame.url()))!
      expect(await viewerFrame.evaluate(() => document.documentElement.lang)).toBe(
        policy === 'catalog-load-failure' ? 'en' : 'de'
      )
      const german = JSON.parse(await readFile(resolve('src/shared/i18n/locales/de.json'), 'utf8'))
      expect(await viewer.getByTestId('open-project-interface').textContent()).toBe(
        policy === 'catalog-load-failure'
          ? 'Reopen project interface'
          : german.renderer['Reopen project interface']
      )
      const projectFrame = page.frames().find((frame) => /^http:\/\/rv-/.test(frame.url()))!
      expect(new URL(viewerFrame.url()).pathname).toBe('/')
      await expect.poll(() => new URL(projectFrame.url()).pathname).toBe('/next')
      const viewerOrigin = new URL(viewerFrame.url()).origin
      const projectOrigin = new URL(projectFrame.url()).origin
      expect(redirects).toContain('/__open_science_view')
      expect(await viewerFrame.evaluate(() => document.cookie)).toBe('')
      expect(await projectFrame.evaluate(() => document.cookie)).toBe('')
      expect(failures).toEqual([])

      type Fixture = {
        ownerId: number
        rogueOrigin: string
        decisions: Array<{ allowed: boolean; origin: string; path: string; windowId: number }>
        menus: Array<{ x: number; y: number; frameUrl: string }>
        nativeMenus: Array<{ url: string; editable: boolean }>
        zoom(value: number): void
        requests(): number
        other(): Promise<number>
        endRun(): void
        revoke(): Promise<void>
        close(): Promise<void>
      }
      const state = (): Promise<{ decisions: Fixture['decisions']; requests: number }> =>
        electron!.evaluate(() => {
          const fixture = (globalThis as unknown as { fixture: Fixture }).fixture
          return { decisions: fixture.decisions, requests: fixture.requests() }
        })
      await expect
        .poll(async () =>
          (await state()).decisions.some(
            (decision) =>
              decision.allowed && decision.origin === viewerOrigin && decision.path === '/'
          )
        )
        .toBe(true)
      const rogueOrigin = await electron.evaluate(
        () => (globalThis as unknown as { fixture: Fixture }).fixture.rogueOrigin
      )
      const menus = (): Promise<{ sent: Fixture['menus']; native: Fixture['nativeMenus'] }> =>
        electron!.evaluate(() => {
          const fixture = (globalThis as unknown as { fixture: Fixture }).fixture
          return { sent: fixture.menus, native: fixture.nativeMenus }
        })
      await electron.evaluate(() =>
        (globalThis as unknown as { fixture: Fixture }).fixture.zoom(1.25)
      )
      // Zoom changes the viewer's responsive layout and the containing frame independently.
      // Stabilize both frame boxes before resolving the project's native click coordinates.
      await (await page.locator('#viewer').elementHandle())!.waitForElementState('stable')
      await (await viewer
        .locator('iframe[title="Bound project"]')
        .elementHandle())!.waitForElementState('stable')
      await project.locator('#project-ready').click({ button: 'right' })
      await expect.poll(async () => (await menus()).native.length).toBe(1)
      await viewer.getByTestId('open-project-interface').click({ button: 'right' })
      await expect.poll(async () => (await menus()).native.length).toBe(2)
      expect((await menus()).native.map((item) => new URL(item.url).origin)).toEqual([
        projectOrigin,
        viewerOrigin
      ])
      // The unchanged production bridge rejects both HTTP surfaces before its async DOM check.
      expect((await menus()).sent).toEqual([])
      // This URL passes the CSP localhost namespace, but has no owner registry entry.
      await page.evaluate((url) => {
        const frame = document.createElement('iframe')
        frame.src = url
        document.body.appendChild(frame)
      }, rogueOrigin + '/')
      await expect
        .poll(async () =>
          (await state()).decisions.some(
            (decision) => !decision.allowed && decision.origin === rogueOrigin
          )
        )
        .toBe(true)
      expect((await state()).requests).toBe(0)
      const blockedResources = await page.evaluate(async (origin) => {
        const element = (tag: 'script' | 'img'): Promise<string> =>
          new Promise((resolve) => {
            const item = document.createElement(tag)
            item.onload = () => resolve('loaded')
            item.onerror = () => resolve('blocked')
            item.src = origin + '/' + tag
            document.body.appendChild(item)
          })
        return Promise.all([
          fetch(origin + '/fetch').then(
            () => 'loaded',
            () => 'blocked'
          ),
          element('script'),
          element('img')
        ])
      }, rogueOrigin)
      expect(blockedResources).toEqual(['blocked', 'blocked', 'blocked'])
      expect((await state()).requests).toBe(0)
      await page.evaluate((url) => {
        window.location.href = url
      }, rogueOrigin + '/top-navigation')
      await expect
        .poll(async () =>
          (await state()).decisions.some(
            (decision) =>
              !decision.allowed &&
              decision.origin === rogueOrigin &&
              decision.path === '/top-navigation'
          )
        )
        .toBe(true)
      expect(page.url()).toMatch(/^file:/)
      for (const [index, scheme] of [
        'open-science-preview',
        'open-science-office-preview'
      ].entries()) {
        await page.evaluate(
          ({ index, scheme }) => {
            const frame = document.createElement('iframe')
            frame.id = 'legacy-' + index
            frame.style.cssText =
              'position:fixed;left:50px;top:100px;width:500px;height:400px;border:0'
            frame.src = scheme + '://fixture/preview.html'
            document.body.appendChild(frame)
          },
          { index, scheme }
        )
        // Electron's custom-protocol navigation does not always emit the CDP lifecycle event
        // Playwright's locator waits for. Verify the loaded DOM in its actual frame instead.
        await expect
          .poll(async () => {
            const frame = page
              .frames()
              .find((item) => item.url() === scheme + '://fixture/preview.html')
            return frame?.evaluate(() => document.getElementById('legacy-preview')?.textContent)
          })
          .toBe('Existing managed preview')
        const frame = page
          .frames()
          .find((item) => item.url() === scheme + '://fixture/preview.html')!
        const clickLegacy = async (id: string): Promise<{ x: number; y: number }> => {
          const point = await frame.evaluate((id) => {
            const bounds = document.getElementById(id)!.getBoundingClientRect()
            return { x: bounds.left + 10, y: bounds.top + 8 }
          }, id)
          const rootPoint = { x: 50 + point.x, y: 100 + point.y }
          await page.mouse.click(rootPoint.x, rootPoint.y, { button: 'right' })
          return rootPoint
        }
        // A loaded custom-protocol frame can precede its hit-test region in the compositor.
        // Wait for two real paints before the native right click (never synthesize the event).
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))
            )
        )
        const before = await menus()
        const point = await clickLegacy('legacy-preview')
        await expect.poll(async () => (await menus()).sent.length).toBe(before.sent.length + 1)
        const request = (await menus()).sent.at(-1)!
        expect(request.frameUrl).toBe(scheme + '://fixture/preview.html')
        expect(Math.abs(request.x - point.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(request.y - point.y)).toBeLessThanOrEqual(1)
        await clickLegacy('passthrough')
        await clickLegacy('editable')
        await expect.poll(async () => (await menus()).native.length).toBe(before.native.length + 3)
        // Wait for the real bridge's frame-query promises before asserting no dispatch.
        await electron.evaluate(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100))
        })
        expect((await menus()).sent.length).toBe(before.sent.length + 1)
        expect((await menus()).native.at(-1)?.editable).toBe(true)
        await page.evaluate((index) => document.getElementById('legacy-' + index)?.remove(), index)
      }
      await electron.evaluate(() => (globalThis as unknown as { fixture: Fixture }).fixture.zoom(1))

      // A registered project origin is still forbidden as a direct child of the privileged root.
      await page.evaluate((url) => {
        const frame = document.createElement('iframe')
        frame.src = url
        document.body.appendChild(frame)
      }, projectOrigin + '/wrong-parent')
      await expect
        .poll(async () =>
          (await state()).decisions.some(
            (decision) =>
              !decision.allowed &&
              decision.origin === projectOrigin &&
              decision.path === '/wrong-parent'
          )
        )
        .toBe(true)
      const otherId = await electron.evaluate(() =>
        (globalThis as unknown as { fixture: Fixture }).fixture.other()
      )
      await expect
        .poll(async () =>
          (await state()).decisions.some(
            (decision) =>
              !decision.allowed && decision.windowId === otherId && decision.origin === viewerOrigin
          )
        )
        .toBe(true)

      await electron.evaluate(() =>
        (globalThis as unknown as { fixture: Fixture }).fixture.endRun()
      )
      await viewerFrame.evaluate((url) => {
        document.querySelector('iframe')!.src = url
      }, projectOrigin + '/after-run')
      await expect
        .poll(async () =>
          (await state()).decisions.some(
            (decision) =>
              !decision.allowed &&
              decision.origin === projectOrigin &&
              decision.path === '/after-run'
          )
        )
        .toBe(true)
      await electron.evaluate(() =>
        (globalThis as unknown as { fixture: Fixture }).fixture.revoke()
      )
      await page.evaluate((url) => {
        ;(document.getElementById('viewer') as HTMLIFrameElement).src = url
      }, viewerOrigin + '/revoked')
      await expect
        .poll(async () =>
          (await state()).decisions.some(
            (decision) =>
              !decision.allowed && decision.origin === viewerOrigin && decision.path === '/revoked'
          )
        )
        .toBe(true)
    } catch (error) {
      const diagnostics = await electron
        ?.evaluate(() => {
          const fixture = (
            globalThis as unknown as { fixture?: { decisions: unknown; diagnostics: unknown } }
          ).fixture
          return fixture
            ? { decisions: fixture.decisions, diagnostics: fixture.diagnostics }
            : undefined
        })
        .catch(() => undefined)
      console.error('Desktop embedding diagnostics:', JSON.stringify(diagnostics))
      const frames = electron
        ? await Promise.all(
            (await electron.firstWindow()).frames().map(async (frame) => ({
              url: frame.url().split('?')[0],
              text: await frame
                .locator('body')
                .innerText({ timeout: 1000 })
                .catch(() => '')
            }))
          )
        : []
      console.error('Desktop embedding frames:', JSON.stringify(frames))
      throw error
    } finally {
      await electron?.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  60_000
)
