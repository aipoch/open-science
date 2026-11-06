/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASK_MARKER } from './mac-update-task-agent.mjs'

export const PROCESS_SCENARIOS = ['M03', 'M04', 'M05', 'M06']
const require = createRequire(import.meta.url)
const native = () => require('@aipoch/process-tree-native')
const inside = (root, path) => {
  const offset = relative(root, path)
  return offset !== '' && !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)
}
export function assertIsolatedPaths(ctx) {
  for (const path of [ctx.configRoot, ctx.profile])
    if (!inside(ctx.root, path))
      throw new Error('Scenario storage must remain inside the disposable root')
}
export function assertTaskWitness(value, expected) {
  if (
    !value ||
    value.kind !== expected.kind ||
    value.nonce !== expected.nonce ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1
  )
    throw new Error('Real task witness is missing, malformed, or belongs to another task')
  return value
}
export function assertTaskStop(before, current) {
  if (current?.uniqueId === before.uniqueId)
    throw new Error(`Managed ${before.kind} process survived update`)
}
export function rendererSaveFailureObserved(events) {
  return events.some((event) => {
    if (event.step !== 'product-shutdown-diagnostics') return false
    try {
      const data = JSON.parse(event.diagnostics)
      return (Array.isArray(data) ? data : [data]).some(
        (entry) =>
          ['renderer-preflight', 'renderer-final'].includes(entry?.step) &&
          entry.outcome === 'failed'
      )
    } catch {
      return false
    }
  })
}
function currentCapturedProcess(entry) {
  const current = native().getDarwinProcess(entry.pid)
  if (current) return current
  try {
    process.kill(entry.pid, 0)
  } catch (error) {
    if (error.code === 'ESRCH') return null
  }
  // An unreadable live process is not proof of stop.
  return { uniqueId: entry.uniqueId, unknown: true }
}
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
async function launchPeer(ctx, configRoot, profile, purpose) {
  const child = await ctx.launchSameInstallation({ configRoot, profile, purpose })
  if (child.page && child.browser && child.pid) return child
  const connection = await ctx.wait('participating profile desktop', () =>
    ctx.connect(profile, child.pid)
  )
  return { ...connection, pid: child.pid }
}

async function runtimeIdentity(configRoot) {
  const owner = JSON.parse(await readFile(join(configRoot, 'runtime-owner.json'), 'utf8'))
  const token = (await readFile(join(configRoot, 'web-token'), 'utf8')).trim()
  const response = await fetch(`http://127.0.0.1:${owner.port}/owner`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-open-science-runtime-generation': owner.generation
    },
    signal: AbortSignal.timeout(5000)
  })
  if (!response.ok) throw new Error('Cannot prove the service owner identity')
  const value = await response.json()
  if (
    value.pid !== owner.pid ||
    value.generation !== owner.generation ||
    !value.startupOptions?.profilePath
  )
    throw new Error('Service ownership evidence changed')
  // Never put desktop attachment secrets, web token or raw owner record into the report.
  return {
    pid: value.pid,
    generation: value.generation,
    profilePath: value.startupOptions.profilePath
  }
}

async function configureTaskProvider(page) {
  return page.evaluate(async () => {
    const name = 'Mac update deterministic task provider'
    const settings = await window.api.settings.upsertProvider({
      type: 'custom',
      name,
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'mac-update-task',
      key: 'disposable-fixture-key',
      apiEndpoints: ['chat-completions'],
      supportsImageInput: false
    })
    const provider = settings.providers.find((entry) => entry.name === name)
    if (!provider) throw new Error('Task provider was not persisted through the app')
    await window.api.settings.setActiveProvider({ id: provider.id, model: 'mac-update-task' })
    await window.api.settings.setAgentFramework({ id: 'opencode' })
    await window.api.settings.setDefaultPermissionProfile({ profile: 'full' })
    const python = (await window.api.runtime.listEnvironments()).python.find(
      (entry) => entry.runnable
    )
    if (!python) throw new Error('No real runnable Python interpreter detected for task acceptance')
    await window.api.runtime.setEnvironmentEnabled('python', python.envId, true)
    const access = await window.api.runtime.setSandboxAccess('python', python.envId, true)
    if (access.cancelled) throw new Error('Real Python sandbox access was not authorized')
    const sandbox = await window.api.settings.getNotebookNetworkStatus()
    if (sandbox.kind !== 'ready')
      throw new Error(`Real Notebook sandbox is unavailable: ${sandbox.kind}`)
    return { python: { envId: python.envId, interpreterPath: python.interpreterPath }, sandbox }
  })
}

