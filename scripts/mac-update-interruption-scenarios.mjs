/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { digest } from './mac-update-acceptance-core.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

// This is an observer of the product's durable admission, never a fabricated receipt.
export function validateBoundHandoff(record, bytes, expected) {
  const request = JSON.parse(bytes.toString())
  if (
    record.schema !== 1 ||
    record.channel !== 'mac-electron-updater' ||
    !['preparing', 'handoff'].includes(record.phase) ||
    record.installationRoot !== expected.appBundle ||
    record.targetVersion !== expected.targetVersion ||
    sha256(bytes) !== record.requestSha256 ||
    request.operationId !== record.operationId ||
    request.applicationPath !== record.installationRoot ||
    request.targetVersion !== record.targetVersion ||
    request.installerSha512 !== record.installerSha512 ||
    request.profilePath !== expected.profile ||
    request.startupOptions?.profilePath !== expected.profile ||
    request.startupOptions?.configRoot !== expected.configRoot ||
    request.installerPath !== join(record.handoffDirectory, 'update.zip') ||
    request.targetManifest?.version !== expected.targetVersion
  )
    throw new Error('Observed Mac handoff is not bound to this scenario and original target')
  return { record, request }
}

export async function findBoundHandoff(ctx) {
  let appBundle
  try {
    appBundle = await realpath(ctx.appBundle)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    appBundle = join(await realpath(dirname(ctx.appBundle)), basename(ctx.appBundle))
  }
  const directory = join(ctx.stateRoot ?? join(ctx.configRoot, 'installations'), sha256(appBundle))
  let record
  try {
    record = JSON.parse(await readFile(join(directory, 'windows-update-in-progress.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  const bytes = await readFile(join(record.handoffDirectory, 'request.json'))
  return validateBoundHandoff(record, bytes, { ...ctx, appBundle })
}

// Do not infer an actual file-replacement stage from the earlier handoff marker.
export function assertInterruptedStage(stage, evidence) {
  if (!evidence.ownerStopped || !evidence.originalTargetBound)
    throw new Error('Interruption lacks stopped-owner and original-target evidence')
  if (stage === 'before-install') {
    if (evidence.phase !== 'preparing' || !evidence.sourceUnchanged || evidence.writerStarted)
      throw new Error('Missed before-install interruption boundary')
  } else if (stage === 'replacing') {
    if (!evidence.writerStopped || !evidence.replacementObserved || !evidence.mainMissing)
      throw new Error('Replacement interruption needs actual writer and missing-main evidence')
  } else if (stage === 'before-target-launch') {
    if (!evidence.writerStopped || !evidence.targetInstalled || evidence.targetStarted)
      throw new Error('Missed installed-but-not-launched interruption boundary')
  } else throw new Error(`Unknown interruption stage: ${stage}`)
}

export function assertNativePause(event, expected) {
  if (
    !event ||
    event.phase !== 'native-fault-paused' ||
    event.atStage !== expected.stage ||
    event.operationId !== expected.operationId ||
    !Number.isSafeInteger(event.pid) ||
    event.pid <= 1 ||
    event.time < expected.startedAt
  )
    throw new Error('No current operation reached the requested native writer pause')
}

function createNativeWriterInterruption(id, ctx, options) {
  const stage = id === 'M09' ? 'native-recovery-runtime-absent' : 'native-recovery-installed'
  let native
  let pausedWriter
  let writerExecutable
  const base = createInterruptionScenario('M08', ctx, {
    ...options,
    openRecovery: async (_ctx, admission) => {
      const configuration = JSON.parse(
        await readFile(join(ctx.entryApp, 'Contents/Resources/mac-recovery-entry.json'), 'utf8')
      )
      if (configuration.faultInjection !== true)
        throw new Error('This signed source does not contain the diagnostic native fault gate')
      native = createRequire(import.meta.url)('@aipoch/process-tree-native')
      writerExecutable = await realpath(join(ctx.entryApp, 'Contents/MacOS/Open-Science'))
      const state = join(ctx.stateRoot, sha256(ctx.appBundle))
      const releaseFile = join(ctx.root, `${id}-unreleased-native-gate`)
      try {
        await stat(releaseFile)
        throw new Error('Native gate release file already exists')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const startedAt = Date.now()
      await ctx.openOrdinaryEntry({ pauseAt: stage, releaseFile })
      const pause = await ctx.wait(
        'actual native writer paused at requested disk phase',
        async () => {
          let text
          try {
            text = await readFile(join(state, 'mac-entry-events.ndjson'), 'utf8')
          } catch (error) {
            if (error.code === 'ENOENT') return undefined
            throw error
          }
          const lines = text.split('\n')
          lines.pop() // Only complete fsynced NDJSON lines are receipts.
          const events = lines.map((line) => JSON.parse(line))
          const event = events.findLast(
            (entry) =>
              entry.phase === 'native-fault-paused' &&
              entry.atStage === stage &&
              entry.operationId === admission.record.operationId &&
              entry.time >= startedAt
          )
          if (!event) return undefined
          assertNativePause(event, { stage, operationId: admission.record.operationId, startedAt })
          return event
        },
        110000
      )
      pausedWriter = native.getDarwinProcess(pause.pid)
      if (
        !pausedWriter ||
        native.getDarwinProcessExecutable(pause.pid, pausedWriter.uniqueId) !== writerExecutable
      )
        throw new Error('Native pause writer is not this ordinary entry process')
      // The signed diagnostic gate already stopped at the real I/O boundary. SIGSTOP additionally
      // freezes the writer while the driver independently proves the disk state before killing it.
      process.kill(pause.pid, 'SIGSTOP')
      await ctx.wait(
        'native writer stopped',
        async () =>
          (await ctx.run('/bin/ps', ['-o', 'state=', '-p', String(pause.pid)])).stdout.includes(
            'T'
          ),
        2000
      )
      const bound = await findBoundHandoff(ctx)
      if (bound?.record.operationId !== admission.record.operationId)
        throw new Error('Native recovery changed the original operation')
      let mainMissing = false
      try {
        await stat(ctx.executable)
      } catch (error) {
        if (error.code === 'ENOENT') mainMissing = true
        else throw error
      }
      const targetStarted = (await ctx.processes()).some((row) => row.executable === ctx.executable)
      let targetInstalled = false
      if (id === 'M10') {
        await ctx.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', ctx.appBundle])
        const version = (
          await ctx.run('/usr/libexec/PlistBuddy', [
            '-c',
            'Print :CFBundleShortVersionString',
            join(ctx.appBundle, 'Contents/Info.plist')
          ])
        ).stdout.trim()
        targetInstalled = version === ctx.targetVersion
      }
      const evidence = {
        stage: id === 'M09' ? 'replacing' : 'before-target-launch',
        ownerStopped: true,
        originalTargetBound: true,
        writerStopped: true,
        replacementObserved: true,
        mainMissing,
        targetInstalled,
        targetStarted,
        event: pause,
        writerUniqueId: pausedWriter.uniqueId
      }
      assertInterruptedStage(evidence.stage, evidence)
      if (!native.signalDarwinProcess(pause.pid, pausedWriter.uniqueId, 9, writerExecutable))
        throw new Error('Native writer termination was not delivered to the observed generation')
      await ctx.wait(
        'native interrupted writer exit',
        async () => native.getDarwinProcess(pause.pid)?.uniqueId !== pausedWriter.uniqueId,
        10000
      )
      ctx.report.nativeWriterInterruption = evidence
      pausedWriter = undefined
      await ctx.openOrdinaryEntry()
    }
  })
  return {
    ...base,
    async afterUpdate() {
      if (!ctx.report.nativeWriterInterruption)
        throw new Error('Native writer interruption was never proven')
    },
    async cleanup() {
      if (
        pausedWriter &&
        native.getDarwinProcess(pausedWriter.pid)?.uniqueId === pausedWriter.uniqueId
      )
        native.signalDarwinProcess(pausedWriter.pid, pausedWriter.uniqueId, 9, writerExecutable)
      await base.cleanup()
    }
  }
}

export function createInterruptionScenario(id, ctx, options = {}) {
  if (['M09', 'M10'].includes(id)) return createNativeWriterInterruption(id, ctx, options)
  if (id !== 'M08') {
    throw new Error(
      `${id}: native writer stage control is not implemented; handoff is not a replacement-stage receipt`
    )
  }
  let native
  let owner
  let stopped = false
  let killed = false
  let sourceDigest
  const stillOwner = () => {
    const current = native.getDarwinProcess(owner.pid)
    return (
      current?.uniqueId === owner.uniqueId &&
      native.getDarwinProcessExecutable(owner.pid, owner.uniqueId) === ctx.executable
    )
  }
  return {
    async beforeApply() {
      if (await findBoundHandoff(ctx))
        throw new Error('Interruption scenario requires a clean admission state')
      if (!resolve(ctx.appBundle).startsWith(resolve(ctx.root) + '/'))
        throw new Error('Refusing interruption outside disposable scenario installation')
      native = createRequire(import.meta.url)('@aipoch/process-tree-native')
      owner = native.getDarwinProcess(ctx.sourcePid)
      if (!owner || !stillOwner()) throw new Error('Cannot establish source process identity')
      sourceDigest = await digest(ctx.executable)
    },
    async apply(_ctx, defaultApply) {
      let cancelled = false
      const observation = (async () => {
        const deadline = Date.now() + 90000
        while (!cancelled && Date.now() < deadline) {
          const bound = await findBoundHandoff(ctx)
          if (!bound) {
            await delay(5)
            continue
          }
          if (bound.record.phase !== 'preparing' || !stillOwner())
            throw new Error('Missed before-install admission boundary')
          // Only the disposable runner's source is paused. Recheck the birth identity before
          // and after POSIX STOP, then use the native identity-bound operation for termination.
          process.kill(owner.pid, 'SIGSTOP')
          stopped = true
          await ctx.wait(
            'source stopped at interruption boundary',
            async () => {
              const { stdout } = await ctx.run('/bin/ps', ['-o', 'state=', '-p', String(owner.pid)])
              return stdout.trim().includes('T')
            },
            2000
          )
          if (!stillOwner()) throw new Error('Source identity changed during interruption')
          const frozen = await findBoundHandoff(ctx)
          const rows = await ctx.processes()
          const writerStarted = rows.some(
            (row) =>
              row.executable.startsWith(ctx.appBundle + '/') && /\/ShipIt$/.test(row.executable)
          )
          const evidence = {
            stage: 'before-install',
            ownerStopped: true,
            originalTargetBound: Boolean(frozen),
            phase: frozen?.record.phase,
            sourceUnchanged: sourceDigest === (await digest(ctx.executable)),
            writerStarted,
            owner: { pid: owner.pid, uniqueId: owner.uniqueId },
            operationId: frozen?.record.operationId,
            observedAt: new Date().toISOString()
          }
          assertInterruptedStage('before-install', evidence)
          if (!native.signalDarwinProcess(owner.pid, owner.uniqueId, 9, ctx.executable))
            throw new Error('Could not interrupt verified source owner')
          killed = true
          await ctx.wait('interrupted source exit', async () => !stillOwner(), 10000)
          await ctx.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', ctx.appBundle])
          ctx.report.interruption = evidence
          await ctx.registerOwnedHandoff?.(frozen)
          if (options.beforeRecovery) await options.beforeRecovery(ctx, frozen)
          if (options.openRecovery) await options.openRecovery(ctx, frozen)
          else await ctx.openOrdinaryEntry()

          return
        }
        if (!cancelled) throw new Error('No durable preparing stage was observed before deadline')
      })()
      // A CDP click can lose its connection because the actual source was interrupted. Such
      // an error is admissible only if the independent interruption observer succeeded.
      const click = Promise.resolve()
        .then(() => defaultApply())
        .then(
          () => undefined,
          (e) => e
        )
      try {
        await observation
      } finally {
        cancelled = true
      }
      const clickError = await click
      if (clickError && !killed) throw clickError
    },
    async cleanup() {
      if (stopped && !killed && stillOwner()) process.kill(owner.pid, 'SIGCONT')
    }
  }
}
