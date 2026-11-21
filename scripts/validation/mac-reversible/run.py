"""Installed-package experiment. Every mutating path belongs to this disposable fixture."""
import hashlib,json,os,re,shutil,signal,subprocess,sys,tempfile,time,traceback
from pathlib import Path

assert os.environ['RUNNER_ENVIRONMENT']=='github-hosted' and sys.platform=='darwin'
root=Path(os.environ['RUNNER_TEMP']).resolve()
out=root/'measurements'
out.mkdir(exist_ok=True)
src=Path(__file__).resolve().parent
arch=os.environ['ARCH']
seed=root/'seed/Open-Science.app'
archive=root/'feed'/f'aipoch-open-science-1.3.2-mac-{arch}.zip'
manifest=(root/'feed/latest-mac.yml').read_text()
digest=re.search(r'url: '+re.escape(archive.name)+r'\s+sha512: (\S+)',manifest)[1]
def run(*args,**kw):
    return subprocess.run(list(map(str,args)),check=True,text=True,**kw)
def wait(fn,seconds=90):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        value=fn()
        if value:return value
        time.sleep(.04)
    raise TimeoutError(getattr(fn,'__name__','condition'))
def alive(pid):
    try:os.kill(pid,0);return True
    except ProcessLookupError:return False
def identity(p):
    s=p.lstat();return (s.st_dev,s.st_ino,s.st_uid)
def size(p):
    return int(run('/usr/bin/du','-sk',p,capture_output=True).stdout.split()[0])*1024 if p.exists() else 0

