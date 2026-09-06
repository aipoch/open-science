#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node CLI uses versioned JSON evidence. */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const DECISION = Object.freeze({
  confidence: 'verified-by-spike',
  transport: 'authenticated-command-gateway-via-guest-unix-bridge',
  supervisor: 'guest-process-group-and-token-supervisor',
  dedicatedGuestRunnerRequired: true
})

const check = (id, passed, code) => ({ id, passed, ...(passed ? {} : { code }) })

const hasProducerFailureMarker = (value) => {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(
    ([key, nested]) =>
      (key === 'errorCode' && typeof nested === 'string' && nested.length > 0) ||
      (key === 'cleanupFailures' && Array.isArray(nested) && nested.length > 0) ||
      hasProducerFailureMarker(nested)
  )
}

const evaluateWsl2SpikeEvidence = (evidence) => {
  if (evidence?.schemaVersion !== 1) {
    return {
      schemaVersion: 1,
      status: 'failed',
      code: 'WSL_SPIKE_EVIDENCE_SCHEMA_INVALID',
      passed: false,
      checks: [check('producer.schemaVersion', false, 'WSL_SPIKE_EVIDENCE_SCHEMA_INVALID')],
      decision: DECISION
    }
  }
  const producerFailureMarkerPresent = hasProducerFailureMarker(evidence)
  if (evidence.status === 'failed' || producerFailureMarkerPresent) {
    const code =
      evidence.status === 'failed'
        ? 'WSL_SPIKE_PRODUCER_FAILED'
        : 'WSL_SPIKE_PRODUCER_FAILURE_MARKER_PRESENT'
    return {
      schemaVersion: 1,
      status: 'failed',
      code,
      passed: false,
      checks: [
        check('producer.status', evidence.status !== 'failed', 'WSL_SPIKE_PRODUCER_FAILED'),
        check(
          'producer.failureMarkersAbsent',
          !producerFailureMarkerPresent,
          'WSL_SPIKE_PRODUCER_FAILURE_MARKER_PRESENT'
        )
      ],
      decision: DECISION
    }
  }
  const capabilityChecks = [
    check('capability.wsl2', evidence.capabilities?.wsl2 === true, 'WSL_SPIKE_WSL2_REQUIRED'),
    check('capability.bash', evidence.capabilities?.bash === true, 'WSL_SPIKE_BASH_MISSING'),
    check(
      'capability.bubblewrap',
      evidence.capabilities?.bubblewrap === true,
      'WSL_SPIKE_BWRAP_MISSING'
    ),
    check(
      'capability.unshare',
      evidence.capabilities?.unshare === true,
      'WSL_SPIKE_UNSHARE_MISSING'
    ),
    check(
      'capability.python3',
      evidence.capabilities?.python3 === true,
      'WSL_SPIKE_BRIDGE_RUNTIME_MISSING'
    ),
    check(
      'capability.nonRootUser',
      evidence.capabilities?.nonRootUser === true,
      'WSL_SPIKE_NON_ROOT_REQUIRED'
    )
  ]
  const missing = capabilityChecks.find((item) => !item.passed)
  if (missing) {
    return {
      schemaVersion: 1,
      status: 'unsupported',
      code: missing.code,
      passed: false,
      checks: capabilityChecks,
      decision: DECISION
    }
  }

  if (!evidence.network || !evidence.lifecycle || !evidence.cleanup) {
    return {
      schemaVersion: 1,
      status: 'unsupported',
      code: 'WSL_SPIKE_MATRIX_NOT_COLLECTED',
      passed: false,
      checks: capabilityChecks,
      decision: DECISION
    }
  }

  const producerChecks = [
    check('producer.status', evidence.status === 'passed', 'WSL_SPIKE_PRODUCER_FAILED'),
    check(
      'producer.failureMarkersAbsent',
      !producerFailureMarkerPresent,
      'WSL_SPIKE_PRODUCER_FAILURE_MARKER_PRESENT'
    )
  ]
  const producerFailure = producerChecks.find((item) => !item.passed)
  if (producerFailure) {
    return {
      schemaVersion: 1,
      status: 'failed',
      code: producerFailure.code,
      passed: false,
      checks: [...capabilityChecks, ...producerChecks],
      decision: DECISION
    }
  }

  const networkChecks = [
    check(
      'network.gatewayAllowed',
      evidence.network?.gatewayAllowed === true,
      'WSL_SPIKE_GATEWAY_ALLOW_FAILED'
    ),
    check(
      'network.gatewayDenied',
      evidence.network?.gatewayDenied === true,
      'WSL_SPIKE_GATEWAY_DENY_FAILED'
    ),
    check(
      'network.directOutboundBlocked',
      evidence.network?.directOutboundBlocked === true,
      'WSL_SPIKE_DIRECT_NETWORK_AVAILABLE'
    ),
    check(
      'network.networkProcessesTerminated',
      evidence.network?.networkProcessesTerminated === true,
      'WSL_SPIKE_NETWORK_PROCESS_CLEANUP_FAILED'
    ),
    check(
      'network.networkProbeStatus',
      evidence.network?.networkProbeStatus === 0,
      'WSL_SPIKE_NETWORK_PROBE_FAILED'
    ),
    check(
      'network.networkProbeTimedOut',
      evidence.network?.networkProbeTimedOut === false,
      'WSL_SPIKE_NETWORK_PROBE_TIMED_OUT'
    )
  ]
  const lifecycleChecks = []
  for (const name of ['normalExit', 'nonZeroExit', 'cancel', 'timeout']) {
    const result = evidence.lifecycle?.[name]
    const cleanupStatusesValid =
      Array.isArray(result?.cleanupStatuses) &&
      result.cleanupStatuses.length > 0 &&
      result.cleanupStatuses.every((status) => Number.isInteger(status) && status === 0)
    lifecycleChecks.push(
      check(`lifecycle.${name}.bounded`, result?.bounded === true, 'WSL_SPIKE_LIFECYCLE_UNBOUNDED'),
      check(
        `lifecycle.${name}.descendantsStopped`,
        result?.descendantsRunning === false,
        'WSL_SPIKE_DESCENDANT_SURVIVED'
      ),
      check(
        `lifecycle.${name}.receiptObserved`,
        result?.receiptObserved === true,
        'WSL_SPIKE_LIFECYCLE_RECEIPT_MISSING'
      ),
      check(
        `lifecycle.${name}.cleanupSucceeded`,
        result?.cleanupSucceeded === true && cleanupStatusesValid,
        'WSL_SPIKE_LIFECYCLE_CLEANUP_FAILED'
      ),
      check(
        `lifecycle.${name}.cleanupStatuses`,
        cleanupStatusesValid && result?.cleanupSucceeded === true,
        'WSL_SPIKE_LIFECYCLE_CLEANUP_FAILED'
      )
    )
  }
  lifecycleChecks.push(
    check(
      'lifecycle.cancel.payloadReadyBeforeTermination',
      evidence.lifecycle.cancel?.payloadReadyBeforeTermination === true,
      'WSL_SPIKE_TERMINATION_EVIDENCE_MISSING'
    ),
    check(
      'lifecycle.cancel.terminationRequested',
      evidence.lifecycle.cancel?.terminationRequested === true,
      'WSL_SPIKE_TERMINATION_EVIDENCE_MISSING'
    ),
    check(
      'lifecycle.timeout.payloadReadyBeforeTermination',
      evidence.lifecycle.timeout?.payloadReadyBeforeTermination === true,
      'WSL_SPIKE_TERMINATION_EVIDENCE_MISSING'
    ),
    check(
      'lifecycle.timeout.terminationRequested',
      evidence.lifecycle.timeout?.terminationRequested === true,
      'WSL_SPIKE_TERMINATION_EVIDENCE_MISSING'
    ),
    check(
      'lifecycle.normalExit.exitCode',
      evidence.lifecycle.normalExit?.exitCode === 0,
      'WSL_SPIKE_EXIT_SEMANTICS_INVALID'
    ),
    check(
      'lifecycle.nonZeroExit.exitCode',
      Number.isInteger(evidence.lifecycle.nonZeroExit?.exitCode) &&
        evidence.lifecycle.nonZeroExit?.exitCode !== 0,
      'WSL_SPIKE_EXIT_SEMANTICS_INVALID'
    ),
    check(
      'lifecycle.cancel.exitCode',
      evidence.lifecycle.cancel?.exitCode === 143,
      'WSL_SPIKE_EXIT_SEMANTICS_INVALID'
    ),
    check(
      'lifecycle.timeout.exitCode',
      evidence.lifecycle.timeout?.exitCode === 143,
      'WSL_SPIKE_EXIT_SEMANTICS_INVALID'
    )
  )
  lifecycleChecks.push(
    check(
      'lifecycle.distroStillRunning',
      evidence.lifecycle?.distroStillRunning === true,
      'WSL_SPIKE_DISTRO_TERMINATED'
    )
  )
  const cleanupChecks = [
    check(
      'cleanup.gatewayClosed',
      evidence.cleanup?.gatewayClosed === true,
      'WSL_SPIKE_CLEANUP_INCOMPLETE'
    ),
    check(
      'cleanup.hostIngressClosed',
      evidence.cleanup?.hostIngressClosed === true,
      'WSL_SPIKE_CLEANUP_INCOMPLETE'
    ),
    check(
      'cleanup.bridgeClosed',
      evidence.cleanup?.bridgeClosed === true,
      'WSL_SPIKE_CLEANUP_INCOMPLETE'
    ),
    check(
      'cleanup.temporaryResourcesRemoved',
      evidence.cleanup?.temporaryResourcesRemoved === true,
      'WSL_SPIKE_CLEANUP_INCOMPLETE'
    ),
    check(
      'cleanup.foreignReceiptIdentitySafe',
      evidence.cleanup?.foreignReceiptIdentitySafe === true,
      'WSL_SPIKE_FOREIGN_IDENTITY_UNSAFE'
    ),
    check(
      'cleanup.durableStartupReconciled',
      evidence.cleanup?.durableStartupReconciled === true,
      'WSL_SPIKE_DURABLE_RECONCILIATION_FAILED'
    ),
    check(
      'cleanup.durableJournalRemoved',
      evidence.cleanup?.durableJournalRemoved === true,
      'WSL_SPIKE_DURABLE_JOURNAL_RETAINED'
    )
  ]
  const checks = [
    ...capabilityChecks,
    ...producerChecks,
    ...networkChecks,
    ...lifecycleChecks,
    ...cleanupChecks
  ]
  const failed = checks.find((item) => !item.passed)
  return {
    schemaVersion: 1,
    status: failed ? 'failed' : 'passed',
    code: failed?.code ?? 'WSL_SPIKE_OK',
    passed: !failed,
    checks,
    decision: DECISION
  }
}

