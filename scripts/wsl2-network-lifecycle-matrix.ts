#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { writeSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { connect as connectTcp, createServer as createTcpServer, type Socket } from 'node:net'

import { CommandGateway } from '../packages/notebook-network-sandbox/runtime/src/gateway/command-gateway.js'
import {
  acquireAtomicGlobalFence,
  captureCleanupFailure,
  exactTerminationProgram,
  matrixResultErrorCode,
  reconcileDurableProcessIdentity,
  removeOwnedGuestRoot,
  withEarlyCleanupResult
} from './wsl2-matrix-runtime-seams.js'
import {
  DURABLE_OWNERSHIP_SCHEMA_VERSION,
  DEFAULT_DURABLE_OWNERSHIP_DIRECTORY,
  canonicalDurableGuestRoot,
  canonicalDurableOwnerToken,
  persistDurableOwnership,
  reconcileDurableOwnershipAtStartup,
  updateDurableOwnership,
  type DurableOwnershipOperations,
  type DurableOwnershipRecord,
  type DurableDirectoryIdentity,
  type DurableProcessIdentity
} from './wsl2-matrix-durable-owner.js'

type CommandResult = Readonly<{
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}>

type LifecycleResult = Readonly<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  bounded: boolean
  descendantsRunning: boolean
  receiptObserved: boolean
  payloadReadyBeforeTermination: boolean
  terminationRequested: boolean
  cleanupSucceeded: boolean
  cleanupStatuses: Array<number | null>
  durationMs: number
}>

type GlobalFence = Readonly<{
  token: string
  heartbeat: () => void
  assertOwned: () => void
  release: () => void
}>

const acquireGlobalFence = (
  directory = DEFAULT_DURABLE_OWNERSHIP_DIRECTORY,
  hooks: { beforeQuarantineRename?: () => void } = {}
): GlobalFence => {
  return acquireAtomicGlobalFence(directory, hooks)
}

const usage =
  'Usage: compile and run scripts/wsl2-network-lifecycle-matrix.ts --distro <name> --user <non-root-user>\n'

const decision = Object.freeze({
  confidence: 'verified-by-spike',
  transport: 'authenticated-command-gateway-via-guest-unix-bridge',
  supervisor: 'guest-process-group-and-token-supervisor',
  dedicatedGuestRunnerRequired: true
})

const parseMatrixArguments = (
  argv: readonly string[]
): Readonly<{
  distro?: string
  user?: string
  crashRecoveryGate: boolean
  simulateOwnerCrashAt?: string
}> => {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index < 0 ? undefined : argv[index + 1]
  }
  return {
    distro: value('--distro'),
    user: value('--user'),
    crashRecoveryGate: argv.includes('--crash-recovery-gate'),
    simulateOwnerCrashAt: value('--simulate-owner-crash-at')
  }
}

const wslArgv = (distro: string, user: string, argv: readonly string[]): string[] => [
  '-d',
  distro,
  '--user',
  user,
  '--exec',
  ...argv
]

const runWsl = (
  distro: string,
  user: string,
  argv: readonly string[],
  timeoutMs = 15_000
): CommandResult => {
  const startedAt = Date.now()
  const result = spawnSync('wsl.exe', wslArgv(distro, user, argv), {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    durationMs: Date.now() - startedAt
  }
}

const runWslAsync = async (
  distro: string,
  user: string,
  argv: readonly string[],
  timeoutMs: number,
  onTimeout?: () => void
): Promise<CommandResult> => {
  const startedAt = Date.now()
  const child = spawn('wsl.exe', wslArgv(distro, user, argv), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const timer = setTimeout(() => {
    timedOut = true
    onTimeout?.()
    child.kill()
  }, timeoutMs)
  const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('exit', (status, signal) => resolve({ status, signal }))
  )
  clearTimeout(timer)
  return { ...result, stdout, stderr, timedOut, durationMs: Date.now() - startedAt }
}

const bash = (
  distro: string,
  user: string,
  program: string,
  args: readonly string[] = [],
  timeoutMs?: number
): CommandResult =>
  runWsl(
    distro,
    user,
    ['bash', '--noprofile', '--norc', '-c', program, 'open-science-matrix', ...args],
    timeoutMs
  )

const writeGuestFile = (distro: string, user: string, path: string, contents: string): void => {
  const encoded = Buffer.from(contents).toString('base64')
  const result = bash(distro, user, 'umask 077; printf %s "$2" | base64 -d > "$1"', [path, encoded])
  if (result.status !== 0) throw new Error(`Could not write ${path}: ${result.stderr.trim()}`)
}

const waitForOutput = (
  child: ChildProcessWithoutNullStreams,
  marker: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${marker}. stderr: ${stderr.trim()}`))
    }, timeoutMs)
    const inspect = (): void => {
      if (!stdout.includes(marker)) return
      cleanup()
      resolve({ stdout, stderr })
    }
    const exited = (code: number | null): void => {
      cleanup()
      reject(new Error(`Guest process exited ${String(code)}. stderr: ${stderr.trim()}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('exit', exited)
    }
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString()
      inspect()
    }
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString()
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('exit', exited)
  })

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string')
        reject(new Error('Test server did not bind TCP.'))
      else resolve(address.port)
    })
  })

const listenHostIngress = (
  onConnection: (client: Socket) => void
): Promise<{
  port: number
  close: () => Promise<void>
}> => {
  const server = createTcpServer(onConnection)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Host ingress did not bind TCP.'))
        return
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}

const guestBridgeProgram = String.raw`
import os, signal, socket, sys, threading, time

socket_path, host, port_text, receipt, completion, token, heartbeat, owner_token = sys.argv[1:]
def write_completion(state):
    temporary = completion + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        handle.write(f'{state} {token}\n')
    os.replace(temporary, completion)
def terminate(_signal, _frame):
    write_completion('STOPPED')
    os._exit(70)
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
def heartbeat_current():
    try:
        saved_owner, saved_ms = open(heartbeat, encoding='utf-8').read().split()
        return saved_owner == owner_token and time.time() * 1000 - int(saved_ms) <= 8000
    except (FileNotFoundError, OSError, ValueError):
        return False
if not heartbeat_current():
    raise SystemExit(70)
payload_delay = os.environ.get('OPEN_SCIENCE_MATRIX_PAYLOAD_PRE_RECEIPT_DELAY_SECONDS')
if payload_delay:
    time.sleep(float(payload_delay))
def monitor_heartbeat():
    while True:
        time.sleep(1)
        if not heartbeat_current():
            write_completion('STOPPED')
            os._exit(70)
threading.Thread(target=monitor_heartbeat, daemon=True).start()
print('OPEN_SCIENCE_BRIDGE_SUPERVISOR_READY', flush=True)
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass
with open(receipt, 'w', encoding='utf-8') as handle:
    start = open('/proc/self/stat', encoding='utf-8').read().split()[21]
    handle.write(f'{os.getpid()} {token} {start} {os.getsid(0)} {os.getpgid(0)}\n')
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(socket_path)
os.chmod(socket_path, 0o600)
listener.listen(32)
print('OPEN_SCIENCE_BRIDGE_READY', flush=True)

while True:
    client, _ = listener.accept()
    try:
        upstream = socket.create_connection((host, int(port_text)), timeout=5)
    except Exception as error:
        print(f'bridge upstream failed: {error}', file=sys.stderr, flush=True)
        client.close()
        continue
    def relay(source, target):
        try:
            while True:
                data = source.recv(65536)
                if not data: break
                target.sendall(data)
        except OSError:
            pass
        try: target.shutdown(socket.SHUT_WR)
        except OSError: pass
    left = threading.Thread(target=relay, args=(client, upstream), daemon=True)
    right = threading.Thread(target=relay, args=(upstream, client), daemon=True)
    left.start(); right.start(); left.join(); right.join()
    client.close()
    upstream.close()
`

