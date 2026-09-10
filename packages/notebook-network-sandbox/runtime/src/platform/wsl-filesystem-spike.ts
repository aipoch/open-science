import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

type WslGuestCommandResult = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
}>

type WslGuestCommandRequest = Readonly<{
  distro: string
  user: string
  args: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}>

type WslGuestCommandRunner = (request: WslGuestCommandRequest) => Promise<WslGuestCommandResult>

type WslFilesystemSpikeRequest = Readonly<{
  workspace: string
  distro: string
  user: string
}>

type WslFilesystemSpikeFixtureOperations = Readonly<{
  mkdir: typeof mkdir
  readFile: typeof readFile
  writeFile: typeof writeFile
  copyFile: typeof copyFile
  link: typeof link
  readdir: typeof readdir
  rename: typeof rename
  rm: typeof rm
  rmdir: typeof rmdir
  stat: typeof stat
  unlink: typeof unlink
  isProcessAlive: (pid: number) => boolean
  processStartIdentity: (pid: number) => string | undefined
}>

type WslFilesystemSpikeFixture = Readonly<{
  workspace: string
  readWriteRoot: string
  readOnlyRoot: string
  unauthorizedRoot: string
  cleanup: () => Promise<void>
}>

type WslFilesystemSpikeFixtureFactory = (workspace: string) => Promise<WslFilesystemSpikeFixture>

type WslFilesystemEvidence = Readonly<{
  architecture: 'x86_64'
  authorizedRead: true
  authorizedWrite: true
  readOnlyWriteBlocked: true
  unauthorizedReadBlocked: true
  sensitiveMountsHidden: true
  windowsInteropBlocked: true
  unicodeAndSpacesSupported: true
  caseBehavior: 'insensitive' | 'sensitive'
}>

type WslFilesystemCapabilityResult =
  | Readonly<{
      kind: 'ready'
      code: 'wsl_filesystem_sandbox_reusable'
      evidence: WslFilesystemEvidence
    }>
  | Readonly<{
      kind: 'unavailable'
      code:
        | 'wsl_path_unsupported'
        | 'wsl_platform_unavailable'
        | 'wsl_distro_unavailable'
        | 'wsl_arch_unsupported'
        | 'wsl_profile_invalid'
        | 'wsl_root_user_unsupported'
        | 'wsl_home_unsupported'
        | 'wsl_bwrap_missing'
        | 'wsl_namespace_unavailable'
        | 'wsl_workspace_unreachable'
        | 'wsl_sandbox_policy_failed'
        | 'wsl_cleanup_incomplete'
        | 'wsl_fixture_busy'
      phase:
        | 'profile'
        | 'host-path'
        | 'wsl-launch'
        | 'guest-prerequisite'
        | 'path-map'
        | 'sandbox'
        | 'cleanup'
    }>

const MARKER_PREFIX = 'OPEN_SCIENCE_WSL_'
const MAX_CAPTURE_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const GUEST_CLEANUP_TIMEOUT_MS = 5_000

const normalizeCapture = (value: string): string => value.replaceAll('\0', '')

const commandExitCode = (error: unknown): number => {
  if (!error || typeof error !== 'object' || !('code' in error)) return error ? 1 : 0
  return typeof error.code === 'number' ? error.code : 1
}

const markerValue = (output: string, marker: string): string | undefined => {
  const prefix = `${MARKER_PREFIX}${marker}:`
  return normalizeCapture(output)
    .split(/\r?\n/u)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
}

const markerFields = (value: string | undefined): ReadonlyMap<string, string> =>
  new Map(
    (value ?? '')
      .split(';')
      .map((field) => field.split('=', 2))
      .filter((field): field is [string, string] => field.length === 2)
  )

const decodeHexMarker = (value: string | undefined): string | undefined => {
  if (!value || !/^(?:[0-9a-f]{2})+$/iu.test(value)) return undefined
  const bytes = Buffer.from(value, 'hex')
  if (bytes.toString('hex') !== value.toLowerCase()) return undefined
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : undefined
  } catch {
    return undefined
  }
}

const wslGuestArguments = ({
  distro,
  user,
  args
}: Pick<WslGuestCommandRequest, 'distro' | 'user' | 'args'>): string[] => [
  '--distribution',
  distro,
  '--user',
  user,
  '--exec',
  ...args
]

const supervisedGuestScript = String.raw`
receipt=$1; token=$2; timeout_seconds=$3; shift 3
umask 077
setsid --wait env OPEN_SCIENCE_FILESYSTEM_TOKEN="$token" /bin/bash --noprofile --norc -c '
  receipt=$1; token=$2; timeout_seconds=$3; shift 3
  start=$(awk '\''{print $22}'\'' "/proc/$$/stat") || exit 70
  sid=$(ps -o sid= -p $$ | tr -d " "); pgid=$(ps -o pgid= -p $$ | tr -d " ")
  [ -n "$start" ] && [ -n "$sid" ] && [ "$pgid" = "$$" ] || exit 70
  terminating=0
  trap '\''terminating=1'\'' TERM
  trap '\''rm -f -- "$receipt" "$receipt.tmp"'\'' EXIT
  printf "%s %s %s %s %s\n" "$$" "$token" "$start" "$sid" "$pgid" > "$receipt.tmp" || exit 71
  mv -f -- "$receipt.tmp" "$receipt" || exit 71
  /usr/bin/timeout --foreground --signal=TERM --kill-after=1s "$timeout_seconds" "$@"; status=$?
  [ "$terminating" -eq 0 ] || sleep 5
  exit "$status"
' open-science-filesystem-supervisor "$receipt" "$token" "$timeout_seconds" "$@"
`

