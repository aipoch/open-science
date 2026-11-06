/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { lstat, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { digest } from './mac-update-acceptance-core.mjs'
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
export const assertFaultHit = (evidence, kind) => {
  if (
    !evidence?.hit ||
    evidence.kind !== kind ||
    !evidence.pid ||
    !evidence.identity ||
    !evidence.observedAt
  )
    throw new Error(`Fault injection was not observed: ${kind}`)
}
export const assertBlocked = (status, targetVersion) => {
  if (
    !status?.error ||
    status.latest !== targetVersion ||
    status.state === 'applying' ||
    ['success', 'installed'].includes(status.outcome)
  )
    throw new Error('Real blocker was not surfaced with its original target intact')
}
export const assertReadableFixture = (data, fixture) => {
  if (
    data.projects?.find((p) => p.id === fixture.project.id)?.name !== fixture.project.name ||
    data.session?.id !== fixture.session.id ||
    data.session.messages?.[0]?.content !== fixture.session.content
  )
    throw new Error('Saved fixture content is no longer readable')
}
const readStatus = (ctx) =>
  ctx.readStatus ? ctx.readStatus() : ctx.page.evaluate(() => window.api.update.getStatus())
// Observe real child scanner birth before signalling. Never corrupt signed resources or replace
// scanner output, and never signal a PID identified only by its historical numeric value.
export const watchScannerFaults = (ctx, persistent = false) => {
  let done = false
  let failure
  const hits = []
  const native = ctx.native || createRequire(import.meta.url)('@aipoch/process-tree-native')
  const task = (async () => {
    while (!done) {
      try {
        for (const row of await ctx.processes()) {
          if (
            row.ppid !== ctx.sourcePid ||
            hits.some((h) => h.identity === `${row.pid}:${row.startedAt}:${row.executable}`)
          )
            continue
          const primary =
            row.executable === '/usr/sbin/lsof' || (persistent && row.executable === '/bin/ps')
          let alternate = false
          if (persistent && row.executable === ctx.executable) {
            const args = (
              await ctx.run('/bin/ps', ['-ww', '-p', String(row.pid), '-o', 'command='])
            ).stdout
            alternate = args.includes('native.listDarwinInstallationMappings(process.argv[2])')
          }
          if (!primary && !alternate) continue
          const current = (await ctx.processes()).find((p) => p.pid === row.pid)
          if (
            !current ||
            current.ppid !== row.ppid ||
            current.startedAt !== row.startedAt ||
            current.executable !== row.executable
          )
            continue
          const birth = native.getDarwinProcess(row.pid)
          if (
            !birth ||
            native.getDarwinProcessExecutable(row.pid, birth.uniqueId) !== row.executable
          )
            continue
          if (persistent) {
            if (!native.signalDarwinProcess(row.pid, birth.uniqueId, 9, row.executable)) continue
          } else process.kill(row.pid, 'SIGSTOP')
          const evidence = {
            kind: persistent ? 'scanner-exit' : 'scanner-timeout',
            hit: true,
            pid: row.pid,
            identity: `${row.pid}:${row.startedAt}:${row.executable}`,
            executable: row.executable,
            uniqueId: birth.uniqueId,
            alternate,
            observedAt: new Date().toISOString()
          }
          hits.push(evidence)
          if (!persistent) {
            done = true
            return
          }
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          failure = error
          return
        }
      }
      await delay(5)
    }
  })()
  return {
    hits,
    cleanup: async () => {
      done = true
      await task
      for (const hit of hits)
        if (native.getDarwinProcess(hit.pid)?.uniqueId === hit.uniqueId)
          native.signalDarwinProcess(hit.pid, hit.uniqueId, 9, hit.executable)
    },
    assertReaped: () => {
      if (hits.some((hit) => native.getDarwinProcess(hit.pid)?.uniqueId === hit.uniqueId))
        throw new Error('Product left an injected scanner alive')
    },
    stop: async () => {
      done = true
      await task
      if (failure) throw failure
    }
  }
}
const commonSourceReady = async (ctx) => {
  const source = (await ctx.processes()).find((p) => p.pid === ctx.sourcePid)
  const backend = await ctx.readBackend(ctx.configRoot)
  const fixture = await ctx.readFixture(ctx.page, ctx.fixture)
  const window = await ctx.nativeWindow(ctx.sourcePid)
  if (
    !source ||
    backend.appVersion !== ctx.sourceVersion ||
    backend.configRoot !== ctx.configRoot ||
    window.onScreenWindows < 1
  )
    throw new Error('Source did not remain usable after cancellation or blocker')
  assertReadableFixture(fixture, ctx.fixture)
  return { process: source, backend, window, fixture }
}
export async function validateOwnedHandoff(ctx, bound) {
  const directory = bound.record.handoffDirectory
  const info = await lstat(directory)
  const expectedParent = await realpath(join(ctx.appDataRoot, 'mac-update-handoffs'))
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    dirname(directory) !== expectedParent ||
    !/^operation-[A-Za-z0-9_-]+$/.test(basename(directory)) ||
    (await realpath(directory)) !== directory
  )
    throw new Error('Refusing a handoff outside the actual account operation directory')
  if (
    !resolve(ctx.appBundle).startsWith(resolve(ctx.root) + '/') ||
    bound.record.installationRoot !== ctx.appBundle ||
    bound.request.applicationPath !== ctx.appBundle ||
    bound.request.profilePath !== ctx.profile ||
    bound.request.startupOptions?.configRoot !== ctx.configRoot ||
    bound.record.operationId !== bound.request.operationId ||
    bound.record.targetVersion !== ctx.targetVersion ||
    bound.request.targetVersion !== ctx.targetVersion ||
    bound.request.installerPath !== join(directory, 'update.zip')
  )
    throw new Error('Handoff is not bound to this isolated installation, profile and operation')
  const requestPath = join(directory, 'request.json')
  const requestInfo = await lstat(requestPath)
  if (
    requestInfo.isSymbolicLink() ||
    !requestInfo.isFile() ||
    (await digest(requestPath)) !== bound.record.requestSha256
  )
    throw new Error('Original handoff request binding changed')
  return directory
}
export async function corruptRetainedPackage(ctx, bound) {
  const directory = await validateOwnedHandoff(ctx, bound)
  const fileInfo = await lstat(bound.request.installerPath)
  const path = await realpath(bound.request.installerPath)
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || path !== join(directory, 'update.zip'))
    throw new Error('Refusing cache fault outside the bound retained package')
  await ctx.registerOwnedHandoff?.(bound)
  const requestPath = join(directory, 'request.json')
  const requestBefore = await digest(requestPath)
  if (requestBefore !== bound.record.requestSha256)
    throw new Error('Original target request was not bound before cache fault')
  const bytesBefore = ctx.feed.metrics.packageBytes
  const original = await digest(path)
  const info = await stat(path)
  if (info.size < 1) throw new Error('Cannot corrupt an unobserved or empty retained package')
  await writeFile(path, 'deliberately damaged retained original update package')
  const damaged = await digest(path)
  if (original === damaged) throw new Error('Retained cache fault did not change bytes')
  const requestUnchanged = requestBefore === (await digest(requestPath))
  if (!requestUnchanged)
    throw new Error('Original target request changed during cache corruption injection')
  ctx.report.cacheFault = {
    originalSha256: original,
    damagedSha256: damaged,
    originalSize: info.size,
    targetVersion: bound.request.targetVersion,
    originalSha512: bound.request.installerSha512,
    requestUnchanged,
    downloadBytesBefore: bytesBefore,
    injected: true
  }
}
export async function loadMacUpdateScenario(id, ctx) {
  if (id === 'M01') return {}
  if (['M03', 'M04', 'M05', 'M06'].includes(id))
    return (await import('./mac-update-process-scenarios.mjs')).createProcessScenario(id, ctx)
  if (['M08', 'M09', 'M10'].includes(id))
    return (await import('./mac-update-interruption-scenarios.mjs')).createInterruptionScenario(
      id,
      ctx
    )
  if (id === 'M11') {
    const base = (
      await import('./mac-update-interruption-scenarios.mjs')
    ).createInterruptionScenario('M08', ctx, { beforeRecovery: corruptRetainedPackage })
    return {
      ...base,
      afterUpdate: async () => {
        if (
          !ctx.report.cacheFault?.injected ||
          ctx.feed.metrics.packageBytes <= ctx.report.cacheFault.downloadBytesBefore
        )
          throw new Error(
            'Cache recovery did not fetch the original package after the observed corruption'
          )
      }
    }
  }
  if (id === 'M12')
    return (await import('./mac-update-stale-startup-scenario.mjs')).createStaleStartupScenario(ctx)
  if (id === 'M02' || id === 'M13') {
    let watcher
    return {
      beforeApply() {
        watcher = watchScannerFaults(ctx, id === 'M13')
      },
      async apply(_ctx, defaultApply) {
        await defaultApply()
        if (id === 'M13') {
          const blocked = await ctx.wait(
            'persistent inspection failure shown in real update status',
            async () => {
              const status = await readStatus(ctx)
              return status.error ? status : undefined
            },
            90000
          )
          await watcher.stop()
          if (
            watcher.hits.filter((hit) => !hit.alternate).length < 2 ||
            !watcher.hits.some((hit) => hit.alternate)
          )
            throw new Error(
              'Persistent fault did not reach both primary attempts and the independent native scanner'
            )
          assertBlocked(blocked, ctx.targetVersion)
          ctx.report.blocked = { status: blocked, sourceReady: await commonSourceReady(ctx) }
          ctx.report.scannerFaults = watcher.hits
          await ctx.page.screenshot({ path: join(ctx.output, 'blocked-query.png') })
          // Removing the external observer is the fault repair; use the same real UI action.
          await defaultApply()
        }
      },
      async afterUpdate() {
        await watcher.stop()
        watcher.assertReaped()
        assertFaultHit(watcher.hits[0], id === 'M02' ? 'scanner-timeout' : 'scanner-exit')
        if (!(await ctx.readProductLogs()).includes('Mac installation occupancy inspection failed'))
          throw new Error('Product did not record the injected query failure')
        ctx.report.scannerFaults = watcher.hits
      },
      async cleanup() {
        await watcher?.cleanup()
      }
    }
  }
  if (id === 'M07') {
    return {
      beforeDownload() {
        ctx.feed.holdPackages()
      },
      async duringDownload() {
        const transfers = await ctx.wait(
          'real package transfer held before user cancellation',
          async () => (ctx.feed.heldTransfers().length ? ctx.feed.heldTransfers() : undefined)
        )
        const before = await readStatus(ctx)
        if (before.state !== 'downloading')
          throw new Error('Download cancellation fault was not reached')
        await ctx.page.getByRole('button', { name: 'Cancel', exact: true }).click()
        const cancelled = await ctx.wait('download cancelled through real UI', async () => {
          const status = await readStatus(ctx)
          return status.state === 'available' ? status : undefined
        })
        if (
          cancelled.latest !== ctx.targetVersion ||
          ['success', 'installed'].includes(cancelled.outcome)
        )
          throw new Error('Cancellation lost the original target or falsely completed installation')
        ctx.report.cancellation = {
          heldTransfers: transfers,
          status: cancelled,
          sourceReady: await commonSourceReady(ctx)
        }
        await ctx.page.screenshot({ path: join(ctx.output, 'cancelled-source-ready.png') })
        ctx.feed.releasePackages()
        await ctx.page
          .getByRole('button', { name: `Update to ${ctx.targetVersion}`, exact: true })
          .click()
        await ctx.page.getByRole('button', { name: /^Download update/ }).click()
      },
      async afterDownloaded() {
        await ctx.page.getByRole('button', { name: 'Close', exact: true }).last().click()
        const ready = await readStatus(ctx)
        if (
          ready.state !== 'ready' ||
          ready.latest !== ctx.targetVersion ||
          ['installed', 'success'].includes(ready.outcome)
        )
          throw new Error('Closing ready dialog lost the accepted offer or started installation')
        ctx.report.cancellation.readyDialogDismissal = {
          status: ready,
          sourceReady: await commonSourceReady(ctx)
        }
        await ctx.page.getByRole('button', { name: 'Update ready', exact: true }).click()
      },
      async beforeApply() {
        const boundary = []
        ctx.page.on('console', (message) => {
          if (message.text().startsWith('MAC_UPDATE_CANCEL_BOUNDARY '))
            boundary.push(JSON.parse(message.text().slice('MAC_UPDATE_CANCEL_BOUNDARY '.length)))
        })
        ctx.report.cancellationBoundary = boundary
        await ctx.page.evaluate(() => {
          const observer = new MutationObserver(() => {
            if (!document.body.textContent.includes('stopping background tasks')) return
            const controls = [...document.querySelectorAll('button')].filter(
              (button) =>
                ['Cancel', 'Close'].includes(button.textContent.trim()) ||
                button.getAttribute('aria-label') === 'Close'
            )
            console.log(
              'MAC_UPDATE_CANCEL_BOUNDARY ' +
                JSON.stringify({
                  applying: true,
                  controls: controls.map((button) => ({ disabled: button.disabled }))
                })
            )
          })
          observer.observe(document.body, { subtree: true, childList: true, attributes: true })
        })
      },
      afterUpdate() {
        if (
          !ctx.report.cancellationBoundary?.length ||
          ctx.report.cancellationBoundary.some((event) =>
            event.controls.some((control) => !control.disabled)
          )
        )
          throw new Error(
            'Safe cancel boundary was not observed or an applying cancel remained enabled'
          )
        if (!ctx.report.cancellation?.sourceReady)
          throw new Error('Cancellation readiness was not proven before retry')
      },
      cleanup() {
        ctx.feed.releasePackages()
      }
    }
  }
  if (id === 'M14') {
    let holder
    const native = createRequire(import.meta.url)('@aipoch/process-tree-native')
    let holderIdentity
    let ready = ''
    const stopHolder = async () => {
      if (!holderIdentity) return
      const current = (await ctx.processes()).find((p) => p.pid === holder.pid)
      if (current && native.getDarwinProcess(holder.pid)?.uniqueId === holderIdentity.uniqueId)
        native.signalDarwinProcess(
          holder.pid,
          holderIdentity.uniqueId,
          15,
          holderIdentity.executable
        )
      await ctx.wait(
        'external mapping holder exits after user repair',
        async () =>
          !(await ctx.processes()).some(
            (p) => p.pid === holder.pid && p.startedAt === holderIdentity.startedAt
          ),
        10000
      )
    }
    return {
      async beforeApply() {
        const binding = join(
          ctx.appBundle,
          'Contents/Resources/app.asar.unpacked/node_modules/@aipoch/process-tree-native/build/Release/process_tree_native.node'
        )
        const before = await digest(binding)
        holder = spawn(
          process.execPath,
          [
            '-e',
            'require(process.argv[1]); console.log("mapped-external-holder-ready"); setInterval(()=>{},1000)',
            binding
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )
        holder.on('error', (error) => {
          ready = `error:${error.message}`
        })
        holder.stdout.on('data', (b) => {
          ready += b.toString()
        })
        ctx.children.push(holder)
        holderIdentity = await ctx.wait('external mapping holder birth identity', async () =>
          (await ctx.processes()).find((p) => p.pid === holder.pid)
        )
        await ctx.wait('real external process maps installation library', async () =>
          ready.includes('mapped-external-holder-ready')
        )
        holderIdentity = (await ctx.processes()).find((p) => p.pid === holder.pid)
        const nativeIdentity = native.getDarwinProcess(holder.pid)
        if (!nativeIdentity)
          throw new Error('External mapping holder disappeared before identity capture')
        holderIdentity.uniqueId = nativeIdentity.uniqueId
        if (!holderIdentity || holderIdentity.executable.startsWith(ctx.appBundle + '/'))
          throw new Error('External blocker is not independently owned')
        const mapping = (
          await ctx.run('/usr/sbin/lsof', ['-n', '-P', '-p', String(holder.pid), '-Fn'])
        ).stdout
        if (!mapping.includes(binding) || (await digest(binding)) !== before)
          throw new Error(
            'External library mapping fault was not observed without changing signed bytes'
          )
        ctx.report.externalMapping = {
          pid: holder.pid,
          identity: holderIdentity,
          mappedLibrarySha256: before,
          observed: true
        }
      },
      async apply(_ctx, defaultApply) {
        await defaultApply()
        const blocked = await ctx.wait(
          'external mapping blocker surfaced',
          async () => {
            const status = await readStatus(ctx)
            return status.error ? status : undefined
          },
          90000
        )
        assertBlocked(blocked, ctx.targetVersion)
        if (
          !(await ctx.processes()).some(
            (p) => p.pid === holder.pid && p.startedAt === holderIdentity.startedAt
          )
        )
          throw new Error('Product terminated the external mapping holder')
        ctx.report.blocked = {
          status: blocked,
          sourceReady: await commonSourceReady(ctx),
          externalPreserved: true
        }
        await ctx.page.screenshot({ path: join(ctx.output, 'external-mapping-blocked.png') })
        await stopHolder()
        await defaultApply()
      },
      async afterUpdate() {
        if (!ctx.report.blocked?.externalPreserved)
          throw new Error('Blocker preservation and repair were not observed')
      },
      async cleanup() {
        await stopHolder()
        holder?.stdout?.destroy()
        holder?.stderr?.destroy()
      }
    }
  }
  throw new Error(`Unknown Mac update scenario: ${id}`)
}