export const guestPreReceiptLauncher = String.raw`
completion=$1
token=$2
heartbeat=$3
owner_token=$4
receipt=$5
shift 5
payload_pid=''
payload_start=''
payload_sid=''
payload_pgid=''
receipt_committed=0
write_completion() {
  state=$1
  temporary="$completion.tmp.$$"
  printf '%s %s\n' "$state" "$token" > "$temporary" && mv -f -- "$temporary" "$completion"
}
receipt_matches() {
  [ -r "$receipt" ] || return 1
  read -r _ recorded _ < "$receipt" || return 1
  [ "$recorded" = "$token" ]
}
heartbeat_current() {
  read -r current_owner current_ms < "$heartbeat" || return 1
  current_now_ms=$(date +%s%3N)
  [ "$current_owner" = "$owner_token" ] && [ $((current_now_ms - current_ms)) -le 8000 ]
}
payload_state() {
  [ -n "$payload_pid" ] && [ -n "$payload_start" ] || return 2
  [ -r "/proc/$payload_pid/stat" ] || return 1
  current_start=$(awk '{print $22}' "/proc/$payload_pid/stat") || return 2
  [ "$current_start" = "$payload_start" ] || return 2
  current_sid=$(ps -o sid= -p "$payload_pid" | tr -d ' ') || return 2
  current_pgid=$(ps -o pgid= -p "$payload_pid" | tr -d ' ') || return 2
  [ "$current_sid" = "$payload_sid" ] && [ "$current_pgid" = "$payload_pgid" ] || return 2
  current_state=$(awk '{print $3}' "/proc/$payload_pid/stat") || return 2
  if [ "$current_state" = Z ]; then return 1; fi
  tr '\0' '\n' < "/proc/$payload_pid/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$token" || return 2
  return 0
}
stop_payload_bounded() {
  payload_state
  classified=$?
  [ "$classified" -eq 1 ] && return 0
  [ "$classified" -eq 0 ] || return 1
  kill -TERM -- "-$payload_pgid" 2>/dev/null || return 1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    payload_state; classified=$?
    [ "$classified" -eq 1 ] && return 0
    [ "$classified" -eq 0 ] || return 1
    sleep .05
  done
  payload_state; classified=$?
  [ "$classified" -eq 1 ] && return 0
  [ "$classified" -eq 0 ] || return 1
  kill -KILL -- "-$payload_pgid" 2>/dev/null || return 1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    payload_state; classified=$?
    [ "$classified" -eq 1 ] && return 0
    [ "$classified" -eq 0 ] || return 1
    sleep .05
  done
  return 1
}
pre_receipt_cleanup() {
  status=$?
  trap - EXIT TERM INT HUP
  if [ "$receipt_committed" -eq 0 ]; then
    if [ -n "$payload_pid" ] && ! stop_payload_bounded; then
      status=73
    else
      write_completion STOPPED || status=72
    fi
  fi
  exit "$status"
}
trap pre_receipt_cleanup EXIT TERM INT HUP
write_completion STARTING || exit 71
if [ -n "\${OPEN_SCIENCE_MATRIX_PRE_HEARTBEAT_DELAY_SECONDS:-}" ]; then
  sleep "$OPEN_SCIENCE_MATRIX_PRE_HEARTBEAT_DELAY_SECONDS"
fi
heartbeat_current || exit 70
setsid --wait "$@" &
payload_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  payload_start=$(awk '{print $22}' "/proc/$payload_pid/stat" 2>/dev/null) || true
  payload_sid=$(ps -o sid= -p "$payload_pid" 2>/dev/null | tr -d ' ') || true
  payload_pgid=$(ps -o pgid= -p "$payload_pid" 2>/dev/null | tr -d ' ') || true
  [ -n "$payload_start" ] && [ "$payload_sid" = "$payload_pid" ] && [ "$payload_pgid" = "$payload_pid" ] && break
  sleep .01
done
[ -n "$payload_start" ] && [ "$payload_sid" = "$payload_pid" ] && [ "$payload_pgid" = "$payload_pid" ] || exit 73
printf '%s %s %s %s %s\n' "$payload_pid" "$payload_start" "$payload_sid" "$payload_pgid" "$token" > "$completion.spawned.tmp.$$" && mv -f -- "$completion.spawned.tmp.$$" "$completion.spawned" || exit 71
while kill -0 "$payload_pid" 2>/dev/null; do
  if receipt_matches; then
    receipt_committed=1
    trap - EXIT TERM INT HUP
    break
  fi
  heartbeat_current || exit 70
  sleep .02
done
wait "$payload_pid"
status=$?
payload_pid=''
if [ "$receipt_committed" -eq 0 ] && receipt_matches; then
  receipt_committed=1
  trap - EXIT TERM INT HUP
fi
exit "$status"
`

const guardedGuestCommand = (
  completion: string,
  token: string,
  heartbeat: string,
  ownerToken: string,
  receipt: string,
  command: readonly string[]
): string[] => [
  'bash',
  '--noprofile',
  '--norc',
  '-c',
  guestPreReceiptLauncher,
  'open-science-pre-receipt',
  completion,
  token,
  heartbeat,
  ownerToken,
  receipt,
  ...command
]

const sandboxProbeProgram = String.raw`
import base64, json, socket, sys

socket_path, username, password, target_port_text = sys.argv[1:]
target_port = int(target_port_text)

auth = base64.b64encode(f'{username}:{password}'.encode()).decode()

def proxy_request(host):
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(5)
    connection.connect(socket_path)
    request = (
        f'GET http://{host}:{target_port}/matrix HTTP/1.1\r\n'
        f'Host: {host}:{target_port}\r\n'
        f'Proxy-Authorization: Basic {auth}\r\n'
        'Connection: close\r\n\r\n'
    )
    connection.sendall(request.encode())
    received = bytearray()
    while True:
        chunk = connection.recv(65536)
        if not chunk: break
        received.extend(chunk)
    connection.close()
    head, _, body = bytes(received).partition(b'\r\n\r\n')
    first = head.split(b'\r\n', 1)[0].split()
    status = int(first[1]) if len(first) > 1 else 0
    return {'status': status, 'body': body.decode(errors='replace')}

allowed = proxy_request('matrix.allowed.invalid')
denied = proxy_request('matrix.denied.invalid')
def direct_probe(host, port):
    try:
        direct = socket.create_connection((host, port), timeout=1)
        direct.close()
        return {'blocked': False, 'error': None}
    except OSError as error:
        return {'blocked': True, 'error': type(error).__name__}

direct_host = direct_probe('127.0.0.1', target_port)
direct_public = direct_probe('1.1.1.1', 80)

print('OPEN_SCIENCE_NETWORK_RESULT ' + json.dumps({
    'gatewayAllowed': allowed['status'] == 200 and allowed['body'] == 'matrix-ok',
    'gatewayAllowedStatus': allowed['status'],
    'gatewayDenied': denied['status'] == 403 and 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED' in denied['body'],
    'gatewayDeniedStatus': denied['status'],
    'directOutboundBlocked': direct_host['blocked'] and direct_public['blocked'],
    'directHostBlocked': direct_host['blocked'],
    'directPublicBlocked': direct_public['blocked'],
    'directHostError': direct_host['error'],
    'directPublicError': direct_public['error']
}), flush=True)
`

const stopToken = (
  distro: string,
  user: string,
  token: string,
  receipt: string,
  descendantsReceipt?: string,
  expectedIdentity?: DurableProcessIdentity
): CommandResult =>
  bash(
    distro,
    user,
    exactTerminationProgram,
    [
      token,
      receipt,
      descendantsReceipt ?? '-',
      expectedIdentity?.leaderPid === null || expectedIdentity?.leaderPid === undefined
        ? '-'
        : String(expectedIdentity.leaderPid),
      expectedIdentity?.startTimeTicks ?? '-',
      expectedIdentity?.sid === null || expectedIdentity?.sid === undefined
        ? '-'
        : String(expectedIdentity.sid),
      expectedIdentity?.pgid === null || expectedIdentity?.pgid === undefined
        ? '-'
        : String(expectedIdentity.pgid),
      expectedIdentity
        ? expectedIdentity.descendants
            .flatMap(({ pid, startTimeTicks, sid, pgid }) => [pid, startTimeTicks, sid, pgid])
            .join(' ')
            .trim() || '-'
        : '-'
    ],
    8_000
  )

const ownedProcessesAlive = (
  distro: string,
  user: string,
  token: string,
  receipt: string
): boolean =>
  bash(
    distro,
    user,
    String.raw`
token=$1
receipt=$2
pids=''
if [ -r "$receipt" ]; then
  IFS= read -r line < "$receipt" || true; set -- $line
  leader=$1; recorded=$2; shift 5
  [ "$recorded" = "$token" ] && pids=$leader
  while [ "$#" -ge 4 ]; do pids="$pids $1"; shift 4; done
fi
for pid in $pids; do
  case "$pid" in ''|*[!0-9]*) continue;; esac
  if [ -r "/proc/$pid/environ" ] && tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$token"; then exit 0; fi
done
exit 1
`,
    [token, receipt],
    8_000
  ).status === 0

