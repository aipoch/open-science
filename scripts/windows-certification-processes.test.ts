import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inspectInstalledProcess, terminateDirectoryProcesses } from './windows-installer-smoke.mjs'
import { suspendFixtureProcess, startNoProtocolRuntime } from './windows-updater-certification.mjs'

it.skipIf(process.platform !== 'win32')(
  'suspends the verified process object and resumes it through an explicit barrier',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'certification-suspension-'))
    const executable = join(root, 'fixture.exe')
    await copyFile(process.execPath, executable)
    const child = spawn(
      executable,
      ['-e', 'console.log("ready"); process.stdin.on("data", () => console.log("responsive"))'],
      { windowsHide: true }
    )
    let suspended: Awaited<ReturnType<typeof suspendFixtureProcess>> | undefined
    try {
      await once(child.stdout!, 'data')
      const identity = await inspectInstalledProcess(executable, child.pid!)
      expect(identity).toBeDefined()
      await expect(
        suspendFixtureProcess({
          identity: { ...identity, startedAt: identity.startedAt - 1 },
          root
        })
      ).rejects.toThrow(/identity changed/)
      suspended = await suspendFixtureProcess({ identity, root })
      let responded = false
      const response = once(child.stdout!, 'data').then(() => {
        responded = true
      })
      child.stdin!.write('ping\n')
      await delay(200)
      expect(responded).toBe(false)
      await suspended.resume()
      await response
      expect(responded).toBe(true)
    } finally {
      await suspended?.resume()
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill()
        await exit
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  },
  60_000
)

it.skipIf(process.platform !== 'win32')(
  'starts an actual installation runtime without inventing a lifecycle registration',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'certification-legacy-'))
    const installDirectory = join(root, 'app')
    const directory = join(installDirectory, 'resources', 'node-runtime')
    await mkdir(directory, { recursive: true })
    await copyFile(process.execPath, join(directory, 'node.exe'))
    let runtime: Awaited<ReturnType<typeof startNoProtocolRuntime>> | undefined
    try {
      runtime = await startNoProtocolRuntime({ installDirectory, root, env: process.env })
      expect(runtime.identity.pid).toBe(runtime.child.pid)
      expect(runtime.child.exitCode).toBeNull()
      await terminateDirectoryProcesses(installDirectory)
      await runtime.exit
      await expect(
        inspectInstalledProcess(runtime.identity.executablePath, runtime.identity.pid)
      ).resolves.toBeUndefined()
    } finally {
      if (runtime && runtime.child.exitCode === null && runtime.child.signalCode === null) {
        const exit = once(runtime.child, 'exit')
        runtime.child.kill()
        await exit
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  },
  60_000
)

it.skipIf(process.platform !== 'win32')(
  'terminates a real isolated installation while the same-named sibling stays alive',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'certification-process-identity-'))
    const owned = join(root, 'app')
    const other = join(root, 'app-other')
    const children: ReturnType<typeof spawn>[] = []
    try {
      for (const directory of [owned, other]) {
        await mkdir(directory)
        const executable = join(directory, 'open-science.exe')
        await copyFile(process.execPath, executable)
        const child = spawn(
          executable,
          ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
          { windowsHide: true }
        )
        children.push(child)
        await once(child.stdout!, 'data')
      }
      const [target, sentinel] = children
      await expect(
        inspectInstalledProcess(join(owned, 'open-science.exe'), target.pid!)
      ).resolves.toMatchObject({ pid: target.pid })
      await expect(
        inspectInstalledProcess(join(owned, 'open-science.exe'), sentinel.pid!)
      ).resolves.toBeUndefined()
      const targetExit = once(target, 'exit')
      await terminateDirectoryProcesses(owned)
      await targetExit
      expect(sentinel.exitCode).toBeNull()
      await expect(
        inspectInstalledProcess(join(other, 'open-science.exe'), sentinel.pid!)
      ).resolves.toMatchObject({ pid: sentinel.pid })
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode === null && child.signalCode === null) {
            const exit = once(child, 'exit')
            child.kill()
            await exit
          }
        })
      )
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  },
  60_000
)
