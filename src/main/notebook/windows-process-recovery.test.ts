import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ShellProcessOwnershipRegistry } from './shell-process-ownership.windows-posix'
import { KernelProcessLifecycleOwner } from './kernel-process-lifecycle.windows-posix'
import { recoverLegacyWindowsProcess } from './windows-process-recovery'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'win32')('legacy Windows object-bound recovery', () => {
  it('loads its unpacked native binary and drains Unicode output before reporting exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'windows-host-streams-'))
    const unpacked = join(root, 'app.asar.unpacked')
    const processHostPath = join(unpacked, 'resources/notebook/kernel_process_host.js')
    const binding =
      'node_modules/@aipoch/process-tree-native/build/Release/process_tree_native.node'
    await mkdir(dirname(processHostPath), { recursive: true })
    await mkdir(dirname(join(unpacked, binding)), { recursive: true })
    await copyFile(
      join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
      processHostPath
    )
    // No package.json or index.cjs is unpacked: ordinary Node must load the actual .node asset.
    await copyFile(join(process.cwd(), binding), join(unpacked, binding))
    const registry = new ShellProcessOwnershipRegistry(root, { processHostPath })
    const host = registry.beginLaunch({
      runId: 'streams',
      projectId: 'project',
      sessionId: 'session',
      platform: 'win32',
      hosted: true
    }).host!
    const output = '输出科学'.repeat(16000)
    const child = spawn(
      process.execPath,
      [
        host.path,
        host.pendingPath,
        host.receiptId,
        process.execPath,
        '-e',
        "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(input);process.stderr.write('drained')})"
      ],
      { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    )
    let stdout = '',
      stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    try {
      const closed = once(child, 'close')
      child.stdin.end(output)
      expect((await closed)[0]).toBe(0)
      expect(stdout).toBe(output)
      expect(stderr).toBe('drained')
      await new ShellProcessOwnershipRegistry(root).recover()
      expect(registry.hasReceipts()).toBe(false)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
  it.each(['shell', 'kernel'] as const)(
    'reaps the %s host and an escaped descendant after its intermediate parent exits',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'legacy-windows-tree-'))
      const release = join(root, 'release'),
        pids = join(root, 'pids.json')
      const script = join(root, 'workload.cjs')
      const shell = new ShellProcessOwnershipRegistry(root)
      const kernel = new KernelProcessLifecycleOwner({ storageRoot: root })
      const shellHost =
        kind === 'shell'
          ? shell.beginLaunch({
              runId: 'owned',
              projectId: 'project',
              sessionId: 'session',
              platform: 'win32',
              hosted: true
            }).host!
          : undefined
      const kernelHost =
        kind === 'kernel'
          ? kernel.beginSpawn({ laneKey: 'lane', processKey: 'kernel', kernelEpochId: 'epoch' })
          : undefined
      const pendingPath = shellHost?.pendingPath ?? kernelHost!.path
      const receiptId = shellHost?.receiptId ?? kernelHost!.record.receiptId
      const children: ChildProcess[] = []
      const idle = `setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)}))process.exit(0)},20)`
      try {
        const leafPid = join(root, 'leaf-pid')
        const leaf = `require('node:fs').writeFileSync(${JSON.stringify(leafPid)},String(process.pid));${idle}`
        const intermediate = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:'ignore',windowsHide:true});c.unref()`
        await writeFile(
          script,
          `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(intermediate)}],{stdio:'ignore',windowsHide:true});child.once('exit',()=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(leafPid)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,Number(fs.readFileSync(${JSON.stringify(leafPid)},'utf8')),child.pid]))}},20)});${idle}`
        )
        const sentinel = spawn(
          process.execPath,
          ['-e', `console.log('ready');${idle}`, receiptId],
          { windowsHide: true }
        )
        children.push(sentinel)
        await once(sentinel.stdout, 'data')
        expect(alive(sentinel.pid!)).toBe(true)
        const host = spawn(
          process.execPath,
          [
            join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
            pendingPath,
            receiptId,
            process.execPath,
            script
          ],
          { windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
        )
        children.push(host)
        let descendants: number[] = []
        await expect
          .poll(
            async () => {
              try {
                descendants = JSON.parse(await readFile(pids, 'utf8'))
                return descendants.slice(0, 2).every(alive) && !alive(descendants[2])
              } catch {
                return false
              }
            },
            { timeout: 5000 }
          )
          .toBe(true)
        if (kind === 'shell') await new ShellProcessOwnershipRegistry(root).recover()
        else await new KernelProcessLifecycleOwner({ storageRoot: root }).recover()
        expect([host.pid!, ...descendants].map(alive)).toEqual([false, false, false, false])
        expect(alive(sentinel.pid!)).toBe(true)
      } finally {
        await writeFile(release, 'release')
        await Promise.all(
          children.map(async (child) => {
            if (child.exitCode === null && child.signalCode === null) await once(child, 'close')
          })
        )
        await rm(root, { recursive: true, force: true })
      }
    },
    20000
  )

  it.each(['active', 'absent'] as const)(
    'reconciles the original %s Job while preserving a reused host PID',
    async (jobState) => {
      const root = await mkdtemp(join(tmpdir(), 'windows-host-reused-'))
      const release = join(root, 'release')
      const registry = new ShellProcessOwnershipRegistry(root)
      const hosted = registry.beginLaunch({
        runId: 'reused',
        projectId: 'project',
        sessionId: 'session',
        platform: 'win32',
        hosted: true
      }).host!
      const command = `console.log('ready');setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)}))process.exit(0)},20)`
      const host = spawn(
        process.execPath,
        [hosted.path, hosted.pendingPath, hosted.receiptId, process.execPath, '-e', command],
        { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
      )
      const sentinel = spawn(
        process.execPath,
        ['-e', "console.log('ready');setInterval(()=>{},1000)"],
        { windowsHide: true }
      )
      try {
        await Promise.all([once(host.stdout, 'data'), once(sentinel.stdout, 'data')])
        if (jobState === 'absent') {
          const closed = once(host, 'close')
          await writeFile(release, 'release')
          await closed
        }
        const oldPath = join(
          root,
          'shell-process-ownership',
          `reused.active.${host.pid}.${hosted.receiptId}.json`
        )
        const newPath = join(
          root,
          'shell-process-ownership',
          `reused.active.${sentinel.pid}.${hosted.receiptId}.json`
        )
        const record = JSON.parse(await readFile(oldPath, 'utf8'))
        // Model the OS reusing the historical PID without attempting to force global PID churn.
        // The Job identity remains the actual Job created by the real host above.
        await writeFile(oldPath, JSON.stringify({ ...record, pid: sentinel.pid }))
        await rename(oldPath, newPath)
        await new ShellProcessOwnershipRegistry(root).recover()
        expect(registry.hasReceipts()).toBe(false)
        expect(alive(sentinel.pid!)).toBe(true)
        await expect.poll(() => alive(host.pid!), { timeout: 3000 }).toBe(false)
      } finally {
        await writeFile(release, 'release')
        for (const child of [host, sentinel]) {
          if (child.exitCode === null && child.signalCode === null) {
            const closed = once(child, 'close')
            child.kill()
            await closed
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    15000
  )

  it('retains a historical receipt without from-birth containment until its process exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-windows-birth-'))
    const child = spawn(process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], {
      windowsHide: true
    })
    try {
      await once(child.stdout, 'data')
      const registry = new ShellProcessOwnershipRegistry(root)
      registry.claim(child, {
        runId: 'birth',
        projectId: 'project',
        sessionId: 'session',
        platform: 'win32'
      })
      expect(
        recoverLegacyWindowsProcess({
          pid: child.pid!
        })
      ).toEqual({ reaped: false })
      expect(alive(child.pid!)).toBe(true)
      const recovered = new ShellProcessOwnershipRegistry(root)
      await expect(recovered.recover()).rejects.toMatchObject({
        code: 'SHELL_PROCESS_RECOVERY_BLOCKED'
      })
      expect(alive(child.pid!)).toBe(true)
      expect(recovered.hasReceipts()).toBe(true)
      const closed = once(child, 'close')
      child.kill()
      await closed
      await recovered.recover()
      expect(recovered.hasReceipts()).toBe(false)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
})
