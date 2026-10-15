import { systemBootIdentity, hasSystemRestarted } from '../system-boot-identity'
import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, rename, open, lstat, readdir, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { runVerificationProcess, VerificationProcessExitError } from './verification-process'
import { UpdateLifecycleError } from '../../shared/update'

export type DebSystemdGate = {
  nonce: string
  unit: string
  directory: string
  stateDirectory: string
  binding: string
  bootIdentity?: string
}

// This string is passed directly as a fixed argv value to the system /bin/sh. No user-owned
// executable, script, command file or Node interpreter ever executes with elevated privileges.
export const DEB_ROOT_GATE_SCRIPT = String.raw`set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH
unset ENV BASH_ENV
root=$1; gate=$2; archive=$3; checksum=$4; binding=$5; nonce=$6
case "$root" in /var/lib/open-science-updates/????????-????-????-????-????????????) ;; *) exit 70;; esac
umask 022
mkdir -p /var/lib/open-science-updates
[ ! -L /var/lib/open-science-updates ] || exit 71
mkdir -m 755 "$root"
state() { printf '%s\n' "$1" > "$root/state.tmp"; chmod 644 "$root/state.tmp"; mv -f "$root/state.tmp" "$root/state"; sync -f "$root"; }
printf '%s\n' "$binding" > "$root/identity"
chmod 644 "$root/identity"
# The package is immutable to the requesting desktop user before the ready receipt is published.
cp -- "$archive" "$root/payload.deb"
chmod 600 "$root/payload.deb"
actual=$(sha512sum "$root/payload.deb" | cut -d ' ' -f 1)
[ "$actual" = "$checksum" ] || { state rejected; exit 72; }
sync -f "$root/payload.deb"
state waiting
while :; do
  if [ -f "$gate/cancel-$nonce" ]; then rm -f "$root/payload.deb"; state cancelled; exit 0; fi
  if [ -f "$gate/commit-$nonce" ]; then break; fi
  sleep 0.1
done
# Cancellation wins until the irreversible package-manager invocation begins.
if [ -f "$gate/cancel-$nonce" ]; then rm -f "$root/payload.deb"; state cancelled; exit 0; fi
state installing
set +e
/usr/bin/dpkg -i "$root/payload.deb"
code=$?
set -e
if [ "$code" -eq 0 ]; then state installed; else state "failed:$code"; fi
exit "$code"
`

// Exit 126/127 can only originate from pkexec refusing authorization/execution; any error
// after the fixed systemd command was attempted is mapped to 200 and remains ambiguous.
export const DEB_AUTHORIZATION_SCRIPT =
  '/usr/bin/systemd-run "$@"; code=$?; if [ "$code" -eq 0 ]; then exit 0; fi; exit 200'
type Run = typeof runVerificationProcess
const properties =
  '--property=LoadState,ActiveState,SubState,ExecMainStatus,ControlGroup,ExitType,MainPID'