const runGuest = (distro, user, command) => {
  const receipt = `/tmp/open-science-wsl-spike-${randomUUID()}.pid`
  const token = `open-science-preflight-${randomUUID()}`
  const boundedProgram = String.raw`
receipt=$1
command=$2
token=$3
setsid --wait env OPEN_SCIENCE_MATRIX_TOKEN="$token" bash --noprofile --norc -c '
  receipt=$1
  command=$2
  token=$3
  start=$(awk '''{print $22}''' "/proc/$$/stat")
  sid=$(ps -o sid= -p $$ | tr -d " "); pgid=$(ps -o pgid= -p $$ | tr -d " ")
  printf "%s %s %s %s %s\n" "$$" "$token" "$start" "$sid" "$pgid" > "$receipt.tmp" && mv -f -- "$receipt.tmp" "$receipt"
  trap '\''rm -f -- "$receipt"'\'' EXIT
  /usr/bin/timeout --signal=TERM --kill-after=1s 5s bash --noprofile --norc -c "$command"
' open-science-spike "$receipt" "$command" "$token"
`
  const result = spawnSync(
    'wsl.exe',
    [
      '-d',
      distro,
      '--user',
      user,
      '--exec',
      'bash',
      '--noprofile',
      '--norc',
      '-c',
      boundedProgram,
      'open-science-spike',
      receipt,
      command,
      token
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    }
  )
  let cleanupFailure
  if (result.error?.code === 'ETIMEDOUT') {
    // `spawnSync` can only terminate wsl.exe. Use the unique guest receipt to target this probe's
    // process group; never terminate the distro or match unrelated guest commands.
    const cleanupProgram = String.raw`
receipt=$1
token=$2
verify() {
  pid=$1; start=$2; sid=$3; pgid=$4
  [ -r "/proc/$pid/stat" ] || return 1
  [ "$(awk '''{print $22}''' "/proc/$pid/stat")" = "$start" ] || return 2
  [ "$(ps -o sid= -p "$pid" | tr -d " ")" = "$sid" ] || return 2
  [ "$(ps -o pgid= -p "$pid" | tr -d " ")" = "$pgid" ] || return 2
  tr '\0' '\n' < "/proc/$pid/environ" | grep -Fqx "OPEN_SCIENCE_MATRIX_TOKEN=$token" || return 2
}
if [ -r "$receipt" ]; then
  read -r pid recorded start sid pgid < "$receipt"
  [ "$recorded" = "$token" ] || exit 6
  verify "$pid" "$start" "$sid" "$pgid"; verified=$?
  [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || exit 6
  [ "$verified" -eq 1 ] || kill -TERM -- "-$pgid" 2>/dev/null || exit 7
  sleep 0.2
  verify "$pid" "$start" "$sid" "$pgid"; verified=$?
  [ "$verified" -eq 1 ] || [ "$verified" -eq 0 ] || exit 6
  [ "$verified" -eq 1 ] || kill -KILL -- "-$pgid" 2>/dev/null || exit 7
fi
rm -f -- "$receipt"
`
    const cleanup = spawnSync(
      'wsl.exe',
      [
        '-d',
        distro,
        '--user',
        user,
        '--exec',
        'bash',
        '--noprofile',
        '--norc',
        '-c',
        cleanupProgram,
        'open-science-spike-cleanup',
        receipt,
        token
      ],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true }
    )
    if (cleanup.status !== 0 || cleanup.error)
      cleanupFailure = new Error('WSL_PREFLIGHT_CLEANUP_FAILED')
  }
  return cleanupFailure ? { ...result, status: null, error: cleanupFailure } : result
}

