import { installationManifestIdentity } from './installation-reboot-recovery'
import {
  assertDebGraphicalPrerequisites,
  createDebSystemdGate,
  cancelDebSystemdGate,
  cancelUnclaimedDebGates,
  DEB_GATE_OBSERVER_SOURCE,
  type DebSystemdGate
} from './deb-systemd-gate'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { installationFs } from './installation-filesystem'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { runVerificationProcess, verificationDirectoryIsSettled } from './verification-process'
import { UpdateLifecycleError } from '../../shared/update'
import {
  inspectMacUpdateArtifact,
  inspectUpdateArtifact,
  verifyArtifactChecksum
} from './installation-artifact'
import {
  bindInstallationExecutor,
  captureInstallationManifestAsync,
  installationStateDirectory,
  inspectInstallationUpdate,
  type InstallationLocation,
  type InstallationManifest
} from './installation-protection'

const { access, open, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } =
  installationFs.promises
const { constants } = installationFs

// Self-contained ordinary Node program. Its binary, source, request and lock live outside the
// replaced bundle. No package or application import is resolved after Desktop exits.
export const INSTALLATION_EXECUTOR_SOURCE = String.raw`
'use strict';
${DEB_GATE_OBSERVER_SOURCE}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const { DatabaseSync } = require('node:sqlite'); const { spawn } = require('node:child_process');
const directory = path.dirname(process.argv[2]);
const requestBytes = fs.readFileSync(process.argv[2]); const request = JSON.parse(requestBytes);
const digest = crypto.createHash('sha256').update(requestBytes).digest('hex');
const database = new DatabaseSync(path.join(directory, 'executor.sqlite'));
try { database.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); } catch { process.exit(2); }
function atomic(name, value) { const file = path.join(directory, name), temp = file + '.tmp'; const fd = fs.openSync(temp, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file); if (process.platform !== 'win32') { const d=fs.openSync(directory,'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } }
function alive(pid) { try { process.kill(pid,0); return true; } catch(e) { return e.code !== 'ESRCH'; } }
const marker=JSON.parse(fs.readFileSync(request.recordPath,'utf8'));
if(marker.operationId!==request.operationId || marker.installationRoot!==request.installationRoot || marker.executor?.directory!==directory || marker.executor?.requestSha256!==digest) process.exit(3);
const resultPath = path.join(directory, 'result.json');
if (fs.existsSync(resultPath)) {
 const previous=JSON.parse(fs.readFileSync(resultPath,'utf8'));
 if(previous.outcome==='failed' && request.debGate && process.argv.includes('--observe-only')) fs.renameSync(resultPath,path.join(directory,'observation-'+crypto.randomUUID()+'.json'));
 else { if(previous.outcome==='failed') { console.error('Original installer repair requires an explicit operation; recovery will not rerun it.'); process.exit(1); } process.exit(0); }
}
atomic('ready.json', { operationId:request.operationId, requestSha256:digest, pid:process.pid });
async function main() {
  while (!process.argv.includes('--observe-only') && alive(request.desktopPid)) {if(request.debGate && fs.existsSync(path.join(directory,'cancel-'+request.debGate.nonce))) break;await new Promise(r=>setTimeout(r,25));}
  let outcome='failed', error;
  try {
    // Restart after a killed executor rolls back its own partial transaction; it never guesses
    // that an unfinished rename was a completed install.
    if (request.channel === 'supervised-deb' && request.debGate) {
      outcome=await observePreparedDebGate(request.debGate,process.argv.includes('--observe-only'));
    } else if (request.channel === 'supervised-deb') {
      const {execFileSync}=require('node:child_process');
      const unit='open-science-install-'+request.executorId+'.service';
      const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
      const inspect=()=>Object.fromEntries(run('/usr/bin/systemctl',['show',unit,'--property=LoadState,ActiveState,SubState,ExecMainStatus,ControlGroup,ExitType']).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]}));
      let state=inspect();
      if(state.LoadState==='not-found') {
        if(process.argv.includes('--observe-only')) throw new Error('The original installer terminal evidence is unavailable; use an explicit original-channel repair.');
        run('/usr/bin/systemd-run',['--unit='+unit,'--property=Type=exec','--property=ExitType=cgroup','--property=RemainAfterExit=yes','--property=KillMode=control-group','--property=TimeoutStartSec=infinity','--','/usr/bin/dpkg','-i',request.stagedBundle]);
      }
      for(;;) {
        state=inspect();
        if(state.LoadState!=='loaded' || state.ExitType!=='cgroup') throw new Error('Package installer supervision is unknown');
        if(state.ActiveState==='active' && state.SubState==='exited' && state.ExecMainStatus==='0') {
          if(state.ControlGroup && fs.existsSync('/sys/fs/cgroup'+state.ControlGroup+'/cgroup.events') && !/^populated 0$/m.test(fs.readFileSync('/sys/fs/cgroup'+state.ControlGroup+'/cgroup.events','utf8'))) throw new Error('Package installer still has writers');
          break;
        }
        if(state.ActiveState==='failed') throw new Error('Package installer failed; repair the same transaction');
        await new Promise(r=>setTimeout(r,100));
      }
      outcome='installed';
    } else if (request.channel === 'supervised-nsis') {
      const native=require(path.join(directory,'process_tree_native.node'));
      const jobFile=path.join(directory,'native-job.json');
      if(fs.existsSync(jobFile)) {
        const oldJob=JSON.parse(fs.readFileSync(jobFile,'utf8')).name;
        const deadline=Date.now()+10000;
        while(!native.reapWindowsOwnedJob(oldJob)) { if(Date.now()>deadline) throw new Error('Previous installer Job has not settled'); await new Promise(r=>setTimeout(r,25)); }
      }
      const name='Local\\OpenScience.Delegation.'+crypto.randomUUID();
      atomic('native-job.json',{name,operationId:request.operationId});
      const environment=Object.entries(process.env).filter(([,v])=>v!==undefined).map(([k,v])=>k+'='+v);
      if(process.platform==='win32' && (!path.win32.isAbsolute(request.installationRoot) || /[\"\0\r\n]/.test(request.installationRoot))) throw new Error('Invalid NSIS installation path');
      // NSIS consumes /D through end-of-command-line; it must be last and unquoted.
      // Only fixed switches and this validated absolute path use verbatim args. Native still quotes the executable.
      const processHandle=native.spawnWindowsOwnedProcess(name,request.stagedBundle,['--updated','/S','/currentuser','/D='+request.installationRoot],environment,directory,true);
      const {Socket}=require('node:net');
      const pipes=processHandle.fds.map((fd,index)=>new Socket({fd,readable:index!==0,writable:index===0}));
      pipes[0].end(); pipes.slice(1).forEach(pipe=>{pipe.on('error',()=>{});pipe.resume()});
      for(;;) {
        const code=native.windowsOwnedProcessExitCode(processHandle.handle), active=native.windowsOwnedJobActiveProcesses(name);
        if(code!==null && active===0) { if(code!==0) throw new Error('Installer failed with exit '+code); break; }
        await new Promise(r=>setTimeout(r,25));
      }
      outcome='installed';
    } else if (process.argv.includes('--observe-only') && !fs.existsSync(path.join(directory,'changing.json'))) {
      // No replacement transaction began. Recovery cancels preparation rather than starting installation.
      outcome='rolled-back';
    } else if (fs.existsSync(path.join(directory,'changing.json'))) {
      if (fs.existsSync(request.backup)) {
        if (fs.existsSync(request.installationRoot)) fs.renameSync(request.installationRoot, request.discard);
        fs.renameSync(request.backup,request.installationRoot);
        outcome='rolled-back';
      } else throw new Error('Interrupted installation requires repair.');
    } else {
      atomic('changing.json', { operationId:request.operationId });
      if (request.fault === 'before-rename') throw new Error('Injected failure before replacement');
      fs.renameSync(request.installationRoot,request.backup);
      if (request.delayFile) while (!fs.existsSync(request.delayFile)) await new Promise(r=>setTimeout(r,25));
      if (request.fault === 'after-old-rename') throw new Error('Injected failure after old rename');
      fs.renameSync(request.stagedBundle,request.installationRoot);
      outcome='installed';
    }
  } catch(e) {
    error=String(e.message || e);
    try {
      if (['supervised-nsis','supervised-deb'].includes(request.channel)) { outcome='failed'; }
      else if (fs.existsSync(request.backup) && !fs.existsSync(request.installationRoot)) { fs.renameSync(request.backup,request.installationRoot); outcome='rolled-back'; }
      else if (!fs.existsSync(request.backup) && fs.existsSync(request.installationRoot) && fs.existsSync(request.stagedBundle)) outcome='rolled-back';
    } catch(rollback) { error += '; rollback: ' + String(rollback); outcome='failed'; }
  }
  // No installation writes are permitted after this receipt. Backup/discard cleanup is deliberately
  // deferred to a future explicit maintenance action; it is outside the installed bundle.
  atomic('result.json',{operationId:request.operationId,requestSha256:digest,pid:process.pid,outcome,error});
  if (outcome==='installed' && request.relaunch) {
    const opener="const {DatabaseSync}=require('node:sqlite');const {spawn}=require('node:child_process');const p=process.argv[1], app=process.argv[2];(async()=>{for(;;){let db;try{db=new DatabaseSync(p);db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');db.close();break}catch{try{db?.close()}catch{}await new Promise(r=>setTimeout(r,25))}}spawn(process.platform==='darwin'?'/usr/bin/open':app,process.platform==='darwin'?['-a',app]:[],{detached:true,stdio:'ignore',env:{...process.env,APPIMAGE:app}}).unref()})()";
    spawn(process.execPath,['-e',opener,path.join(directory,'executor.sqlite'),request.launchPath || request.installationRoot],{detached:true,stdio:'ignore'}).unref();
  }
  process.exit(outcome==='failed'?1:0);
}
main().catch(e=>{atomic('result.json',{operationId:request.operationId,requestSha256:digest,pid:process.pid,outcome:'failed',error:String(e)});process.exit(1)});
`

