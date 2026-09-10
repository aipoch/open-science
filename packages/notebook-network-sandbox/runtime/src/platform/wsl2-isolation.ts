import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import type { FilesystemLayoutInput } from './filesystem-layout.js'
import type { GatewayCredentials } from '../gateway/command-gateway.js'

type Wsl2Target = Readonly<{
  kind: 'wsl2'
  profileId: string
  distro: string
  user: string
}>

type Wsl2PathMapper = (path: string, signal?: AbortSignal) => Promise<string>
type Wsl2CleanupReason = 'exit' | 'cancel' | 'timeout' | 'spawn-failed'

type Wsl2GuestCleanupRequest = Readonly<{
  distro: string
  user: string
  receipt: string
  token: string
  reason: Wsl2CleanupReason
}>

type Wsl2GuestCleanup = (request: Wsl2GuestCleanupRequest) => Promise<boolean>
type Wsl2GuestReconciliation = (request: {
  distro: string
  user: string
  signal?: AbortSignal
}) => Promise<boolean>

type Wsl2LaunchRequest = Readonly<{
  target: Wsl2Target
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  pathEnvironment?: NodeJS.ProcessEnv
  filesystem: FilesystemLayoutInput
  gatewayPort?: number
  gatewayCredentials?: GatewayCredentials
  mapPath?: Wsl2PathMapper
  cleanupGuest?: Wsl2GuestCleanup
  reconcileGuest?: Wsl2GuestReconciliation
  openBridge?: Wsl2GatewayBridgeOpener
  onCleanupReady?: (release: Wsl2Launch['release']) => void
  signal?: AbortSignal
}>

type Wsl2ReleaseResult = Readonly<{
  processesTerminated: boolean
  networkClosed: boolean
  temporaryResourcesRemoved: boolean
}>

type MappedFilesystemLayout = Readonly<{
  cwd: string
  readOnlyRoots: string[]
  readWriteRoots: string[]
  deniedReadRoots: string[]
  deniedWriteRoots: string[]
  privateRoot?: string
}>

type Wsl2Launch = Readonly<{
  argv: string[]
  env: NodeJS.ProcessEnv
  beginSpawn: () => Readonly<{ started: () => void; notStarted: () => void }>
  release: (reason?: Wsl2CleanupReason) => Promise<Wsl2ReleaseResult>
}>

const MAX_CLEANUP_CAPTURE_BYTES = 64 * 1024
const GUEST_CLEANUP_TIMEOUT_MS = 8_000

const executionWrapperScript = String.raw`
receipt=$1; token=$2; shift 2
umask 077
printf 'v1 %s\n' "$token" > "$receipt.tmp" || exit 71
mv -f -- "$receipt.tmp" "$receipt" || exit 71
export OPEN_SCIENCE_WSL_EXECUTION_TOKEN="$token"
exec "$@"
`