async function startTasks(ctx, active, report) {
  report.runtime = await configureTaskProvider(ctx.page)
  const workspace = join(await realpath(ctx.root), 'real-task-workspace')
  await mkdir(workspace, { recursive: true })
  const work = []
  report.tasks = work
  report.agents = []
  for (const kind of ['python', 'repl', 'bash']) {
    const nonce = randomUUID()
    const agentWitness = join(workspace, `provider-${nonce}.json`)
    const session = await ctx.page.evaluate(
      async ({ projectId, cwd }) =>
        window.api.acp.createSession({
          projectId,
          cwd,
          permissionProfile: 'full',
          memoryEnabled: false
        }),
      { projectId: ctx.fixture.project.id, cwd: workspace }
    )
    const initial = await ctx.page.evaluate((scope) => window.api.notebook.state(scope), {
      sessionId: session.sessionId,
      projectId: ctx.fixture.project.id,
      workspaceCwd: workspace
    })
    const dataRoot = await realpath(initial.dataRoot)
    if (!inside(await realpath(ctx.root), dataRoot))
      throw new Error('Notebook task data root escaped the fixture')
    const witness = join(dataRoot, `${kind}-${nonce}.json`)
    const request = { kind, active, witness, nonce, agentWitness }
    // The fixture supplies a deterministic provider response, not a fake Notebook service. Real
    // app-issued MCP capabilities are the only path the external agent gets to launch these tasks.
    const prompting = ctx.page
      .evaluate(({ sessionId, text }) => window.api.acp.sendPrompt({ sessionId, text }), {
        sessionId: session.sessionId,
        text: TASK_MARKER + Buffer.from(JSON.stringify(request)).toString('base64')
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error })
      )
    // A failed MCP launch can leave an external provider running without any kernel witness.
    // Capture its process-generation receipt separately before waiting for prompt completion.
    const provider = await ctx.wait(
      'real task provider identity',
      async () => {
        const value = assertTaskWitness(JSON.parse(await readFile(agentWitness, 'utf8')), {
          kind: 'provider',
          nonce
        })
        const identity = native().getDarwinProcess(value.pid)
        if (!identity) return false
        return {
          ...value,
          uniqueId: identity.uniqueId,
          executablePath: native().getDarwinProcessExecutable(value.pid, identity.uniqueId)
        }
      },
      30000
    )
    report.agents.push(provider)
    const prompted = await prompting
    if ('error' in prompted) throw prompted.error
    const evidence = await ctx.wait(
      `real ${kind} execution witness`,
      async () => {
        const value = assertTaskWitness(JSON.parse(await readFile(witness, 'utf8')), request)
        // Shell commands are stateless. A completed command's $$ is historical evidence, not a
        // resident process to require alive or to grant later termination authority.
        const identity = !active && kind === 'bash' ? null : native().getDarwinProcess(value.pid)
        if (!identity && (active || kind !== 'bash'))
          throw new Error(`Real ${kind} process exited before update`)
        return {
          ...value,
          ...(identity
            ? {
                uniqueId: identity.uniqueId,
                executablePath: native().getDarwinProcessExecutable(value.pid, identity.uniqueId)
              }
            : { resident: false }),
          sessionId: session.sessionId,
          projectId: ctx.fixture.project.id,
          witness
        }
      },
      120000
    )
    const run = await ctx.wait(
      `real ${kind} application run status`,
      async () => {
        const state = await ctx.page.evaluate((scope) => window.api.notebook.state(scope), {
          sessionId: session.sessionId,
          projectId: ctx.fixture.project.id,
          workspaceCwd: workspace
        })
        return state.runs.find(
          (entry) =>
            entry.kernelKind === kind && entry.status === (active ? 'running' : 'completed')
        )
      },
      120000
    )
    work.push({ ...evidence, runId: run.runId, statusBefore: run.status })
  }
  // Positive sandbox evidence: status above comes from its real owner; capture that the shipped
  // sandbox implementation participates in this live process tree without retaining raw argv.
  report.sandbox = {
    ready: true,
    taskKinds: work.map((entry) => entry.kind),
    purpose: 'Actual packaged notebook, REPL and sandboxed Shell capability calls'
  }
  const backend = await runtimeIdentity(ctx.configRoot)
  const host = native().getDarwinProcess(backend.pid)
  if (!host) throw new Error('Real sandbox owner host is not alive')
  report.sandbox.ownerHost = {
    kind: 'sandbox-owner-host',
    pid: host.pid,
    uniqueId: host.uniqueId,
    executablePath: native().getDarwinProcessExecutable(host.pid, host.uniqueId)
  }
  return work
}

