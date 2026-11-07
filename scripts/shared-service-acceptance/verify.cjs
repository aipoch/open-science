const { _electron: electron, chromium } = require('playwright')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const bundle = path.join(os.homedir(), 'Applications/Open-Science.app')
const res = path.join(bundle, 'Contents/Resources')
const executablePath = path.join(bundle, 'Contents/MacOS/Open-Science')
const cli = (...args) => execFileSync(path.join(res,'node-runtime/node'), [path.join(res,'cli/index.mjs'), ...args], {encoding:'utf8',timeout:20000}).trim()
const status = () => JSON.parse(cli('status','--json'))
const record = (step, data={}) => {
  const line = JSON.stringify({ step, at:new Date().toISOString(), ...data })
  console.log(line)
  fs.appendFileSync('evidence/observations.jsonl',line+'\n')
}
const snapshot = (s) => ({version:s.appVersion, pid:s.pid, generation:s.lifetime?.generation, apps:s.lifetime?.apps, explicit:s.lifetime?.explicit})
const wait = async (label,check,ms=60000) => {
  const end=Date.now()+ms; let last
  while(Date.now()<end){try {const value=await check(); if(value) return value} catch(e){last=e} await new Promise(r=>setTimeout(r,550))}
  throw new Error(label+' timed out'+(last?' ('+String(last.message).slice(0,200)+')':''))
}
let app, page, browser
const launch = async () => {
  app=await electron.launch({executablePath,args:['--lang=en-US'],timeout:90000})
  page=await app.firstWindow()
  await page.waitForFunction(async()=> (await window.api?.databaseStartup?.getState())?.phase==='ready',null,{timeout:90000})
  await wait('settings IPC readiness',async()=>{await page.evaluate(()=>window.api.settings.markOnboardingComplete());return true},90000)
  await page.reload({waitUntil:'domcontentloaded'})
  await page.waitForFunction(async()=> (await window.api?.desktopRuntime?.getState())?.phase==='connected')
}
async function run(){
  await launch()
  record('desktop ready',{version:await app.evaluate(({app})=>app.getVersion()), pid:JSON.parse(fs.readFileSync(path.join(os.homedir(),'.open-science/runtime-owner.json'))).pid})
  const started=JSON.parse(cli('start','--no-open','--json'))
  const old=status()
  record('CLI start',{result:started.result,...snapshot(old)})
  assert.equal(started.result,'already-running')
  assert.equal(old.lifetime.explicit,true)
  assert.equal(old.lifetime.apps,1)
  const proc=app.process()
  await app.evaluate(({app})=>{setTimeout(()=>app.quit(),10)})
  await wait('last Desktop exits',()=>proc.exitCode!==null || proc.signalCode!==null)
  const detached=status()
  record('Desktop quit',snapshot(detached))
  assert.equal(detached.pid,old.pid)
  assert.equal(detached.lifetime.generation,old.lifetime.generation)
  assert.equal(detached.lifetime.apps,0)
  await launch()
  const attached=status()
  record('Desktop reattached',snapshot(attached))
  assert.equal(attached.pid,old.pid)
  assert.equal(attached.lifetime.generation,old.lifetime.generation)
  assert.equal(attached.lifetime.apps,1)
  browser=await chromium.launch({channel:'chrome'})
  const web=await browser.newPage()
  let connected=false,disconnected=false
  web.on('websocket',s=>{
    if(!new URL(s.url()).pathname.endsWith('/events'))return
    s.on('framereceived',()=>{if(!connected){connected=true;record('external Web events active')}})
    s.on('close',()=>{if(!disconnected){disconnected=true;record('external Web events closed')}})
  })
  await web.goto(cli('url'),{waitUntil:'domcontentloaded'})
  await wait('authenticated external event stream',()=>connected)
  await app.evaluate(()=>{
    const r=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json')
    r('electron-updater').autoUpdater.setFeedURL({provider:'generic',url:'http://127.0.0.1:18765'})
  })
  const state=()=>page.evaluate(()=>window.api.update.getStatus())
  await page.evaluate(()=>window.api.update.check())
  await wait('available target',async()=>{const s=await state();return s.latest==='1.1.0' && s.state==='available'})
  await page.evaluate(()=>window.api.update.download())
  await wait('verified download ready',async()=> (await state()).state==='ready',120000)
  await page.locator('button.update-reminder').first().click()
  const dialog=page.getByRole('dialog').last()
  await dialog.waitFor()
  const text=await dialog.innerText()
  record('visible before update',{text:text.split(/What.s new/i)[0],buttons:await dialog.locator('button:visible').allTextContents()})
  await dialog.screenshot({path:'evidence/before-update.png'})
  assert.equal(disconnected,false)
  await dialog.getByRole('button',{name:/^(Update|Restart to update)$/}).click()
  const target=await wait('successor Desktop and backend',async()=>{
    if(!page.isClosed()){
      const s=await state().catch(()=>null)
      if(s?.reason && s.reason!=='user-cancelled' && !global.reported){
        global.reported=true;record('update gate response',{reason:s.reason, detail:s.recovery?.detail, blockers:s.recovery?.blockingProcesses})
        await page.screenshot({path:'evidence/update-gate.png'}).catch(()=>{})
      }
    }
    const s=status()
    return s.appVersion==='1.1.0' && s.lifetime.apps===1 && s
  },180000)
  record('successor attached',snapshot(target))
  assert.notEqual(target.pid,old.pid)
  assert.notEqual(target.lifetime.generation,old.lifetime.generation)
  assert.equal(target.lifetime.explicit,true)
  await wait('external socket closed',()=>disconnected)
  assert.throws(()=>process.kill(old.pid,0),{code:'ESRCH'})
  execFileSync('codesign',['--verify','--deep','--strict',bundle])
  record('signed replacement verified')
}
run().then(()=>process.exit(0)).catch(async e=>{if(page && !page.isClosed()){await page.screenshot({path:'evidence/failure.png',timeout:5000}).catch(()=>{});console.log('UI:', (await page.locator('body').innerText({timeout:3000}).catch(()=>'' )).slice(0,1800))}console.error(e.message.replace(/token=[^ &]+/gi,'token=<redacted>'));process.exit(1)})