// Every process launched below bwrap inherits the unguessable token. Cleanup scans the guest
// process table for that exact environment marker, freezes the matches so they cannot fork, and
// signals only identities whose PID start time and token still match. The distribution stays up.
const exactExecutionCleanupScript = String.raw`
receipt=$1; token=$2
i=0
while [ ! -r "$receipt" ] && [ "$i" -lt 40 ]; do
  i=$((i + 1)); sleep 0.05
done
[ -r "$receipt" ] || exit 3
IFS=' ' read -r version recorded_token < "$receipt" || exit 4
[ "$version" = v1 ] && [ "$recorded_token" = "$token" ] || exit 4
marker="OPEN_SCIENCE_WSL_EXECUTION_TOKEN=$token"
identities=
known=' '
capture() {
  capture_found=0
  for environment in /proc/[0-9]*/environ; do
    [ -r "$environment" ] || continue
    tr '\0' '\n' < "$environment" 2>/dev/null | grep -Fqx "$marker" || continue
    target_pid=${'$'}{environment#/proc/}; target_pid=${'$'}{target_pid%/environ}
    case "$known" in *" $target_pid "*) continue;; esac
    target_start=$(awk '{print $22}' "/proc/$target_pid/stat" 2>/dev/null) || continue
    case "$target_pid:$target_start" in *[!0-9:]*) exit 6;; esac
    kill -STOP -- "$target_pid" 2>/dev/null || continue
    retry=0
    while [ "$retry" -lt 25 ]; do
      state=$(awk '{print $3}' "/proc/$target_pid/stat" 2>/dev/null) || break
      [ "$state" = T ] || [ "$state" = t ] || { retry=$((retry + 1)); sleep 0.01; continue; }
      current_start=$(awk '{print $22}' "/proc/$target_pid/stat" 2>/dev/null) || break
      [ "$current_start" = "$target_start" ] || exit 6
      identities="$identities $target_pid:$target_start"
      known="$known$target_pid "
      capture_found=1
      break
    done
  done
}
i=0
while [ "$i" -lt 5 ]; do
  capture || exit $?
  [ "$capture_found" -eq 0 ] && break
  i=$((i + 1))
done
verify() {
  verify_pid=$1; verify_start=$2
  [ -r "/proc/$verify_pid/stat" ] || return 1
  [ "$(awk '{print $3}' "/proc/$verify_pid/stat" 2>/dev/null)" != Z ] || return 1
  [ "$(awk '{print $22}' "/proc/$verify_pid/stat" 2>/dev/null)" = "$verify_start" ] || return 1
  tr '\0' '\n' < "/proc/$verify_pid/environ" 2>/dev/null | grep -Fqx "$marker" || return 2
}
signal_all() {
  requested_signal=$1
  for identity in $identities; do
    IFS=: read -r member_pid member_start <<EOF
$identity
EOF
    verify "$member_pid" "$member_start"; verified=$?
    [ "$verified" -eq 1 ] && continue
    [ "$verified" -eq 0 ] || return 6
    kill "-$requested_signal" -- "$member_pid" 2>/dev/null || return 7
  done
}
signal_all TERM || exit $?
signal_all CONT || exit $?
sleep 0.25
signal_all KILL || exit $?
i=0
while [ "$i" -lt 30 ]; do
  alive=0
  for identity in $identities; do
    IFS=: read -r member_pid member_start <<EOF
$identity
EOF
    verify "$member_pid" "$member_start"; verified=$?
    [ "$verified" -eq 0 ] && alive=1
    [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || exit 6
  done
  [ "$alive" -eq 0 ] && break
  i=$((i + 1)); sleep 0.1
done
[ "${'$'}{alive:-0}" -eq 0 ] || exit 5
rm -f -- "$receipt" "$receipt.tmp" || exit 8
`

const reconcileExecutionReceiptsScript = String.raw`
cleanup_program=$1
receipts=
for receipt in /tmp/.open-science-execution-*.receipt; do
  [ -e "$receipt" ] || continue
  [ -f "$receipt" ] && [ ! -L "$receipt" ] && [ -O "$receipt" ] || exit 20
  name=${'$'}{receipt#/tmp/.open-science-execution-}
  uuid=${'$'}{name%.receipt}
  printf '%s\n' "$uuid" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || exit 21
  expected="v1 open-science-execution-$uuid"
  [ "$(wc -l < "$receipt")" -eq 1 ] || exit 22
  [ "$(cat -- "$receipt")" = "$expected" ] || exit 22
  receipts="$receipts $receipt"
done
for receipt in $receipts; do
  name=${'$'}{receipt#/tmp/.open-science-execution-}
  uuid=${'$'}{name%.receipt}
  /bin/bash --noprofile --norc -c "$cleanup_program" open-science-wsl-reconcile "$receipt" "open-science-execution-$uuid" || exit $?
done
`

type Wsl2GatewayBridge = Readonly<{
  socketPath: string
  close: () => Promise<Readonly<{ networkClosed: boolean; temporaryResourcesRemoved: boolean }>>
}>