def case(mode):
    d=Path(tempfile.mkdtemp(prefix='reversible-',dir=root))
    apps=d/'Applications';apps.mkdir()
    app=apps/'Open-Science.app'
    run('cp','-cR',seed,app)
    original=identity(app)
    scratch=d/'scratch';scratch.mkdir()
    for name in ['data','profile','config','state']:(d/name).mkdir()
    other=apps/'Unrelated.app';other.mkdir()
    keep=[other/'sentinel',d/'data/user-sentinel']
    for p in keep:p.write_bytes(os.urandom(64))
    sentinels=[(identity(p),p.read_bytes()) for p in keep]
    initial={'archive':str(archive),'sha512':digest}
    (d/'input.json').write_text(json.dumps(initial))
    env={**os.environ,'TMPDIR':str(scratch)}
    log=out/(mode+'.jsonl')
    def note(event,**values):
        with log.open('a') as f:f.write(json.dumps(dict(time=time.time_ns()//1000000,event=event,**values))+'\n')
    def cli(action,**kw):return run('node',src/'cli.cjs',action,d,env=env,**kw)
    def probe(action,extra=None,check=True):
        cmd=['node',env['PROBE'],action,str(d),str(root/'feed'),arch]
        return subprocess.run(cmd,text=True,capture_output=True,env={**env,**(extra or {})},check=check,timeout=25)
    def ws():
        res=probe('workspace',check=False)
        if res.returncode:
            (d/'last-workspace-error').write_text(res.stderr[-2200:])
            return None
        return json.loads(res.stdout.splitlines()[-1])['details']
    def launch(paused=False):
        probe('launch',{'TRACE_START':'1'} if paused else None)
        if paused:run('node',src/'observe-start.mjs',timeout=45)
    def prep():
        cli('prepare')
        p=json.loads((d/'prepared.json').read_text())
        note('stage-space',stageKB=size(Path(p['stagedBundle']))//1024,executorKB=size(Path(p['directory']))//1024)
        return p
    def cancel(p,reason):
        if monitor:
            monitor.wait(timeout=30)
            assert monitor.returncode==0
        else:cli('discard')
        assert not Path(p['directory']).exists() and not Path(p['stagedBundle']).parent.exists()
        note('reclaimed',reason=reason,stageBytes=size(Path(p['stagedBundle']).parent),executorBytes=size(Path(p['directory'])))
    monitor=None
    try:
        if mode=='shipit':
            launch()
            a=wait(ws);assert a['version']=='1.3.1'
            with (d/'server.log').open('w') as outlog:
                server=subprocess.Popen(['node',env['PROBE'],'serve',str(d),str(root/'feed'),arch],env=env,stdout=outlog,stderr=subprocess.STDOUT)
                try:
                    wait(lambda:(d/'feed-url').exists())
                    probe('configure')
                    probe('manual-download')
                    note('quit-request');probe('quit')
                    wait(lambda:not alive(a['pid']),150);note('A-exited')
                    note('open-request');launch()
                    b=wait(ws);note('first-workspace',**b)
                    assert Path(b['exe']).resolve()==(app/'Contents/MacOS/Open-Science').resolve()
                    run('codesign','--verify','--deep','--strict',app)
                    probe('quit');wait(lambda:not alive(b['pid']))
                    assert b['version']=='1.3.2', 'first real workspace was '+b['version']
                finally:server.terminate();server.wait()
        elif mode in ('normal','rapid','rollback'):
            launch(True)
            a=wait(ws);assert a['version']=='1.3.1'
            p=prep()
            if mode=='rollback':(d/'rollback-trial').touch()
            armed=probe('arm')
            note('armed',details=json.loads(armed.stdout.splitlines()[-1])['details'])
            (d/'request-quit').touch();note('quit-request')
            probe('quit')
            wait(lambda:not alive(a['pid']),150);note('A-exited')
            if mode=='rollback':
                wait(lambda:(Path(p['directory'])/'result.json').exists())
                result=json.loads((Path(p['directory'])/'result.json').read_text())
                assert result['outcome']=='rolled-back' and identity(app)==original
                cli('rolledBack')
                run('codesign','--verify','--deep','--strict',app)
                note('rollback-verified',outcome=result['outcome'],originalInode=original[1])
                return
            if mode=='rapid':
                note('open-request')
                launch()
            else:
                wait(lambda:(Path(p['directory'])/'result.json').exists() or 'handoff-refused' in (d/'stages.jsonl').read_text(),30)
                cli('receipt')
                note('open-request')
                launch()
            # Keep the previous acceptance deadline as an explicit result. Further
            # observation does not delay exit/open or grant the client a larger budget.
            missed_cutoff=False
            try:b=wait(ws,90)
            except TimeoutError:
                missed_cutoff=True
                note('no-ready-workspace-at-original-cutoff',cutoffSeconds=90)
                b=wait(ws,210)
            result_path=Path(p['directory'])/'result.json'
            if result_path.exists():note('result-time',resultMs=result_path.stat().st_mtime_ns//1000000)
            note('first-workspace',**b)
            assert b['pid']!=a['pid'] and b['version']==b['data']['version']=='1.3.2'
            assert Path(b['exe']).resolve()==(app/'Contents/MacOS/Open-Science').resolve()
            cli('receipt')
            stage=Path(p['stagedBundle']).parent;executor=Path(p['directory'])
            backup=stage/'previous.app'
            note('natural-residue',backupBytes=size(backup),executorBytes=size(executor))
            assert identity(backup)==original and set(stage.iterdir())=={backup}
            assert executor.parent.parent==d/'state' and stage.parent==apps
            assert not any((executor.parent/f).exists() for f in ('update-in-progress.json','verified-startup.json'))
            shutil.rmtree(stage);shutil.rmtree(executor)
            note('confirmed-backup-reclaimed',residualBytes=size(stage)+size(executor))
            probe('quit');wait(lambda:not alive(b['pid']))
            if missed_cutoff:raise AssertionError('original 90-second observation failed; later result recorded')
        elif mode=='interrupt':
            proc=subprocess.Popen(['node',str(src/'cli.cjs'),'prepare',str(d)],env=env,start_new_session=True)
            prefix='.open-science-install-'
            stage=wait(lambda:next(apps.glob(prefix+'*'),None))
            staging=identity(stage)
            tmp=wait(lambda:next((p for p in scratch.glob('open-science-update-*') if (p/'Open-Science.app/Contents').exists()),None))
            tmpid=identity(tmp)
            proc.kill();proc.wait()
            note('owner-killed',stageBytes=size(stage),scratchBytes=size(tmp))
            # ditto starts a new process group. Let that exact extraction finish.
            def settled():
                lines=run('/bin/ps','-axo','pid=,command=',capture_output=True).stdout.splitlines()
                return not any('/usr/bin/ditto' in line and str(tmp) in line for line in lines)
            wait(settled)
            assert identity(stage)==staging and identity(tmp)==tmpid and not (d/'prepared.json').exists()
            shutil.rmtree(stage);shutil.rmtree(tmp)
            note('surviving-owner-reclaimed',residualBytes=size(stage)+size(tmp))
        else:
            if mode=='opt-out':
                launch();a=wait(ws)
            p=prep()
            if sys.argv[1]=='owner':
                monitor=subprocess.Popen(['node',str(src/'owner.cjs'),str(d)],env=env)
                wait(lambda:(d/'monitor-ready').exists(),10)
            if mode=='busy':
                child=subprocess.Popen([str(app/'Contents/Resources/node-runtime/node'),'-e','setInterval(()=>{},1000)'])
                try:
                    env['HOLDER']=str(child.pid);cli('busy')
                finally:child.terminate();child.wait()
                cancel(p,'foreign holder')
            elif mode=='opt-out':
                probe('off')
                assert (d/'profile/disable-background-update-downloads').exists()
                cancel(p,'signed Settings preference')
                probe('quit');wait(lambda:not alive(a['pid']))
            elif mode=='superseded':
                old=root/'candidate'/f'aipoch-open-science-1.3.1-mac-{arch}.zip'
                import base64
                new_id=base64.b64encode(hashlib.sha512(old.read_bytes()).digest()).decode()
                (d/'next-input').write_text(json.dumps({'archive':str(old),'sha512':new_id}));(d/'next-input').replace(d/'input.json')
                assert json.loads((d/'input.json').read_text())['sha512']!=p['sha512']
                cancel(p,'different signed archive identity; no downgrade requested')
            elif mode in ('move','trash'):
                if mode=='move':
                    moved=d/'Moved.app';app.rename(moved)
                else:
                    moved=Path(run('swift',src/'trash.swift',app,capture_output=True).stdout.strip())
                assert not app.exists() and identity(moved)==original
                cancel(p,'target disappeared, no subsequent launch')
                assert identity(moved)==original
                if mode=='trash':moved.rename(app)
        note('case-passed')
    finally:
        if monitor and monitor.poll() is None:monitor.terminate();monitor.wait()
        for file in (d/'state').glob('*/executor-*/result.json'):
            result=json.loads(file.read_text())
            note('durable-result',outcome=result.get('outcome'),timeMs=file.stat().st_mtime_ns//1000000)
        note('coordination-root-space',bytes=size(d/'state'))
        run('codesign','--verify','--deep','--strict',seed)
        note('other-signed-copy-verified',inode=identity(seed)[1])
        for f in ['stages.jsonl','last-workspace-error','stderr','stdout']:
            if (d/f).is_file():shutil.copyfile(d/f,out/(mode+'-'+f))
        assert [(identity(p),p.read_bytes()) for p in keep]==sentinels
        note('sentinels-intact',installIdentity=identity(app) if app.exists() else None)
        # Measure leftovers before runner disposal, including failed handoffs.
        note('end-space',privateStageBytes=sum(size(x) for x in apps.glob('.open-science-install-*')),executorBytes=sum(size(x) for x in (d/'state').glob('*/executor-*')),scratchStageBytes=sum(size(x) for x in scratch.glob('open-science-update-*')))
        # No generic sweep. Retain unexpected state for remaining diagnostics.
cases=['opt-out','superseded','move','trash','interrupt','busy'] if sys.argv[1]=='lifecycle' else ['opt-out','superseded','move','trash'] if sys.argv[1]=='owner' else [sys.argv[1]]
failures=[]
for mode in cases:
    try:case(mode)
    except Exception as error:
        traceback.print_exc()
        with (out/(mode+'.error')).open('w') as f:f.write(str(error))
        failures.append(mode)
if failures:sys.exit('failed: '+','.join(failures))