const exactGuestCleanupScript = String.raw`
receipt=$1; token=$2
i=0
while [ ! -r "$receipt" ] && [ "$i" -lt 40 ]; do i=$((i + 1)); sleep 0.05; done
if [ ! -r "$receipt" ]; then rm -f -- "$receipt.tmp"; exit 3; fi
IFS= read -r receipt_line < "$receipt" || exit 3
set -- $receipt_line
[ "$#" -ge 5 ] || exit 4
pid=$1; recorded_token=$2; expected_start=$3; expected_sid=$4; expected_pgid=$5; shift 5
[ "$recorded_token" = "$token" ] || exit 4
case "$pid:$expected_start:$expected_sid:$expected_pgid" in *[!0-9:]*) exit 4;; esac
[ "$expected_pgid" = "$pid" ] || exit 4
identities="$pid:$expected_start:$expected_sid:$expected_pgid"
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 4 ] || exit 4
  case "$1:$2:$3:$4" in *[!0-9:]*) exit 4;; esac
  identities="$identities $1:$2:$3:$4"
  shift 4
done
verify() {
  target_pid=$1; target_start=$2; target_sid=$3; target_pgid=$4
  retry=0
  while [ "$retry" -le 5 ]; do
    [ -r "/proc/$target_pid/stat" ] || return 1
    [ "$(awk '{print $3}' "/proc/$target_pid/stat" 2>/dev/null)" != Z ] || return 1
    [ "$(awk '{print $22}' "/proc/$target_pid/stat" 2>/dev/null)" = "$target_start" ] || return 1
    current_sid=$(ps -o sid= -p "$target_pid" 2>/dev/null | tr -d ' ')
    current_pgid=$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d ' ')
    if [ -n "$current_sid" ] && [ -n "$current_pgid" ]; then
      [ "$current_sid" = "$target_sid" ] && [ "$current_pgid" = "$target_pgid" ] || return 2
      tr '\0' '\n' < "/proc/$target_pid/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_FILESYSTEM_TOKEN=$token" && return 0
    fi
    retry=$((retry + 1))
    [ "$retry" -le 5 ] && sleep 0.02
  done
  return 2
}
known_pids=" $pid "
frozen_groups=' '
descendant_fields=
wait_stopped() {
  stopped_pid=$1; stopped_start=$2
  stopped_retry=0
  while [ "$stopped_retry" -lt 50 ]; do
    [ -r "/proc/$stopped_pid/stat" ] || return 1
    [ "$(awk '{print $22}' "/proc/$stopped_pid/stat" 2>/dev/null)" = "$stopped_start" ] || return 1
    stopped_state=$(awk '{print $3}' "/proc/$stopped_pid/stat" 2>/dev/null) || return 2
    [ "$stopped_state" = T ] || [ "$stopped_state" = t ] || {
      stopped_retry=$((stopped_retry + 1)); sleep 0.01; continue
    }
    return 0
  done
  return 2
}
freeze_identity() {
  freeze_pid=$1; freeze_start=$2; freeze_sid=$3; freeze_pgid=$4
  verify "$freeze_pid" "$freeze_start" "$freeze_sid" "$freeze_pgid"; verified=$?
  [ "$verified" -eq 1 ] && return 0
  [ "$verified" -eq 0 ] || return 6
  if [ "$freeze_pgid" = "$freeze_pid" ]; then
    case "$frozen_groups" in
      *" $freeze_pgid "*) ;;
      *) kill -STOP -- "-$freeze_pgid" 2>/dev/null || return 7; frozen_groups="$frozen_groups$freeze_pgid ";;
    esac
  else
    case "$frozen_groups" in
      *" $freeze_pgid "*) ;;
      *) kill -STOP -- "$freeze_pid" 2>/dev/null || return 7;;
    esac
  fi
  wait_stopped "$freeze_pid" "$freeze_start"; stopped=$?
  [ "$stopped" -eq 1 ] && return 0
  [ "$stopped" -eq 0 ] || return 6
}
capture_descendants() {
  parent=$1
  [ -r "/proc/$parent/task/$parent/children" ] || return 6
  children=$(cat "/proc/$parent/task/$parent/children" 2>/dev/null) || return 6
  for child in $children; do
    case "$known_pids" in *" $child "*) continue;; esac
    [ -r "/proc/$child/stat" ] || continue
    child_start=$(awk '{print $22}' "/proc/$child/stat" 2>/dev/null) || continue
    child_sid=$(ps -o sid= -p "$child" 2>/dev/null | tr -d ' ')
    child_pgid=$(ps -o pgid= -p "$child" 2>/dev/null | tr -d ' ')
    [ -n "$child_start" ] && [ -n "$child_sid" ] && [ -n "$child_pgid" ] || continue
    tr '\0' '\n' < "/proc/$child/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_FILESYSTEM_TOKEN=$token" || return 6
    known_pids="$known_pids$child "
    identities="$identities $child:$child_start:$child_sid:$child_pgid"
    descendant_fields="$descendant_fields $child $child_start $child_sid $child_pgid"
    freeze_identity "$child" "$child_start" "$child_sid" "$child_pgid" || return $?
    capture_descendants "$child" || return $?
  done
}
capture_failed=0
freeze_identity "$pid" "$expected_start" "$expected_sid" "$expected_pgid" || capture_failed=$?
[ "$capture_failed" -ne 0 ] || capture_descendants "$pid" || capture_failed=$?
receipt_update_failed=0
printf '%s %s %s %s %s%s\n' "$pid" "$token" "$expected_start" "$expected_sid" "$expected_pgid" "$descendant_fields" > "$receipt.tmp" &&
  mv -f -- "$receipt.tmp" "$receipt" || receipt_update_failed=1
signal_phase() {
  signal=$1; signaled_groups=' '
  for identity in $identities; do
    IFS=: read -r member_pid member_start member_sid member_pgid <<EOF
$identity
EOF
    case "$signaled_groups" in *" $member_pgid "*) continue;; esac
    if [ "$member_pgid" = "$member_pid" ]; then
      group_alive=false
      for candidate in $identities; do
        IFS=: read -r candidate_pid candidate_start candidate_sid candidate_pgid <<EOF
$candidate
EOF
        [ "$candidate_pgid" = "$member_pgid" ] || continue
        verify "$candidate_pid" "$candidate_start" "$candidate_sid" "$candidate_pgid"; verified=$?
        [ "$verified" -eq 0 ] && group_alive=true
        [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || return 6
      done
      signaled_groups="$signaled_groups$member_pgid "
      $group_alive || continue
      kill "-$signal" -- "-$member_pgid" 2>/dev/null || return 7
    else
      verify "$member_pid" "$member_start" "$member_sid" "$member_pgid"; verified=$?
      [ "$verified" -eq 1 ] && continue
      [ "$verified" -eq 0 ] || return 6
      kill "-$signal" -- "$member_pid" 2>/dev/null || return 7
    fi
  done
}
signal_phase TERM || exit $?
signal_phase CONT || exit $?
sleep 0.25
signal_phase KILL || exit $?
i=0
while [ "$i" -lt 30 ]; do
  alive=false
  for identity in $identities; do
    IFS=: read -r member_pid member_start member_sid member_pgid <<EOF
$identity
EOF
    verify "$member_pid" "$member_start" "$member_sid" "$member_pgid"; verified=$?
    [ "$verified" -eq 0 ] && alive=true
    [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || exit 6
  done
  $alive || break
  i=$((i + 1)); sleep 0.1
done
[ "$capture_failed" -eq 0 ] || exit "$capture_failed"
$alive && exit 5
rm -f -- "$receipt" "$receipt.tmp"
[ "$receipt_update_failed" -eq 0 ] || exit 8
`

