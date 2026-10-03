import { expect, it, vi } from 'vitest'
import type { NotebookProcessSandbox } from './process-sandbox'
import { probeWindowsRuntimeComponent } from './windows-runtime-probe'
import type { WindowsRuntimeComponentSelection } from './windows-runtime-components'

const selection = (): WindowsRuntimeComponentSelection => ({
  release: {
    component: 'node',
    version: '22.0.0'
  } as unknown as WindowsRuntimeComponentSelection['release'],
  root: '/runtime',
  executable: process.execPath
})

// The wrap mock stands in for the native containment boundary: it runs a trivially successful
// command, and lets each test control termination confirmation and cleanup flags.
const wrapWith =
  (overrides: {
    confirm: () => Promise<boolean>
    cleanup: (reason: string, outcome: { processesTerminated: boolean }) => Promise<unknown>
    args?: string[]
  }): NotebookProcessSandbox['wrap'] =>
  async () => ({
    executable: process.execPath,
    args: overrides.args ?? ['-e', 'process.stdout.write("RUNTIME_PROBE_OK")'],
    env: {},
    confirmProcessTreeTermination: overrides.confirm,
    annotateStderr: (stderr: string) => stderr,
    cleanup: overrides.cleanup as never
  })

it('polls the termination proof within a bounded window instead of sampling a single instant', async () => {
  let confirmations = 0
  const cleanup = vi.fn(async (_reason: string, outcome: { processesTerminated: boolean }) => ({
    processesTerminated: outcome.processesTerminated,
    networkClosed: true,
    temporaryResourcesRemoved: true
  }))
  const wrap = wrapWith({
    confirm: async () => {
      confirmations += 1
      return confirmations >= 3
    },
    cleanup
  })
  await probeWindowsRuntimeComponent(selection(), wrap)
  expect(confirmations).toBe(3)
  expect(cleanup).toHaveBeenCalledWith(
    'exit',
    expect.objectContaining({ processesTerminated: true })
  )
})

it('includes the cleanup flags and notifies diagnostics when cleanup cannot be confirmed', async () => {
  const diagnostics: string[] = []
  const wrap = wrapWith({
    confirm: async () => true,
    cleanup: async () => ({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: false
    })
  })
  await expect(
    probeWindowsRuntimeComponent(selection(), wrap, undefined, (message) =>
      diagnostics.push(message)
    )
  ).rejects.toThrow('"temporaryResourcesRemoved":false')
  expect(diagnostics.join('\n')).toContain('cleanup flags')
})

it('surfaces bounded probe output through diagnostics before incompatibility is thrown', async () => {
  const diagnostics: string[] = []
  const wrap = wrapWith({
    confirm: async () => true,
    cleanup: async () => ({
      processesTerminated: true,
      networkClosed: true,
      temporaryResourcesRemoved: true
    }),
    args: ['-e', 'process.stderr.write("PROBE_BOOM"); process.exit(1)']
  })
  await expect(
    probeWindowsRuntimeComponent(selection(), wrap, undefined, (message) =>
      diagnostics.push(message)
    )
  ).rejects.toThrow('incompatible with protected execution')
  expect(diagnostics.join('\n')).toContain('PROBE_BOOM')
})
