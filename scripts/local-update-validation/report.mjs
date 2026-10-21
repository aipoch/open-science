/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SCENARIOS } from './server.mjs'

export async function readJsonLines(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line, index, lines) => {
      try {
        return [JSON.parse(line)]
      } catch (error) {
        if (index === lines.length - 1 && !text.endsWith('\n')) return [] // Concurrent append, retry at next observation.
        throw new Error(`Invalid JSONL evidence in ${path}: ${error.message}`)
      }
    })
}
const exists = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}
const status = (event) => (event.type === 'update-status' ? event.status : undefined)
const after = (events, type, index = -1) =>
  events.findIndex((event, i) => i > index && event.type === type)

export function evaluateScenario({
  scenario,
  app = [],
  server = [],
  observations = [],
  fixture,
  zipSha512,
  versionA,
  isolationVerified = true
}) {
  const states = app.map(status).filter(Boolean)
  const available = states.some((value) => value.state === 'available')
  const handoffIndex = app.findIndex((event) =>
    ['handoff-boundary', 'handoff-failure'].includes(event.type)
  )
  const downloaded = app.findIndex(
    (event) =>
      event.type === 'download-verified' &&
      event.artifactSha512 === zipSha512 &&
      event.networkTransferred === true &&
      event.checksumAlgorithm === 'sha512'
  )
  const stopped = after(app, 'runtime-stopped', downloaded)
  const stopProof =
    stopped >= 0 &&
    app[stopped].processExited === true &&
    app[stopped].exitRecord === 'clean' &&
    app[stopped].lockHeld === true &&
    observations.some(
      (event) =>
        event.type === 'runtime-exit-observed' &&
        event.pid === app[stopped].pid &&
        event.generation === app[stopped].generation
    )
  const boundary =
    downloaded >= 0 &&
    stopped > downloaded &&
    handoffIndex > stopped &&
    stopProof &&
    app[handoffIndex].nativeInstallInvoked === false &&
    app[handoffIndex].targetStarted === false
  const stopFailure = app.findIndex((event) =>
    ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(status(event)?.reason)
  )
  const recovered = after(
    app,
    'runtime-recovered',
    scenario === 'shutdown-failure' ? stopped : handoffIndex
  )
  const recoveryProof =
    (boundary ||
      (scenario === 'shutdown-failure' &&
        stopFailure >= 0 &&
        stopped > stopFailure &&
        stopProof)) &&
    recovered > stopped &&
    app[recovered].serviceReady === true &&
    observations.some(
      (event) =>
        event.type === 'runtime-recovery-observed' &&
        event.pid === app[recovered].pid &&
        event.generation === app[recovered].generation
    )
  const recoveredAt = recovered >= 0 ? Date.parse(app[recovered].at) : Infinity
  const dataPreserved = fixture?.preserved === true
  const recoveryWrite =
    fixture?.recoveryWrite?.exists === true && fixture.recoveryWrite.mtimeMs > recoveredAt
  const faultTriggered = [...server, ...observations].some(
    (event) => event.type === 'fault-triggered' && event.fault === scenario
  )
  const unexpected =
    server.some((event) => event.type === 'facility-failure') ||
    observations.some((event) => event.type === 'facility-failure')
  const unsafe =
    observations.some((event) => event.type === 'target-started-observed') ||
    states.some((value) => value.outcome === 'installed') ||
    app.some(
      (event) =>
        event.type === 'native-install-started' ||
        event.type === 'target-started' ||
        event.nativeInstallInvoked === true ||
        event.targetStarted === true ||
        (versionA && event.type === 'application-started' && event.version !== versionA)
    )
  const taskRunning = observations.find((event) => event.type === 'task-running-observed')
  const taskExit = observations.find(
    (event) =>
      event.type === 'task-exit-observed' &&
      event.pid === taskRunning?.pid &&
      event.mtimeMs === taskRunning?.mtimeMs
  )
  const taskNotRestarted = observations.some(
    (event) =>
      event.type === 'task-not-restarted' &&
      event.pid === taskRunning?.pid &&
      event.mtimeMs === taskRunning?.mtimeMs &&
      event.recoveryGeneration === app[recovered]?.generation
  )
  const sourceReady = server.find((event) => event.type === 'source-ready')
  const started = app.find((event) => event.type === 'application-started')
  const launched = observations.find(
    (event) => event.type === 'initial-application-launched' && event.pid === started?.pid
  )
  const preflight = observations.find(
    (event) =>
      event.type === 'source-health-before-launch' &&
      event.origin === sourceReady?.origin &&
      event.ready === true
  )
  const sourceClosed = server.findLast(
    (event) => event.type === 'source-closed' && event.origin === sourceReady?.origin
  )
  const portReleased = observations.findLast(
    (event) => event.type === 'source-port-released' && event.origin === sourceReady?.origin
  )
  const stoppedEvents = app.filter((event) => event.type === 'runtime-stopped')
  const quitEvents = app.filter((event) => event.type === 'application-quit')
  const lifecycle = {
    sourceReadyBeforeA: !!(
      sourceReady &&
      started &&
      launched &&
      preflight &&
      Date.parse(sourceReady.at) <= Date.parse(started.at) &&
      Date.parse(preflight.at) <= Date.parse(started.at)
    ),
    sourceSurvivedApplication:
      stoppedEvents.length + quitEvents.length > 0 &&
      stoppedEvents.every((event) =>
        observations.some(
          (observed) =>
            observed.type === 'source-health-after-runtime-stop' &&
            observed.pid === event.pid &&
            observed.generation === event.generation &&
            observed.origin === sourceReady?.origin &&
            observed.ready === true &&
            Date.parse(observed.at) >= Date.parse(event.at)
        )
      ) &&
      quitEvents.every((event) =>
        observations.some(
          (observed) =>
            observed.type === 'source-health-after-application-quit' &&
            observed.pid === event.pid &&
            observed.origin === sourceReady?.origin &&
            observed.ready === true &&
            Date.parse(observed.at) >= Date.parse(event.at)
        )
      ),
    sourceClosed: !!sourceClosed,
    portReleased: !!(
      sourceClosed &&
      portReleased &&
      Date.parse(portReleased.at) >= Date.parse(sourceClosed.at)
    )
  }
  const lifecyclePassed = Object.values(lifecycle).every(Boolean)
  let passed = false
  switch (scenario) {
    case 'boundary':
      passed =
        boundary &&
        app[handoffIndex].type === 'handoff-boundary' &&
        states.some((value) => value.recovery?.canRecover === true)
      break
    case 'manual-local': {
      const reveal = app.findLast((event) => event.type === 'manual-file-reveal-invoked')
      passed =
        boundary &&
        recoveryProof &&
        states.some((value) => value.manualInstall?.kind === 'local') &&
        !!reveal &&
        observations.some(
          (event) =>
            event.type === 'native-finder-selection' &&
            event.path === reveal.path &&
            Date.parse(event.at) >= Date.parse(reveal.at)
        )
      break
    }
    case 'manual-non-standalone':
      passed =
        boundary &&
        recoveryProof &&
        states.some(
          (value) =>
            value.manualInstall?.kind === 'website' &&
            value.manualInstall.reason === 'not-standalone'
        ) &&
        !app.some((event) => event.type === 'manual-file-reveal-invoked')
      break
    case 'manual-download-failure':
      passed =
        faultTriggered &&
        states.some((value) => value.state === 'error') &&
        states.some(
          (value) =>
            value.manualInstall?.kind === 'website' &&
            value.manualInstall.reason === 'download-failed'
        ) &&
        downloaded < 0 &&
        handoffIndex < 0
      break
    case 'cache-corrupt-entry':
    case 'cache-delete-entry':
    case 'cache-corrupt-reveal':
    case 'cache-delete-reveal': {
      const invalidated = observations.find(
        (event) => event.type === 'fault-triggered' && event.fault === scenario
      )
      passed =
        boundary &&
        recoveryProof &&
        !!invalidated &&
        app.some(
          (event) =>
            event.type === 'update-status' &&
            event.status.manualInstall?.kind === 'website' &&
            event.status.manualInstall.reason === 'unavailable' &&
            Date.parse(event.at) >= Date.parse(invalidated.at)
        ) &&
        !app.some(
          (event) =>
            event.type === 'manual-file-reveal-invoked' &&
            Date.parse(event.at) >= Date.parse(invalidated.at)
        )
      break
    }
    case 'handoff-failure':
      passed =
        boundary &&
        app[handoffIndex].type === 'handoff-failure' &&
        recoveryProof &&
        dataPreserved &&
        recoveryWrite
      break
    case 'same-version':
    case 'lower-version':
      passed =
        states.some((value) => value.state === 'up-to-date') &&
        !available &&
        handoffIndex < 0 &&
        server.some((event) => event.path === '/latest-mac.yml')
      break
    case 'download-cancel': {
      const cancelled = app.findIndex((event) => status(event)?.outcome === 'cancelled')
      passed =
        faultTriggered &&
        cancelled > 0 &&
        app.slice(0, cancelled).some((event) => event.type === 'update-progress') &&
        downloaded > cancelled &&
        app
          .slice(cancelled + 1, downloaded)
          .some((event) => status(event)?.state === 'downloading') &&
        server.some((event) => event.type === 'response-interrupted')
      break
    }
    case 'network-failure': {
      const failure = app.findIndex((event) => status(event)?.state === 'error')
      passed = faultTriggered && failure >= 0 && downloaded > failure
      break
    }
    case 'checksum-failure':
    case 'corrupt-artifact':
      passed =
        faultTriggered &&
        states.some(
          (value) => value.state === 'error' && /checksum|sha512|digest/i.test(value.error ?? '')
        ) &&
        server.some(
          (event) =>
            event.type === 'request' && event.method === 'GET' && event.path?.endsWith('.zip')
        ) &&
        downloaded < 0 &&
        handoffIndex < 0 &&
        !states.some((value) => value.state === 'ready')
      break
    case 'active-task': {
      const blocked = app.findIndex(
        (event) =>
          status(event)?.reason === 'active-work' && status(event)?.blockedBy?.includes('notebook')
      )
      passed =
        blocked >= 0 &&
        taskRunning &&
        taskExit &&
        Date.parse(taskRunning.at) <= Date.parse(app[blocked].at) &&
        Date.parse(taskExit.at) <= Date.parse(app[handoffIndex]?.at) &&
        app.slice(0, blocked + 1).every((event) => event.type !== 'runtime-stopped') &&
        states.some(
          (value) => value.reason === 'active-work' && value.recovery?.runtime === 'running'
        ) &&
        boundary &&
        recoveryProof &&
        dataPreserved &&
        recoveryWrite &&
        taskNotRestarted
      break
    }
    case 'shutdown-failure': {
      const fault = server.find(
        (event) =>
          event.type === 'fault-triggered' &&
          event.fault === scenario &&
          event.mechanism === 'runtime-lock-hardlink'
      )
      const release = server.find(
        (event) =>
          event.type === 'fault-released' &&
          event.fault === scenario &&
          event.reason === 'user-request'
      )
      const observed = observations.find(
        (event) =>
          event.type === 'shutdown-fault-observed' &&
          event.dev === fault?.dev &&
          event.ino === fault?.ino &&
          event.nlink === 2
      )
      const released = observations.find(
        (event) =>
          event.type === 'shutdown-fault-release-observed' &&
          event.dev === fault?.dev &&
          event.ino === fault?.ino &&
          event.nlink === 1
      )
      passed =
        downloaded >= 0 &&
        faultTriggered &&
        !!observed &&
        !!released &&
        !!release &&
        stopFailure >= 0 &&
        handoffIndex < 0 &&
        states.some(
          (value) =>
            ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(value.reason) &&
            value.recovery?.canRecover === true
        ) &&
        Date.parse(fault.at) <= Date.parse(app[stopFailure].at) &&
        Date.parse(release.at) >= Date.parse(app[stopFailure].at) &&
        recovered > stopFailure &&
        Date.parse(app[recovered].at) >= Date.parse(release.at) &&
        recoveryProof &&
        dataPreserved &&
        recoveryWrite
      break
    }
  }
  const executed =
    app.length > 0 &&
    (scenario !== 'shutdown-failure' ||
      states.some((value) =>
        ['runtime-stop-timeout', 'runtime-stop-unclean'].includes(value.reason)
      ))
  return {
    scenario,
    status:
      unexpected || unsafe
        ? 'failed'
        : passed && lifecyclePassed && isolationVerified
          ? 'passed'
          : executed
            ? 'failed'
            : 'not-run',
    presetFault: [
      'network-failure',
      'checksum-failure',
      'corrupt-artifact',
      'handoff-failure',
      'shutdown-failure',
      'download-cancel'
    ].includes(scenario),
    faultTriggered:
      scenario === 'handoff-failure'
        ? app.some((event) => event.type === 'handoff-failure')
        : faultTriggered,
    downloadVerified: downloaded >= 0,
    runtimeStopped: stopProof,
    handoffBoundaryReached: boundary,
    runtimeRecovered: recoveryProof,
    taskProcessObserved: !!taskRunning,
    taskProcessExited: !!taskExit,
    taskNotRestarted,
    dataPreserved,
    writableAfterRecovery: recoveryWrite,
    lifecycle,
    isolationVerified,
    facilityFailure: unexpected,
    unsafeAction: unsafe,
    diagnostics:
      passed && lifecyclePassed && isolationVerified
        ? []
        : [
            'Required evidence is incomplete or contradicts the scenario; inspect app-events.jsonl, server-events.jsonl, observations.jsonl and application.log.'
          ]
  }
}

