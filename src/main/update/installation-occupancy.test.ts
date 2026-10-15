import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectInstallationProcesses,
  inspectInstallationProcessesAsync
} from './installation-occupancy'

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), run: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }))
vi.mock('./verification-process', () => ({ runVerificationProcess: mocks.run }))
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.restoreAllMocks())

// Both APIs must find the same occupants from the platform's native process-list format.
describe.each(['sync', 'async'] as const)('%s installation occupancy', (mode) => {
  const inspect = async (root: string, signal?: AbortSignal): Promise<number[]> =>
    mode === 'sync'
      ? inspectInstallationProcesses(root)
      : inspectInstallationProcessesAsync(root, signal)
  function output(...values: string[]): void {
    for (const stdout of values) {
      mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout })
      mocks.run.mockResolvedValueOnce({ stdout, stderr: '' })
    }
  }

  it('finds Linux command-line occupants and deduplicates PIDs', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    output('  10 /opt/Open Science/node\n20 unrelated\n10 /opt/Open Science/backend\ninvalid\n')
    const signal = new AbortController().signal
    expect(await inspect('/opt/Open Science', signal)).toEqual([10])
    if (mode === 'async')
      expect(mocks.run).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,command='], {
        signal,
        timeoutMs: 15_000
      })
  })

  it('includes macOS text mappings without accepting similarly prefixed bundles', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    output(
      '10 /Applications/Science.app/node\n',
      'p10\nn/Applications/Science.app/node\np11\nn/Applications/Science.app\np12\nn/Applications/Science.app/Contents/node\np13\nn/Applications/Science.app-old/node\n'
    )
    expect(await inspect('/Applications/Science.app')).toEqual([10, 11, 12])
  })

  it.each([true, false])(
    'reads case-insensitive Windows process identities (array=%s)',
    async (array) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const executable = { ProcessId: '42', ExecutablePath: 'C:\\Apps\\Science\\node.exe' }
      output(
        JSON.stringify(
          array
            ? [
                executable,
                { ProcessId: 43, CommandLine: 'node C:\\APPS\\SCIENCE\\backend.cjs' },
                { ProcessId: 44, ExecutablePath: null, CommandLine: null }
              ]
            : executable
        )
      )
      expect(await inspect('c:\\apps\\science')).toEqual(array ? [42, 43] : [42])
    }
  )

  it.each(['linux', 'win32', 'darwin'] as const)(
    'fails closed when %s inspection fails',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      if (platform === 'darwin') output('')
      mocks.spawnSync.mockReturnValueOnce({ status: 1, stdout: '' })
      mocks.run.mockRejectedValueOnce(new Error('inspection failed'))
      await expect(inspect('/installed/app')).rejects.toThrow(
        mode === 'sync' ? 'could not be inspected' : 'inspection failed'
      )
    }
  )

  it('rejects invalid Windows process JSON instead of reporting an empty installation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    output('not JSON')
    await expect(inspect('C:\\Apps\\Science')).rejects.toThrow()
  })
})