function liveFixtureDescendants(appBundle) {
  const binding = native()
  const table = binding.listDarwinProcesses()
  if (!table?.complete) throw new Error('Fixture cleanup process coverage is unknown')
  const rows = table.processes.flatMap((entry) => {
    const executablePath = binding.getDarwinProcessExecutable(entry.pid, entry.uniqueId)
    return executablePath ? [{ ...entry, executablePath }] : []
  })
  const selected = new Map(
    rows
      .filter((entry) => entry.executablePath.startsWith(appBundle + '/'))
      .map((entry) => [entry.uniqueId, entry])
  )
  let changed = true
  while (changed) {
    changed = false
    for (const entry of rows) {
      if (selected.has(entry.uniqueId)) continue
      if (
        /\.app\//i.test(entry.executablePath) &&
        !entry.executablePath.startsWith(appBundle + '/')
      ) {
        const script = binding.getDarwinProcessArguments(entry.pid)?.at(-1)
        if (
          !/^(?:python(?:\d+(?:\.\d+)*)?|r(?:script)?|node|electron)$/i.test(
            basename(entry.executablePath)
          ) ||
          !script?.startsWith(appBundle + '/Contents/Resources/') ||
          !/\/(?:app\.asar\.unpacked\/)?resources\/notebook\/(?:python_loop\.py|r_loop\.R|repl_loop\.js)$/.test(
            script
          )
        )
          continue
      }
      const parent = selected.get(entry.parentUniqueId)
      if (parent && (entry.ppid === parent.pid || entry.ppid === 1)) {
        selected.set(entry.uniqueId, entry)
        changed = true
      }
    }
  }
  return [...selected.values()]
}