type Wsl2GatewayBridgeOpener = (request: {
  target: Wsl2Target
  gatewayPort: number
  signal?: AbortSignal
  onBridgeCreated?: (bridge: Wsl2GatewayBridge) => void
}) => Promise<Wsl2GatewayBridge>

const WINDOWS_PATH = /^[a-z]:[\\/]/iu
const SAFE_USER = /^[a-z_][a-z0-9_-]*[$]?$/u
const wslExecutable = (): string =>
  win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wsl.exe')

const bridgeProgram = String.raw`
import os, socket, sys, threading
socket_path, port_text = sys.argv[1:]
directory = os.path.dirname(socket_path)
os.makedirs(directory, mode=0o700, exist_ok=False)
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
peers = set()
stopping = threading.Event()
def close_all():
    stopping.set()
    try: listener.close()
    except OSError: pass
    for peer in list(peers):
        try: peer.close()
        except OSError: pass
def watch_owner():
    sys.stdin.buffer.read()
    close_all()
threading.Thread(target=watch_owner, daemon=True).start()
try:
    try:
        probe = socket.create_connection(('127.0.0.1', int(port_text)), timeout=2)
        probe.close()
    except OSError:
        print('OPEN_SCIENCE_WSL_GATEWAY_NAT_UNSUPPORTED', file=sys.stderr, flush=True)
        raise SystemExit(78)
    listener.bind(socket_path)
    os.chmod(socket_path, 0o600)
    listener.listen(32)
    listener.settimeout(0.5)
    print('OPEN_SCIENCE_WSL_GATEWAY_READY', flush=True)
    while not stopping.is_set():
        try: client, _ = listener.accept()
        except socket.timeout: continue
        except OSError: break
        try: upstream = socket.create_connection(('127.0.0.1', int(port_text)), timeout=5)
        except OSError:
            client.close()
            continue
        peers.update((client, upstream))
        def relay(source, target):
            try:
                while True:
                    data = source.recv(65536)
                    if not data: break
                    target.sendall(data)
            except OSError: pass
            try: target.shutdown(socket.SHUT_WR)
            except OSError: pass
        threading.Thread(target=relay, args=(client, upstream), daemon=True).start()
        threading.Thread(target=relay, args=(upstream, client), daemon=True).start()
finally:
    close_all()
    try: os.unlink(socket_path)
    except FileNotFoundError: pass
    try: os.rmdir(directory)
    except OSError: pass
`

const sandboxGatewayProgram = String.raw`
import os, signal, socket, subprocess, sys, threading, urllib.parse
socket_path, port_text, username, password, command = sys.argv[1:]
peers = set()
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', int(port_text)))
listener.listen(32)
listener.settimeout(0.5)
stopping = threading.Event()
def relay(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data: break
            target.sendall(data)
    except OSError: pass
    try: target.shutdown(socket.SHUT_WR)
    except OSError: pass
def accept_connections():
    while not stopping.is_set():
        try: client, _ = listener.accept()
        except socket.timeout: continue
        except OSError: break
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try: upstream.connect(socket_path)
        except OSError:
            client.close(); upstream.close(); continue
        peers.update((client, upstream))
        threading.Thread(target=relay, args=(client, upstream), daemon=True).start()
        threading.Thread(target=relay, args=(upstream, client), daemon=True).start()
threading.Thread(target=accept_connections, daemon=True).start()
authority = f'{urllib.parse.quote(username)}:{urllib.parse.quote(password)}@127.0.0.1:{port_text}'
http_proxy = f'http://{authority}'
socks_proxy = f'socks5h://{authority}'
child_env = dict(os.environ)
for key in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','GRPC_PROXY','grpc_proxy','DOCKER_HTTP_PROXY','DOCKER_HTTPS_PROXY'):
    child_env[key] = http_proxy
for key in ('FTP_PROXY','ftp_proxy'):
    child_env[key] = socks_proxy
child_env.update({'NO_PROXY':'','no_proxy':'','CLOUDSDK_PROXY_TYPE':'http','CLOUDSDK_PROXY_ADDRESS':'127.0.0.1','CLOUDSDK_PROXY_PORT':port_text,'CLOUDSDK_PROXY_USERNAME':username,'CLOUDSDK_PROXY_PASSWORD':password})
child = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-c', command], env=child_env)
def forward(signum, _frame):
    try: child.send_signal(signum)
    except ProcessLookupError: pass
for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(signum, forward)
status = child.wait()
stopping.set()
listener.close()
for peer in list(peers):
    try: peer.close()
    except OSError: pass
raise SystemExit(status)
`