export type PreparedMacInstallation = {
  channel?: 'supervised-mac' | 'supervised-appimage' | 'supervised-nsis' | 'supervised-deb'
  debGate?: DebSystemdGate
  nativePath?: string
  launchPath?: string
  directory: string
  stagedBundle: string
  nodePath: string
  executorPath: string
  installationRoot: string
  manifest: InstallationManifest
}

export async function prepareSupervisedMacInstallation(
  options: InstallationLocation & {
    archive: string
    targetVersion: string
    sha512?: string
    signal?: AbortSignal
  }
): Promise<PreparedMacInstallation> {
  const installationRoot = await realpath(options.installationRoot)
  const parent = dirname(installationRoot)
  // Preflight happens while the service is still available. Staging beside the bundle guarantees
  // rename stays on the same volume; write access to its parent is required for both swap and rollback.
  await access(parent, constants.W_OK | constants.X_OK)
  const directory = await mkdtemp(join(parent, '.open-science-install-'))
  const stagedBundle = join(directory, 'replacement.app')
  let executorDirectory: string | undefined
  try {
    if (options.sha512)
      await verifyArtifactChecksum(options.archive, options.sha512, options.signal)
    const manifest = await inspectMacUpdateArtifact(
      options.archive,
      options.targetVersion,
      options.signal,
      async (bundle) => {
        await runVerificationProcess('/usr/bin/ditto', [bundle, stagedBundle], {
          signal: options.signal,
          cwd: directory
        })
      }
    )
    const copiedManifest = await captureInstallationManifestAsync(
      stagedBundle,
      options.targetVersion,
      options.signal
    )
    if (JSON.stringify(copiedManifest) !== JSON.stringify(manifest))
      throw new Error('Staged installation integrity mismatch.')
    if ((await stat(parent)).dev !== (await stat(stagedBundle)).dev)
      throw new Error('Installation staging is on another volume.')
    const state = installationStateDirectory(options)
    await mkdir(state, { recursive: true, mode: 0o700 })
    executorDirectory = await mkdtemp(join(state, 'executor-'))
    const nodePath = join(executorDirectory, 'node'),
      executorPath = join(executorDirectory, 'executor.cjs')
    await runVerificationProcess(
      '/usr/bin/ditto',
      [join(installationRoot, 'Contents/Resources/node-runtime/node'), nodePath],
      { signal: options.signal, cwd: executorDirectory }
    )
    await chmod(nodePath, 0o700)
    await runVerificationProcess(
      nodePath,
      ['-e', "new (require('node:sqlite').DatabaseSync)(':memory:').close()"],
      { cwd: executorDirectory, signal: options.signal }
    )
    await writeFile(executorPath, INSTALLATION_EXECUTOR_SOURCE, { mode: 0o600 })
    return {
      directory: executorDirectory,
      stagedBundle,
      nodePath,
      executorPath,
      installationRoot,
      manifest
    }
  } catch (error) {
    if (executorDirectory && verificationDirectoryIsSettled(executorDirectory))
      await rm(executorDirectory, { recursive: true, force: true })
    if (verificationDirectoryIsSettled(directory))
      await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function launchPreparedMacInstaller(
  location: InstallationLocation,
  operationId: string,
  prepared: PreparedMacInstallation,
  options: { desktopPid: number; relaunch: boolean }
): Promise<void> {
  const record = inspectInstallationUpdate(location)
  if (!record || record.operationId !== operationId)
    throw new Error('The installation operation changed.')
  const request = {
    operationId,
    bootIdentity: record.bootIdentity,
    oldManifestSha256: installationManifestIdentity(record.oldManifest),
    targetManifestSha256: installationManifestIdentity(record.targetManifest),
    executorId: randomUUID(),
    channel: prepared.channel ?? 'supervised-mac',
    launchPath: prepared.launchPath,
    debGate: prepared.debGate,
    nativeSha256: prepared.nativePath
      ? (await captureInstallationManifestAsync(prepared.nativePath, 'executor')).files['@image']
      : undefined,
    nodeSha256: (await captureInstallationManifestAsync(prepared.nodePath, 'executor')).files[
      '@image'
    ],
    executorSha256: createHash('sha256')
      .update(await readFile(prepared.executorPath))
      .digest('hex'),
    recordPath: join(installationStateDirectory(location), 'update-in-progress.json'),
    installationRoot: prepared.installationRoot,
    stagedBundle: prepared.stagedBundle,
    backup: join(dirname(prepared.stagedBundle), 'previous.app'),
    discard: join(dirname(prepared.stagedBundle), 'interrupted.app'),
    ...options
  }
  const requestPath = join(prepared.directory, 'request.json')
  const bytes = JSON.stringify(request)
  const requestFile = await open(requestPath, 'wx', 0o600)
  try {
    await requestFile.writeFile(bytes)
    await requestFile.sync()
  } finally {
    await requestFile.close()
  }
  if (process.platform !== 'win32') {
    const requestDirectory = await open(prepared.directory, 'r')
    try {
      await requestDirectory.sync()
    } finally {
      await requestDirectory.close()
    }
  }
  const requestSha256 = createHash('sha256').update(bytes).digest('hex')
  bindInstallationExecutor(location, operationId, {
    channel: prepared.channel ?? 'supervised-mac',
    directory: prepared.directory,
    requestSha256
  })
  const child = spawn(prepared.nodePath, [prepared.executorPath, requestPath], {
    detached: true,
    stdio: 'ignore'
  })
  const failed = new Promise<never>((_resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () =>
      reject(
        new UpdateLifecycleError(
          'install-failed',
          'The installation executor exited before becoming ready.'
        )
      )
    )
  })
  const ready = (async () => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const receipt = JSON.parse(await readFile(join(prepared.directory, 'ready.json'), 'utf8'))
        if (
          receipt.operationId === operationId &&
          receipt.requestSha256 === requestSha256 &&
          receipt.pid === child.pid
        ) {
          child.unref()
          return
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new UpdateLifecycleError(
      'install-failed',
      'The installation executor has not acknowledged this operation.'
    )
  })()
  await Promise.race([failed, ready])
}

export async function discardPreparedMacInstallation(
  prepared: PreparedMacInstallation
): Promise<void> {
  try {
    await access(join(prepared.directory, 'request.json'))
    throw new UpdateLifecycleError(
      'install-failed',
      'An accepted installer request cannot be discarded.'
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (prepared.debGate) await cancelDebSystemdGate(prepared.debGate)
  if (verificationDirectoryIsSettled(dirname(prepared.stagedBundle)))
    await rm(dirname(prepared.stagedBundle), { recursive: true, force: true })
  if (verificationDirectoryIsSettled(prepared.directory))
    await rm(prepared.directory, { recursive: true, force: true })
}

/** Stable-name AppImages are replaced as a single file, without remounting or executing app code. */
export async function prepareSupervisedAppImageInstallation(
  options: InstallationLocation & {
    archive: string
    targetVersion: string
    sha512: string
    runtimeNode: string
    signal?: AbortSignal
  }
): Promise<PreparedMacInstallation> {
  const installationRoot = await realpath(options.installationRoot)
  const parent = dirname(installationRoot)
  await access(parent, constants.W_OK | constants.X_OK)
  const manifest = await inspectUpdateArtifact({ ...options, platform: 'linux' })
  const staging = await mkdtemp(join(parent, '.open-science-install-'))
  let executorDirectory: string | undefined
  try {
    const stagedBundle = join(staging, 'replacement.AppImage')
    await copyFile(options.archive, stagedBundle, constants.COPYFILE_EXCL)
    await chmod(stagedBundle, 0o755)
    const copied = await captureInstallationManifestAsync(
      stagedBundle,
      options.targetVersion,
      options.signal
    )
    if (JSON.stringify(copied) !== JSON.stringify(manifest))
      throw new Error('Staged AppImage integrity mismatch.')
    if ((await stat(parent)).dev !== (await stat(stagedBundle)).dev)
      throw new Error('AppImage staging is on another volume.')
    const state = installationStateDirectory(options)
    await mkdir(state, { recursive: true, mode: 0o700 })
    executorDirectory = await mkdtemp(join(state, 'executor-'))
    const nodePath = join(executorDirectory, 'node'),
      executorPath = join(executorDirectory, 'executor.cjs')
    await copyFile(options.runtimeNode, nodePath, constants.COPYFILE_EXCL)
    await chmod(nodePath, 0o700)
    await runVerificationProcess(
      nodePath,
      ['-e', "new (require('node:sqlite').DatabaseSync)(':memory:').close()"],
      { cwd: executorDirectory, signal: options.signal }
    )
    await writeFile(executorPath, INSTALLATION_EXECUTOR_SOURCE, { mode: 0o600 })
    return {
      channel: 'supervised-appimage',
      directory: executorDirectory,
      stagedBundle,
      nodePath,
      executorPath,
      installationRoot,
      manifest
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (executorDirectory && verificationDirectoryIsSettled(executorDirectory))
      await rm(executorDirectory, { recursive: true, force: true })
    throw error
  }
}

export const launchPreparedInstaller = launchPreparedMacInstaller
export const discardPreparedInstallation = discardPreparedMacInstallation
export type PreparedInstallation = PreparedMacInstallation

/** Replays only the same durable transaction; the worker rolls back an interrupted swap. */
export async function resumeBoundInstallationExecutor(
  location: InstallationLocation,
  operationId: string
): Promise<void> {
  const record = inspectInstallationUpdate(location)
  if (
    !record ||
    record.operationId !== operationId ||
    record.phase !== 'handoff' ||
    !record.executor
  )
    throw new Error('No resumable installation executor is bound.')
  const directory = record.executor.directory
  const bytes = await readFile(join(directory, 'request.json'))
  if (createHash('sha256').update(bytes).digest('hex') !== record.executor.requestSha256)
    throw new Error('Installation executor request changed.')
  if (record.executor.channel === 'supervised-nsis')
    throw new Error(
      'The original NSIS installer has no verified terminal result. Recovery cannot rerun it; an explicit original-channel repair is required while startup remains protected.'
    )
  const request = JSON.parse(bytes.toString())
  const nodePath = join(directory, 'node'),
    executorPath = join(directory, 'executor.cjs')
  if (
    request.operationId !== operationId ||
    request.installationRoot !== record.installationRoot ||
    request.recordPath !== join(installationStateDirectory(location), 'update-in-progress.json')
  )
    throw new Error('Installation executor identity changed.')
  if (
    (await captureInstallationManifestAsync(nodePath, 'executor')).files['@image'] !==
      request.nodeSha256 ||
    createHash('sha256')
      .update(await readFile(executorPath))
      .digest('hex') !== request.executorSha256
  )
    throw new Error('Installation executor materials changed.')
  const database = new DatabaseSync(join(directory, 'executor.sqlite'))
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    try {
      const receipt = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      if (
        !['supervised-nsis', 'supervised-deb'].includes(record.executor.channel) ||
        receipt.outcome !== 'failed'
      )
        return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  } finally {
    database.close()
  }
  // The worker takes the same lifetime lock itself, so concurrent recovery requests cannot mutate twice.
  const child = spawn(nodePath, [executorPath, join(directory, 'request.json'), '--observe-only'], {
    detached: true,
    stdio: 'ignore'
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.unref()
      reject(
        new Error('Installation executor recovery is still running; startup remains protected.')
      )
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      code === 0
        ? resolve()
        : reject(new Error(`Installation executor recovery did not settle (${code}, ${signal}).`))
    })
  })
}

/** Per-user NSIS only: no elevation broker or detached installer channel is admitted. */
export async function prepareSupervisedNsisInstallation(
  options: InstallationLocation & {
    archive: string
    targetVersion: string
    sha512: string
    runtimeNode: string
    currentExecutable: string
    nativeBinding: string
    signal?: AbortSignal
    sevenZip?: string
  }
): Promise<PreparedInstallation> {
  if (process.platform !== 'win32')
    throw new Error('NSIS supervision requires Windows native verification.')
  const installationRoot = await realpath(options.installationRoot)
  await access(installationRoot, constants.W_OK)
  const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
  const signatures = await runVerificationProcess(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; @(${quote(options.currentExecutable)},${quote(options.archive)}) | ForEach-Object { $s=Get-AuthenticodeSignature -LiteralPath $_; if($s.Status -ne 'Valid') { throw 'Untrusted installer signature' }; $s.SignerCertificate.Thumbprint }`
    ],
    { signal: options.signal }
  )
  const publishers = signatures.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
  if (
    publishers.length !== 2 ||
    !/^[A-Fa-f0-9]{40,64}$/.test(publishers[0]) ||
    publishers[0] !== publishers[1]
  )
    throw new Error(
      'The installer and installed application must have the same trusted publisher certificate.'
    )
  const manifest = await inspectUpdateArtifact({ ...options, platform: 'win32' })
  const state = installationStateDirectory(options)
  await mkdir(state, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(state, 'executor-'))
  try {
    const stagedBundle = join(directory, 'installer.exe'),
      nodePath = join(directory, 'node.exe'),
      executorPath = join(directory, 'executor.cjs'),
      nativePath = join(directory, 'process_tree_native.node')
    for (const [source, target] of [
      [options.archive, stagedBundle],
      [options.runtimeNode, nodePath],
      [options.nativeBinding, nativePath]
    ])
      await copyFile(source, target, constants.COPYFILE_EXCL)
    await verifyArtifactChecksum(stagedBundle, options.sha512, options.signal)
    await writeFile(executorPath, INSTALLATION_EXECUTOR_SOURCE, { mode: 0o600 })
    await runVerificationProcess(
      nodePath,
      [
        '-e',
        "const n=require(process.argv[1]);if(typeof n.windowsOwnedJobActiveProcesses!=='function'||typeof n.spawnWindowsOwnedProcess!=='function')process.exit(1);new(require('node:sqlite').DatabaseSync)(':memory:').close()",
        nativePath
      ],
      { cwd: directory, signal: options.signal }
    )
    return {
      channel: 'supervised-nsis',
      directory,
      stagedBundle,
      nodePath,
      executorPath,
      nativePath,
      installationRoot,
      manifest,
      launchPath: options.currentExecutable
    }
  } catch (error) {
    if (verificationDirectoryIsSettled(directory))
      await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Requires already-authorized system package management; never starts an elevation dialog after stop. */
export async function prepareSupervisedDebInstallation(
  options: InstallationLocation & {
    archive: string
    targetVersion: string
    sha512: string
    runtimeNode: string
    currentExecutable: string
    signal?: AbortSignal
  }
): Promise<PreparedInstallation> {
  await assertDebGraphicalPrerequisites(options.signal)
  const manifest = await inspectUpdateArtifact({ ...options, platform: 'linux' })
  const state = installationStateDirectory(options)
  await mkdir(state, { recursive: true, mode: 0o700 })
  await cancelUnclaimedDebGates(state)
  const directory = await mkdtemp(join(state, 'executor-'))
  try {
    const stagedBundle = join(directory, 'installer.deb'),
      nodePath = join(directory, 'node'),
      executorPath = join(directory, 'executor.cjs')
    await copyFile(options.archive, stagedBundle, constants.COPYFILE_EXCL)
    await verifyArtifactChecksum(stagedBundle, options.sha512, options.signal)
    await copyFile(options.runtimeNode, nodePath, constants.COPYFILE_EXCL)
    await chmod(nodePath, 0o700)
    await runVerificationProcess(
      nodePath,
      ['-e', "new (require('node:sqlite').DatabaseSync)(':memory:').close()"],
      { cwd: directory, signal: options.signal }
    )
    await writeFile(executorPath, INSTALLATION_EXECUTOR_SOURCE, { mode: 0o600 })
    const debGate = await createDebSystemdGate({ ...options, directory, archive: stagedBundle })
    return {
      channel: 'supervised-deb',
      debGate,
      directory,
      stagedBundle,
      nodePath,
      executorPath,
      installationRoot: await realpath(options.installationRoot),
      manifest,
      launchPath: options.currentExecutable
    }
  } catch (error) {
    let hasGate = false
    try {
      await access(join(directory, 'deb-gate.json'))
      hasGate = true
    } catch {
      // No durable gate descriptor was created.
    }
    if (!hasGate && verificationDirectoryIsSettled(directory))
      await rm(directory, { recursive: true, force: true })
    throw error
  }
}
