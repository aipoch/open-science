import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32')(
  'reads commitment and exact process births without leaking handles or following recycled identities',
  async () => {
    const native = createRequire(import.meta.url)(
      '@aipoch/process-tree-native'
    ) as typeof import('@aipoch/process-tree-native')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    try {
      await once(child, 'spawn')
      const first = await native.sampleWindowsResources(true, [])
      expect(first.supported).toBe(true)
      expect(first.system?.committedBytes).toBeGreaterThan(0)
      expect(first.system?.commitLimitBytes).toBeGreaterThanOrEqual(first.system!.committedBytes)
      const self = first.processes.find((item) => item.pid === process.pid)!
      const observed = first.processes.find((item) => item.pid === child.pid)!
      expect(observed.birth).toBe(native.readWindowsResourceBirth(child.pid!))
      expect(observed.birth).toMatch(/^\d{17,20}$/)
      expect(observed.parentPid).toBe(process.pid)
      expect(observed.privateBytes).toBeGreaterThan(0)
      expect(observed.workingSetBytes).toBeGreaterThan(0)
      for (let i = 0; i < 40; i++)
        await native.sampleWindowsResources(true, [{ pid: child.pid!, birth: observed.birth! }])
      const after = await native.sampleWindowsResources(true, [])
      expect(
        after.processes.find((item) => item.pid === process.pid)!.handleCount! - self.handleCount!
      ).toBeLessThan(8)
      const exited = once(child, 'exit')
      child.kill()
      await exited
      const final = await native.sampleWindowsResources(true, [
        { pid: child.pid!, birth: observed.birth! }
      ])
      expect(
        final.processes.some((item) => item.pid === child.pid && item.birth === observed.birth)
      ).toBe(false)
      const onlySystem = await native.sampleWindowsResources(false, [])
      expect(onlySystem.processes).toEqual([])
      expect(onlySystem.system?.commitLimitBytes).toBeGreaterThan(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.kill()
        await exited
      }
    }
  }
)