const compressedPython = (program: string): string =>
  `import base64,zlib;exec(zlib.decompress(base64.b64decode('${deflateRawSync(program).toString('base64')}'),-15))`

const sandboxGatewayLauncher = compressedPython(sandboxGatewayProgram)

const sanitizedHostEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
  if (systemRoot) {
    env.SystemRoot = systemRoot
    env.WINDIR = systemRoot
  }
  return env
}

const waitForBridgeReady = (
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal
): Promise<void> =>
  new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(
      () => finish(new Error('WSL2 network bridge did not become ready.')),
      5_000
    )
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onStdout = (chunk: Buffer): void => {
      stdout = (stdout + chunk.toString('utf8')).slice(-128)
      if (stdout.includes('OPEN_SCIENCE_WSL_GATEWAY_READY\n')) finish()
    }
    const onStderr = (chunk: Buffer): void => {
      stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024)
      if (Buffer.byteLength(stderr, 'utf8') >= 64 * 1024)
        finish(new Error('WSL2 network bridge output exceeded its limit.'))
    }
    const onError = (): void => finish(new Error('WSL2 network bridge could not start.'))
    const onExit = (code: number | null): void =>
      finish(
        new Error(
          code === 78 || stderr.includes('OPEN_SCIENCE_WSL_GATEWAY_NAT_UNSUPPORTED')
            ? 'WSL2_NETWORK_TRANSPORT_UNSUPPORTED: WSL2 Bash Preview network access requires mirrored networking.'
            : 'WSL2 network bridge exited before ready.'
        )
      )
    const onAbort = (): void => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.once('error', onError)
    child.once('exit', onExit)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })

const verifyBridgeRemoved = (target: Wsl2Target, socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      wslExecutable(),
      [
        '--distribution',
        target.distro,
        '--user',
        target.user,
        '--exec',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        '[ ! -e "$1" ] && [ ! -e "${1%/*}" ]',
        'open-science-wsl-bridge-verify',
        socketPath
      ],
      { encoding: 'buffer', maxBuffer: 1024, timeout: 5_000, windowsHide: true },
      (error) => resolve(!error)
    )
  })

const closeBridgeProcess = async (
  child: ChildProcessWithoutNullStreams,
  target: Wsl2Target,
  socketPath: string
): Promise<Readonly<{ networkClosed: boolean; temporaryResourcesRemoved: boolean }>> => {
  let exitedCleanly = child.exitCode !== null || child.signalCode !== null
  if (!exitedCleanly) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stdin.end()
    exitedCleanly = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000))
    ])
    if (!exitedCleanly) child.kill()
  }
  const removed = await verifyBridgeRemoved(target, socketPath)
  return {
    networkClosed: exitedCleanly && removed,
    temporaryResourcesRemoved: removed
  }
}