const exactPidHasToken = (distro: string, user: string, pid: string, token: string): boolean =>
  bash(
    distro,
    user,
    String.raw`case "$1" in ''|*[!0-9]*) exit 1;; esac; tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$2"`,
    [pid, token]
  ).status === 0

const pendingIdentity = (token: string, receiptPath: string): DurableProcessIdentity => ({
  token,
  receiptPath,
  completionPath: `${receiptPath}.completion`,
  leaderPid: null,
  startTimeTicks: null,
  sid: null,
  pgid: null,
  descendants: []
})

const readReceiptIdentity = (
  distro: string,
  user: string,
  identity: DurableProcessIdentity
): DurableProcessIdentity | undefined => {
  const result = bash(
    distro,
    user,
    String.raw`receipt=$1; expected=$2; IFS= read -r line < "$receipt" || exit 1; set -- $line; pid=$1; token=$2; shift 2; [ "$token" = "$expected" ] || exit 1; case "$pid:$*" in *[!0-9:\ ]*) exit 1;; esac; printf '%s %s\n' "$pid" "$*"`,
    [identity.receiptPath, identity.token]
  )
  const [pid, startTimeTicks, sid, pgid, ...descendantFields] = result.stdout.trim().split(/\s+/)
  if (result.status !== 0 || !pid || !startTimeTicks || !sid || !pgid) return undefined
  if (![pid, startTimeTicks, sid, pgid, ...descendantFields].every((value) => /^\d+$/.test(value)))
    return undefined
  if (descendantFields.length % 4 !== 0) return undefined
  const descendants = []
  for (let index = 0; index < descendantFields.length; index += 4) {
    const [descendantPid, descendantStart, descendantSid, descendantPgid] = descendantFields.slice(
      index,
      index + 4
    )
    if (!descendantPid || !descendantStart || !descendantSid || !descendantPgid) return undefined
    descendants.push({
      pid: Number(descendantPid),
      startTimeTicks: descendantStart,
      sid: Number(descendantSid),
      pgid: Number(descendantPgid)
    })
  }
  return {
    ...identity,
    leaderPid: Number(pid),
    startTimeTicks,
    sid: Number(sid),
    pgid: Number(pgid),
    descendants
  }
}

const ownerMarkerPath = (record: DurableOwnershipRecord): string =>
  `${record.guestRoot}/.open-science-owner`
const preparingRootPath = (record: DurableOwnershipRecord): string =>
  `${record.guestRoot}.preparing-${record.ownerToken}`

const readGuestDirectoryIdentity = (
  distro: string,
  user: string,
  path: string
): DurableDirectoryIdentity | undefined => {
  const result = bash(
    distro,
    user,
    'LC_ALL=C; [ "$(stat -c %F -- "$1")" = directory ] || exit 1; stat -c "%d %i %W" -- "$1"',
    [path]
  )
  const [device, inode, birthTimeSeconds] = result.stdout.trim().split(/\s+/)
  if (
    result.status !== 0 ||
    ![device, inode, birthTimeSeconds].every((value) => value && /^[0-9]+$/.test(value))
  )
    return undefined
  return { device: device!, inode: inode!, birthTimeSeconds: birthTimeSeconds! }
}

const removeExactGuestDirectory = (
  distro: string,
  user: string,
  path: string,
  identity: DurableDirectoryIdentity
): boolean =>
  bash(
    distro,
    user,
    String.raw`
python3 - "$1" "$2" "$3" "$4" <<'PY'
import os, stat, subprocess, sys
path, expected_dev, expected_ino, expected_birth = sys.argv[1:]
parent, name = os.path.split(path)
parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
target_fd = None
try:
    observed = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(observed.st_mode): raise SystemExit(6)
    if str(observed.st_dev) != expected_dev or str(observed.st_ino) != expected_ino:
        raise SystemExit(6)
    target_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    anchored = os.fstat(target_fd)
    birth = subprocess.check_output(
        ['stat', '-Lc', '%W', f'/proc/self/fd/{target_fd}'],
        text=True,
        pass_fds=(target_fd,),
    ).strip()
    if str(anchored.st_dev) != expected_dev or str(anchored.st_ino) != expected_ino or birth != expected_birth:
        raise SystemExit(6)
    def remove_tree(parent_descriptor, entry_name):
        entry = os.stat(entry_name, dir_fd=parent_descriptor, follow_symlinks=False)
        if not stat.S_ISDIR(entry.st_mode):
            os.unlink(entry_name, dir_fd=parent_descriptor)
            return
        child_descriptor = os.open(
            entry_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=parent_descriptor,
        )
        try:
            for child_name in os.listdir(child_descriptor):
                remove_tree(child_descriptor, child_name)
        finally:
            os.close(child_descriptor)
        os.rmdir(entry_name, dir_fd=parent_descriptor)
    for child_name in os.listdir(target_fd):
        remove_tree(target_fd, child_name)
    still_anchored = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if (
        not stat.S_ISDIR(still_anchored.st_mode)
        or str(still_anchored.st_dev) != expected_dev
        or str(still_anchored.st_ino) != expected_ino
    ):
        raise SystemExit(6)
    os.close(target_fd)
    target_fd = None
    os.rmdir(name, dir_fd=parent_fd)
finally:
    if target_fd is not None: os.close(target_fd)
    os.close(parent_fd)
PY
`,
    [path, identity.device, identity.inode, identity.birthTimeSeconds]
  ).status === 0

const durableOwnershipOperations = (assertFence: () => void): DurableOwnershipOperations => ({
  proveOwnership: (record) => {
    assertFence()
    if (record.guestRootTransition) return true
    const rootAbsent =
      bash(record.distro, record.user, '[ ! -e "$1" ]', [record.guestRoot]).status === 0
    if (rootAbsent) return true
    // A root with no host-captured complete receipt may still contain a launcher from the
    // spawn-to-capture crash window. Its guest heartbeat supervisor owns self-cleanup; the host
    // preserves the journal for a later retry instead of inferring that no process exists.
    if (record.processes.length === 0 && record.phase !== 'preparing') return false
    const result = bash(
      record.distro,
      record.user,
      String.raw`[ -f "$1" ] || exit 1; IFS= read -r actual < "$1" || exit 1; [ "$actual" = "$2" ]`,
      [ownerMarkerPath(record), record.ownerToken]
    )
    return result.status === 0
  },
  stopProcess: (identity, record) => {
    assertFence()
    const outcome = reconcileDurableProcessIdentity(identity, {
      receiptExists: () =>
        bash(record.distro, record.user, '[ -r "$1" ]', [identity.receiptPath]).status === 0,
      pendingCompletionProvesStopped: () =>
        bash(
          record.distro,
          record.user,
          'read -r state token < "$1" || exit 1; { [ "$state" = NOT_STARTED ] || [ "$state" = STOPPED ]; } && [ "$token" = "$2" ]',
          [identity.completionPath, identity.token]
        ).status === 0,
      capturePendingReceipt: () => readReceiptIdentity(record.distro, record.user, identity),
      terminateComplete: (exactIdentity) => {
        const descendantsReceipt = identity.receiptPath.endsWith('.receipt')
          ? `${identity.receiptPath.slice(0, -'.receipt'.length)}.ready`
          : undefined
        const stopped = stopToken(
          record.distro,
          record.user,
          exactIdentity.token,
          exactIdentity.receiptPath,
          descendantsReceipt,
          exactIdentity as DurableProcessIdentity
        )
        if (stopped.status === 4 || stopped.status === 6) return 'mismatch'
        return stopped.status === 0 ? 'stopped' : 'failed'
      }
    })
    if (outcome === 'mismatch') {
      throw new Error('WSL_MATRIX_OWNERSHIP_CONFLICT')
    }
    return outcome === 'stopped' || outcome === 'absent'
  },
  removeGuestRoot: async (record) => {
    assertFence()
    const quarantine = `${record.guestRoot}.quarantine-${record.ownerToken}`
    const run = (program: string, args: string[]): boolean => {
      assertFence()
      return bash(record.distro, record.user, program, args).status === 0
    }
    return removeOwnedGuestRoot(
      {
        rootExists: () => run('[ -e "$1" ]', [record.guestRoot]),
        quarantineExists: () => run('[ -e "$1" ]', [quarantine]),
        readCanonicalIdentity: () =>
          readGuestDirectoryIdentity(record.distro, record.user, record.guestRoot),
        canonicalIdentityMatches: (identity) => {
          const observed = readGuestDirectoryIdentity(record.distro, record.user, record.guestRoot)
          return observed !== undefined && JSON.stringify(observed) === JSON.stringify(identity)
        },
        quarantineIdentityMatches: (identity) => {
          const observed = readGuestDirectoryIdentity(record.distro, record.user, quarantine)
          return observed !== undefined && JSON.stringify(observed) === JSON.stringify(identity)
        },
        removePreparingRoot: () => {
          const preparingRoot = preparingRootPath(record)
          if (!run('[ -e "$1" ]', [preparingRoot])) return true
          return record.preparingRootIdentity
            ? removeExactGuestDirectory(
                record.distro,
                record.user,
                preparingRoot,
                record.preparingRootIdentity
              )
            : false
        },
        persistTransition: async (phase, identity) => {
          assertFence()
          await updateDurableOwnership(record.runId, (current) => ({
            ...current,
            guestRootTransition: {
              quarantinePath: quarantine,
              ownerToken: record.ownerToken,
              phase,
              identity
            }
          }))
          return true
        },
        clearTransition: async () => {
          assertFence()
          await updateDurableOwnership(record.runId, (current) => ({
            ...current,
            guestRootTransition: null
          }))
          return true
        },
        quarantine: () => run('mv -- "$1" "$2"', [record.guestRoot, quarantine]),
        markerMatchesCanonical: () =>
          run('IFS= read -r actual < "$1/.open-science-owner" && [ "$actual" = "$2" ]', [
            record.guestRoot,
            record.ownerToken
          ]),
        markerMatchesInQuarantine: () =>
          run('IFS= read -r actual < "$1/.open-science-owner" && [ "$actual" = "$2" ]', [
            quarantine,
            record.ownerToken
          ]),
        removeQuarantine: (identity) =>
          removeExactGuestDirectory(record.distro, record.user, quarantine, identity)
      },
      record.guestRootTransition
    )
  }
})

