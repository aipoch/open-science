// Capture the identifier supplied by this signed launch to crashReporter.start.
// The repository independently checks executable, crash database and this identifier.
import { setTimeout as delay } from 'node:timers/promises'
let target
for(let n=0;n<150&&!target;n++){try{[target]=await fetch('http://127.0.0.1:19365/json/list').then(r=>r.json())}catch{} if(!target)await delay(100)}
if(!target) throw Error('no initial process')
const ws=new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
let id=0,paused
const pending=new Map()
const stopped=new Promise(r=>paused=r)
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Debugger.paused')paused(m.params.callFrames[0].callFrameId);if(pending.has(m.id)){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(JSON.stringify(m.error))):r(m.result)}}
const call=(method,params={})=>new Promise((r,j)=>{pending.set(++id,[r,j]);ws.send(JSON.stringify({id,method,params}))})
const guard=setTimeout(()=>process.exit(1),30000)
await call('Debugger.enable')
await call('Runtime.runIfWaitingForDebugger')
const frame=await stopped
const observed=await call('Debugger.evaluateOnCallFrame',{callFrameId:frame,expression:`(()=>{const r=process.getBuiltinModule('module').createRequire(process.execPath)('electron').crashReporter; const start=r.start.bind(r);r.start=(options)=>{globalThis.__perfCrashInstance=options.globalExtra?.openScienceInstance;return start(options)};return true})()`,returnByValue:true})
console.log('observer', observed.result?.value, observed.exceptionDetails?.text)
await call('Debugger.resume')
ws.close()
clearTimeout(guard)