const openWsl2GatewayBridge: Wsl2GatewayBridgeOpener = async ({
  target,
  gatewayPort,
  signal,
  onBridgeCreated
}) => {
  signal?.throwIfAborted()
  const socketPath = `/tmp/open-science-network-${randomUUID()}/gateway.sock`
  const child = spawn(
    wslExecutable(),
    [
      '--distribution',
      target.distro,
      '--user',
      target.user,
      '--exec',
      '/usr/bin/python3',
      '-c',
      bridgeProgram,
      socketPath,
      String(gatewayPort)
    ],
    { env: sanitizedHostEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const bridge = { socketPath, close: () => closeBridgeProcess(child, target, socketPath) }
  onBridgeCreated?.(bridge)
  try {
    await waitForBridgeReady(child, signal)
  } catch (error) {
    const cleanup = await closeBridgeProcess(child, target, socketPath)
    if (!cleanup.networkClosed || !cleanup.temporaryResourcesRemoved) {
      throw new Error('WSL2 network bridge cleanup was incomplete.', { cause: error })
    }
    throw error
  }
  return bridge
}

const validateTarget = (target: Wsl2Target): void => {
  if (!target.profileId.trim() || !target.distro.trim() || /[\0\r\n]/u.test(target.distro)) {
    throw new Error('WSL2 sandbox profile is invalid.')
  }
  if (!SAFE_USER.test(target.user) || target.user === 'root') {
    throw new Error('WSL2 sandbox user is invalid.')
  }
}

const defaultPathMapper =
  (target: Wsl2Target): Wsl2PathMapper =>
  async (path, signal) => {
    signal?.throwIfAborted()
    if (!WINDOWS_PATH.test(path)) {
      if (path.startsWith('/')) return path
      throw new Error('Only canonical Windows or absolute guest paths are supported.')
    }
    return new Promise<string>((resolve, reject) => {
      execFile(
        wslExecutable(),
        [
          '--distribution',
          target.distro,
          '--user',
          target.user,
          '--exec',
          '/usr/bin/wslpath',
          '-a',
          '-u',
          path
        ],
        {
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
          timeout: 5_000,
          windowsHide: true,
          ...(signal ? { signal } : {})
        },
        (error, stdout) => {
          const mapped = stdout.trim()
          if (error || !mapped.startsWith('/') || /[\0\r\n]/u.test(mapped)) {
            reject(new Error('WSL2 sandbox path mapping failed.'))
            return
          }
          resolve(mapped)
        }
      )
    })
  }

const defaultCleanupGuest: Wsl2GuestCleanup = ({ distro, user, receipt, token }) =>
  new Promise((resolve) => {
    execFile(
      wslExecutable(),
      [
        '--distribution',
        distro,
        '--user',
        user,
        '--exec',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        exactExecutionCleanupScript,
        'open-science-wsl-cleanup',
        receipt,
        token
      ],
      {
        encoding: 'buffer',
        maxBuffer: MAX_CLEANUP_CAPTURE_BYTES,
        timeout: GUEST_CLEANUP_TIMEOUT_MS,
        windowsHide: true
      },
      (error) => resolve(!error)
    )
  })

const reconcileWsl2ExecutionReceipts: Wsl2GuestReconciliation = ({ distro, user, signal }) =>
  new Promise((resolve, reject) => {
    execFile(
      wslExecutable(),
      [
        '--distribution',
        distro,
        '--user',
        user,
        '--exec',
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        reconcileExecutionReceiptsScript,
        'open-science-wsl-reconcile-receipts',
        exactExecutionCleanupScript
      ],
      {
        encoding: 'buffer',
        maxBuffer: MAX_CLEANUP_CAPTURE_BYTES,
        timeout: GUEST_CLEANUP_TIMEOUT_MS,
        windowsHide: true,
        ...(signal ? { signal } : {})
      },
      (error) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          return
        }
        resolve(!error)
      }
    )
  })

const profileReconciliations = new Map<string, Promise<void>>()

const reconcileProfile = (request: Wsl2LaunchRequest): Promise<void> => {
  // Remember a successful reconciliation for this guest user: a concurrent second wrap must not
  // rescan receipts after the first wrap starts publishing its current receipt. This fence is
  // Process-local by design: the desktop single-instance contract owns first-launch serialization.
  // limitation, while every restart still reconciles durable receipts before its first spawn.
  const key = JSON.stringify([request.target.distro, request.target.user])
  const current = profileReconciliations.get(key)
  if (current) return current
  const task = (request.reconcileGuest ?? reconcileWsl2ExecutionReceipts)({
    distro: request.target.distro,
    user: request.target.user,
    ...(request.signal ? { signal: request.signal } : {})
  })
    .then((complete) => {
      if (!complete) {
        throw new Error(
          'SHELL_CLEANUP_INCOMPLETE: Previous WSL2 shell execution receipts could not be reconciled.'
        )
      }
    })
    .catch((error) => {
      profileReconciliations.delete(key)
      throw error
    })
  profileReconciliations.set(key, task)
  return task
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

const cleanupComplete = (result: Wsl2ReleaseResult): boolean =>
  result.processesTerminated && result.networkClosed && result.temporaryResourcesRemoved

const containsPosixPath = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)