const cleanupTimedOutGuest = (
  distro: string,
  user: string,
  receipt: string,
  token: string
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      wslGuestArguments({
        distro,
        user,
        args: [
          '/bin/bash',
          '--noprofile',
          '--norc',
          '-c',
          exactGuestCleanupScript,
          'open-science-filesystem-cleanup',
          receipt,
          token
        ]
      }),
      {
        encoding: 'buffer',
        maxBuffer: MAX_CAPTURE_BYTES,
        timeout: GUEST_CLEANUP_TIMEOUT_MS,
        windowsHide: true
      },
      (error) => {
        if (error) {
          reject(new Error('WSL filesystem guest cleanup failed'))
        } else resolve()
      }
    )
  })

const defaultRunGuest: WslGuestCommandRunner = ({ distro, user, args, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    const token = `open-science-filesystem-${randomUUID()}`
    const receipt = `/tmp/.open-science-filesystem-${token}.receipt`
    const wslArgs = wslGuestArguments({
      distro,
      user,
      args: [
        '/bin/bash',
        '--noprofile',
        '--norc',
        '-c',
        supervisedGuestScript,
        'open-science-filesystem-host',
        receipt,
        token,
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        ...args
      ]
    })
    execFile(
      'wsl.exe',
      wslArgs,
      {
        encoding: 'buffer',
        maxBuffer: MAX_CAPTURE_BYTES,
        signal,
        timeout: timeoutMs,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (
          error &&
          (('killed' in error && error.killed) ||
            ('code' in error && error.code === 'ABORT_ERR') ||
            ('code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') ||
            error.name === 'AbortError')
        ) {
          void cleanupTimedOutGuest(distro, user, receipt, token).then(
            () => reject(error),
            (cleanupError: unknown) => reject(cleanupError)
          )
          return
        }
        if (error && (!('code' in error) || typeof error.code === 'string')) {
          reject(error)
          return
        }
        resolve({
          exitCode: commandExitCode(error),
          stdout: Buffer.from(stdout).toString('utf8'),
          stderr: Buffer.from(stderr).toString('utf8')
        })
      }
    )
  })

const preflightScript = String.raw`
arch=$(uname -m 2>/dev/null || printf unknown)
uid=$(id -u 2>/dev/null || printf unknown)
if [ "$uid" != 0 ] && [ "$uid" != unknown ]; then nonroot=1; else nonroot=0; fi
home_path=$(getent passwd "$uid" 2>/dev/null | cut -d: -f6)
[ -n "$home_path" ] || home_path=\${HOME:-/}
home_hex=$(printf '%s' "$home_path" | od -An -tx1 | tr -d ' \n')
if command -v bwrap >/dev/null 2>&1; then bwrap=1; else bwrap=0; fi
if command -v unshare >/dev/null 2>&1; then unshare_tool=1; else unshare_tool=0; fi
if [ "$unshare_tool" = 1 ] && unshare --user --map-root-user true >/dev/null 2>&1; then namespace=1; else namespace=0; fi
printf 'OPEN_SCIENCE_WSL_PROBE:arch=%s;uid=%s;nonroot=%s;bwrap=%s;unshare=%s;namespace=%s\n' "$arch" "$uid" "$nonroot" "$bwrap" "$unshare_tool" "$namespace"
printf 'OPEN_SCIENCE_WSL_HOME_HEX:%s\n' "$home_hex"
`

const pathScript = String.raw`
path=$(wslpath -a -u "$1" 2>/dev/null) || exit 72
[ -d "$path" ] || exit 73
printf 'OPEN_SCIENCE_WSL_PATH:%s\n' "$path"
`