export async function writeReport(runRoot) {
  const owner = await exists(join(runRoot, '.local-update-validation-owner.json'))
  if (!owner) throw new Error('Not an owned local-update-validation run.')
  const source = await exists(join(runRoot, 'source.json'))
  const build = await exists(join(runRoot, 'build.json'))
  let names = []
  try {
    names = await readdir(join(runRoot, 'scenarios'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const scenarios = []
  for (const name of names.sort()) {
    const dir = join(runRoot, 'scenarios', name)
    const config = await exists(join(dir, 'local-update.json'))
    if (!config) continue
    const keychain = await exists(join(dir, 'keychain-verification.json'))
    const app = (await readJsonLines(join(dir, 'app-events.jsonl'))).filter(
      (event) => event.runId === config.runId && event.scenario === config.scenario
    )
    const isolationVerified =
      config.credentialMode === 'sandbox'
        ? build?.credentialMode === 'sandbox' &&
          keychain?.isolated === true &&
          keychain.mode === 'local-update-credential-sandbox' &&
          keychain.productionCredentialAcceptance === false &&
          app.some(
            (event) =>
              event.type === 'credential-scope-verified' &&
              event.mode === 'local-update-credential-sandbox' &&
              event.isolated === true &&
              event.productionCredentialAcceptance === false
          )
        : keychain?.isolated === true &&
          keychain?.hostPreferencesUnchanged === true &&
          keychain.defaultKeychain === config.keychainPath &&
          keychain.searchList?.length === 1 &&
          keychain.searchList[0] === config.keychainPath
    scenarios.push({
      ...evaluateScenario({
        scenario: config.scenario,
        app,
        isolationVerified,
        server: await readJsonLines(join(dir, 'server-events.jsonl')),
        observations: await readJsonLines(join(dir, 'observations.jsonl')),
        fixture: await exists(join(dir, 'fixture-verification.json')),
        zipSha512: (config.servedArtifact ?? build?.b)?.files?.find((file) =>
          file.name.endsWith('.zip')
        )?.sha512,
        versionA: build?.versionA
      }),
      directory: dir,
      credentialMode: config.credentialMode ?? 'native',
      productionCredentialAcceptance: config.credentialMode !== 'sandbox' && isolationVerified
    })
  }
  const required = SCENARIOS.map((scenario) => ({
    scenario,
    status: scenarios.some((result) => result.scenario === scenario && result.unsafeAction)
      ? 'failed'
      : scenarios.some((result) => result.scenario === scenario && result.status === 'passed')
        ? 'passed'
        : scenarios.some((result) => result.scenario === scenario && result.status === 'failed')
          ? 'failed'
          : 'not-run'
  }))
  const failures = await readJsonLines(join(runRoot, 'facility-events.jsonl'))
  const report = {
    schema: 1,
    runId: owner.runId,
    generatedAt: new Date().toISOString(),
    status:
      required.every((result) => result.status === 'passed') &&
      build?.boundaryVerified === true &&
      failures.length === 0 &&
      !scenarios.some((result) => result.unsafeAction)
        ? 'passed'
        : 'not-passed',
    source: source && {
      commit: source.commit,
      snapshotId: source.snapshotId,
      fileCount: source.files.length
    },
    artifacts: build,
    requiredScenarios: required,
    scenarios,
    facilityFailures: failures,
    unverified: [
      'native-installation',
      'B-startup',
      'post-update-data',
      'production-signing-and-notarization',
      'Windows-NSIS-native-and-differential',
      'Linux-AppImage-native',
      'Linux-DEB-native',
      'external-browser-website-route',
      ...(build?.productionFullPackageVerified ? [] : ['production-full-package'])
    ],
    diagnosticsDirectory: runRoot
  }
  await writeFile(join(runRoot, 'result.json'), `${JSON.stringify(report, null, 2)}\n`)
  const summary = [
    '# Local macOS update validation',
    '',
    `Run: ${owner.runId}`,
    `Result: **${report.status}**`,
    `Commit: ${source?.commit ?? 'not captured'}`,
    `Snapshot: ${source?.snapshotId ?? 'not captured'}`,
    `Versions: A ${build?.versionA ?? '?'} → B ${build?.versionB ?? '?'}`,
    '',
    '| Required scenario | Status |',
    '| --- | --- |',
    ...required.map((item) => `| ${item.scenario} | ${item.status} |`),
    '',
    `Native installation, B startup and post-update data are **unverified**. Complete production/test package boundary verification: ${build?.productionFullPackageVerified === true ? 'passed' : 'not-run'}.`,
    'The runner never installs B, shuts down A, stops its backend, or recovers its services.',
    '',
    `Structured evidence: ${join(runRoot, 'result.json')}`,
    `Diagnostics: ${runRoot}`,
    ''
  ].join('\n')
  await writeFile(join(runRoot, 'summary.md'), summary)
  return report
}
