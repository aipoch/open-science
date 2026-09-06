/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest'

import {
  collectWsl2SpikeEvidence,
  evaluateWsl2SpikeEvidence,
  parseCliArguments
} from './wsl2-network-lifecycle-spike.mjs'

const completeEvidence = () => ({
  schemaVersion: 1,
  status: 'passed',
  distro: 'Ubuntu-22.04',
  capabilities: {
    wsl2: true,
    bash: true,
    bubblewrap: true,
    unshare: true,
    python3: true,
    nonRootUser: true
  },
  network: {
    gatewayAllowed: true,
    gatewayDenied: true,
    directOutboundBlocked: true,
    networkProcessesTerminated: true,
    networkProbeStatus: 0,
    networkProbeTimedOut: false
  },
  lifecycle: {
    normalExit: {
      bounded: true,
      exitCode: 0,
      descendantsRunning: false,
      receiptObserved: true,
      cleanupSucceeded: true,
      cleanupStatuses: [0]
    },
    nonZeroExit: {
      bounded: true,
      exitCode: 23,
      descendantsRunning: false,
      receiptObserved: true,
      cleanupSucceeded: true,
      cleanupStatuses: [0]
    },
    cancel: {
      bounded: true,
      exitCode: 143,
      descendantsRunning: false,
      receiptObserved: true,
      cleanupSucceeded: true,
      cleanupStatuses: [0, 0],
      payloadReadyBeforeTermination: true,
      terminationRequested: true
    },
    timeout: {
      bounded: true,
      exitCode: 143,
      descendantsRunning: false,
      receiptObserved: true,
      cleanupSucceeded: true,
      cleanupStatuses: [0, 0],
      payloadReadyBeforeTermination: true,
      terminationRequested: true
    },
    distroStillRunning: true
  },
  cleanup: {
    gatewayClosed: true,
    hostIngressClosed: true,
    bridgeClosed: true,
    temporaryResourcesRemoved: true,
    foreignReceiptIdentitySafe: true,
    durableStartupReconciled: true,
    durableJournalRemoved: true
  }
})

