import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync, appendFileSync, chmodSync } from 'node:fs'
import { basename,join,resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
const [action, location, feedDir, architecture] = process.argv.slice(2)
const dir=resolve(location), app=join(dir,'Applications/Open-Science.app'), exe=app+'/Contents/MacOS/Open-Science'
const config=join(dir,'config'), profile=join(dir,'profile'), data=join(dir,'data')
const updName='os-quit-accept-'+basename(dir)
const record=(event,details)=>{const rec=JSON.stringify({time:new Date(),event,details});console.log(rec);appendFileSync(join(dir,'acceptance.jsonl'),rec+'\n')}
if(action==='serve'){
  const server=createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname
    if(!['/latest-mac.yml','/aipoch-open-science-1.3.2-mac-'+architecture+'.zip'].includes(path)){res.writeHead(404).end();return}
    const file=join(feedDir,path.slice(1)), size=statSync(file).size
    res.writeHead(200,{'Content-Length':size})
    const stream=createReadStream(file);let bytes=0
    stream.on('data',b=>bytes+=b.length);res.once('close',()=>{stream.destroy();record('served',{path,bytes,finished:res.writableFinished})});stream.pipe(res)
  })
  server.listen(0,'127.0.0.1',()=>writeFileSync(join(dir,'feed-url'),'http://127.0.0.1:'+server.address().port)); 
}else if(action==='launch'){
  for(const p of [config,profile,data])mkdirSync(p,{recursive:true})
  if(!existsSync(join(config,'settings.json'))) writeFileSync(join(config,'settings.json'),JSON.stringify({version:2,providers:[],onboardingCompletedAt:Date.now(),pathsNormalizedAt:Date.now(),dataRoot:data,localePreference:'en',notificationsEnabled:false}))
  const env={OPEN_SCIENCE_CONFIG_ROOT:config,OPEN_SCIENCE_USER_DATA:profile,OPEN_SCIENCE_E2E_STORAGE_ROOT:config}
  execFileSync('open',['-n','-a',app,...Object.entries(env).flatMap(([k,v])=>['--env',k+'='+v]),'--args','--inspect=127.0.0.1:19365','--lang=en-US','--credential-store=file'])
}else {
  const targets=await fetch('http://127.0.0.1:19365/json/list').then(r=>r.json());assert.equal(targets.length,1)
  const sock=new WebSocket(targets[0].webSocketDebuggerUrl);await new Promise((r,j)=>{sock.onopen=r;sock.onerror=j})
  let seq=0
  const evaluate=async code=>{const id=++seq;return new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('Eval timeout')),120000);sock.onmessage=e=>{const m=JSON.parse(e.data);if(m.id!==id)return;clearTimeout(timer);if(m.error||m.result.exceptionDetails)j(Error(JSON.stringify(m.error||m.result.exceptionDetails)));else r(m.result.result.value)};sock.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:code,awaitPromise:true,returnByValue:true}}))})}
  const run=(body)=>evaluate(`(async()=>{const req=process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app.asar/package.json'), {app,BrowserWindow,autoUpdater:native,Menu}=req('electron'), fs=req('fs');if(fs.realpathSync(process.execPath)!==fs.realpathSync(${JSON.stringify(exe)})||app.getPath('userData')!==${JSON.stringify(profile)})throw Error('isolation');const w=BrowserWindow.getAllWindows().find(x=>x.webContents.getURL().includes('index.html')), render=s=>w.webContents.executeJavaScript(s,true); ${body}})()`)
  const renderer=(code)=>run('return await render('+JSON.stringify(code)+')')
  try{
    if(action==='configure'){
      const url=readFileSync(join(dir,'feed-url'),'utf8');writeFileSync(join(dir,'test-feed.yml'),'provider: generic\nurl: '+url+'\nupdaterCacheDirName: '+updName+'\n')
      record('configure',await run(`const u=req('electron-updater').autoUpdater;u.updateConfigPath=${JSON.stringify(join(dir,'test-feed.yml'))};u.setFeedURL({provider:'generic',url:${JSON.stringify(url)}});for(const [owner,e] of [['SDK',u],['Squirrel',native]])for(const name of ['checking-for-update','update-downloaded','error'])e.on(name,(x)=>fs.appendFileSync(${JSON.stringify(join(dir,'events.jsonl'))},JSON.stringify({t:new Date(),owner,name,pid:process.pid,info:x instanceof Error?x.message:undefined})+'\\n'));return {exe:process.execPath,pid:process.pid,version:app.getVersion(),sdk:req('electron-updater/package.json').version,windows:BrowserWindow.getAllWindows().map(w=>w.webContents.getURL())}`))
      record('check',await renderer('window.api.update.check()'))
    }else if(action==='status')record('status',await run("return {pid:process.pid,version:app.getVersion(),focused:!!BrowserWindow.getFocusedWindow(),win:BrowserWindow.getAllWindows().map(x=>x.webContents.getURL()),status:await render('window.api.update.getStatus()')}"))
    else if(action==='identity')record('identity',await run('return {version:app.getVersion(),pid:process.pid,exe:process.execPath}'))
    else if(action==='off'||action==='on')record(action,await renderer('window.api.update.setAutomaticDownloads('+String(action==='on')+')'))
    else if(action==='manual-download')record(action,await renderer('window.api.update.download()'))
    else if(action==='restart')record(action,await renderer('void window.api.update.apply();true'))
    else if(action==='hide')record(action,await run('app.hide();return process.pid'))
    else if(action==='close')record(action,await run('w.close();return process.pid'))
    else if(action==='quit')record(action,await run("setTimeout(()=>Menu.sendActionToFirstResponder('terminate:'),100);return process.pid"))
    else if(action==='settings'){
      record('controls',await renderer("Array.from(document.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||b.textContent).filter(Boolean).slice(0,65)"))
      await renderer("document.querySelector('[aria-label=\"Settings\"]')?.click()")
      await delay(900)
      record('settings-open',await renderer("({text:document.body.innerText.slice(0,600),switch:!!document.querySelector('[aria-label=\"Automatically download updates\"]')})"))
      await renderer("document.querySelector('[data-settings-anchor=\"general.about\"]')?.scrollIntoView({block:'center'})")
      await delay(350)
      const png=await run("return (await w.webContents.capturePage()).toPNG().toString('base64')")
      writeFileSync(join(dir,'settings.png'),Buffer.from(png,'base64'))
    }
  }finally{sock.close()}
}