const containsWindowsPath = (parent: string, child: string): boolean => {
  const relative = win32.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative))
}

const mountParents = (path: string): string[] => {
  const parents: string[] = []
  let parent = posix.dirname(path)
  while (parent !== '/') {
    parents.push(parent)
    parent = posix.dirname(parent)
  }
  return parents.reverse()
}

const createLaunchPathMapper = (
  request: Wsl2LaunchRequest
): ((path: string) => Promise<string>) => {
  const mapPath = request.mapPath ?? defaultPathMapper(request.target)
  return async (path: string): Promise<string> => {
    try {
      const mapped = await mapPath(path, request.signal)
      request.signal?.throwIfAborted()
      if (!mapped.startsWith('/') || /[\0\r\n]/u.test(mapped)) throw new Error('invalid path')
      return mapped
    } catch {
      request.signal?.throwIfAborted()
      throw new Error('WSL2 sandbox path mapping failed.')
    }
  }
}

const mapFilesystemLayout = async (
  request: Wsl2LaunchRequest,
  map: (path: string) => Promise<string>
): Promise<MappedFilesystemLayout> => ({
  cwd: await map(request.cwd),
  readOnlyRoots: await Promise.all(unique(request.filesystem.readOnlyRoots).map(map)),
  readWriteRoots: await Promise.all(unique(request.filesystem.readWriteRoots).map(map)),
  deniedReadRoots: await Promise.all(unique(request.filesystem.deniedReadRoots).map(map)),
  deniedWriteRoots: await Promise.all(unique(request.filesystem.deniedWriteRoots).map(map)),
  ...(request.filesystem.privateRoot
    ? { privateRoot: await map(request.filesystem.privateRoot) }
    : {})
})

const createGuestEnvironment = async (
  request: Wsl2LaunchRequest,
  map: (path: string) => Promise<string>
): Promise<Record<string, string>> => {
  const environment: Record<string, string> = {
    HOME: '/tmp/open-science-home',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin'
  }
  for (const [key, value] of Object.entries(request.pathEnvironment ?? {})) {
    if (!value) continue
    if (Object.hasOwn(environment, key)) {
      throw new Error('WSL2 sandbox path environment key is reserved.')
    }
    if (
      !WINDOWS_PATH.test(value) ||
      !request.filesystem.readWriteRoots.some((root) => containsWindowsPath(root, value))
    ) {
      throw new Error('WSL2 sandbox path environment is not writable.')
    }
    environment[key] = await map(value)
  }
  return environment
}

