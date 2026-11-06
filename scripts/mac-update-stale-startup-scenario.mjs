/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from './mac-update-acceptance-core.mjs'
import { createInterruptionScenario } from './mac-update-interruption-scenarios.mjs'
import { assertRuntimeOwner, assertBackendDescendant } from './mac-update-target-observation.mjs'
import { assertReadableFixture } from './mac-update-fault-scenarios.mjs'

export function assertVerifiedReadyPause(receipt, ticket, expected) {
  if (
    !receipt ||
    receipt.phase !== 'verified-ready-before-cleanup' ||
    receipt.operationId !== expected.operationId ||
    ticket?.operationId !== expected.operationId ||
    receipt.installationRoot !== expected.appBundle ||
    receipt.profilePath !== expected.profile ||
    !Number.isSafeInteger(receipt.pid) ||
    receipt.pid <= 1 ||
    receipt.time < expected.startedAt
  )
    throw new Error('No real target-ready startup ticket pause was observed')
}

export function createStaleStartupScenario(ctx) {
  let before
  let stateDirectory
  const native = () => createRequire(import.meta.url)('@aipoch/process-tree-native')
  const base = createInterruptionScenario('M08', ctx, {
    openRecovery: async (_ctx, admission) => {
      const configuration = JSON.parse(
        await readFile(join(ctx.entryApp, 'Contents/Resources/mac-recovery-entry.json'), 'utf8')
      )
      if (!configuration.faultInjection)
        throw new Error('Signed diagnostic startup gate is unavailable')
      stateDirectory = join(ctx.stateRoot, createHash('sha256').update(ctx.appBundle).digest('hex'))
      const releaseFile = join(ctx.stateRoot, 'M12-unreleased-startup-gate')
      try {
        await stat(releaseFile)
        throw new Error('Startup gate release file already exists')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const startedAt = Date.now()
      await ctx.openOrdinaryEntry({ startupPause: true, releaseFile })
      const paused = await ctx.wait(
        'target data/window verified before actual ticket cleanup',
        async () => {
          const receipt = JSON.parse(
            await readFile(join(stateDirectory, 'mac-verified-ready-pause.json'), 'utf8')
          )
          const ticket = JSON.parse(
            await readFile(join(stateDirectory, 'verified-startup.json'), 'utf8')
          )
          assertVerifiedReadyPause(receipt, ticket, {
            ...ctx,
            operationId: admission.record.operationId,
            startedAt
          })
          const candidate = (await ctx.processes()).find(
            (row) => row.pid === receipt.pid && row.executable === ctx.executable
          )
          if (!candidate) return undefined
          return { receipt, ticket, candidate }
        },
        110000
      )
      const connection = await ctx.connect(ctx.profile, paused.candidate.pid)
      const data = await ctx.readFixture(connection.page, ctx.fixture)
      const bootstrap = await ctx.readBackend(ctx.configRoot)
      assertReadableFixture(data, ctx.fixture)
      const ownerRecord = JSON.parse(
        await readFile(join(ctx.configRoot, 'runtime-owner.json'), 'utf8')
      )
      const token = (await readFile(join(ctx.configRoot, 'web-token'), 'utf8')).trim()
      const response = await fetch(`http://127.0.0.1:${ownerRecord.port}/owner`, {
        headers: {
          authorization: `Bearer ${token}`,
          'x-open-science-runtime-generation': ownerRecord.generation
        },
        signal: AbortSignal.timeout(15000)
      })
      if (!response.ok) throw new Error('Paused target backend is unavailable')
      const owner = await response.json()
      assertRuntimeOwner(ownerRecord, owner, bootstrap, ctx)
      const binding = assertBackendDescendant(native(), paused.candidate, owner.pid, ctx.appBundle)
      const window = await ctx.nativeWindow(paused.candidate.pid)
      if (window.onScreenWindows < 1) throw new Error('Paused verified target has no real window')
      await connection.page.screenshot({
        path: join(ctx.output, 'M12-target-verified-before-cleanup.png')
      })
      await ctx.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', ctx.appBundle])
      const targetIdentity = native().getDarwinProcess(paused.candidate.pid)
      if (
        !targetIdentity ||
        native().getDarwinProcessExecutable(targetIdentity.pid, targetIdentity.uniqueId) !==
          (await realpath(ctx.executable))
      )
        throw new Error('Paused target process identity changed')
      before = {
        executableSha256: await digest(ctx.executable),
        packageBytes: ctx.feed.metrics.packageBytes,
        eventBytes: (await readFile(join(stateDirectory, 'mac-entry-events.ndjson'))).length
      }
      ctx.report.staleStartup = {
        receipt: paused.receipt,
        operationId: admission.record.operationId,
        nativeWindow: window,
        backendVersion: bootstrap.appVersion,
        profilePath: owner.startupOptions.profilePath,
        data,
        before
      }
      // If the verified target's service survives the Desktop interruption, accepting its later
      // adoption requires this exact observed birth identity and runtime generation, not a PID.
      ctx.previouslyVerifiedBackend = { ...binding, generation: owner.generation }
      if (
        !native().signalDarwinProcess(
          targetIdentity.pid,
          targetIdentity.uniqueId,
          9,
          ctx.executable
        )
      )
        throw new Error('Could not interrupt the verified-ready target')
      await ctx.wait(
        'verified target interrupted with its real ticket retained',
        async () =>
          native().getDarwinProcess(targetIdentity.pid)?.uniqueId !== targetIdentity.uniqueId,
        10000
      )
      const retained = JSON.parse(
        await readFile(join(stateDirectory, 'verified-startup.json'), 'utf8')
      )
      if (retained.operationId !== admission.record.operationId)
        throw new Error('Real startup ticket was lost before restart')
      await ctx.openOrdinaryEntry()
    }
  })
  return {
    ...base,
    async afterUpdate() {
      if (
        !before ||
        (await digest(ctx.executable)) !== before.executableSha256 ||
        ctx.feed.metrics.packageBytes !== before.packageBytes
      )
        throw new Error('Stale ready-state recovery replaced or redownloaded the completed target')
      const events = (await readFile(join(stateDirectory, 'mac-entry-events.ndjson')))
        .subarray(before.eventBytes)
        .toString()
      if (
        /native-recovery-(?:staged|before-publish|runtime-absent|installed|cache-downloaded)/.test(
          events
        )
      )
        throw new Error('Stale startup completion unnecessarily reran installation')
      ctx.report.staleStartup.completedWithoutReinstall = true
    }
  }
}
