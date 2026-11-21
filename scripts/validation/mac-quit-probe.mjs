import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync, appendFileSync, chmodSync } from 'node:fs'
import { basename,join,resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
const [action, location, feedDir, architecture] = process.argv.slice(2)
const dir=resolve(location), app=process.env.OS_ACCEPT_APP||join(dir,'Applications/Open-Science.app'), exe=app+'/Contents/MacOS/Open-Science'
const config=join(dir,'config'), profile=join(dir,'profile'), data=join(dir,'data')
const updName='os-quit-accept-'+basename(dir)
const record=(event,details)=>{const rec=JSON.stringify({time:new Date(),event,details},(k,v)=>['notes','localizedNotes'].includes(k)?undefined:v);console.log(rec);appendFileSync(join(dir,'acceptance.jsonl'),rec+'\n')}
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
  if(!existsSync(join(config,'settings.json'))) writeFileSync(join(config,'settings.json'),JSON.stringify({version:2,providers:[],onboardingCompletedAt:Date.now(),pathsNormalizedAt:Date.now(),dataRoot:data,localePreference:process.env.NOTICE_LOCALE||'en',notificationsEnabled:false}))
  const env={OPEN_SCIENCE_CONFIG_ROOT:config,OPEN_SCIENCE_USER_DATA:profile}
  execFileSync('open',['-n','--stdout',join(dir,'stdout'),'--stderr',join(dir,'stderr'),'-a',app,...Object.entries(env).flatMap(([k,v])=>['--env',k+'='+v]),...(process.env.FIXTURE_FILE?[process.env.FIXTURE_FILE]:process.env.FIXTURE_LINK
    ?['open-science://import?'+new URLSearchParams({version:'1',origin:'http://127.0.0.1:65533',port:'65533',name:'handoff-url.science',size:'5',secret:'ab'.repeat(32)})]:[]),'--args','--inspect=127.0.0.1:19365','--lang=en-US'])
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
      await renderer('window.api.update.check()'); record('check',await renderer('window.api.update.check()')); assert.ok(readFileSync(join(dir,'server.log'),'utf8').includes('/latest-mac.yml'),'test feed was not contacted')
    }else if(action==='status')record('status',await run("return {pid:process.pid,version:app.getVersion(),focused:!!BrowserWindow.getFocusedWindow(),win:BrowserWindow.getAllWindows().map(x=>x.webContents.getURL()),status:await render('window.api.update.getStatus()')}"))
    else if(action==='workspace')record(action,await run(`if(!w||!w.isVisible())throw Error('no visible workspace'); const data=await render("Promise.all([window.api.runtimeStartup.getState(),window.api.update.getStatus()]).then(([runtime,status])=>({runtime:runtime.phase,version:status.current,text:document.body.innerText.includes('New project')}))");if(!data.text||data.runtime!=='ready')throw Error(JSON.stringify(data)); const projects=await render('window.api.projects.list().then(rows=>rows.length)'); if(!Number.isInteger(projects))throw Error('project list unavailable'); return {data,projects,pid:process.pid,version:app.getVersion(),exe:process.execPath}`))
    else if(action==='socket') {
      const socket=await run("const id=req('crypto').createHash('sha256').update(process.execPath).update('\\0').update(app.getVersion()).digest('hex').slice(0,20);return req('path').join(req('os').tmpdir(),'os-update-'+process.getuid(),id+'.sock')")
      writeFileSync(join(dir,'fixture-socket'),socket)
    } else if(action.startsWith('notice-')) {
      const button="Array.from(document.querySelectorAll('[role=status] button')).find(b=>['查看更新','View updates'].includes(b.textContent.trim()))"
      const home=await renderer("!!document.querySelector('main') && /新建项目|创建项目|New project/.test(document.body.innerText)")
      const shown=await renderer('!!('+button+')')
      if(action==='notice-absent'){assert.ok(home);assert.equal(shown,false);record(action,{home,shown})}
      else if(action==='notice-settings'){assert.ok(await renderer("!!document.querySelector('[data-settings-anchor=\"general.about\"]')"));record(action,{reachedVersionSettings:true})}
      else {
        assert.ok(home);assert.ok(shown)
        const clean=await run("return !process.env.OPEN_SCIENCE_UPDATE_OPEN_INTERRUPTED && !process.argv.some(s=>s.endsWith('.science')||s.startsWith('open-science:'))")
        assert.ok(clean)
        assert.equal(await renderer("!!document.querySelector('[role=dialog]')"),false)
        assert.equal(await renderer("window.api.packagePresentation.getState().then(s=>!!s?.browserTransfers?.length)"),false)
        const png=await run("return (await w.webContents.capturePage()).toPNG().toString('base64')")
        writeFileSync(join(dir,'interrupted-open.png'),Buffer.from(png,'base64'))
        if(action==='notice-dismiss')await renderer('('+button+').parentElement.querySelector("button[aria-label]").click()')
        else await renderer('('+button+').click()')
        assert.equal(await renderer('!!('+button+')'),false)
        assert.equal(await renderer("location.hash"),'')
        record(action,{home,shown,clean,dismissed:true})
      }
    }
    else if(action==='document')record(action,await run(`const observed=await render("Array.from(document.querySelectorAll('[role=dialog]')).map(n=>n.innerText).some(t=>t.includes('Import Session package'))");return {observed,version:app.getVersion(),pid:process.pid,argvHasDocument:process.argv.some(v=>v.endsWith('.science'))}`))
    else if(action==='link')record(action,await run(`const state=await render("window.api.packagePresentation.getState()");const matches=state?.browserTransfers?.filter(t=>t.filename==='handoff-url.science')??[];return {observed:matches.length===1,count:matches.length,version:app.getVersion(),pid:process.pid,argvHasUrl:process.argv.some(v=>v.startsWith('open-science:'))}`))
    else if(action==='identity')record('identity',await run('return {version:app.getVersion(),pid:process.pid,exe:process.execPath}'))
    else if(action==='off'||action==='on')record(action,await renderer('window.api.update.setAutomaticDownloads('+String(action==='on')+')'))
    else if(action==='windows')record('windows',await run('return BrowserWindow.getAllWindows().map(w=>w.webContents.getURL())'))
    else if(action==='manual-download')record(action,await renderer('window.api.update.download()'))
    else if(action==='restart')record(action,await renderer('void window.api.update.apply();true'))
    else if(action==='hide')record(action,await run('app.hide();return process.pid'))
    else if(action==='close')record(action,await run('w.close();return process.pid'))
    else if(action==='quit')record(action,await run("setTimeout(()=>Menu.sendActionToFirstResponder('terminate:'),100);return process.pid"))
    else if(action==='settings'){
      for(let n=0;n<30&&!await renderer("!!document.querySelector('[aria-label=\"Settings\"]')");n++)await delay(250)
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