const sandboxScript = String.raw`
workspace=$1
read_write=$2
read_only=$3
unauthorized=$4
case_probe=$5
guest_home=$6

bwrap \
  --die-with-parent \
  --new-session \
  --unshare-all \
  --cap-drop ALL \
  --ro-bind / / \
  --tmpfs /run \
  --tmpfs /home \
  --tmpfs /mnt \
  --tmpfs /media \
  --tmpfs "$guest_home" \
  --ro-bind "$workspace" "$workspace" \
  --ro-bind "$read_only" "$read_only" \
  --remount-ro /home \
  --remount-ro /mnt \
  --remount-ro /media \
  --remount-ro "$guest_home" \
  --bind "$read_write" "$read_write" \
  --tmpfs /tmp \
  --dev /dev \
  --proc /proc \
  --clearenv \
  --setenv PATH /usr/bin:/bin \
  --chdir "$read_write" \
  -- /bin/sh -eu -c '
    rw_read=0; rw_write=0; ro_read=0; ro_write_blocked=0
    unauthorized_hidden=0; home_hidden=0; mount_hidden=0; media_hidden=0; interop_blocked=0
    [ "$(cat input.txt)" = allowed ] && rw_read=1
    printf written > output.txt && rw_write=1
    [ "$(cat "$1/input.txt")" = readonly ] && ro_read=1
    if ! (printf denied > "$1/output.txt") 2>/dev/null; then ro_write_blocked=1; fi
    [ ! -e "$2/secret.txt" ] && unauthorized_hidden=1
    if [ -z "$(find "$4" -mindepth 1 -print -quit 2>/dev/null)" ]; then home_hidden=1; fi
    [ ! -e /mnt/c/Windows/System32/cmd.exe ] && mount_hidden=1
    if [ -z "$(find /media -mindepth 1 -print -quit 2>/dev/null)" ]; then media_hidden=1; fi
    interop_socket=$(find /run/WSL -name "*_interop" -print -quit 2>/dev/null || true)
    if [ -z "$interop_socket" ] && ! "$1/interop-probe.exe" /c exit 0 >/dev/null 2>&1; then interop_blocked=1; fi
    if [ -e "$3" ]; then case_behavior=insensitive; else case_behavior=sensitive; fi
    printf "OPEN_SCIENCE_WSL_RESULT:rw_read=%s;rw_write=%s;ro_read=%s;ro_write_blocked=%s;unauthorized_hidden=%s;home_hidden=%s;mount_hidden=%s;media_hidden=%s;interop_blocked=%s;unicode_space=1;case=%s\\n" \
      "$rw_read" "$rw_write" "$ro_read" "$ro_write_blocked" "$unauthorized_hidden" \
      "$home_hidden" "$mount_hidden" "$media_hidden" "$interop_blocked" "$case_behavior"
  ' sandbox-command "$read_only" "$unauthorized" "$case_probe" "$guest_home"
`

class WslFixtureCleanupError extends Error {}
class WslFixtureBusyError extends Error {}

const defaultFixtureOperations: WslFilesystemSpikeFixtureOperations = {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  link,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return Boolean(
        error && typeof error === 'object' && 'code' in error && error.code === 'EPERM'
      )
    }
  },
  processStartIdentity: (pid) => (pid === process.pid ? CURRENT_PROCESS_START_IDENTITY : undefined)
}

type WslFixtureJournal = Readonly<{
  schema: 1
  ownerId: string
  pid: number
  processStartIdentity: string
  heartbeatAtMs: number
  fixtureRoot: string
  secretRoot: string
  cleanupRoots: Readonly<{
    fixture: WslFixtureCleanupRoot
    secret: WslFixtureCleanupRoot
  }>
}>

type WslFixtureCleanupRoot = Readonly<{
  root: string
  stagingPath: string
  quarantinePath: string
  state: 'absent' | 'staging' | 'canonical' | 'quarantined' | 'removed'
  identity?: WslDirectoryIdentity
}>

type WslDirectoryIdentity = Readonly<{
  dev: number
  ino: number
  birthtimeMs: number
}>

type WslFixtureRootMarker = Readonly<{
  schema: 1
  ownerId: string
  root: string
}>

const ROOT_MARKER_NAME = '.open-science-owner.json'
const FIXTURE_LEASE_HEARTBEAT_MAX_AGE_MS = 120_000
const CURRENT_PROCESS_START_IDENTITY = String(Math.floor(Date.now() - process.uptime() * 1000))

const ownerStagingRoot = (root: string, ownerId: string): string => `${root}.staging-${ownerId}`

const initialCleanupRoots = (
  paths: ReturnType<typeof durableFixturePaths>,
  ownerId: string
): WslFixtureJournal['cleanupRoots'] => ({
  fixture: {
    root: paths.fixtureRoot,
    stagingPath: ownerStagingRoot(paths.fixtureRoot, ownerId),
    quarantinePath: `${paths.fixtureRoot}.quarantine-${ownerId}`,
    state: 'absent'
  },
  secret: {
    root: paths.secretRoot,
    stagingPath: ownerStagingRoot(paths.secretRoot, ownerId),
    quarantinePath: `${paths.secretRoot}.quarantine-${ownerId}`,
    state: 'absent'
  }
})

