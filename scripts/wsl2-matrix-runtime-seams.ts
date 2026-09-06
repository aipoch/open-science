import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

export const exactTerminationProgram = String.raw`
token=$1; receipt=$2; expected_pid=$4; expected_start=$5; expected_sid=$6; expected_pgid=$7; expected_descendants=$8
if [ -r "$receipt" ]; then
  IFS= read -r receipt_line < "$receipt" || exit 3; set -- $receipt_line
  leader=$1; recorded_token=$2; leader_start=$3; leader_sid=$4; leader_pgid=$5; shift 5
  receipt_descendants="$*"; [ -n "$receipt_descendants" ] || receipt_descendants=-
  [ "$recorded_token" = "$token" ] || exit 4
elif [ "$expected_pid" != - ]; then
  leader=$expected_pid; leader_start=$expected_start; leader_sid=$expected_sid; leader_pgid=$expected_pgid
  receipt_descendants=$expected_descendants
else exit 3; fi
case "$leader:$leader_start:$leader_sid:$leader_pgid" in *[!0-9:]*) exit 4;; esac
if [ "$expected_pid" != - ]; then
  [ "$leader" = "$expected_pid" ] && [ "$leader_start" = "$expected_start" ] &&
    [ "$leader_sid" = "$expected_sid" ] && [ "$leader_pgid" = "$expected_pgid" ] || exit 6
  [ "$receipt_descendants" = "$expected_descendants" ] || exit 6
fi
identities="$leader:$leader_start:$leader_sid:$leader_pgid"
if [ "$receipt_descendants" = - ]; then set --; else set -- $receipt_descendants; fi
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 4 ] || exit 4; case "$1:$2:$3:$4" in *[!0-9:]*) exit 4;; esac
  identities="$identities $1:$2:$3:$4"; shift 4
done
verify_identity() {
  local pid expected_start expected_sid expected_pgid retry current_state current_start current_sid current_pgid
  pid=$1; expected_start=$2; expected_sid=$3; expected_pgid=$4
  retry=0
  while [ "$retry" -le 5 ]; do
    [ -r "/proc/$pid/stat" ] || return 1
    current_state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null) || return 1
    [ "$current_state" = Z ] && return 1
    current_start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null) || return 1
    [ "$current_start" = "$expected_start" ] || return 2
    current_sid=$(ps -o sid= -p "$pid" 2>/dev/null | tr -d ' ')
    current_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$current_sid" ] && [ -n "$current_pgid" ]; then
      [ "$current_sid" = "$expected_sid" ] && [ "$current_pgid" = "$expected_pgid" ] || return 2
      tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$token" && return 0
    fi
    retry=$((retry + 1))
    [ "$retry" -le 5 ] && sleep 0.02
  done
  return 2
}
signal_phase() {
  local signal signaled_groups identity pid start sid pgid verified group_alive member member_pid member_start member_sid member_pgid signaled
  signal=$1
  signaled_groups=' '
  for identity in $identities; do
    IFS=: read -r pid start sid pgid <<EOF
$identity
EOF
    case "$signaled_groups" in *" $pgid "*) continue;; esac
    if [ "$pgid" = "$pid" ]; then
      group_alive=false
      for member in $identities; do
        IFS=: read -r member_pid member_start member_sid member_pgid <<EOF
$member
EOF
        [ "$member_pgid" = "$pgid" ] || continue
        verify_identity "$member_pid" "$member_start" "$member_sid" "$member_pgid"; verified=$?
        [ "$verified" -eq 0 ] && group_alive=true
        [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || return 6
      done
      signaled_groups="$signaled_groups$pgid "
      $group_alive || continue
      kill "-$signal" -- "-$pid" 2>/dev/null
    else
      verify_identity "$pid" "$start" "$sid" "$pgid"; verified=$?
      [ "$verified" -eq 1 ] && continue
      [ "$verified" -eq 0 ] || return 6
      kill "-$signal" -- "$pid" 2>/dev/null
    fi
    signaled=$?
    if [ "$signaled" -ne 0 ]; then
      verify_identity "$pid" "$start" "$sid" "$pgid"; verified=$?
      [ "$verified" -eq 1 ] && continue
      [ "$verified" -eq 0 ] && return 7
      return 6
    fi
  done
}
signal_phase TERM || exit $?
sleep 0.25
signal_phase KILL || exit $?
i=0
while [ "$i" -lt 30 ]; do
  alive=false
  for identity in $identities; do
    IFS=: read -r pid start sid pgid <<EOF
$identity
EOF
    verify_identity "$pid" "$start" "$sid" "$pgid"; verified=$?
    [ "$verified" -eq 0 ] && alive=true
    [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || exit 6
  done
  $alive || exit 0; i=$((i + 1)); sleep 0.1
done
exit 5
`