export function createProcessScenario(id, ctx) {
  if (!PROCESS_SCENARIOS.includes(id)) throw new Error('Unknown process scenario')
  assertIsolatedPaths(ctx)
  const evidence = {
    id,
    status: 'not-run',
    level: 'signed-package-required',
    events: [],
    tasks: []
  }
  ctx.report.processScenario = evidence
  let peer
  let peerIdentity
  let peerFixture
  let stopAt
  let closeSampler
  const capturedTargets = () => [
    ...evidence.tasks.filter((entry) => entry.uniqueId),
    ...(evidence.sandbox?.ownerHost ? [evidence.sandbox.ownerHost] : []),
    ...(evidence.participantProcesses ?? []),
    ...(peerIdentity ? [{ ...peerIdentity, kind: 'peer' }] : [])
  ]
  return {
    async prepareLaunch() {
      if (!['M03', 'M05'].includes(id)) return
      const launcher = join(ctx.root, 'task-provider', 'opencode')
      await mkdir(dirname(launcher), { recursive: true })
      const script = fileURLToPath(new URL('./mac-update-task-agent.mjs', import.meta.url))
      await writeFile(
        launcher,
        `#!/bin/sh\nexport OPEN_SCIENCE_MAC_ACCEPTANCE_ROOT=${shellQuote(await realpath(ctx.root))}\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
        { mode: 0o700, flag: 'wx' }
      )
      await mkdir(ctx.configRoot, { recursive: true })
      await writeFile(
        join(ctx.configRoot, 'settings.json'),
        JSON.stringify({
          opencodePath: launcher,
          opencodeVersion: '1.0.0',
          localePreference: 'en',
          sessionDetailsModel: { mode: 'disabled' },
          defaultPermissionProfile: 'full'
        }),
        { flag: 'wx', mode: 0o600 }
      )
      evidence.provider = { path: script, mode: 'deterministic-ACP-real-MCP' }
    },
    async beforeDownload() {
      if (id !== 'M04') return
      const before = await runtimeIdentity(ctx.configRoot)
      evidence.participantProcesses = [ctx.sourcePid, before.pid].map((pid) => {
        const process = native().getDarwinProcess(pid)
        if (!process) throw new Error('Original participating process identity is unavailable')
        return { kind: 'participating-owner', pid, uniqueId: process.uniqueId }
      })
      const profile = join(ctx.root, 'participating-profile')
      peer = await launchPeer(ctx, ctx.configRoot, profile)
      peerFixture = await ctx.prepareProfile({ page: peer.page, label: 'M04 peer original data' })
      const after = await runtimeIdentity(ctx.configRoot)
      if (
        before.pid !== after.pid ||
        before.generation !== after.generation ||
        before.profilePath === profile
      )
        throw new Error('Non-service-owner scenario did not attach to the existing owner')
      if (typeof ctx.setInitiator !== 'function')
        throw new Error('Runner must support non-owner initiator selection')
      evidence.participants = { originalOwner: before, initiatingProfile: profile, peerFixture }
      await ctx.setInitiator({ page: peer.page, browser: peer.browser, pid: peer.pid, profile })
      evidence.events.push({ step: 'non-owner-selected', at: Date.now() })
    },
    async beforeApply() {
      if (id === 'M03' || id === 'M05') await startTasks(ctx, id === 'M05', evidence)
      await ctx.page.exposeBinding('__macUpdateLifecycleWitness', (_, event) => {
        evidence.events.push(event)
        if (event.step !== 'product-close-start' || evidence.closeStartedAt !== undefined) return
        evidence.closeStartedAt = event.at
        stopAt = event.at
        const sample = () => {
          try {
            if (
              capturedTargets().every(
                (entry) => currentCapturedProcess(entry)?.uniqueId !== entry.uniqueId
              )
            )
              evidence.closeElapsedMs = Date.now() - stopAt
            else if (Date.now() - stopAt > 25000) evidence.closeExceeded = true
          } catch (error) {
            evidence.closeInspectionError = error.message
          }
          if (
            evidence.closeElapsedMs !== undefined ||
            evidence.closeExceeded ||
            evidence.closeInspectionError
          ) {
            clearInterval(closeSampler)
            closeSampler = undefined
          }
        }
        closeSampler = setInterval(sample, 50)
        closeSampler.unref()
        sample()
      })
      await ctx.page.evaluate(() => {
        window.api.update.onStatus((status) => {
          if (status.recovery?.phase === 'stopping')
            void window.__macUpdateLifecycleWitness({ step: 'product-close-start', at: Date.now() })
        })
      })
      if (id === 'M05') {
        await ctx.page.exposeBinding('__macUpdateFlushFault', (_, event) =>
          evidence.events.push(event)
        )
        await ctx.page.evaluate(() => {
          if (!window.api.sessions.onFlushRequest || !window.api.sessions.sendFlushResponse)
            throw new Error('Real renderer flush protocol unavailable')
          window.api.sessions.onFlushRequest((request) => {
            window.api.sessions.sendFlushResponse({
              requestId: request.requestId,
              status: 'failed'
            })
            void window.__macUpdateFlushFault({
              step: 'renderer-save-failed-response',
              requestId: request.requestId,
              at: Date.now()
            })
          })
          window.api.update.onStatus((status) => {
            if (status.diagnostics)
              void window.__macUpdateFlushFault({
                step: 'product-shutdown-diagnostics',
                diagnostics: status.diagnostics,
                at: Date.now()
              })
          })
        })
      }
      if (id === 'M06') {
        const configRoot = join(ctx.root, 'unresponsive-peer-data')
        const profile = join(ctx.root, 'unresponsive-peer-profile')
        peer = await launchPeer(ctx, configRoot, profile)
        peerFixture = await ctx.prepareProfile({
          page: peer.page,
          label: 'M06 unresponsive original data'
        })
        peerIdentity = native().getDarwinProcess(peer.pid)
        const actual = native().getDarwinProcessExecutable(peer.pid, peerIdentity?.uniqueId)
        const expected = await realpath(ctx.executable)
        if (!peerIdentity || actual !== expected)
          throw new Error('Cannot prove same-installation peer before SIGSTOP')
        if (native().getDarwinProcessExecutable(peer.pid, peerIdentity.uniqueId) !== expected)
          throw new Error('Peer changed identity during unresponsive-fault preparation')
        process.kill(peer.pid, 'SIGSTOP')
        const status = await ctx.run('/bin/ps', ['-o', 'stat=', '-p', String(peer.pid)])
        if (!status.stdout.includes('T'))
          throw new Error('Unresponsive peer fault did not take effect')
        evidence.peer = {
          pid: peer.pid,
          uniqueId: peerIdentity.uniqueId,
          configRoot,
          profile,
          fixture: peerFixture
        }
        evidence.events.push({ step: 'verified-peer-SIGSTOP', at: Date.now() })
      }
      stopAt = Date.now()
      evidence.status = 'armed'
    },
    async afterApply() {
      const targets = capturedTargets()
      if (!targets.length) return
      await ctx.wait(
        'bounded application-owned shutdown',
        () =>
          evidence.closeElapsedMs !== undefined ||
          evidence.closeExceeded ||
          evidence.closeInspectionError,
        120000
      )
      if (evidence.closeInspectionError)
        throw new Error('Shutdown observation unknown: ' + evidence.closeInspectionError)
      if (evidence.closeExceeded || evidence.closeElapsedMs > 25000)
        throw new Error(
          'Application process close exceeded its 20s budget plus 5s observation tolerance'
        )
      evidence.events.push({ step: 'all-captured-generations-stopped', at: Date.now() })
    },
    async afterUpdate() {
      for (const task of evidence.tasks) {
        if (task.uniqueId) assertTaskStop(task, currentCapturedProcess(task))
        assertTaskWitness(JSON.parse(await readFile(task.witness, 'utf8')), task)
      }
      if (evidence.sandbox?.ownerHost)
        assertTaskStop(
          evidence.sandbox.ownerHost,
          currentCapturedProcess(evidence.sandbox.ownerHost)
        )
      if (id === 'M05') {
        const failed = evidence.events.some(
          (event) => event.step === 'renderer-save-failed-response'
        )
        const accepted = rendererSaveFailureObserved(evidence.events)
        if (!failed || !accepted)
          throw new Error('Save failure was not observed by the real update shutdown')
      }
      if (id === 'M04') {
        if (!ctx.readTargetFixture)
          throw new Error('Independent target data observation is unavailable')
        const data = await ctx.readTargetFixture(peerFixture)
        if (
          !data.projects.some(
            (entry) =>
              entry.id === peerFixture.project.id && entry.name === peerFixture.project.name
          ) ||
          data.session?.messages?.[0]?.content !== peerFixture.session.content
        )
          throw new Error('Participating profile saved contents were not readable after update')
      }
      if (id === 'M06') {
        if (native().getDarwinProcess(peer.pid)?.uniqueId === peerIdentity.uniqueId)
          throw new Error('Unresponsive peer survived application update')
        // The harness may reopen this participant only after the main successor has independently
        // passed automatic-launch checks, solely to read its already persisted data.
        const reopened = await launchPeer(
          ctx,
          evidence.peer.configRoot,
          evidence.peer.profile,
          'participant-data-verification'
        )
        const data = await ctx.readFixture(reopened.page, peerFixture)
        if (data.session?.messages?.[0]?.content !== peerFixture.session.content)
          throw new Error('Unresponsive participant saved data was lost')
      }
      evidence.updateObservedAfterMs = Date.now() - stopAt
      evidence.status = 'passed'
    },
    async cleanup() {
      if (closeSampler) {
        clearInterval(closeSampler)
        closeSampler = undefined
      }
      if (
        peerIdentity &&
        native().getDarwinProcess(peerIdentity.pid)?.uniqueId === peerIdentity.uniqueId
      ) {
        // Resume only our captured generation so the runner's normal identity-checked cleanup can
        // settle a failed scenario. This is never used to manufacture update success.
        process.kill(peerIdentity.pid, 'SIGCONT')
        evidence.events.push({ step: 'failed-scenario-peer-resumed-for-cleanup', at: Date.now() })
      }
      const targets = [...evidence.tasks, ...(evidence.agents ?? [])].filter(
        (entry) => entry.pid && entry.uniqueId && entry.executablePath
      )
      let inspectionError
      try {
        targets.push(...liveFixtureDescendants(await realpath(ctx.appBundle)))
      } catch (error) {
        inspectionError = error
      }
      for (const entry of targets)
        if (native().getDarwinProcess(entry.pid)?.uniqueId === entry.uniqueId)
          native().signalDarwinProcess(entry.pid, entry.uniqueId, 9, entry.executablePath)
      await ctx.wait(
        'captured fixture workload cleanup',
        () =>
          targets.every(
            (entry) => native().getDarwinProcess(entry.pid)?.uniqueId !== entry.uniqueId
          ),
        5000
      )
      if (inspectionError) throw inspectionError
      evidence.events.push({
        step: 'identity-checked-fixture-cleanup',
        at: Date.now(),
        count: targets.length
      })
    }
  }
}