const rootMarkerMatches = async (
  markerRoot: string,
  expectedRoot: string,
  ownerId: string,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<boolean> => {
  try {
    const marker = JSON.parse(
      await operations.readFile(join(markerRoot, ROOT_MARKER_NAME), 'utf8')
    ) as Partial<WslFixtureRootMarker>
    return marker.schema === 1 && marker.ownerId === ownerId && marker.root === expectedRoot
  } catch {
    return false
  }
}

const durableFixturePaths = (
  workspace: string
): Readonly<{
  fixtureRoot: string
  secretRoot: string
  journalPath: string
}> => {
  const workspaceIdentity = createHash('sha256')
    .update(win32.resolve(workspace))
    .digest('hex')
    .slice(0, 24)
  return {
    fixtureRoot: join(workspace, '.open-science-wsl-spike-fixture'),
    secretRoot: join(tmpdir(), `.open-science-wsl-spike-secret-${workspaceIdentity}`),
    journalPath: join(workspace, '.open-science-wsl-spike-owner.json')
  }
}

const isMissingPathError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')

const pathExists = async (
  path: string,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<boolean> => {
  try {
    await operations.stat(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

const directoryIdentity = async (
  path: string,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<WslDirectoryIdentity> => {
  const value = await operations.stat(path)
  return { dev: value.dev, ino: value.ino, birthtimeMs: value.birthtimeMs }
}

const directoryIdentityMatches = async (
  path: string,
  expected: WslDirectoryIdentity,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<boolean> => {
  try {
    const current = await directoryIdentity(path, operations)
    return (
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.birthtimeMs === expected.birthtimeMs
    )
  } catch {
    return false
  }
}

const retryTransientFilesystemOperation = async (operation: () => Promise<void>): Promise<void> => {
  const retryDelaysMs = [5, 10, 20, 40, 80, 160] as const
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation()
      return
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      if (
        !code ||
        !['EACCES', 'EBUSY', 'EPERM'].includes(code) ||
        attempt >= retryDelaysMs.length
      ) {
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
    }
  }
}

const removeIdentityBoundTree = async (
  root: string,
  expected: WslDirectoryIdentity,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<void> => {
  if (!(await directoryIdentityMatches(root, expected, operations))) {
    throw new Error('fixture directory identity mismatch')
  }
  for (const entry of await operations.readdir(root)) {
    if (!(await directoryIdentityMatches(root, expected, operations))) {
      throw new Error('fixture directory identity changed')
    }
    await operations.rm(join(root, entry), { recursive: true, force: true })
    if (!(await directoryIdentityMatches(root, expected, operations))) {
      throw new Error('fixture directory identity changed')
    }
  }
  if (!(await directoryIdentityMatches(root, expected, operations))) {
    throw new Error('fixture directory identity changed')
  }
  await operations.rmdir(root)
}

const persistFixtureJournal = async (
  paths: ReturnType<typeof durableFixturePaths>,
  journal: WslFixtureJournal,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<void> => {
  const pendingPath = `${paths.journalPath}.pending`
  const claimPath = `${pendingPath}.claim-${journal.ownerId}`
  try {
    let pending: string | undefined
    try {
      pending = await operations.readFile(pendingPath, 'utf8')
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }
    if (pending !== undefined) {
      await retryTransientFilesystemOperation(() =>
        operations.writeFile(paths.journalPath, pending, {
          encoding: 'utf8',
          flag: 'w',
          flush: true
        })
      )
      await retryTransientFilesystemOperation(() => operations.unlink(pendingPath))
    }

    const serialized = JSON.stringify(journal)
    await operations.writeFile(claimPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true
    })
    await operations.link(claimPath, pendingPath)
    await retryTransientFilesystemOperation(() =>
      operations.writeFile(paths.journalPath, serialized, {
        encoding: 'utf8',
        flag: 'w',
        flush: true
      })
    )
    await retryTransientFilesystemOperation(() => operations.unlink(pendingPath))
  } finally {
    await operations.rm(claimPath, { force: true })
  }
}

const publishInitialFixtureJournal = async (
  paths: ReturnType<typeof durableFixturePaths>,
  journal: WslFixtureJournal,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<void> => {
  const claimPath = `${paths.journalPath}.claim-${journal.ownerId}`
  try {
    await operations.writeFile(claimPath, JSON.stringify(journal), {
      encoding: 'utf8',
      flag: 'wx',
      flush: true
    })
    await operations.link(claimPath, paths.journalPath)
  } finally {
    await operations.rm(claimPath, { force: true })
  }
}

const removeOwnedFixture = async (
  paths: ReturnType<typeof durableFixturePaths>,
  journal: WslFixtureJournal,
  operations: WslFilesystemSpikeFixtureOperations,
  includeJournal: boolean
): Promise<void> => {
  try {
    const persisted = await readJournal(paths, operations)
    if (!persisted || persisted.ownerId !== journal.ownerId)
      throw new Error('fixture owner changed')
    let currentJournal = persisted
    const rootNames = ['secret', 'fixture'] as const
    const updateRootState = async (
      name: (typeof rootNames)[number],
      patch: Partial<Pick<WslFixtureCleanupRoot, 'state' | 'identity'>>
    ): Promise<void> => {
      currentJournal = {
        ...currentJournal,
        heartbeatAtMs: Date.now(),
        cleanupRoots: {
          ...currentJournal.cleanupRoots,
          [name]: { ...currentJournal.cleanupRoots[name], ...patch }
        }
      }
      await persistFixtureJournal(paths, currentJournal, operations)
    }
    for (const name of rootNames) {
      let cleanupRoot = currentJournal.cleanupRoots[name]
      const { root, stagingPath, quarantinePath: quarantine } = cleanupRoot
      if (cleanupRoot.state === 'removed') continue
      if (cleanupRoot.state === 'absent') {
        const ownedPathExists = await Promise.all(
          [stagingPath, root, quarantine].map((path) => pathExists(path, operations))
        )
        if (ownedPathExists.some(Boolean)) throw new Error('unowned fixture path exists')
        await updateRootState(name, { state: 'removed', identity: undefined })
        continue
      }
      if (!cleanupRoot.identity) throw new Error('missing fixture directory identity')
      if (cleanupRoot.state === 'staging') {
        const stagingExists = await pathExists(stagingPath, operations)
        if (stagingExists) {
          await removeIdentityBoundTree(stagingPath, cleanupRoot.identity, operations)
          await updateRootState(name, { state: 'removed', identity: undefined })
          continue
        }
        if (!(await directoryIdentityMatches(root, cleanupRoot.identity, operations))) {
          throw new Error('published fixture identity mismatch')
        }
        await updateRootState(name, { state: 'canonical', identity: cleanupRoot.identity })
        cleanupRoot = currentJournal.cleanupRoots[name]
      }
      const expectedIdentity = cleanupRoot.identity
      if (!expectedIdentity) throw new Error('missing fixture directory identity')
      let quarantineExists = await pathExists(quarantine, operations)
      if (cleanupRoot.state === 'quarantined') {
        if (quarantineExists) {
          await removeIdentityBoundTree(quarantine, expectedIdentity, operations)
        }
        await updateRootState(name, { state: 'removed', identity: undefined })
        continue
      }
      if (!quarantineExists) {
        const rootExists = await pathExists(root, operations)
        if (!rootExists) {
          await updateRootState(name, { state: 'removed', identity: undefined })
          continue
        }
        if (!(await directoryIdentityMatches(root, expectedIdentity, operations))) {
          throw new Error('canonical fixture identity mismatch')
        }
        if (!(await rootMarkerMatches(root, root, journal.ownerId, operations))) {
          throw new Error('canonical fixture ownership mismatch')
        }
        try {
          await operations.rename(root, quarantine)
          quarantineExists = true
        } catch (error) {
          if (!isMissingPathError(error)) throw error
        }
      }
      if (!quarantineExists) {
        await updateRootState(name, { state: 'removed', identity: undefined })
        continue
      }
      if (!(await directoryIdentityMatches(quarantine, expectedIdentity, operations))) {
        throw new Error('quarantine fixture identity mismatch')
      }
      if (!(await rootMarkerMatches(quarantine, root, journal.ownerId, operations))) {
        try {
          await operations.rename(quarantine, root)
        } catch {
          // Keep both paths plus the journal when a concurrent replacement occupies canonical.
        }
        throw new Error('fixture root ownership mismatch')
      }
      if (!(await rootMarkerMatches(quarantine, root, journal.ownerId, operations))) {
        throw new Error('fixture root ownership changed')
      }
      await updateRootState(name, { state: 'quarantined', identity: expectedIdentity })
      await removeIdentityBoundTree(quarantine, expectedIdentity, operations)
      await updateRootState(name, { state: 'removed', identity: undefined })
    }
    if (includeJournal) {
      await operations.unlink(paths.journalPath)
      await operations.rm(`${paths.journalPath}.pending`, { force: true })
    }
  } catch {
    throw new WslFixtureCleanupError()
  }
}

const publishOwnedRoot = async (
  name: keyof WslFixtureJournal['cleanupRoots'],
  paths: ReturnType<typeof durableFixturePaths>,
  journal: WslFixtureJournal,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<WslFixtureJournal> => {
  const rootRecord = journal.cleanupRoots[name]
  const { root, stagingPath: stagingRoot } = rootRecord
  await operations.mkdir(stagingRoot)
  const stagingIdentity = await directoryIdentity(stagingRoot, operations)
  let currentJournal: WslFixtureJournal = {
    ...journal,
    heartbeatAtMs: Date.now(),
    cleanupRoots: {
      ...journal.cleanupRoots,
      [name]: { ...rootRecord, state: 'staging', identity: stagingIdentity }
    }
  }
  await persistFixtureJournal(paths, currentJournal, operations)
  await operations.writeFile(
    join(stagingRoot, ROOT_MARKER_NAME),
    JSON.stringify({ schema: 1, ownerId: journal.ownerId, root }),
    { encoding: 'utf8', flag: 'wx', flush: true }
  )
  await operations.rename(stagingRoot, root)
  const canonicalIdentity = await directoryIdentity(root, operations)
  if (
    canonicalIdentity.dev !== stagingIdentity.dev ||
    canonicalIdentity.ino !== stagingIdentity.ino ||
    canonicalIdentity.birthtimeMs !== stagingIdentity.birthtimeMs
  ) {
    throw new WslFixtureCleanupError()
  }
  currentJournal = {
    ...currentJournal,
    heartbeatAtMs: Date.now(),
    cleanupRoots: {
      ...currentJournal.cleanupRoots,
      [name]: {
        ...currentJournal.cleanupRoots[name],
        state: 'canonical',
        identity: canonicalIdentity
      }
    }
  }
  await persistFixtureJournal(paths, currentJournal, operations)
  return currentJournal
}

const readJournal = async (
  paths: ReturnType<typeof durableFixturePaths>,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<WslFixtureJournal | undefined> => {
  let raw: string
  try {
    try {
      raw = await operations.readFile(`${paths.journalPath}.pending`, 'utf8')
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      raw = await operations.readFile(paths.journalPath, 'utf8')
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw new WslFixtureCleanupError()
  }
  try {
    const value = JSON.parse(raw) as Partial<WslFixtureJournal>
    if (
      value.schema !== 1 ||
      typeof value.ownerId !== 'string' ||
      !/^[0-9a-f-]{36}$/iu.test(value.ownerId) ||
      !Number.isSafeInteger(value.pid) ||
      value.fixtureRoot !== paths.fixtureRoot ||
      value.secretRoot !== paths.secretRoot
    ) {
      throw new Error('invalid fixture journal')
    }
    const processStartIdentity =
      typeof value.processStartIdentity === 'string'
        ? value.processStartIdentity
        : `legacy-${value.ownerId}`
    const heartbeatAtMs =
      typeof value.heartbeatAtMs === 'number' && Number.isFinite(value.heartbeatAtMs)
        ? value.heartbeatAtMs
        : 0
    const expectedRoots = initialCleanupRoots(paths, value.ownerId)
    const cleanupRoots = value.cleanupRoots ?? expectedRoots
    for (const name of ['fixture', 'secret'] as const) {
      const root = cleanupRoots[name]
      const expected = expectedRoots[name]
      if (
        !root ||
        root.root !== expected.root ||
        root.stagingPath !== expected.stagingPath ||
        root.quarantinePath !== expected.quarantinePath ||
        !['absent', 'staging', 'canonical', 'quarantined', 'removed'].includes(root.state) ||
        (root.state !== 'absent' && root.state !== 'removed' && !root.identity)
      ) {
        throw new Error('invalid fixture cleanup transition')
      }
    }
    return {
      ...(value as WslFixtureJournal),
      processStartIdentity,
      heartbeatAtMs,
      cleanupRoots
    }
  } catch {
    throw new WslFixtureCleanupError()
  }
}

const reconcileDurableFixture = async (
  paths: ReturnType<typeof durableFixturePaths>,
  operations: WslFilesystemSpikeFixtureOperations
): Promise<void> => {
  const journal = await readJournal(paths, operations)
  if (!journal) return
  const heartbeatAgeMs = Date.now() - journal.heartbeatAtMs
  const observedProcessStart = operations.processStartIdentity(journal.pid)
  if (
    operations.isProcessAlive(journal.pid) &&
    heartbeatAgeMs >= 0 &&
    heartbeatAgeMs <= FIXTURE_LEASE_HEARTBEAT_MAX_AGE_MS &&
    (observedProcessStart === undefined || observedProcessStart === journal.processStartIdentity)
  ) {
    throw new WslFixtureBusyError()
  }
  await removeOwnedFixture(paths, journal, operations, true)
}

const createWslFilesystemSpikeFixture = async (
  workspace: string,
  operations: WslFilesystemSpikeFixtureOperations = defaultFixtureOperations
): Promise<WslFilesystemSpikeFixture> => {
  const paths = durableFixturePaths(workspace)
  await reconcileDurableFixture(paths, operations)
  const ownerId = randomUUID()
  let journal: WslFixtureJournal = {
    schema: 1,
    ownerId,
    pid: process.pid,
    processStartIdentity: operations.processStartIdentity(process.pid) ?? `unknown-${ownerId}`,
    heartbeatAtMs: Date.now(),
    fixtureRoot: paths.fixtureRoot,
    secretRoot: paths.secretRoot,
    cleanupRoots: initialCleanupRoots(paths, ownerId)
  }
  try {
    await publishInitialFixtureJournal(paths, journal, operations)
  } catch {
    throw new WslFixtureBusyError()
  }
  try {
    journal = await publishOwnedRoot('fixture', paths, journal, operations)
    journal = await publishOwnedRoot('secret', paths, journal, operations)
    const readWriteRoot = join(paths.fixtureRoot, 'Allowed RW 路径')
    const readOnlyRoot = join(paths.fixtureRoot, 'Allowed RO CaseProbe')
    await operations.mkdir(readWriteRoot)
    await operations.mkdir(readOnlyRoot)
    await operations.writeFile(join(readWriteRoot, 'input.txt'), 'allowed', 'utf8')
    await operations.writeFile(join(readOnlyRoot, 'input.txt'), 'readonly', 'utf8')
    await operations.writeFile(join(paths.secretRoot, 'secret.txt'), 'secret', 'utf8')
    await operations.copyFile(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      join(readOnlyRoot, 'interop-probe.exe')
    )
    let cleaned = false
    return {
      workspace,
      readWriteRoot,
      readOnlyRoot,
      unauthorizedRoot: paths.secretRoot,
      cleanup: async () => {
        if (cleaned) return
        await removeOwnedFixture(paths, journal, operations, true)
        cleaned = true
      }
    }
  } catch (error) {
    try {
      await removeOwnedFixture(paths, journal, operations, true)
    } catch {
      throw new WslFixtureCleanupError()
    }
    throw error
  }
}

const createFixture: WslFilesystemSpikeFixtureFactory = createWslFilesystemSpikeFixture

const run = async (
  runGuest: WslGuestCommandRunner,
  request: WslFilesystemSpikeRequest,
  args: readonly string[]
): Promise<WslGuestCommandResult> =>
  runGuest({
    distro: request.distro,
    user: request.user,
    args,
    timeoutMs: DEFAULT_TIMEOUT_MS
  })

const unavailable = (
  code: Extract<WslFilesystemCapabilityResult, { kind: 'unavailable' }>['code'],
  phase: Extract<WslFilesystemCapabilityResult, { kind: 'unavailable' }>['phase']
): WslFilesystemCapabilityResult => ({ kind: 'unavailable', code, phase })

type GuestFixturePaths = readonly [string, string, string, string]

const mapFixturePaths = async (
  runGuest: WslGuestCommandRunner,
  request: WslFilesystemSpikeRequest,
  fixture: WslFilesystemSpikeFixture
): Promise<GuestFixturePaths | undefined> => {
  const hostPaths = [
    fixture.workspace,
    fixture.readWriteRoot,
    fixture.readOnlyRoot,
    fixture.unauthorizedRoot
  ] as const
  const guestPaths: string[] = []
  for (const hostPath of hostPaths) {
    const mapped = await run(runGuest, request, [
      '/bin/sh',
      '-c',
      pathScript,
      'path-map',
      win32.resolve(hostPath)
    ])
    const guestPath = mapped.exitCode === 0 ? markerValue(mapped.stdout, 'PATH') : undefined
    if (!guestPath?.startsWith('/')) return undefined
    guestPaths.push(guestPath)
  }
  return [guestPaths[0]!, guestPaths[1]!, guestPaths[2]!, guestPaths[3]!]
}

const probeFilesystemFixture = async (
  runGuest: WslGuestCommandRunner,
  request: WslFilesystemSpikeRequest,
  fixture: WslFilesystemSpikeFixture,
  guestHome: string
): Promise<WslFilesystemCapabilityResult> => {
  const guestPaths = await mapFixturePaths(runGuest, request, fixture)
  if (!guestPaths) return unavailable('wsl_workspace_unreachable', 'path-map')

  const [guestWorkspace, guestReadWrite, guestReadOnly, guestUnauthorized] = guestPaths
  const caseProbe = join(guestReadOnly, 'input.txt')
    .toLocaleLowerCase('en-US')
    .replaceAll('\\', '/')
  let sandbox: WslGuestCommandResult
  try {
    sandbox = await run(runGuest, request, [
      '/bin/sh',
      '-c',
      sandboxScript,
      'sandbox',
      guestWorkspace,
      guestReadWrite,
      guestReadOnly,
      guestUnauthorized,
      caseProbe,
      guestHome
    ])
  } catch {
    return unavailable('wsl_sandbox_policy_failed', 'sandbox')
  }
  const evidence = markerFields(markerValue(sandbox.stdout, 'RESULT'))
  const required = [
    'rw_read',
    'rw_write',
    'ro_read',
    'ro_write_blocked',
    'unauthorized_hidden',
    'home_hidden',
    'mount_hidden',
    'media_hidden',
    'interop_blocked',
    'unicode_space'
  ]
  const caseBehavior = evidence.get('case')
  if (
    sandbox.exitCode !== 0 ||
    required.some((key) => evidence.get(key) !== '1') ||
    (caseBehavior !== 'insensitive' && caseBehavior !== 'sensitive')
  ) {
    return unavailable('wsl_sandbox_policy_failed', 'sandbox')
  }

  return {
    kind: 'ready',
    code: 'wsl_filesystem_sandbox_reusable',
    evidence: {
      architecture: 'x86_64',
      authorizedRead: true,
      authorizedWrite: true,
      readOnlyWriteBlocked: true,
      unauthorizedReadBlocked: true,
      sensitiveMountsHidden: true,
      windowsInteropBlocked: true,
      unicodeAndSpacesSupported: true,
      caseBehavior
    }
  }
}

const fixtureProbeFailure = (error: unknown): WslFilesystemCapabilityResult => {
  if (error instanceof WslFixtureCleanupError) {
    return unavailable('wsl_cleanup_incomplete', 'cleanup')
  }
  if (error instanceof WslFixtureBusyError) return unavailable('wsl_fixture_busy', 'cleanup')
  return unavailable('wsl_workspace_unreachable', 'path-map')
}

const probeWslFilesystemSandboxReuse = async (
  request: WslFilesystemSpikeRequest,
  dependencies: Readonly<{
    runGuest?: WslGuestCommandRunner
    createFixture?: WslFilesystemSpikeFixtureFactory
  }> = {}
): Promise<WslFilesystemCapabilityResult> => {
  if (
    request.distro.trim().length === 0 ||
    request.user.trim().length === 0 ||
    request.distro.includes('\0') ||
    request.user.includes('\0')
  ) {
    return unavailable('wsl_profile_invalid', 'profile')
  }
  if (!/^[a-z]:[\\/]/iu.test(request.workspace) || request.workspace.startsWith('\\\\')) {
    return unavailable('wsl_path_unsupported', 'host-path')
  }

  const runGuest = dependencies.runGuest ?? defaultRunGuest
  let preflight: WslGuestCommandResult
  try {
    preflight = await run(runGuest, request, ['/bin/sh', '-c', preflightScript])
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    return unavailable(
      code === 'ENOENT' ? 'wsl_platform_unavailable' : 'wsl_distro_unavailable',
      'wsl-launch'
    )
  }
  if (preflight.exitCode !== 0) return unavailable('wsl_distro_unavailable', 'wsl-launch')

  const prerequisites = markerFields(markerValue(preflight.stdout, 'PROBE'))
  if (prerequisites.get('arch') !== 'x86_64') {
    return unavailable('wsl_arch_unsupported', 'guest-prerequisite')
  }
  if (prerequisites.get('bwrap') !== '1') {
    return unavailable('wsl_bwrap_missing', 'guest-prerequisite')
  }
  if (prerequisites.get('unshare') !== '1' || prerequisites.get('namespace') !== '1') {
    return unavailable('wsl_namespace_unavailable', 'guest-prerequisite')
  }
  if (prerequisites.get('nonroot') !== '1' || prerequisites.get('uid') === '0') {
    return unavailable('wsl_root_user_unsupported', 'guest-prerequisite')
  }
  const guestHome = decodeHexMarker(markerValue(preflight.stdout, 'HOME_HEX'))
  if (!guestHome?.startsWith('/') || guestHome === '/') {
    return unavailable('wsl_home_unsupported', 'guest-prerequisite')
  }

  let fixture: WslFilesystemSpikeFixture | undefined
  let capabilityResult: WslFilesystemCapabilityResult
  try {
    fixture = await (dependencies.createFixture ?? createFixture)(request.workspace)
    capabilityResult = await probeFilesystemFixture(runGuest, request, fixture, guestHome)
  } catch (error) {
    capabilityResult = fixtureProbeFailure(error)
  }
  try {
    await fixture?.cleanup()
  } catch {
    return unavailable('wsl_cleanup_incomplete', 'cleanup')
  }
  return capabilityResult
}

export {
  createWslFilesystemSpikeFixture,
  defaultRunGuest,
  durableFixturePaths,
  probeWslFilesystemSandboxReuse,
  WslFixtureCleanupError,
  WslFixtureBusyError,
  wslGuestArguments
}
export type {
  WslFilesystemCapabilityResult,
  WslFilesystemEvidence,
  WslFilesystemSpikeRequest,
  WslFilesystemSpikeFixture,
  WslFilesystemSpikeFixtureFactory,
  WslFilesystemSpikeFixtureOperations,
  WslGuestCommandRequest,
  WslGuestCommandResult,
  WslGuestCommandRunner
}