const buildBubblewrapArguments = (
  filesystem: MappedFilesystemLayout,
  guestEnvironment: Readonly<Record<string, string>>,
  bridgeSocketPath: string,
  credentials: GatewayCredentials,
  command: string
): string[] => {
  const { cwd, readOnlyRoots, readWriteRoots, deniedReadRoots, deniedWriteRoots, privateRoot } =
    filesystem
  const exposedRoots = [...readOnlyRoots, ...readWriteRoots]
  const needsExplicitDeny = (path: string): boolean =>
    !privateRoot ||
    !containsPosixPath(privateRoot, path) ||
    exposedRoots.some((root) => containsPosixPath(root, path))
  const explicitDeniedReadRoots = deniedReadRoots.filter(needsExplicitDeny)
  const explicitDeniedWriteRoots = deniedWriteRoots.filter(needsExplicitDeny)

  const args = [
    '/usr/bin/bwrap',
    '--die-with-parent',
    '--new-session',
    // Includes the fresh network namespace that the guest bridge crosses explicitly.
    '--unshare-all',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/',
    '/',
    '--tmpfs',
    '/run',
    '--dir',
    '/run/open-science-notebook',
    '--bind',
    bridgeSocketPath,
    '/run/open-science-notebook/gateway.sock',
    '--tmpfs',
    '/home',
    '--tmpfs',
    '/mnt',
    '--tmpfs',
    '/media',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/tmp/open-science-home',
    '--dev',
    '/dev',
    '--proc',
    '/proc'
  ]

  const coveredBySensitiveRoot = (path: string): boolean =>
    ['/home', '/mnt', '/media'].some((root) => containsPosixPath(root, path))
  const sensitiveRoots = unique([
    '/home',
    '/mnt',
    '/media',
    ...(privateRoot && !coveredBySensitiveRoot(privateRoot) ? [privateRoot] : [])
  ])
  const mountDestinations = unique([
    ...readOnlyRoots,
    ...readWriteRoots,
    ...explicitDeniedReadRoots,
    ...explicitDeniedWriteRoots
  ])
  const visibleParents = unique(mountDestinations.flatMap(mountParents)).filter(
    (parent) => parent !== '/home' && parent !== '/mnt' && parent !== '/media'
  )
  for (const parent of visibleParents) args.push('--dir', parent)
  // Writable and hidden directories need concrete destinations. Read-only binds can point to files,
  // so bubblewrap creates those destinations from the source type when the bind is applied.
  for (const root of readWriteRoots) args.push('--dir', root)
  for (const root of explicitDeniedReadRoots) args.push('--dir', root)

  // Ancestor binds must precede descendant binds. Denies are applied afterward so a narrower grant
  // cannot reopen a subtree owned by a denied ancestor.
  const mountPriority = { readOnly: 0, readWrite: 1 } as const
  const allowedMounts = [
    ...readOnlyRoots.map((path) => ({ kind: 'readOnly' as const, path })),
    ...readWriteRoots.map((path) => ({ kind: 'readWrite' as const, path }))
  ].sort((left, right) => {
    const depth = left.path.split('/').length - right.path.split('/').length
    return depth || mountPriority[left.kind] - mountPriority[right.kind]
  })
  for (const mount of allowedMounts) {
    args.push(mount.kind === 'readOnly' ? '--ro-bind' : '--bind', mount.path, mount.path)
  }
  for (const root of explicitDeniedWriteRoots) args.push('--ro-bind', root, root)
  for (const root of explicitDeniedReadRoots) args.push('--tmpfs', root)
  // This remount is non-recursive: explicit writable child mounts remain writable while ungranted
  // siblings under the sensitive scaffolding become read-only.
  for (const root of sensitiveRoots) args.push('--remount-ro', root)
  args.push('--clearenv')
  for (const [key, value] of Object.entries(guestEnvironment)) {
    args.push('--setenv', key, value)
  }
  args.push(
    '--chdir',
    cwd,
    '--',
    '/usr/bin/python3',
    '-c',
    sandboxGatewayLauncher,
    '/run/open-science-notebook/gateway.sock',
    '3128',
    credentials.username,
    credentials.password,
    command
  )
  return args
}

