import assert from 'node:assert/strict'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareSupervisedMacInstallation, discardPreparedMacInstallation, launchPreparedMacInstaller } from '../../../src/main/update/installation-executor'
import { beginInstallationUpdateAsync, advanceInstallationUpdateAsync, installationStateDirectory, assertInstallationExecutorSettled, inspectInstallationUpdate, verifyInstallationManifestAsync } from '../../../src/main/update/installation-protection'
import { inspectOwnedCrashpadProcesses } from '../../../src/main/update/installation-occupancy'
import { readRuntimeExitOutcome } from '../../../src/main/runtime-stop-confirmation'

export const location = (d) => ({ installationRoot: join(d,'Applications/Open-Science.app'), stateRoot:join(d,'state') })
const read = (f) => JSON.parse(fs.readFileSync(f,'utf8'))
const prepared = (d) => read(join(d,'prepared.json'))
export const note = (d,event,details={}) => fs.appendFileSync(join(d,'stages.jsonl'),JSON.stringify({time:Date.now(),event,...details})+'\n')
export function signature(path) {
  const text = execFileSync('/usr/bin/codesign',['-dr','-',path],{encoding:'utf8',stdio:['ignore','pipe','pipe']})
  return text.trim().replace(/^designated => /,'')
}
function verify(path,requirement) {
  assert.match(requirement,/com\.aipoch\.open-science/)
  assert.match(requirement,/87G9WFU9H3/)
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','--all-architectures','-R='+requirement,path])
}
export async function prepare(d) {
  const loc=location(d)
  const {archive,sha512}=read(join(d,'input.json'))
  note(d,'prepare-start')
  const req=signature(loc.installationRoot)
  verify(loc.installationRoot,req)
  const result=await prepareSupervisedMacInstallation({...loc,archive,sha512,targetVersion:'1.3.2'})
  try {
    verify(result.stagedBundle,req)
    const stats=fs.statSync(result.stagedBundle)
    assert.equal(stats.dev,fs.statSync(loc.installationRoot).dev)
    fs.writeFileSync(join(d,'prepared.json'),JSON.stringify({...result,req,dev:stats.dev,ino:stats.ino,sha512}),{flag:'wx',mode:0o600})
    note(d,'prepared',{dev:stats.dev,ino:stats.ino,staged:result.stagedBundle,executor:result.directory})
  } catch (err) {await discardPreparedMacInstallation(result);throw err}
}
export async function discard(d) {
  const p=prepared(d)
  assert.equal(dirname(dirname(p.stagedBundle)),dirname(location(d).installationRoot))
  assert.equal(dirname(p.directory),installationStateDirectory(location(d)))
  const s=fs.lstatSync(p.stagedBundle)
  assert(s.ino===p.ino && s.dev===p.dev)
  await discardPreparedMacInstallation(p)
  assert(!fs.existsSync(p.directory) && !fs.existsSync(dirname(p.stagedBundle)))
  note(d,'discarded')
}
export async function arm(d,electron,crashInstance) {
  const {app}=electron, loc=location(d), p=prepared(d), config=join(d,'config')
  assert.equal(app.getVersion(),'1.3.1')
  assert.equal(fs.realpathSync(process.execPath),join(loc.installationRoot,'Contents/MacOS/Open-Science'))
  const owner=read(join(config,'runtime-owner.json'))
  const response=await fetch('http://127.0.0.1:'+owner.port+'/owner',{headers:{Authorization:'Bearer '+fs.readFileSync(join(config,'web-token'),'utf8').trim(),'x-open-science-runtime-generation':owner.generation}})
  assert(response.ok)
  const info=await response.json()
  assert.equal(info.startupOptions.configRoot,config)
  assert.equal(info.startupOptions.profilePath,join(d,'profile'))
  assert.equal(info.pid,owner.pid)
  const ownedPids=()=>[process.pid,...app.getAppMetrics().map(x=>x.pid),...inspectOwnedCrashpadProcesses({installationRoot:loc.installationRoot,crashDumpsPath:app.getPath('crashDumps'),instanceId:crashInstance || ''})]
  const generation=info.desktopGeneration
  const original=app.exit.bind(app)
  let pending=false
  // Only intercept the experiment's explicitly requested, clean ordinary quit.
  app.exit=(status=0)=>{
    if(status!==0 || !fs.existsSync(join(d,'request-quit')))return original(status)
    if(pending)return
    pending=true
    void (async()=>{
      assert.equal(await readRuntimeExitOutcome(config,generation,info.pid),'clean')
      assert(!fs.existsSync(join(d,'profile/disable-background-update-downloads')))
      assert.equal(read(join(d,'input.json')).sha512,p.sha512)
      const st=fs.lstatSync(p.stagedBundle)
      assert(st.ino===p.ino && st.dev===p.dev)
      note(d,'final-check')
      verify(p.stagedBundle,p.req)
      note(d,'final-signature-verified')
      assert(await verifyInstallationManifestAsync(p.stagedBundle,p.manifest))
      note(d,'final-manifest-verified')
      const record=await beginInstallationUpdateAsync({...loc,currentVersion:'1.3.1',targetVersion:'1.3.2',targetManifest:p.manifest,runtime:{pid:info.pid,generation,configRoot:config},startupOptions:info.startupOptions,allowedProcessIds:ownedPids})
      note(d,'admitted')
      await advanceInstallationUpdateAsync(loc,record.operationId,'stopping')
      await advanceInstallationUpdateAsync(loc,record.operationId,'stopped',true)
      await advanceInstallationUpdateAsync(loc,record.operationId,'handoff',false,{allowedProcessIds:ownedPids()})
      await launchPreparedMacInstaller(loc,record.operationId,p,{desktopPid:process.pid,relaunch:false,...(fs.existsSync(join(d,'rollback-trial'))?{fault:'after-old-rename'}:{})})
      fs.writeFileSync(join(d,'bound.json'),JSON.stringify(inspectInstallationUpdate(loc)),{flag:'wx',mode:0o600})
      note(d,'executor-armed')
    })().catch(error=>note(d,'handoff-refused',{error:String(error),reason:error.reason,blocking:error.recovery?.blockingProcesses})).finally(()=>original(status))
  }
  return {pid:process.pid,generation,crashInstance:!!crashInstance}
}
export function receipt(d) {
  const p=prepared(d)
  const result=read(join(p.directory,'result.json'))
  assert.equal(result.outcome,'installed')
  verify(location(d).installationRoot,p.req)
  const record=read(join(d,'bound.json'))
  assert.equal(assertInstallationExecutorSettled(record),'installed')
  note(d,'installed-verified',{outcome:result.outcome})
}
export { inspectInstallationAvailability } from '../../../src/main/update/installation-protection'
export function rolledBack(d) {
  const p=prepared(d)
  const record=read(join(d,'bound.json'))
  assert.equal(assertInstallationExecutorSettled(record),'rolled-back')
  verify(location(d).installationRoot,p.req)
  note(d,'rollback-lock-released')
}