const lifecycleWrapper = String.raw`
receipt=$1
token=$2
mode=$3
ready=$4
heartbeat=$5
owner_token=$6
completion=$7
start=$(awk '{print $22}' "/proc/$$/stat")
sid=$(ps -o sid= -p $$ | tr -d ' ')
pgid=$(ps -o pgid= -p $$ | tr -d ' ')
write_leader_receipt() {
  printf '%s %s %s %s %s\n' "$$" "$token" "$start" "$sid" "$pgid" > "$receipt.tmp" && mv -f -- "$receipt.tmp" "$receipt"
}
cleanup() {
  status=$?
  trap - EXIT TERM INT HUP
  jobs -pr | xargs -r kill -TERM 2>/dev/null || true
  printf 'STOPPED %s\n' "$token" > "$completion.tmp" && mv -f -- "$completion.tmp" "$completion" || status=72
  exit "$status"
}
trap cleanup EXIT TERM INT HUP
case "$mode" in
  normal) write_leader_receipt || exit 71; exit 0 ;;
  nonzero) write_leader_receipt || exit 71; exit 23 ;;
  descendants)
    gate="$ready.gate"
    rm -f -- "$gate"
    bash --noprofile --norc -c '
      gate=$1; heartbeat=$2; owner=$3
      until [ -e "$gate" ]; do read -r saved ms < "$heartbeat" || exit 70; [ "$saved" = "$owner" ] || exit 70; sleep .05; done
      while read -r saved ms < "$heartbeat" && [ "$saved" = "$owner" ] && [ $(( $(date +%s%3N) - ms )) -le 8000 ]; do sleep .2; done
    ' open-science-background "$gate" "$heartbeat" "$owner_token" & background_pid=$!
    background_start=$(awk '{print $22}' "/proc/$background_pid/stat")
    background_sid=$(ps -o sid= -p "$background_pid" | tr -d ' ')
    background_pgid=$(ps -o pgid= -p "$background_pid" | tr -d ' ')
    setsid bash --noprofile --norc -c '
      ready=$1
      heartbeat=$2; owner=$3; gate=$4
      bash --noprofile --norc -c '\''
        gate=$1; heartbeat=$2; owner=$3
        until [ -e "$gate" ]; do read -r saved ms < "$heartbeat" || exit 70; [ "$saved" = "$owner" ] || exit 70; sleep .05; done
        while read -r saved ms < "$heartbeat" && [ "$saved" = "$owner" ] && [ $(( $(date +%s%3N) - ms )) -le 8000 ]; do sleep .2; done
      '\'' open-science-escaped-child "$gate" "$heartbeat" "$owner" & grandchild=$!
      sid=$(ps -o sid= -p "$grandchild" | tr -d " ")
      pgid=$(ps -o pgid= -p "$grandchild" | tr -d " ")
      start=$(awk "{print \$22}" "/proc/$grandchild/stat")
      printf "%s %s %s %s\n" "$grandchild" "$start" "$sid" "$pgid" > "$ready"
      wait
    ' open-science-escaped "$ready.escaped" "$heartbeat" "$owner_token" "$gate" >/dev/null 2>&1 & escaped_launcher=$!
    escaped_launcher_start=$(awk '{print $22}' "/proc/$escaped_launcher/stat")
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      escaped_launcher_sid=$(ps -o sid= -p "$escaped_launcher" | tr -d ' ')
      escaped_launcher_pgid=$(ps -o pgid= -p "$escaped_launcher" | tr -d ' ')
      [ "$escaped_launcher_sid" = "$escaped_launcher" ] && [ "$escaped_launcher_pgid" = "$escaped_launcher" ] && break
      sleep 0.01
    done
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -s "$ready.escaped" ] && break
      sleep 0.05
    done
    read -r escaped_grandchild escaped_start escaped_sid escaped_pgid < "$ready.escaped"
    printf '%s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s %s\n' "$$" "$token" "$start" "$sid" "$pgid" "$background_pid" "$background_start" "$background_sid" "$background_pgid" "$escaped_launcher" "$escaped_launcher_start" "$escaped_launcher_sid" "$escaped_launcher_pgid" "$escaped_grandchild" "$escaped_start" "$escaped_sid" "$escaped_pgid" > "$receipt.tmp" || exit 71
    mv -f -- "$receipt.tmp" "$receipt" || exit 71
    printf '%s %s %s %s %s %s %s %s %s %s %s %s\n' "$background_pid" "$background_start" "$background_sid" "$background_pgid" "$escaped_launcher" "$escaped_launcher_start" "$escaped_launcher_sid" "$escaped_launcher_pgid" "$escaped_grandchild" "$escaped_start" "$escaped_sid" "$escaped_pgid" > "$ready" || exit 71
    touch "$gate" || exit 71
    wait
    ;;
  *) exit 64 ;;
esac
`

