from pathlib import Path
import os

base = Path("timing/scripts/validation/mac-quit-probe.mjs").read_text()
def replace(a,b):
    global base
    assert base.count(a)==1, a
    base=base.replace(a,b)
replace("const env={OPEN_SCIENCE_CONFIG_ROOT", "const env={OPEN_SCIENCE_INSTALLATION_STATE_ROOT:join(dir,'state'),OPEN_SCIENCE_CONFIG_ROOT")
replace("'--inspect=127.0.0.1:19365'", "process.env.TRACE_START?'--inspect-brk=127.0.0.1:19365':'--inspect=127.0.0.1:19365'")
replace("else if(action==='identity')", '''else if(action==='arm')record(action,await run(`return await req(${JSON.stringify(process.env.DRIVER)}).arm(${JSON.stringify(dir)},req('electron'),globalThis.__perfCrashInstance)`))
    else if(action==='workspace')record(action,await run(`if(!w||!w.isVisible())throw Error('no visible workspace'); const data=await render("Promise.all([window.api.runtimeStartup.getState(),window.api.update.getStatus()]).then(([runtime,status])=>({runtime:runtime.phase,version:status.current,text:document.body.innerText.includes('New project')}))");if(!data.text||data.runtime!=='ready')throw Error(JSON.stringify(data)); const projects=await render('window.api.projects.list().then(rows=>rows.length)'); if(!Number.isInteger(projects))throw Error('project list unavailable'); return {data,projects,pid:process.pid,version:app.getVersion(),exe:process.execPath}`))
    else if(action==='identity')''')
Path(os.environ['PROBE']).write_text(base)
