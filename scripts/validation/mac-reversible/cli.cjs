const api=require(process.env.DRIVER)
const [action,d]=process.argv.slice(2)
Promise.resolve(action==='busy'?api.inspectInstallationAvailability(api.location(d)).then(()=>{throw Error('accepted occupied target')},error=>{if(!error.recovery?.blockingProcesses?.some(p=>p.pid===Number(process.env.HOLDER)))throw error;api.note(d,'holder-refused',{pid:Number(process.env.HOLDER)})}):api[action](d)).catch(e=>{console.error(e);process.exitCode=1})