const wsl2Launch = async (request: Wsl2LaunchRequest): Promise<Wsl2Launch> => {
  validateTarget(request.target)
  request.signal?.throwIfAborted()
  await reconcileProfile(request)
  request.signal?.throwIfAborted()
  const map = createLaunchPathMapper(request)
  const filesystem = await mapFilesystemLayout(request, map)
  const guestEnvironment = await createGuestEnvironment(request, map)
  const token = `open-science-execution-${randomUUID()}`
  const receipt = `/tmp/.open-science-execution-${token.slice('open-science-execution-'.length)}.receipt`
  guestEnvironment.OPEN_SCIENCE_WSL_EXECUTION_TOKEN = token

  if (!request.gatewayPort || !request.gatewayCredentials) {
    throw new Error('WSL2 network gateway is unavailable.')
  }
  let bridge: Wsl2GatewayBridge | undefined
  let spawnState: 'not-started' | 'uncertain' | 'started' = 'not-started'
  let releasePromise: Promise<Wsl2ReleaseResult> | undefined
  let releaseReason: Wsl2CleanupReason | undefined
  let processesTerminated = false
  let networkClosed = false
  let bridgeResourcesRemoved = false
  const release: Wsl2Launch['release'] = (reason = 'exit') => {
    releaseReason ??= reason
    if (releasePromise) return releasePromise
    const attempt = Promise.allSettled([
      processesTerminated || spawnState === 'not-started'
        ? Promise.resolve(true)
        : (request.cleanupGuest ?? defaultCleanupGuest)({
            distro: request.target.distro,
            user: request.target.user,
            receipt,
            token,
            reason: releaseReason
          }),
      networkClosed && bridgeResourcesRemoved
        ? Promise.resolve({ networkClosed: true, temporaryResourcesRemoved: true })
        : bridge!.close()
    ]).then(([processes, bridgeCleanup]) => {
      processesTerminated ||= processes.status === 'fulfilled' && processes.value
      networkClosed ||= bridgeCleanup.status === 'fulfilled' && bridgeCleanup.value.networkClosed
      bridgeResourcesRemoved ||=
        bridgeCleanup.status === 'fulfilled' && bridgeCleanup.value.temporaryResourcesRemoved
      const temporaryResourcesRemoved = bridgeResourcesRemoved && processesTerminated
      return { processesTerminated, networkClosed, temporaryResourcesRemoved }
    })
    releasePromise = attempt.then(
      (result) => {
        if (!cleanupComplete(result)) releasePromise = undefined
        return result
      },
      (error) => {
        releasePromise = undefined
        throw error
      }
    )
    return releasePromise
  }
  const ownBridge = (createdBridge: Wsl2GatewayBridge): void => {
    if (bridge) return
    bridge = createdBridge
    request.onCleanupReady?.(release)
  }
  const openedBridge = await (request.openBridge ?? openWsl2GatewayBridge)({
    target: request.target,
    gatewayPort: request.gatewayPort,
    ...(request.signal ? { signal: request.signal } : {}),
    onBridgeCreated: ownBridge
  })
  ownBridge(openedBridge)
  if (request.signal?.aborted) {
    const cleanup = await release('cancel')
    if (!cleanupComplete(cleanup)) {
      throw new Error(
        'SHELL_CLEANUP_INCOMPLETE: WSL2 bridge preparation cleanup could not be verified.'
      )
    }
    request.signal.throwIfAborted()
  }

  const bwrap = buildBubblewrapArguments(
    filesystem,
    guestEnvironment,
    openedBridge.socketPath,
    request.gatewayCredentials,
    request.command
  )

  return {
    argv: [
      wslExecutable(),
      '--distribution',
      request.target.distro,
      '--user',
      request.target.user,
      '--exec',
      '/bin/bash',
      '--noprofile',
      '--norc',
      '-c',
      executionWrapperScript,
      'open-science-wsl-execution',
      receipt,
      token,
      ...bwrap
    ],
    env: sanitizedHostEnvironment(),
    beginSpawn: () => {
      if (spawnState !== 'not-started') throw new Error('WSL2 spawn was already admitted.')
      spawnState = 'uncertain'
      return {
        started: () => {
          if (spawnState === 'uncertain') spawnState = 'started'
        },
        notStarted: () => {
          if (spawnState === 'uncertain') spawnState = 'not-started'
        }
      }
    },
    release
  }
}

export { openWsl2GatewayBridge, reconcileWsl2ExecutionReceipts, wsl2Launch }
export type {
  Wsl2GuestCleanup,
  Wsl2GuestCleanupRequest,
  Wsl2GuestReconciliation,
  Wsl2GatewayBridge,
  Wsl2GatewayBridgeOpener,
  Wsl2Launch,
  Wsl2LaunchRequest,
  Wsl2PathMapper,
  Wsl2ReleaseResult,
  Wsl2Target
}
