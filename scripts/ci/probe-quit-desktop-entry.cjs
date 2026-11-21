const fs = require('node:fs')
const path = require('node:path')
const {execFileSync} = require('node:child_process')
const {randomBytes} = require('node:crypto')
const {setTimeout: sleep} = require('node:timers/promises')

module.exports = function registerDesktopEntry({image, root, env, chromium}) {
  const applications = path.join(env.XDG_DATA_HOME, 'applications')
  const mime = path.join(env.XDG_DATA_HOME, 'mime')
  fs.mkdirSync(applications, {recursive:true})
  fs.mkdirSync(path.join(mime,'packages'), {recursive:true})
  const name = 'upgrade-open-science.desktop'
  const port = 19473
  fs.writeFileSync(path.join(applications,name), [
    '[Desktop Entry]', 'Type=Application', 'Name=Open-Science acceptance',
    'Exec="'+image+'" --no-sandbox --disable-gpu --password-store=gnome-libsecret --remote-debugging-port='+port+' %U',
    'MimeType=application/x-open-science-session;x-scheme-handler/open-science;', 'Terminal=false',''
  ].join('\n'))
  fs.writeFileSync(path.join(mime,'packages','science.xml'),
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info"><mime-type type="application/x-open-science-session"><glob pattern="*.science"/></mime-type></mime-info>')
  const run=(cmd,...args)=>execFileSync(cmd,args,{env,stdio:'ignore',timeout:15000})
  run('update-mime-database',mime)
  run('update-desktop-database',applications)
  for(const type of ['application/x-open-science-session','x-scheme-handler/open-science']) run('gio','mime',type,name)
  const document = path.join(root,'Desktop handoff.science')
  fs.writeFileSync(document,'Awaiting user project selection')
  const linkName='Browser handoff.science'
  const url='open-science://import?'+new URLSearchParams({version:'1',origin:'https://research.example',secret:randomBytes(32).toString('hex'),port:'51433',name:linkName,size:'12'})
  return {
    open(kind) {run('gio','open',kind==='file'?document:url)},
    async verify(kind) {
      const start=Date.now()
      let browser,page
      while(Date.now()-start<90000 && !page) {
        try {
          browser ??= await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000})
          page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('file:') || p.url().startsWith('app:'))
        } catch {}
        if (!page) await sleep(100)
      }
      if(!page)throw Error('desktop entry did not start a debuggable application window')
      const expected=kind==='file'?path.basename(document):linkName
      await page.waitForFunction(async ({kind,expected})=>{
        try {
          if((await window.api.update.getStatus()).current!=='1.3.2')return false
          const snapshot=await window.api.sessions.packageOperation({action:'snapshot'})
          return kind==='file'
            ? snapshot?.importFilename===expected || snapshot?.pendingImports?.some(p=>p.filename===expected)
            : snapshot?.browserTransfers?.some(t=>t.filename===expected && t.state!=='failed')
        } catch{return false}
      },{kind,expected},{timeout:60000})
      console.log('Desktop association handled by 1.3.2:',kind,expected)
      return {browser,page}
    }
  }
}