describe('WSL2 network and lifecycle spike result', () => {
  it('fails closed with stable missing-capability codes before claiming sandbox evidence', () => {
    const evidence = completeEvidence()
    evidence.capabilities.bubblewrap = false
    evidence.network = null
    evidence.lifecycle = null

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'unsupported',
      code: 'WSL_SPIKE_BWRAP_MISSING',
      passed: false,
      checks: expect.arrayContaining([
        { id: 'capability.bubblewrap', passed: false, code: 'WSL_SPIKE_BWRAP_MISSING' }
      ])
    })
  })

  it('accepts only gateway-mediated network and bounded lifecycle evidence', () => {
    expect(evaluateWsl2SpikeEvidence(completeEvidence())).toMatchObject({
      status: 'passed',
      code: 'WSL_SPIKE_OK',
      passed: true,
      decision: {
        confidence: 'verified-by-spike',
        transport: 'authenticated-command-gateway-via-guest-unix-bridge',
        supervisor: 'guest-process-group-and-token-supervisor',
        dedicatedGuestRunnerRequired: true
      }
    })
  })

  it('reports incomplete cleanup instead of hiding a successful command result', () => {
    const evidence = completeEvidence()
    evidence.cleanup.bridgeClosed = false

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_CLEANUP_INCOMPLETE',
      passed: false,
      checks: expect.arrayContaining([
        {
          id: 'cleanup.bridgeClosed',
          passed: false,
          code: 'WSL_SPIKE_CLEANUP_INCOMPLETE'
        }
      ])
    })
  })

  it('rejects an otherwise positive producer failure envelope', () => {
    const evidence = completeEvidence()
    evidence.status = 'failed'
    evidence.errorCode = 'WSL_MATRIX_FAILED'
    evidence.cleanupFailures = ['gateway-close']

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_PRODUCER_FAILED',
      passed: false
    })
  })

  it('does not downgrade a failed cleanup envelope to a missing capability', () => {
    const evidence = completeEvidence()
    evidence.status = 'failed'
    evidence.errorCode = 'WSL_MATRIX_CLEANUP_INCOMPLETE'
    evidence.cleanupFailures = ['global-fence-release']
    evidence.capabilities.bubblewrap = false
    evidence.network = null
    evidence.lifecycle = null
    evidence.cleanup = null

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_PRODUCER_FAILED',
      passed: false
    })
  })

  it('rejects an unsupported producer schema version', () => {
    const evidence = completeEvidence()
    evidence.schemaVersion = 2
    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_EVIDENCE_SCHEMA_INVALID'
    })
  })

  it.each([
    ['root errorCode', (evidence) => (evidence.errorCode = 'WSL_MATRIX_FAILED')],
    ['cleanupFailures', (evidence) => (evidence.cleanupFailures = ['gateway-close'])],
    ['nested errorCode', (evidence) => (evidence.network.errorCode = 'WSL_MATRIX_NETWORK_FAILED')]
  ])('rejects the producer failure marker %s', (_name, mutate) => {
    const evidence = completeEvidence()
    mutate(evidence)
    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_PRODUCER_FAILURE_MARKER_PRESENT'
    })
  })

  it.each([
    [undefined, true],
    [[], true],
    [[0, 1], true],
    [[0], false]
  ])('rejects missing or contradictory lifecycle cleanup statuses %#', (statuses, succeeded) => {
    const evidence = completeEvidence()
    evidence.lifecycle.cancel.cleanupStatuses = statuses
    evidence.lifecycle.cancel.cleanupSucceeded = succeeded
    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_LIFECYCLE_CLEANUP_FAILED'
    })
  })

  it.each([
    ['networkProcessesTerminated', false, 'WSL_SPIKE_NETWORK_PROCESS_CLEANUP_FAILED'],
    ['networkProbeStatus', 9, 'WSL_SPIKE_NETWORK_PROBE_FAILED'],
    ['networkProbeTimedOut', true, 'WSL_SPIKE_NETWORK_PROBE_TIMED_OUT']
  ])('requires the network safety receipt %s', (field, value, code) => {
    const evidence = completeEvidence()
    evidence.network[field] = value
    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({ status: 'failed', code })
  })

  it.each(['normalExit', 'nonZeroExit', 'cancel', 'timeout'])(
    'requires %s cleanup to succeed',
    (scenario) => {
      const evidence = completeEvidence()
      evidence.lifecycle[scenario].cleanupSucceeded = false
      expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
        status: 'failed',
        code: 'WSL_SPIKE_LIFECYCLE_CLEANUP_FAILED'
      })
    }
  )

  it.each([
    ['foreignReceiptIdentitySafe', 'WSL_SPIKE_FOREIGN_IDENTITY_UNSAFE'],
    ['durableStartupReconciled', 'WSL_SPIKE_DURABLE_RECONCILIATION_FAILED'],
    ['durableJournalRemoved', 'WSL_SPIKE_DURABLE_JOURNAL_RETAINED']
  ])('requires the cleanup safety receipt %s', (field, code) => {
    const evidence = completeEvidence()
    evidence.cleanup[field] = false
    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({ status: 'failed', code })
  })

  it.each([
    ['gatewayAllowed', 'WSL_SPIKE_GATEWAY_ALLOW_FAILED'],
    ['gatewayDenied', 'WSL_SPIKE_GATEWAY_DENY_FAILED'],
    ['directOutboundBlocked', 'WSL_SPIKE_DIRECT_NETWORK_AVAILABLE']
  ])('returns a stable network failure for %s', (field, code) => {
    const evidence = completeEvidence()
    evidence.network[field] = false

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({ status: 'failed', code })
  })

  it.each(['normalExit', 'nonZeroExit', 'cancel', 'timeout'])(
    'requires %s to converge without a surviving descendant',
    (scenario) => {
      const evidence = completeEvidence()
      evidence.lifecycle[scenario].descendantsRunning = true

      expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
        status: 'failed',
        code: 'WSL_SPIKE_DESCENDANT_SURVIVED'
      })
    }
  )

  it('rejects contradictory exit semantics', () => {
    const evidence = completeEvidence()
    evidence.lifecycle.normalExit.exitCode = 99

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_EXIT_SEMANTICS_INVALID'
    })
  })

  it('fails closed with a stable code when lifecycle evidence is incomplete', () => {
    const evidence = completeEvidence()
    evidence.lifecycle.cancel = undefined

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_LIFECYCLE_UNBOUNDED'
    })
  })

  it('requires lifecycle and host-ingress cleanup receipts', () => {
    const missingLifecycleReceipt = completeEvidence()
    missingLifecycleReceipt.lifecycle.timeout.receiptObserved = false
    expect(evaluateWsl2SpikeEvidence(missingLifecycleReceipt)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_LIFECYCLE_RECEIPT_MISSING'
    })

    const missingIngressReceipt = completeEvidence()
    missingIngressReceipt.cleanup.hostIngressClosed = false
    expect(evaluateWsl2SpikeEvidence(missingIngressReceipt)).toMatchObject({
      status: 'failed',
      code: 'WSL_SPIKE_CLEANUP_INCOMPLETE'
    })
  })

  it('collects preflight capability evidence through the guest runner seam', () => {
    const commands = []
    const evidence = collectWsl2SpikeEvidence(
      'Test-Distro',
      'test-user',
      (distro, user, command) => {
        commands.push({ distro, user, command })
        return { status: command.includes('bwrap') ? 127 : 0 }
      }
    )

    expect(evidence).toMatchObject({
      distro: 'Test-Distro',
      user: 'test-user',
      capabilities: { wsl2: true, bubblewrap: false },
      network: null,
      lifecycle: null,
      cleanup: null
    })
    expect(commands).toHaveLength(6)
    expect(commands.every((command) => command.user === 'test-user')).toBe(true)
  })

  it('reports an uncollected matrix explicitly when every preflight check passes', () => {
    const evidence = collectWsl2SpikeEvidence('Test-Distro', 'test-user', () => ({ status: 0 }))

    expect(evaluateWsl2SpikeEvidence(evidence)).toMatchObject({
      status: 'unsupported',
      code: 'WSL_SPIKE_MATRIX_NOT_COLLECTED'
    })
  })

  it('requires explicit distro and user CLI bindings', () => {
    expect(parseCliArguments(['--distro', 'Ubuntu-22.04', '--user', 'open-science-spike'])).toEqual(
      { distro: 'Ubuntu-22.04', user: 'open-science-spike' }
    )
    expect(parseCliArguments(['--distro', 'Ubuntu-22.04'])).toEqual({
      distro: 'Ubuntu-22.04',
      user: undefined
    })
  })
})