const waitForReceipt = async (
  distro: string,
  user: string,
  receipt: string,
  token: string,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = bash(
      distro,
      user,
      '[ -r "$1" ] && read -r pid saved _start _sid _pgid < "$1" && [ "$saved" = "$2" ]',
      [receipt, token],
      3_000
    )
    if (result.status === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const waitForCompletionState = async (
  distro: string,
  user: string,
  completion: string,
  token: string,
  state: 'STARTING' | 'STOPPED',
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = bash(
      distro,
      user,
      'read -r observed_state observed_token < "$1" && [ "$observed_state" = "$2" ] && [ "$observed_token" = "$3" ]',
      [completion, state, token],
      3_000
    )
    if (result.status === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const waitForSpawnedIdentity = async (
  distro: string,
  user: string,
  completion: string,
  token: string,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = bash(
      distro,
      user,
      'read -r pid start sid pgid observed_token < "$1.spawned" && case "$pid:$start:$sid:$pgid" in *[!0-9:]*) exit 1;; esac; [ "$pid" = "$sid" ] && [ "$pid" = "$pgid" ] && [ "$observed_token" = "$2" ]',
      [completion, token],
      3_000
    )
    if (result.status === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const waitForPayloadReady = async (
  distro: string,
  user: string,
  readyReceipt: string,
  token: string,
  timeoutMs: number
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = bash(
      distro,
      user,
      String.raw`
read -r background background_start background_sid background_pgid launcher launcher_start launcher_sid launcher_pgid escaped escaped_start escaped_sid escaped_pgid < "$1" || exit 1
case "$background:$background_start:$background_sid:$background_pgid:$launcher:$launcher_start:$launcher_sid:$launcher_pgid:$escaped:$escaped_start:$escaped_sid:$escaped_pgid" in *[!0-9:]*) exit 1;; esac
kill -0 "$background" 2>/dev/null && kill -0 "$launcher" 2>/dev/null && kill -0 "$escaped" 2>/dev/null || exit 1
[ "$background_sid" != "$launcher_sid" ] && [ "$launcher_sid" = "$launcher_pgid" ] && [ "$escaped_sid" = "$launcher_sid" ] || exit 1
for pid in "$background" "$launcher" "$escaped"; do
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$2" || exit 1
done
`,
      [readyReceipt, token],
      3_000
    )
    if (result.status === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const lifecycleCase = async (
  distro: string,
  user: string,
  guestRoot: string,
  name: 'normalExit' | 'nonZeroExit' | 'cancel' | 'timeout',
  token: string,
  heartbeatPath: string,
  ownerToken: string,
  beginLaunch: (identity: DurableProcessIdentity) => Promise<void>,
  captureProcess: (identity: DurableProcessIdentity) => Promise<DurableProcessIdentity>,
  crashRunId?: string
): Promise<LifecycleResult> => {
  const receipt = `${guestRoot}/${name}.receipt`
  const readyReceipt = `${guestRoot}/${name}.ready`
  const mode = name === 'normalExit' ? 'normal' : name === 'nonZeroExit' ? 'nonzero' : 'descendants'
  const startedAt = Date.now()
  let cleanupSucceeded = true
  const cleanupStatuses: Array<number | null> = []
  const stopLifecycle = (): void => {
    const stopped = stopToken(distro, user, token, receipt, readyReceipt)
    cleanupStatuses.push(stopped.status)
    cleanupSucceeded = stopped.status === 0 && cleanupSucceeded
  }
  const pending = pendingIdentity(token, receipt)
  await beginLaunch(pending)
  const child = spawn(
    'wsl.exe',
    wslArgv(distro, user, [
      'setsid',
      '--wait',
      'env',
      `OPEN_SCIENCE_MATRIX_TOKEN=${token}`,
      ...guardedGuestCommand(pending.completionPath, token, heartbeatPath, ownerToken, receipt, [
        'bwrap',
        '--die-with-parent',
        '--new-session',
        '--unshare-net',
        '--ro-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--bind',
        guestRoot,
        guestRoot,
        '--',
        'bash',
        '--noprofile',
        '--norc',
        '-c',
        lifecycleWrapper,
        'open-science-lifecycle',
        receipt,
        token,
        mode,
        readyReceipt,
        heartbeatPath,
        ownerToken,
        pending.completionPath
      ])
    ]),
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  // Lifecycle output is deliberately discarded: receipts carry the bounded evidence without
  // logging command output, paths, or guest identity details.
  child.stdout.resume()
  child.stderr.resume()
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))
  )
  const receiptObserved = await waitForReceipt(distro, user, receipt, token, 3_000)
  if (receiptObserved) await captureProcess(pending)
  let payloadReadyBeforeTermination = name === 'normalExit' || name === 'nonZeroExit'
  let terminationRequested = false
  if (name === 'cancel') {
    payloadReadyBeforeTermination = await waitForPayloadReady(
      distro,
      user,
      readyReceipt,
      token,
      3_000
    )
    if (crashRunId) {
      bash(distro, user, 'rm -f -- "$1" "$1.escaped"', [readyReceipt])
      writeSync(1, `OPEN_SCIENCE_CRASH_RUN ${crashRunId}\n`)
      process.exit(86)
    }
    terminationRequested = true
    stopLifecycle()
  } else if (name === 'timeout') {
    payloadReadyBeforeTermination = await waitForPayloadReady(
      distro,
      user,
      readyReceipt,
      token,
      3_000
    )
    await new Promise((resolve) => setTimeout(resolve, 650))
    terminationRequested = true
    stopLifecycle()
  }
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const timer = setTimeout(() => {
        stopLifecycle()
        child.kill()
        resolve({ code: null, signal: 'SIGKILL' })
      }, 8_000)
      void exitPromise.then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    }
  )
  stopLifecycle()
  const descendantsRunning = ownedProcessesAlive(distro, user, token, receipt)
  return {
    exitCode: result.code,
    signal: result.signal,
    bounded: Date.now() - startedAt < 8_000,
    descendantsRunning,
    receiptObserved,
    payloadReadyBeforeTermination,
    terminationRequested,
    cleanupSucceeded,
    cleanupStatuses,
    durationMs: Date.now() - startedAt
  }
}

const verifyForeignReceiptSafety = async (
  distro: string,
  user: string,
  guestRoot: string,
  foreignToken: string,
  claimedToken: string,
  heartbeatPath: string,
  ownerToken: string,
  beginLaunch: (identity: DurableProcessIdentity) => Promise<void>,
  captureProcess: (identity: DurableProcessIdentity) => Promise<DurableProcessIdentity>
): Promise<boolean> => {
  const receipt = `${guestRoot}/foreign-receipt-safety.receipt`
  const pending = pendingIdentity(foreignToken, receipt)
  await beginLaunch(pending)
  const child = spawn(
    'wsl.exe',
    wslArgv(distro, user, [
      'setsid',
      '--wait',
      'env',
      `OPEN_SCIENCE_MATRIX_TOKEN=${foreignToken}`,
      ...guardedGuestCommand(
        pending.completionPath,
        foreignToken,
        heartbeatPath,
        ownerToken,
        receipt,
        [
          'bash',
          '--noprofile',
          '--norc',
          '-c',
          'completion=$3; trap \'status=$?; printf "STOPPED %s\\n" "$2" > "$completion.tmp" && mv -f -- "$completion.tmp" "$completion"; exit $status\' EXIT TERM INT; start=$(awk \'{print $22}\' "/proc/$$/stat"); sid=$(ps -o sid= -p $$ | tr -d " "); pgid=$(ps -o pgid= -p $$ | tr -d " "); printf "%s %s %s %s %s\\n" "$$" "$2" "$start" "$sid" "$pgid" > "$1"; sleep 30',
          'open-science-foreign-receipt',
          receipt,
          foreignToken,
          pending.completionPath
        ]
      )
    ]),
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] }
  )
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let pid = ''
  try {
    if (!(await waitForReceipt(distro, user, receipt, foreignToken, 3_000))) return false
    const captured = await captureProcess(pending)
    const read = bash(distro, user, 'read -r pid token < "$1"; printf %s "$pid"', [receipt])
    pid = read.stdout.trim()
    if (!/^\d+$/.test(pid)) return false

    // Simulate a stale receipt whose numeric PID now names a different live process. Matching the
    // receipt alone must not authorize a signal when the current /proc identity has another token.
    const forged = bash(
      distro,
      user,
      'printf "%s %s %s %s %s\\n" "$1" "$2" "$3" "$4" "$5" > "$6"',
      [
        pid,
        claimedToken,
        captured.startTimeTicks!,
        String(captured.sid),
        String(captured.pgid),
        receipt
      ]
    )
    if (forged.status !== 0) return false
    stopToken(distro, user, claimedToken, receipt)
    const survivedForeignReceipt = exactPidHasToken(distro, user, pid, foreignToken)

    bash(distro, user, 'printf "%s %s %s %s %s\\n" "$1" "$2" "$3" "$4" "$5" > "$6"', [
      pid,
      foreignToken,
      captured.startTimeTicks!,
      String(captured.sid),
      String(captured.pgid),
      receipt
    ])
    let stoppedAfterExactReceipt = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      stopToken(distro, user, foreignToken, receipt)
      if (!exactPidHasToken(distro, user, pid, foreignToken)) {
        stoppedAfterExactReceipt = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
    stoppedAfterExactReceipt ||= !exactPidHasToken(distro, user, pid, foreignToken)
    return survivedForeignReceipt && stoppedAfterExactReceipt
  } finally {
    if (pid) {
      bash(
        distro,
        user,
        String.raw`tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$2" && kill -TERM "$1" 2>/dev/null || true`,
        [pid, foreignToken]
      )
    }
    child.kill()
  }
}

const preflight = (distro: string, user: string): Record<string, boolean> => {
  const probes = {
    wsl2: "uname -r | grep -qi 'microsoft-standard-WSL2'",
    bash: 'command -v bash >/dev/null',
    python3: 'command -v python3 >/dev/null',
    bubblewrap: 'command -v bwrap >/dev/null',
    setsid: 'command -v setsid >/dev/null',
    base64: 'command -v base64 >/dev/null',
    nonRootUser: '[ "$(id -u)" -ne 0 ]'
  }
  return Object.fromEntries(
    Object.entries(probes).map(([name, program]) => [
      name,
      bash(distro, user, program).status === 0
    ])
  )
}

const main = async (): Promise<void> => {
  const { distro, user, crashRecoveryGate, simulateOwnerCrashAt } = parseMatrixArguments(
    process.argv.slice(2)
  )
  if (!distro || !user) {
    process.stderr.write(usage)
    process.exitCode = 64
    return
  }

  if (crashRecoveryGate) {
    for (const phase of [
      'after-staging-before-marker',
      'after-bridge-pending',
      'after-bridge-stale-start-before-receipt',
      'after-bridge-post-spawn-before-receipt',
      'after-bridge-register',
      'after-bridge-receipt',
      'after-bridge-capture',
      'after-cancel-receipt-without-ready'
    ]) {
      const crashed = spawnSync(
        process.execPath,
        [process.argv[1]!, '--distro', distro, '--user', user, '--simulate-owner-crash-at', phase],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }
      )
      if (crashed.status !== 86) {
        process.stdout.write(
          `${JSON.stringify({
            schemaVersion: 1,
            status: 'failed',
            errorCode: 'WSL_MATRIX_CRASH_GATE_DID_NOT_CRASH',
            phase,
            childStatus: crashed.status,
            childResult: crashed.stdout.trim() || undefined
          })}\n`
        )
        process.exitCode = 1
        return
      }
      const crashedRunId = /OPEN_SCIENCE_CRASH_RUN ([0-9a-f-]{36})/.exec(crashed.stdout)?.[1]
      if (!crashedRunId) {
        process.stdout.write(
          `${JSON.stringify({ schemaVersion: 1, status: 'failed', errorCode: 'WSL_MATRIX_CRASH_GATE_RECEIPT_MISSING', phase })}\n`
        )
        process.exitCode = 1
        return
      }
      void crashedRunId
      if (phase !== 'after-staging-before-marker')
        await new Promise((resolve) => setTimeout(resolve, 12_000))
    }
  }

  let globalFence: GlobalFence
  try {
    globalFence = acquireGlobalFence()
  } catch {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'failed', errorCode: 'WSL_MATRIX_GLOBAL_OWNER_ACTIVE' })}\n`
    )
    process.exitCode = 1
    return
  }
  const releaseFenceForEarlyReturn = async (): Promise<string[]> => {
    const cleanupFailures: string[] = []
    await captureCleanupFailure(cleanupFailures, 'global-fence-release', () =>
      globalFence.release()
    )
    return cleanupFailures
  }

  let startupRecovery: Awaited<ReturnType<typeof reconcileDurableOwnershipAtStartup>>
  try {
    startupRecovery = await reconcileDurableOwnershipAtStartup(
      durableOwnershipOperations(globalFence.assertOwned),
      { globallyFenced: true }
    )
  } catch {
    const cleanupFailures = await releaseFenceForEarlyReturn()
    process.stdout.write(
      `${JSON.stringify(
        withEarlyCleanupResult(
          {
            schemaVersion: 1,
            status: 'failed',
            errorCode: 'WSL_MATRIX_DURABLE_RECOVERY_FAILED'
          },
          cleanupFailures
        )
      )}\n`
    )
    process.exitCode = 1
    return
  }
  const startupRecoveryComplete = startupRecovery.every(
    ({ status }) => status === 'cleaned' || status === 'preserved-active'
  )
  if (!startupRecoveryComplete) {
    const cleanupFailures = await releaseFenceForEarlyReturn()
    process.stdout.write(
      `${JSON.stringify(
        withEarlyCleanupResult(
          {
            schemaVersion: 1,
            status: 'failed',
            distro,
            userBinding: 'explicit-non-root',
            errorCode: 'WSL_MATRIX_DURABLE_RECOVERY_INCOMPLETE',
            durableRecovery: startupRecovery.map((result) => ({
              status: result.status,
              ...(result.status === 'preserved-retryable' &&
              result.error.message === 'WSL_MATRIX_OWNERSHIP_CONFLICT'
                ? { errorCode: 'WSL_MATRIX_OWNERSHIP_CONFLICT' }
                : {})
            }))
          },
          cleanupFailures
        ),
        null,
        2
      )}\n`
    )
    process.exitCode = 1
    return
  }

  const capabilities = preflight(distro, user)
  if (Object.values(capabilities).some((available) => !available)) {
    const cleanupFailures = await releaseFenceForEarlyReturn()
    const result = withEarlyCleanupResult(
      {
        schemaVersion: 1,
        status: 'unsupported',
        distro,
        userBinding: 'explicit',
        capabilities
      },
      cleanupFailures
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.status === 'failed' ? 1 : 2
    return
  }

  const runToken = randomUUID()
  const guestRoot = canonicalDurableGuestRoot(runToken)
  const ownerToken = canonicalDurableOwnerToken(runToken)
  const leaseId = `lease-${runToken}-${randomUUID()}`
  const socketPath = `${guestRoot}/gateway.sock`
  const bridgeReceipt = `${guestRoot}/bridge.receipt`
  const bridgeScript = `${guestRoot}/bridge.py`
  const sandboxScript = `${guestRoot}/sandbox.py`
  const networkReceipt = `${guestRoot}/network.receipt`
  const heartbeatPath = `${guestRoot}/.host-heartbeat`
  const credentials = {
    username: `matrix-${randomBytes(8).toString('hex')}`,
    password: randomBytes(24).toString('base64url')
  }
  let gateway: CommandGateway | undefined
  let target: Server | undefined
  let bridge: ChildProcessWithoutNullStreams | undefined
  let closeHostIngress: (() => Promise<void>) | undefined
  const hostIngressPeers = new Set<Socket>()
  let gatewayClosed = false
  let hostIngressClosed = false
  let bridgeClosed = false
  let temporaryResourcesRemoved = false
  let foreignReceiptIdentitySafe = false
  let network: Record<string, unknown> | null = null
  let lifecycle: Record<string, unknown> | null = null
  let fatalError: string | undefined
  let bridgeStderr = ''
  const decisions: string[] = []
  let durableJournalCreated = false
  let durableHeartbeat: NodeJS.Timeout | undefined
  let heartbeatInFlight: Promise<void> | undefined
  let durableHeartbeatFailure: string | undefined
  const cleanupFailures: string[] = []
  const cleanup = (name: string, operation: () => void | Promise<void>): Promise<boolean> =>
    captureCleanupFailure(cleanupFailures, name, operation)
  const durableRecord: DurableOwnershipRecord = {
    schemaVersion: DURABLE_OWNERSHIP_SCHEMA_VERSION,
    runId: runToken,
    distro,
    user,
    guestRoot,
    ownerToken,
    leaseId,
    heartbeatAtMs: Date.now(),
    phase: 'preparing',
    guestRootTransition: null,
    preparingRootIdentity: null,
    processes: []
  }
  let journalUpdateQueue: Promise<unknown> = Promise.resolve()
  const crashAtPhase = (phase: string): void => {
    if (simulateOwnerCrashAt !== phase) return
    writeSync(1, `OPEN_SCIENCE_CRASH_RUN ${runToken}\n`)
    process.exit(86)
  }
  const updateJournal = async (
    update: (current: DurableOwnershipRecord) => DurableOwnershipRecord
  ): Promise<void> => {
    const operation = journalUpdateQueue.then(() => updateDurableOwnership(runToken, update))
    journalUpdateQueue = operation.catch(() => undefined)
    await operation
  }
  const captureProcess = async (
    pending: DurableProcessIdentity
  ): Promise<DurableProcessIdentity> => {
    const captured = readReceiptIdentity(distro, user, pending)
    if (!captured) throw new Error('WSL_MATRIX_PROCESS_IDENTITY_NOT_CAPTURED')
    await updateJournal((current) => ({
      ...current,
      heartbeatAtMs: Date.now(),
      phase: 'running',
      processes: current.processes.some(
        (identity) =>
          identity.token === pending.token && identity.receiptPath === pending.receiptPath
      )
        ? current.processes.map((identity) =>
            identity.token === pending.token && identity.receiptPath === pending.receiptPath
              ? captured
              : identity
          )
        : [...current.processes, captured]
    }))
    return captured
  }
  const beginLaunch = async (pending: DurableProcessIdentity): Promise<void> => {
    const prepared = bash(
      distro,
      user,
      'printf "NOT_STARTED %s\\n" "$2" > "$1.tmp" && mv -f -- "$1.tmp" "$1"',
      [pending.completionPath, pending.token]
    )
    if (prepared.status !== 0) throw new Error('WSL_MATRIX_COMPLETION_PROOF_PREPARE_FAILED')
    await updateJournal((current) => ({
      ...current,
      heartbeatAtMs: Date.now(),
      phase: 'launching',
      processes: current.processes.some(({ token }) => token === pending.token)
        ? current.processes
        : [...current.processes, pending]
    }))
  }

  try {
    await persistDurableOwnership(durableRecord)
    durableJournalCreated = true
    const preparingRoot = preparingRootPath(durableRecord)
    const staged = bash(distro, user, 'umask 077; mkdir -- "$1"', [preparingRoot])
    if (staged.status !== 0) throw new Error(staged.stderr.trim())
    const preparingIdentity = readGuestDirectoryIdentity(distro, user, preparingRoot)
    if (!preparingIdentity) throw new Error('WSL_MATRIX_PREPARING_ROOT_IDENTITY_MISSING')
    await updateJournal((current) => ({
      ...current,
      preparingRootIdentity: preparingIdentity
    }))
    crashAtPhase('after-staging-before-marker')
    const madeRoot = bash(
      distro,
      user,
      'printf "%s\\n" "$3" > "$1/.open-science-owner" && printf "%s %s\\n" "$3" "$4" > "$1/.host-heartbeat" && mv -- "$1" "$2"',
      [preparingRoot, guestRoot, ownerToken, String(Date.now())]
    )
    if (madeRoot.status !== 0) throw new Error(madeRoot.stderr.trim())
    await updateJournal((current) => ({ ...current, preparingRootIdentity: null }))
    durableHeartbeat = setInterval(() => {
      if (heartbeatInFlight) return
      heartbeatInFlight = updateJournal((current) => ({
        ...current,
        heartbeatAtMs: Date.now()
      }))
        .then(() => {
          globalFence.heartbeat()
          const refreshed = bash(
            distro,
            user,
            'printf "%s %s\\n" "$2" "$3" > "$1.tmp" && mv -f -- "$1.tmp" "$1"',
            [heartbeatPath, ownerToken, String(Date.now())]
          )
          if (refreshed.status !== 0) throw new Error('WSL_MATRIX_GUEST_HEARTBEAT_FAILED')
        })
        .catch((error: unknown) => {
          durableHeartbeatFailure = error instanceof Error ? error.message : String(error)
        })
        .finally(() => {
          heartbeatInFlight = undefined
        })
    }, 1_000)
    writeGuestFile(distro, user, bridgeScript, guestBridgeProgram)
    writeGuestFile(distro, user, sandboxScript, sandboxProbeProgram)

    target = createServer((_request, response) => response.end('matrix-ok'))
    const targetPort = await listen(target)
    gateway = await CommandGateway.open({
      credentials,
      decide: async (host) => {
        decisions.push(host)
        return host === 'matrix.allowed.invalid'
          ? { allowed: true, address: '127.0.0.1' }
          : { allowed: false, message: 'OPEN_SCIENCE_NETWORK_POLICY_BLOCKED: matrix deny' }
      }
    })
    const hostIngress = await listenHostIngress((client) => {
      const upstream = connectTcp({ host: '127.0.0.1', port: gateway!.port })
      hostIngressPeers.add(client)
      hostIngressPeers.add(upstream)
      const forget = (): void => {
        hostIngressPeers.delete(client)
        hostIngressPeers.delete(upstream)
      }
      client.once('close', forget)
      upstream.once('close', forget)
      client.once('error', () => upstream.destroy())
      upstream.once('error', () => client.destroy())
      client.pipe(upstream).pipe(client)
    })
    closeHostIngress = hostIngress.close

    const bridgeToken = `bridge-${runToken}`
    const bridgeIdentity = pendingIdentity(bridgeToken, bridgeReceipt)
    await beginLaunch(bridgeIdentity)
    crashAtPhase('after-bridge-pending')
    const launchedBridge = spawn(
      'wsl.exe',
      wslArgv(distro, user, [
        'setsid',
        '--wait',
        'env',
        `OPEN_SCIENCE_MATRIX_TOKEN=${bridgeToken}`,
        ...(simulateOwnerCrashAt === 'after-bridge-stale-start-before-receipt'
          ? ['OPEN_SCIENCE_MATRIX_PRE_HEARTBEAT_DELAY_SECONDS=10']
          : []),
        ...(simulateOwnerCrashAt === 'after-bridge-post-spawn-before-receipt'
          ? ['OPEN_SCIENCE_MATRIX_PAYLOAD_PRE_RECEIPT_DELAY_SECONDS=30']
          : []),
        ...guardedGuestCommand(
          bridgeIdentity.completionPath,
          bridgeToken,
          heartbeatPath,
          ownerToken,
          bridgeReceipt,
          [
            'python3',
            bridgeScript,
            socketPath,
            '127.0.0.1',
            String(hostIngress.port),
            bridgeReceipt,
            bridgeIdentity.completionPath,
            bridgeToken,
            heartbeatPath,
            ownerToken
          ]
        )
      ]),
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    launchedBridge.stdin.end()
    if (simulateOwnerCrashAt === 'after-bridge-stale-start-before-receipt') {
      const starting = await waitForCompletionState(
        distro,
        user,
        bridgeIdentity.completionPath,
        bridgeToken,
        'STARTING',
        3_000
      )
      if (!starting) throw new Error('WSL_MATRIX_STALE_START_NOT_OBSERVED')
      crashAtPhase('after-bridge-stale-start-before-receipt')
    }
    if (simulateOwnerCrashAt === 'after-bridge-post-spawn-before-receipt') {
      const spawned = await waitForSpawnedIdentity(
        distro,
        user,
        bridgeIdentity.completionPath,
        bridgeToken,
        3_000
      )
      if (!spawned) throw new Error('WSL_MATRIX_POST_SPAWN_IDENTITY_NOT_OBSERVED')
      crashAtPhase('after-bridge-post-spawn-before-receipt')
    }
    bridge = launchedBridge
    if (simulateOwnerCrashAt === 'after-bridge-register') {
      await waitForOutput(launchedBridge, 'OPEN_SCIENCE_BRIDGE_SUPERVISOR_READY', 8_000)
      crashAtPhase('after-bridge-register')
    }
    await waitForOutput(launchedBridge, 'OPEN_SCIENCE_BRIDGE_READY', 8_000)
    crashAtPhase('after-bridge-receipt')
    await captureProcess(bridgeIdentity)
    crashAtPhase('after-bridge-capture')
    launchedBridge.stderr.on('data', (chunk: Buffer) => (bridgeStderr += chunk.toString()))

    const networkToken = `network-${runToken}`
    const networkIdentity = pendingIdentity(networkToken, networkReceipt)
    await beginLaunch(networkIdentity)
    const networkProgram = String.raw`
completion=$10
start=$(awk '{print $22}' "/proc/$$/stat"); sid=$(ps -o sid= -p $$ | tr -d ' '); pgid=$(ps -o pgid= -p $$ | tr -d ' ')
printf '%s %s %s %s %s\n' "$$" "$2" "$start" "$sid" "$pgid" > "$1" || exit 71
bwrap --die-with-parent --new-session --unshare-net --ro-bind / / --tmpfs /run --dir /run/open-science-matrix --ro-bind "$3" /run/open-science-matrix/sandbox.py --bind "$4" /run/open-science-matrix/gateway.sock --proc /proc --dev /dev --tmpfs /tmp -- python3 /run/open-science-matrix/sandbox.py /run/open-science-matrix/gateway.sock "$5" "$6" "$7"
status=$?; printf 'STOPPED %s\n' "$2" > "$completion.tmp" && mv -f -- "$completion.tmp" "$completion" || exit 72; exit "$status"
`
    const networkCommandPromise = runWslAsync(
      distro,
      user,
      [
        'setsid',
        '--wait',
        'env',
        `OPEN_SCIENCE_MATRIX_TOKEN=${networkToken}`,
        ...guardedGuestCommand(
          networkIdentity.completionPath,
          networkToken,
          heartbeatPath,
          ownerToken,
          networkReceipt,
          [
            'bash',
            '--noprofile',
            '--norc',
            '-c',
            networkProgram,
            'open-science-matrix',
            networkReceipt,
            networkToken,
            sandboxScript,
            socketPath,
            credentials.username,
            credentials.password,
            String(targetPort),
            heartbeatPath,
            ownerToken,
            networkIdentity.completionPath
          ]
        )
      ],
      15_000,
      () => stopToken(distro, user, networkToken, networkReceipt)
    )
    const networkCommand = await networkCommandPromise
    if (!(await waitForReceipt(distro, user, networkReceipt, networkToken, 3_000))) {
      throw new Error('WSL_MATRIX_NETWORK_IDENTITY_NOT_CAPTURED')
    }
    await captureProcess(networkIdentity)
    const networkStopSucceeded = stopToken(distro, user, networkToken, networkReceipt).status === 0
    const networkProcessesTerminated =
      networkStopSucceeded && !ownedProcessesAlive(distro, user, networkToken, networkReceipt)
    const networkLine = networkCommand.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('OPEN_SCIENCE_NETWORK_RESULT '))
    if (!networkLine) {
      network = {
        gatewayAllowed: false,
        gatewayDenied: false,
        directOutboundBlocked: false,
        errorCode: 'WSL_MATRIX_NETWORK_PROBE_FAILED',
        exitCode: networkCommand.status,
        bridgeError: bridgeStderr.length > 0,
        decisionCount: decisions.length
      }
    } else {
      network = JSON.parse(networkLine.slice('OPEN_SCIENCE_NETWORK_RESULT '.length)) as Record<
        string,
        unknown
      >
      network.networkProcessesTerminated = networkProcessesTerminated
      network.networkProbeStatus = networkCommand.status
      network.networkProbeTimedOut = networkCommand.timedOut
    }

    lifecycle = {
      normalExit: await lifecycleCase(
        distro,
        user,
        guestRoot,
        'normalExit',
        `lifecycle-normalExit-${runToken}`,
        heartbeatPath,
        ownerToken,
        beginLaunch,
        captureProcess
      ),
      nonZeroExit: await lifecycleCase(
        distro,
        user,
        guestRoot,
        'nonZeroExit',
        `lifecycle-nonZeroExit-${runToken}`,
        heartbeatPath,
        ownerToken,
        beginLaunch,
        captureProcess
      ),
      cancel: await lifecycleCase(
        distro,
        user,
        guestRoot,
        'cancel',
        `lifecycle-cancel-${runToken}`,
        heartbeatPath,
        ownerToken,
        beginLaunch,
        captureProcess,
        simulateOwnerCrashAt === 'after-cancel-receipt-without-ready' ? runToken : undefined
      ),
      timeout: await lifecycleCase(
        distro,
        user,
        guestRoot,
        'timeout',
        `lifecycle-timeout-${runToken}`,
        heartbeatPath,
        ownerToken,
        beginLaunch,
        captureProcess
      )
    }
    foreignReceiptIdentitySafe = await verifyForeignReceiptSafety(
      distro,
      user,
      guestRoot,
      `foreign-${runToken}`,
      `stale-${runToken}`,
      heartbeatPath,
      ownerToken,
      beginLaunch,
      captureProcess
    )

    const bridgeStopSucceeded = stopToken(distro, user, bridgeToken, bridgeReceipt).status === 0
    launchedBridge.kill()
    bridgeClosed =
      bridgeStopSucceeded && !ownedProcessesAlive(distro, user, bridgeToken, bridgeReceipt)
    bridge = undefined
    await gateway.close()
    gatewayClosed = true
    gateway = undefined
    for (const peer of hostIngressPeers) peer.destroy()
    await closeHostIngress()
    hostIngressClosed = true
    closeHostIngress = undefined
    await closeServer(target)
    target = undefined
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error)
  } finally {
    if (durableHeartbeat) clearInterval(durableHeartbeat)
    await cleanup('heartbeat', async () => heartbeatInFlight)
    await cleanup('journal-update', async () => journalUpdateQueue)
    if (durableHeartbeatFailure && !fatalError) fatalError = durableHeartbeatFailure
    if (bridge) {
      const bridgeStop = stopToken(distro, user, `bridge-${runToken}`, bridgeReceipt)
      if (bridgeStop.status !== 0) cleanupFailures.push('bridge-stop')
      await cleanup('bridge-host-process-close', () => {
        bridge!.kill()
      })
      bridgeClosed =
        bridgeStop.status === 0 &&
        !ownedProcessesAlive(distro, user, `bridge-${runToken}`, bridgeReceipt)
    }
    if (gateway) {
      gatewayClosed = await cleanup('gateway-close', () => gateway!.close())
    }
    for (const peer of hostIngressPeers) {
      await cleanup('host-ingress-peer-close', () => {
        peer.destroy()
      })
    }
    if (closeHostIngress) {
      hostIngressClosed = await cleanup('host-ingress-close', closeHostIngress)
    }
    if (target) await cleanup('target-server-close', () => closeServer(target!))
    if (durableJournalCreated) {
      await cleanup('durable-reconcile', async () => {
        const recovery = await reconcileDurableOwnershipAtStartup(
          durableOwnershipOperations(globalFence.assertOwned),
          { activeLeaseId: leaseId, globallyFenced: true }
        )
        temporaryResourcesRemoved ||= recovery.some(
          (result) => result.status === 'cleaned' && result.runId === runToken
        )
      })
    }
  }

  await cleanup('global-fence-release', () => globalFence.release())

  const distroStillRunning = bash(distro, user, 'true').status === 0
  const lifecycleValues = lifecycle ? Object.values(lifecycle) : []
  const lifecycleCleanupComplete =
    lifecycleValues.length === 4 &&
    lifecycleValues.every(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        (value as LifecycleResult).cleanupSucceeded &&
        (value as LifecycleResult).cleanupStatuses.length > 0 &&
        (value as LifecycleResult).cleanupStatuses.every((status) => status === 0)
    )
  const cleanupComplete =
    cleanupFailures.length === 0 &&
    lifecycleCleanupComplete &&
    network?.networkProcessesTerminated === true &&
    gatewayClosed &&
    hostIngressClosed &&
    bridgeClosed &&
    temporaryResourcesRemoved &&
    foreignReceiptIdentitySafe &&
    startupRecoveryComplete
  const passed =
    !fatalError &&
    cleanupComplete &&
    network?.gatewayAllowed === true &&
    network.gatewayDenied === true &&
    network.directOutboundBlocked === true &&
    lifecycleValues.every(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        (value as LifecycleResult).bounded &&
        (value as LifecycleResult).cleanupSucceeded &&
        !(value as LifecycleResult).descendantsRunning &&
        (value as LifecycleResult).receiptObserved
    ) &&
    (lifecycle?.cancel as LifecycleResult | undefined)?.terminationRequested === true &&
    (lifecycle?.cancel as LifecycleResult | undefined)?.payloadReadyBeforeTermination === true &&
    (lifecycle?.timeout as LifecycleResult | undefined)?.terminationRequested === true &&
    (lifecycle?.timeout as LifecycleResult | undefined)?.payloadReadyBeforeTermination === true &&
    (lifecycle?.normalExit as LifecycleResult | undefined)?.exitCode === 0 &&
    (lifecycle?.nonZeroExit as LifecycleResult | undefined)?.exitCode === 23 &&
    (lifecycle?.cancel as LifecycleResult | undefined)?.exitCode === 143 &&
    (lifecycle?.timeout as LifecycleResult | undefined)?.exitCode === 143 &&
    network.networkProbeStatus === 0 &&
    network.networkProbeTimedOut === false &&
    distroStillRunning &&
    startupRecoveryComplete

  const outputErrorCode = matrixResultErrorCode(passed, cleanupComplete)

  const output = {
    schemaVersion: 1,
    status: passed ? 'passed' : 'failed',
    distro,
    userBinding: 'explicit-non-root',
    capabilities,
    network,
    lifecycle: lifecycle ? { ...lifecycle, distroStillRunning } : null,
    cleanup: {
      gatewayClosed,
      hostIngressClosed,
      bridgeClosed,
      temporaryResourcesRemoved,
      foreignReceiptIdentitySafe,
      durableStartupReconciled: startupRecoveryComplete,
      durableStartupRecoveredRuns: startupRecovery.filter(({ status }) => status === 'cleaned')
        .length,
      durableJournalRemoved: temporaryResourcesRemoved
    },
    decision,
    ...(outputErrorCode ? { errorCode: outputErrorCode } : {}),
    ...(cleanupFailures.length > 0 ? { cleanupFailures } : {})
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  process.exitCode = passed ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main()

export { acquireGlobalFence, lifecycleWrapper, parseMatrixArguments, wslArgv }