export function parseSystemdProperties(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const index = line.indexOf('=')
        return [line.slice(0, index), line.slice(index + 1)]
      })
  )
}
export function debUnitArguments(
  gate: DebSystemdGate,
  archive: string,
  checksum: string
): string[] {
  return [
    '/usr/bin/systemd-run',
    '--unit=' + gate.unit,
    '--expand-environment=no',
    '--property=Type=exec',
    '--property=ExitType=cgroup',
    '--property=RemainAfterExit=yes',
    '--property=KillMode=control-group',
    '--property=ProtectControlGroups=yes',
    '--property=TimeoutStartSec=infinity',
    '--property=Restart=no',
    '--property=UnsetEnvironment=ENV BASH_ENV LD_PRELOAD LD_LIBRARY_PATH',
    '--',
    '/bin/sh',
    '-c',
    DEB_ROOT_GATE_SCRIPT,
    'open-science-deb-gate',
    gate.stateDirectory,
    gate.directory,
    archive,
    checksum,
    gate.binding,
    gate.nonce
  ]
}
export async function createDebSystemdGate(
  options: {
    directory: string
    archive: string
    sha512: string
    installationRoot: string
    targetVersion: string
    signal?: AbortSignal
  },
  run: Run = runVerificationProcess
): Promise<DebSystemdGate> {
  if (!isAbsolute(options.directory) || !isAbsolute(options.archive))
    throw new Error('Debian installation materials require absolute paths.')
  const nonce = randomUUID(),
    unit = `open-science-install-${nonce}.service`
  const checksum = Buffer.from(options.sha512, 'base64').toString('hex')
  if (checksum.length !== 128) throw new Error('A SHA-512 artifact identity is required.')
  const gate: DebSystemdGate = {
    nonce,
    unit,
    directory: options.directory,
    stateDirectory: `/var/lib/open-science-updates/${nonce}`,
    bootIdentity: systemBootIdentity(),
    binding: createHash('sha256')
      .update(
        JSON.stringify({
          nonce,
          checksum,
          installationRoot: options.installationRoot,
          targetVersion: options.targetVersion
        })
      )
      .digest('hex')
  }
  await durableWrite(join(options.directory, 'deb-gate.json'), JSON.stringify(gate))
  try {
    await run(
      '/usr/bin/pkexec',
      [
        '/bin/sh',
        '-c',
        DEB_AUTHORIZATION_SCRIPT,
        'open-science-authorize',
        ...debUnitArguments(gate, options.archive, checksum).slice(1)
      ],
      {
        signal: options.signal,
        timeoutMs: 120_000,
        cwd: options.directory
      }
    )
    const deadline = Date.now() + 30_000
    for (;;) {
      options.signal?.throwIfAborted()
      const state = await inspectDebSystemdGate(gate, run)
      if (state === 'waiting') return gate
      if (state !== 'starting')
        throw new Error('The authorized package installer did not become ready.')
      if (Date.now() > deadline)
        throw new Error(
          'The authorized package installer did not become ready before the deadline.'
        )
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch (error) {
    // A delayed authorization may still create the unit. Keep this cancellation gate on disk
    // even when command termination or manager state cannot be established.
    await durableWrite(join(gate.directory, `cancel-${nonce}`), 'cancel')
    if (
      error instanceof VerificationProcessExitError &&
      error.command === '/usr/bin/pkexec' &&
      (error.exitCode === 126 || error.exitCode === 127)
    )
      await durableWrite(
        join(gate.directory, 'authorization-rejected.json'),
        JSON.stringify({ nonce, binding: gate.binding })
      )
    throw error
  }
}
export async function inspectDebSystemdGate(
  gate: DebSystemdGate,
  run: Run = runVerificationProcess
): Promise<'starting' | 'waiting' | 'installing' | 'cancelled' | 'installed' | 'failed'> {
  const reply = await run('/usr/bin/systemctl', ['show', gate.unit, properties], {
    timeoutMs: 10_000
  })
  const unit = parseSystemdProperties(reply.stdout)
  if (unit.LoadState === 'not-found') {
    if (
      (await hasBoundReceipt(gate, 'authorization-rejected.json')) ||
      hasSystemRestarted(gate.bootIdentity, systemBootIdentity())
    )
      return 'cancelled'
    return 'starting'
  }
  if (unit.LoadState !== 'loaded' || unit.ExitType !== 'cgroup')
    throw new Error('The package installer unit identity is unknown.')
  let status: string
  try {
    const directory = await lstat(gate.stateDirectory)
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== 0 ||
      (directory.mode & 0o022) !== 0
    )
      throw new Error('The privileged package receipt directory is not trusted.')
    if ((await readFile(join(gate.stateDirectory, 'identity'), 'utf8')).trim() !== gate.binding)
      throw new Error('The privileged package receipt belongs to another operation.')
    status = (await readFile(join(gate.stateDirectory, 'state'), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && unit.ActiveState === 'active')
      return 'starting'
    throw error
  }
  if (status === 'waiting' || status === 'installing') {
    if (unit.ActiveState === 'active' && unit.SubState === 'running' && Number(unit.MainPID) > 0)
      return status
    // The durable state can outlive an OOM-killed shell. It is never readiness evidence by itself.
    if (status === 'waiting' && isTerminalDebUnit(unit) && (await debCgroupEmpty(unit)))
      return 'cancelled'
    throw new Error(
      'The package gate stopped unexpectedly; retain protection and inspect its result.'
    )
  }
  if (
    status === 'cancelled' ||
    status === 'installed' ||
    status.startsWith('failed:') ||
    status === 'rejected'
  ) {
    if (
      !['active', 'failed'].includes(unit.ActiveState) ||
      !['exited', 'failed'].includes(unit.SubState)
    )
      return 'starting'
    if (unit.ControlGroup) {
      const events = join('/sys/fs/cgroup', unit.ControlGroup, 'cgroup.events')
      try {
        if (!/^populated 0$/m.test(await readFile(events, 'utf8'))) return 'starting'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (status === 'installed' && unit.ExecMainStatus !== '0')
      throw new Error('The package installer did not exit successfully.')
    return status === 'cancelled' || status === 'rejected'
      ? 'cancelled'
      : status === 'installed'
        ? 'installed'
        : 'failed'
  }
  throw new Error('The package installer terminal state is unknown.')
}
function isTerminalDebUnit(unit: Record<string, string>): boolean {
  return (
    ['active', 'failed'].includes(unit.ActiveState) &&
    ['exited', 'failed'].includes(unit.SubState) &&
    unit.MainPID === '0'
  )
}
async function debCgroupEmpty(unit: Record<string, string>): Promise<boolean> {
  if (!unit.ControlGroup) return true
  try {
    return /^populated 0$/m.test(
      await readFile(join('/sys/fs/cgroup', unit.ControlGroup, 'cgroup.events'), 'utf8')
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}
export async function cancelDebSystemdGate(
  gate: DebSystemdGate,
  run: Run = runVerificationProcess
): Promise<void> {
  if (await hasBoundReceipt(gate, 'gate-cancelled.json')) return
  await durableWrite(join(gate.directory, `cancel-${gate.nonce}`), 'cancel')
  const deadline = Date.now() + 30_000
  for (;;) {
    const state = await inspectDebSystemdGate(gate, run)
    if (state === 'cancelled') {
      await durableWrite(
        join(gate.directory, 'gate-cancelled.json'),
        JSON.stringify({ nonce: gate.nonce, binding: gate.binding })
      )
      return
    }
    if (state === 'installing' || state === 'installed' || state === 'failed')
      throw new Error(
        'The package installer has crossed its commit boundary; keep protection and check its result.'
      )
    if (Date.now() > deadline)
      throw new Error('Package installer cancellation is not confirmed; its gate was retained.')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
async function hasBoundReceipt(gate: DebSystemdGate, name: string): Promise<boolean> {
  try {
    const receipt = JSON.parse(await readFile(join(gate.directory, name), 'utf8'))
    return receipt.nonce === gate.nonce && receipt.binding === gate.binding
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function durableWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`,
    file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  const directory = await open(join(path, '..'), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}
/** A crash before beginInstallationUpdate may leave a ready gate but cannot commit it.
 * The next preparation cancels those descriptors before creating another privileged unit. */
export async function cancelUnclaimedDebGates(
  stateDirectory: string,
  run: Run = runVerificationProcess
): Promise<void> {
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('executor-')) continue
    const directory = join(stateDirectory, entry.name)
    let gate: DebSystemdGate
    try {
      gate = JSON.parse(await readFile(join(directory, 'deb-gate.json'), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    try {
      await access(join(directory, 'request.json'))
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (
      gate.directory !== directory ||
      !/^[a-f0-9-]{36}$/.test(gate.nonce) ||
      gate.unit !== `open-science-install-${gate.nonce}.service` ||
      gate.stateDirectory !== `/var/lib/open-science-updates/${gate.nonce}`
    )
      throw new Error('An abandoned package gate has an invalid identity.')
    await cancelDebSystemdGate(gate, run)
    // Retire only after a bound settled cancellation receipt. Accepted requests are never swept.
    await rm(join(directory, 'deb-gate.json'))
  }
}
export async function assertDebGraphicalPrerequisites(signal?: AbortSignal): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Debian supervision requires Linux.')
  for (const path of [
    '/sys/fs/cgroup/cgroup.controllers',
    '/usr/bin/pkexec',
    '/usr/bin/systemd-run',
    '/usr/bin/systemctl',
    '/usr/bin/dpkg'
  ])
    await access(path)
  const help = await runVerificationProcess('/usr/bin/systemd-run', ['--help'], { signal })
  if (!help.stdout.includes('--expand-environment='))
    throw new UpdateLifecycleError(
      'installation-busy',
      'This systemd version cannot preserve the fixed installer command arguments. systemd 254 or newer and cgroup v2 are required.',
      {
        phase: 'preparing',
        runtime: 'running',
        installation: 'unchanged',
        canCancel: true,
        canRecover: false,
        canRetryInstall: false,
        detail: 'unsupported-channel'
      }
    )
}

// Injected verbatim into the copied ordinary-user executor; no application imports are loaded.
export const DEB_GATE_OBSERVER_SOURCE = String.raw`
async function observePreparedDebGate(gate, observing) {
 const fs=require('node:fs'), path=require('node:path'), {execFileSync}=require('node:child_process');
 if(!/^[a-f0-9-]{36}$/.test(gate.nonce) || gate.unit!=='open-science-install-'+gate.nonce+'.service' || gate.stateDirectory!=='/var/lib/open-science-updates/'+gate.nonce || gate.directory!==directory) throw new Error('The package gate identity changed');
 const commit=path.join(directory,'commit-'+gate.nonce), cancel=path.join(directory,'cancel-'+gate.nonce);
 const descriptor=fs.lstatSync(gate.stateDirectory);
 if(!descriptor.isDirectory() || descriptor.isSymbolicLink() || descriptor.uid!==0 || (descriptor.mode&0o022)!==0 || fs.readFileSync(path.join(gate.stateDirectory,'identity'),'utf8').trim()!==gate.binding) throw new Error('The package gate receipt is not trusted');
 // Recovery observes a committed transaction; if it never committed, cancel the waiting gate.
 if(observing && !fs.existsSync(commit)) atomic('cancel-'+gate.nonce,'cancel');
 else if(!observing && !fs.existsSync(cancel)) atomic('commit-'+gate.nonce,'commit');
 for(;;) {
  const output=execFileSync('/usr/bin/systemctl',['show',gate.unit,'--property=LoadState,ActiveState,SubState,ExecMainStatus,ControlGroup,ExitType,MainPID'],{encoding:'utf8',timeout:10000});
  const unit=Object.fromEntries(output.trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)]}));
  if(unit.LoadState!=='loaded' || unit.ExitType!=='cgroup') throw new Error('The package installer unit is unavailable; do not rerun it during recovery');
  const state=fs.readFileSync(path.join(gate.stateDirectory,'state'),'utf8').trim();
  const deadWaiting=state==='waiting' && ['active','failed'].includes(unit.ActiveState) && ['exited','failed'].includes(unit.SubState) && unit.MainPID==='0';
  if(['installed','cancelled'].includes(state) || state.startsWith('failed:') || deadWaiting) {
   if(['active','failed'].includes(unit.ActiveState) && ['exited','failed'].includes(unit.SubState)) {
    const events=path.join('/sys/fs/cgroup',unit.ControlGroup || '', 'cgroup.events');
    if(unit.ControlGroup && fs.existsSync(events) && !/^populated 0$/m.test(fs.readFileSync(events,'utf8'))) {await new Promise(r=>setTimeout(r,50));continue;}
    if(state==='cancelled' || deadWaiting) return 'rolled-back';
    if(state==='installed' && unit.ExecMainStatus==='0') return 'installed';
    throw new Error('The original package installer failed; an explicit original-channel repair is required');
   }
  }
  if(['failed','inactive'].includes(unit.ActiveState)) throw new Error('The package gate stopped without a terminal receipt; keep protection');
  await new Promise(r=>setTimeout(r,100));
 }
}
`