const guestSucceeds = (distro, user, command, guestRunner) => {
  const result = guestRunner(distro, user, command)
  return result.status === 0 && !result.error
}

const collectWsl2SpikeEvidence = (distro, user, guestRunner = runGuest) => {
  const capabilities = {
    // Inspect the guest kernel instead of localized/UTF-16 `wsl.exe --status` output.
    wsl2: guestSucceeds(distro, user, "uname -r | grep -qi 'microsoft-standard-WSL2'", guestRunner),
    bash: guestSucceeds(distro, user, 'command -v bash >/dev/null', guestRunner),
    bubblewrap: guestSucceeds(distro, user, 'command -v bwrap >/dev/null', guestRunner),
    unshare: guestSucceeds(
      distro,
      user,
      'bwrap --unshare-net --ro-bind / / --proc /proc --dev /dev -- true',
      guestRunner
    ),
    python3: guestSucceeds(distro, user, 'command -v python3 >/dev/null', guestRunner),
    nonRootUser: guestSucceeds(distro, user, '[ "$(id -u)" -ne 0 ]', guestRunner)
  }
  return {
    schemaVersion: 1,
    distro,
    user,
    capabilities,
    // The executable integration matrix deliberately remains absent until every production
    // prerequisite is present. This makes an incomplete environment fail closed rather than
    // accidentally proving network or lifecycle isolation with a weaker substitute.
    network: null,
    lifecycle: null,
    cleanup: null
  }
}

const parseCliArguments = (argv) => {
  const distroArgument = argv.indexOf('--distro')
  const userArgument = argv.indexOf('--user')
  return {
    distro: distroArgument >= 0 ? argv[distroArgument + 1] : undefined,
    user: userArgument >= 0 ? argv[userArgument + 1] : undefined
  }
}

const main = () => {
  const { distro, user } = parseCliArguments(process.argv.slice(2))
  if (!distro || !user) {
    process.stderr.write(
      'Usage: node scripts/wsl2-network-lifecycle-spike.mjs --distro <name> --user <name>\n'
    )
    process.exitCode = 64
    return
  }
  const evidence = collectWsl2SpikeEvidence(distro, user)
  const result = evaluateWsl2SpikeEvidence(evidence)
  process.stdout.write(`${JSON.stringify({ evidence, result }, null, 2)}\n`)
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'unsupported' ? 2 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()

export { collectWsl2SpikeEvidence, evaluateWsl2SpikeEvidence, parseCliArguments, runGuest }
