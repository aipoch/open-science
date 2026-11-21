const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { load } = require('js-yaml')

async function verify(dir, name, feed) {
  const file = path.join(dir, name)
  const a = crypto.createHash('sha256'), b = crypto.createHash('sha512')
  for await (const chunk of fs.createReadStream(file)) { a.update(chunk); b.update(chunk) }
  const release = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'))).assets.find(asset => asset.name === name)
  const offer = load(fs.readFileSync(path.join(dir,feed),'utf8')).files.find(asset => asset.url.endsWith(name))
  assert.equal('sha256:' + a.digest('hex'),release.digest)
  assert.equal(b.digest('base64'),offer.sha512)
  assert.equal(fs.statSync(file).size,offer.size)
  console.log(name,offer.size,release.digest)
}

async function version(entry, expected, profile) {
  const { _electron } = require('playwright')
  const app = await _electron.launch({
    executablePath: entry,
    args: ['--no-sandbox','--disable-gpu','--password-store=gnome-libsecret'],
    env: {...process.env,OPEN_SCIENCE_E2E_STORAGE_ROOT:profile},
    timeout: 45000
  })
  try {
    const result=await app.evaluate(({app})=>({
      version:app.getVersion(), entry:process.env.APPIMAGE, exe:app.getPath('exe'),
      mount:process.env.APPDIR
    }))
    assert.equal(result.entry,entry); assert.equal(result.version,expected)
    assert.ok(result.mount && result.exe.startsWith(result.mount + '/'))
    const mounts=fs.readFileSync('/proc/'+app.process().pid+'/mountinfo','utf8')
    assert.ok(mounts.split('\n').some(line=>line.includes(' '+result.mount+' ') && line.includes(' - fuse')))
    console.log(JSON.stringify(result))
  } finally {
    const closed = new Promise(r=>app.once('close',r))
    await app.evaluate(({app})=>{setTimeout(()=>app.exit(0),20)})
    await closed
  }
}
async function main(){
  const [mode,dir,arch,feed]=process.argv.slice(2)
  if(mode==='verify')return verify(dir,arch,feed)
  if(mode==='apply'){
    const {AppImageUpdater}=require('electron-updater/out/AppImageUpdater')
    const sdk=Object.create(AppImageUpdater.prototype)
    Object.defineProperty(sdk,'installerPath',{value:arch})
    process.env.APPIMAGE=dir
    assert.equal(sdk.doInstall({isForceRunAfter:false}),true)
    return
  }
  assert.equal(require('electron-updater/package.json').version,'6.8.9')
  const name=v=>'aipoch-open-science-'+v+'-linux-'+arch+'.AppImage'
  for(const stable of [true,false]){
    const install=fs.mkdtempSync(path.join(dir,'entry-')),cache=fs.mkdtempSync(path.join(dir,'sdk-'))
    const old=path.join(install,stable?'Open-Science.AppImage':name('1.3.1')), candidate=path.join(cache,name('1.3.2'))
    const profile=fs.mkdtempSync(path.join(dir,'profile-'))
    fs.copyFileSync(path.join(dir,'1.3.1',name('1.3.1')),old)
    fs.copyFileSync(path.join(dir,'1.3.2',name('1.3.2')),candidate)
    await version(old,'1.3.1',profile)
    const started=Date.now()
    execFileSync(process.execPath,[__filename,'apply',old,candidate],{stdio:'inherit',timeout:90000})
    console.log('SDK returned after',Date.now()-started,'ms; original path exists:',fs.existsSync(old))
    assert.equal(fs.existsSync(old),stable)
    await version(stable?old:path.join(install,name('1.3.2')),'1.3.2',profile)
    fs.rmSync(install,{recursive:true})
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
