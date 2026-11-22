const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict'), http=require('node:http')
const {createRequire}=require('node:module')
const req=createRequire(path.join(process.env.QA_REPO,'package.json'))
const {_electron,chromium}=req('playwright')
const {setTimeout:sleep}=require('node:timers/promises')
const [candidate,feedDir,feedName]=process.argv.slice(2)
const root=fs.mkdtempSync('/tmp/quit-case-'), image=path.join(root,'Open-Science-1.3.1.AppImage')
async function main(){
 fs.copyFileSync(candidate,image);fs.chmodSync(image,0o755)
 const feed=req('js-yaml').load(fs.readFileSync(path.join(feedDir,feedName),'utf8'))
 const file=feed.files.find(f=>f.url.endsWith('.AppImage'))
 const server=http.createServer((r,s)=>{
   if(r.url.split('?')[0].endsWith('.yml'))return s.end(JSON.stringify(feed))
   if(!r.url.split('?')[0].endsWith('/'+file.url)){s.writeHead(404);return s.end()}
   s.writeHead(200,{'Content-Length':file.size});fs.createReadStream(path.join(feedDir,file.url)).pipe(s)
 })
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const env={...process.env,OPEN_SCIENCE_E2E_STORAGE_ROOT:path.join(root,'profile')}
 const entry=require('./probe-quit-desktop-entry.cjs')({image,root,env,chromium})
 console.log('starting',image)
 const desk=await _electron.launch({executablePath:image,args:['--no-sandbox','--password-store=gnome-libsecret','--disable-gpu'],env,timeout:180000})
 desk.process().stderr.on('data',b=>{const s=b.toString();if(/fail|error|quit|occup/i.test(s))console.log('desktop',s.slice(-800))})
 desk.on('console',m=>{if(m.type()==='error')console.log('main error',m.text())})
 await desk.evaluate(({dialog})=>{
   dialog.showErrorBox=(title,message)=>console.error('QA startup error',title,message)
   const show=dialog.showMessageBox.bind(dialog)
   dialog.showMessageBox=(...args)=>{const opts=args.at(-1);console.error('QA dialog',opts.title,opts.message,opts.detail);return show(...args)}
 })
 desk.on('window',w=>w.on('pageerror',e=>console.log('renderer startup error',e.message.slice(0,350))))
 const page=await desk.firstWindow()
 page.on('pageerror',e=>console.log('renderer startup error',e.message.slice(0,350)))
 page.on('console',m=>{if(m.type()==='error')console.log('renderer console',m.text().slice(0,350))})
 await page.waitForFunction(async()=>{try{return (await window.api.databaseStartup.getState()).phase==='ready'}catch{return false}},{},{timeout:90000})

 for(let i=0;i<45;i++) {
   const view=await page.evaluate(()=>({text:document.body.innerText.slice(0,220),onboarding:!!document.querySelector('[data-onboarding-layout]'),state:window.location.hash})).catch(()=>({}))
   if(i%5===0)console.log('desktop view',view)
   if(view.onboarding) {
     await page.evaluate(()=>window.api.settings.markOnboardingComplete())
     await page.reload({waitUntil:'domcontentloaded'})
     break
   }
   if(await page.getByRole('button',{name:'New project',exact:true}).count())break
   await sleep(1000)
 }
 console.log('workspace view',await page.locator('body').innerText().then(x=>x.slice(0,350)))
 console.log('initial version',await page.evaluate(async()=>(await window.api.update.getStatus()).current))
 await desk.evaluate(({app},url)=>{
   const sdk=process.mainModule.require('node:module').createRequire(app.getAppPath()+'/package.json')('electron-updater').autoUpdater
   sdk.disableDifferentialDownload=true;sdk.setFeedURL(url)
 },'http://127.0.0.1:'+server.address().port+'/')
 console.log('offer', (await page.evaluate(()=>window.api.update.check())).state)
 const ready=await page.evaluate(()=>window.api.update.download())
 console.log('download',ready.state,ready.latest,ready.error,ready.automaticDownloads);assert.equal(ready.state,'ready')
 console.log('ordinary quit entry', await desk.evaluate(({app})=>({version:app.getVersion(),image:process.env.APPIMAGE})))
 console.log('A service state exists',fs.existsSync(path.join(env.OPEN_SCIENCE_E2E_STORAGE_ROOT,'web-service.json')))
 const oldPid=await desk.evaluate(()=>process.pid)
 const overlap=process.env.QA_OPEN_KIND?.startsWith('during-')
 const kind=process.env.QA_OPEN_KIND?.replace(/^during-/,'')
 if(overlap) {
   // Keep the real renderer active briefly so a second desktop invocation can reach the old PID.
   // Actual save requests, acknowledgements and the normal quit code remain untouched.
   await page.evaluate(()=>setTimeout(()=>{const end=performance.now()+1100;while(performance.now()<end){}},20))
 }
 await desk.evaluate(({app},root)=>{
   const fs=process.mainModule.require('node:fs')
   app.once('before-quit',()=>fs.writeFileSync(root+'/quitting','1'))
   app.once('second-instance',()=>fs.writeFileSync(root+'/relayed','1'))
   setTimeout(()=>app.quit(),5)
 },root)
 if(overlap) {
   for(let i=0;i<500&&!fs.existsSync(root+'/quitting');i++)await sleep(10)
   assert.ok(fs.existsSync(root+'/quitting') && fs.existsSync('/proc/'+oldPid))
   entry.open(kind)
   console.log('Desktop association requested during ordinary quit:',kind)
 }
 for(let i=0;fs.existsSync('/proc/'+oldPid)&&i<900;i++)await sleep(100)
 assert.ok(!fs.existsSync('/proc/'+oldPid),'ordinary quit timed out')
 console.log('old PID exited',oldPid,'bytes at original path',fs.statSync(image).size,'expected B',file.size)
 if(kind) {
   if(overlap) {
     assert.ok(fs.existsSync(root+'/relayed'), 'old desktop must receive the overlapping request')
     await entry.verifyService(kind)
   } else {
     entry.open(kind)
     await entry.verify(kind)
   }
   server.close()
   return
 }
 const next=await _electron.launch({executablePath:image,args:['--no-sandbox','--password-store=gnome-libsecret','--disable-gpu'],env,timeout:180000})
 const actual=await next.evaluate(({app})=>({version:app.getVersion(),entry:process.env.APPIMAGE}))
 console.log('reopened',actual);assert.equal(actual.version,'1.3.2');assert.equal(actual.entry,image)
 await next.evaluate(({app})=>{setTimeout(()=>app.exit(0),10)})
 server.close()
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1)})