export type GlobalFence = Readonly<{
  token: string
  heartbeat: () => void
  assertOwned: () => void
  release: () => void
}>

export function acquireAtomicGlobalFence(
  directory: string,
  hooks: {
    beforeQuarantineRename?: () => void
    beforeReleaseRemove?: (quarantinePath: string) => void
  } = {}
): GlobalFence {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lockPath = join(directory, 'global-owner.lock')
  const ownerPath = join(lockPath, 'owner.json')
  const heartbeatPath = join(lockPath, 'heartbeat.json')
  const token = randomUUID()
  const stagingPath = join(directory, `global-owner.claim-${token}`)
  const writeSynced = (path: string, value: unknown): void => {
    const descriptor = openSync(path, 'wx', 0o600)
    try {
      const payload = Buffer.from(JSON.stringify(value))
      writeSync(descriptor, payload, 0, payload.length, 0)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
  const syncDirectory = (): void => {
    let descriptor: number | undefined
    try {
      descriptor = openSync(directory, 'r')
      fsyncSync(descriptor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) throw error
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
  type ReleaseTransition = {
    token: string
    pid: number
    quarantinePath: string
    deletingPath: string
    ownerToken: string
    heartbeatToken: string
    identity: { device: string; inode: string; birthtimeMs: string }
  }
  const hostDirectoryIdentity = (
    path: string
  ): { device: string; inode: string; birthtimeMs: string } | undefined => {
    try {
      const metadata = lstatSync(path, { bigint: true })
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined
      return {
        device: String(metadata.dev),
        inode: String(metadata.ino),
        birthtimeMs: String(metadata.birthtimeMs)
      }
    } catch {
      return undefined
    }
  }
  const sameHostDirectory = (path: string, expected: ReleaseTransition['identity']): boolean => {
    const observed = hostDirectoryIdentity(path)
    return observed !== undefined && JSON.stringify(observed) === JSON.stringify(expected)
  }
  const removeReleaseTransition = (transitionPath: string, transition: ReleaseTransition): void => {
    const currentPath = existsSync(transition.deletingPath)
      ? transition.deletingPath
      : transition.quarantinePath
    if (!existsSync(currentPath)) {
      unlinkSync(transitionPath)
      syncDirectory()
      return
    }
    if (!sameHostDirectory(currentPath, transition.identity)) {
      throw new Error('WSL_MATRIX_GLOBAL_RELEASE_IDENTITY_MISMATCH')
    }
    if (currentPath === transition.quarantinePath) {
      renameSync(transition.quarantinePath, transition.deletingPath)
      syncDirectory()
    }
    if (!sameHostDirectory(transition.deletingPath, transition.identity)) {
      throw new Error('WSL_MATRIX_GLOBAL_RELEASE_IDENTITY_MISMATCH')
    }
    hooks.beforeReleaseRemove?.(transition.deletingPath)
    if (!sameHostDirectory(transition.deletingPath, transition.identity)) {
      throw new Error('WSL_MATRIX_GLOBAL_RELEASE_IDENTITY_MISMATCH')
    }
    rmSync(transition.deletingPath, { recursive: true, force: true })
    unlinkSync(transitionPath)
    syncDirectory()
  }
  const reconcileReleaseTransitions = (): void => {
    for (const name of readdirSync(directory).filter(
      (entry) => entry.startsWith('global-owner.release-') && entry.endsWith('.json')
    )) {
      const transitionPath = join(directory, name)
      const transition = JSON.parse(
        readFileSync(transitionPath, 'utf8')
      ) as Partial<ReleaseTransition>
      const expectedName =
        typeof transition.token === 'string'
          ? `global-owner.release-${transition.token}.json`
          : undefined
      const expectedQuarantine =
        typeof transition.token === 'string'
          ? join(directory, `global-owner.release-${transition.token}`)
          : undefined
      const expectedDeleting = expectedQuarantine ? `${expectedQuarantine}.deleting` : undefined
      if (
        name !== expectedName ||
        transition.quarantinePath !== expectedQuarantine ||
        transition.deletingPath !== expectedDeleting ||
        transition.ownerToken !== transition.token ||
        transition.heartbeatToken !== transition.token ||
        !Number.isSafeInteger(transition.pid) ||
        transition.pid! <= 0 ||
        !transition.identity ||
        !['device', 'inode', 'birthtimeMs'].every(
          (key) =>
            typeof transition.identity?.[key as keyof typeof transition.identity] === 'string'
        )
      ) {
        throw new Error('WSL_MATRIX_GLOBAL_RELEASE_TRANSITION_INVALID')
      }
      removeReleaseTransition(transitionPath, transition as ReleaseTransition)
    }
  }
  reconcileReleaseTransitions()
  mkdirSync(stagingPath, { mode: 0o700 })
  writeSynced(join(stagingPath, 'owner.json'), { token, pid: process.pid })
  writeSynced(join(stagingPath, 'heartbeat.json'), { token, heartbeatAtMs: Date.now() })
  const failActive = (): never => {
    rmSync(stagingPath, { recursive: true, force: true })
    throw new Error('WSL_MATRIX_GLOBAL_OWNER_ACTIVE')
  }
  for (;;) {
    try {
      renameSync(stagingPath, lockPath)
      syncDirectory()
      break
    } catch (error) {
      if (!existsSync(lockPath)) throw error
      let owner: { token?: string; pid?: number } = {}
      let observedHeartbeat: { token?: string; heartbeatAtMs?: number } = {}
      try {
        owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as typeof owner
        observedHeartbeat = JSON.parse(
          readFileSync(heartbeatPath, 'utf8')
        ) as typeof observedHeartbeat
      } catch {
        failActive()
      }
      let ownerAlive = false
      if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
        try {
          process.kill(owner.pid!, 0)
          ownerAlive = true
        } catch {
          ownerAlive = false
        }
      }
      const stale =
        typeof owner.token === 'string' &&
        observedHeartbeat.token === owner.token &&
        typeof observedHeartbeat.heartbeatAtMs === 'number' &&
        !ownerAlive &&
        Date.now() - observedHeartbeat.heartbeatAtMs >= 250
      if (!stale) failActive()
      const quarantine = `${lockPath}.stale-${randomUUID()}`
      hooks.beforeQuarantineRename?.()
      renameSync(lockPath, quarantine)
      syncDirectory()
      const movedOwner = JSON.parse(
        readFileSync(join(quarantine, 'owner.json'), 'utf8')
      ) as typeof owner
      const movedHeartbeat = JSON.parse(
        readFileSync(join(quarantine, 'heartbeat.json'), 'utf8')
      ) as typeof observedHeartbeat
      if (
        movedOwner.token !== owner.token ||
        movedOwner.pid !== owner.pid ||
        movedHeartbeat.token !== observedHeartbeat.token ||
        movedHeartbeat.heartbeatAtMs !== observedHeartbeat.heartbeatAtMs
      ) {
        if (!existsSync(lockPath)) renameSync(quarantine, lockPath)
        failActive()
      }
      rmSync(quarantine, { recursive: true, force: true })
    }
  }
  const assertOwned = (): void => {
    const current = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string }
    if (current.token !== token) throw new Error('WSL_MATRIX_FENCE_LOST')
  }
  const heartbeat = (): void => {
    assertOwned()
    const temporary = join(lockPath, `heartbeat-${randomUUID()}.tmp`)
    writeSynced(temporary, { token, heartbeatAtMs: Date.now() })
    renameSync(temporary, heartbeatPath)
  }
  return {
    token,
    heartbeat,
    assertOwned,
    release: () => {
      assertOwned()
      const ownerSnapshot = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
        token?: string
        pid?: number
      }
      const heartbeatSnapshot = JSON.parse(readFileSync(heartbeatPath, 'utf8')) as {
        token?: string
      }
      if (
        ownerSnapshot.token !== token ||
        ownerSnapshot.pid !== process.pid ||
        heartbeatSnapshot.token !== token
      ) {
        throw new Error('WSL_MATRIX_FENCE_LOST')
      }
      const quarantinePath = join(directory, `global-owner.release-${token}`)
      const deletingPath = `${quarantinePath}.deleting`
      const transitionPath = `${quarantinePath}.json`
      const temporaryTransition = `${transitionPath}.${randomUUID()}.tmp`
      const releaseIdentity = hostDirectoryIdentity(lockPath)
      if (!releaseIdentity) throw new Error('WSL_MATRIX_FENCE_LOST')
      writeSynced(temporaryTransition, {
        token,
        pid: process.pid,
        quarantinePath,
        deletingPath,
        ownerToken: ownerSnapshot.token,
        heartbeatToken: heartbeatSnapshot.token,
        identity: releaseIdentity
      })
      renameSync(temporaryTransition, transitionPath)
      syncDirectory()
      renameSync(lockPath, quarantinePath)
      syncDirectory()
      const movedOwner = JSON.parse(
        readFileSync(join(quarantinePath, 'owner.json'), 'utf8')
      ) as typeof ownerSnapshot
      const movedHeartbeat = JSON.parse(
        readFileSync(join(quarantinePath, 'heartbeat.json'), 'utf8')
      ) as typeof heartbeatSnapshot
      if (
        movedOwner.token !== ownerSnapshot.token ||
        movedOwner.pid !== ownerSnapshot.pid ||
        movedHeartbeat.token !== heartbeatSnapshot.token
      ) {
        throw new Error('WSL_MATRIX_FENCE_LOST')
      }
      const transition = JSON.parse(readFileSync(transitionPath, 'utf8')) as ReleaseTransition
      removeReleaseTransition(transitionPath, transition)
    }
  }
}

export type GuestRootOwnershipOperations = {
  rootExists: () => boolean | Promise<boolean>
  quarantineExists: () => boolean | Promise<boolean>
  readCanonicalIdentity: () =>
    DurableDirectoryIdentity | undefined | Promise<DurableDirectoryIdentity | undefined>
  canonicalIdentityMatches: (identity: DurableDirectoryIdentity) => boolean | Promise<boolean>
  quarantineIdentityMatches: (identity: DurableDirectoryIdentity) => boolean | Promise<boolean>
  removePreparingRoot: () => boolean | Promise<boolean>
  persistTransition: (
    phase: 'prepared' | 'verified',
    identity: DurableDirectoryIdentity
  ) => boolean | Promise<boolean>
  clearTransition: () => boolean | Promise<boolean>
  quarantine: () => boolean | Promise<boolean>
  markerMatchesCanonical: () => boolean | Promise<boolean>
  markerMatchesInQuarantine: () => boolean | Promise<boolean>
  removeQuarantine: (identity: DurableDirectoryIdentity) => boolean | Promise<boolean>
}

export type DurableDirectoryIdentity = Readonly<{
  device: string
  inode: string
  birthTimeSeconds: string
}>

export async function removeOwnedGuestRoot(
  operations: GuestRootOwnershipOperations,
  transition: {
    phase: 'prepared' | 'verified'
    identity: DurableDirectoryIdentity
  } | null = null
): Promise<boolean> {
  let phase = transition?.phase
  let identity = transition?.identity
  if (!phase) {
    if (!(await operations.rootExists())) return operations.removePreparingRoot()
    if (!(await operations.markerMatchesCanonical())) return false
    identity = await operations.readCanonicalIdentity()
    if (!identity || !(await operations.persistTransition('prepared', identity))) return false
    phase = 'prepared'
  }
  if (!(await operations.quarantineExists())) {
    if (phase === 'verified') {
      if (!(await operations.clearTransition())) return false
      return operations.removePreparingRoot()
    }
    if (
      !(await operations.rootExists()) ||
      !(await operations.markerMatchesCanonical()) ||
      !identity ||
      !(await operations.canonicalIdentityMatches(identity)) ||
      !(await operations.quarantine())
    )
      return false
  }
  if (!identity || !(await operations.quarantineIdentityMatches(identity))) return false
  if (phase === 'prepared') {
    if (!(await operations.markerMatchesInQuarantine())) return false
    if (!(await operations.persistTransition('verified', identity))) return false
  }
  if (!(await operations.removeQuarantine(identity))) return false
  if (!(await operations.clearTransition())) return false
  return operations.removePreparingRoot()
}

export type DurableTerminationIdentity = Readonly<{
  token: string
  receiptPath: string
  completionPath: string
  leaderPid: number | null
  startTimeTicks: string | null
  sid: number | null
  pgid: number | null
}>

export type DurableTerminationOutcome = 'stopped' | 'absent' | 'mismatch' | 'failed'

export async function captureCleanupFailure(
  failures: string[],
  name: string,
  operation: () => void | Promise<void>
): Promise<boolean> {
  try {
    await operation()
    return true
  } catch {
    failures.push(name)
    return false
  }
}

export function matrixResultErrorCode(
  passed: boolean,
  cleanupComplete: boolean
): 'WSL_MATRIX_FAILED' | 'WSL_MATRIX_CLEANUP_INCOMPLETE' | undefined {
  if (passed) return undefined
  return cleanupComplete ? 'WSL_MATRIX_FAILED' : 'WSL_MATRIX_CLEANUP_INCOMPLETE'
}

export function withEarlyCleanupResult<T extends Readonly<{ status: string }>>(
  result: T,
  cleanupFailures: readonly string[]
):
  | T
  | (T & {
      status: 'failed'
      errorCode: 'WSL_MATRIX_CLEANUP_INCOMPLETE'
      cleanupFailures: string[]
    }) {
  if (cleanupFailures.length === 0) return result
  return {
    ...result,
    status: 'failed',
    errorCode: 'WSL_MATRIX_CLEANUP_INCOMPLETE',
    cleanupFailures: [...cleanupFailures]
  }
}

export function reconcileDurableProcessIdentity(
  identity: DurableTerminationIdentity,
  operations: {
    receiptExists: () => boolean
    pendingCompletionProvesStopped: () => boolean
    capturePendingReceipt: () => DurableTerminationIdentity | undefined
    terminateComplete: (complete: DurableTerminationIdentity) => DurableTerminationOutcome
  }
): DurableTerminationOutcome {
  const complete =
    identity.leaderPid !== null &&
    identity.startTimeTicks !== null &&
    identity.sid !== null &&
    identity.pgid !== null
  if (!complete && !operations.receiptExists()) {
    return operations.pendingCompletionProvesStopped() ? 'stopped' : 'failed'
  }
  const target = complete ? identity : operations.capturePendingReceipt()
  if (!target) return 'failed'
  return operations.terminateComplete(target)
}
