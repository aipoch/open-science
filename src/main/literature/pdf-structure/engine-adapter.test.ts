import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createPdfStructureEngine as createPackageEngine } from '@aipoch/pdf-structure'
import { beforeEach, expect, it, vi } from 'vitest'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../../process-tree'
import { createPdfStructureEngine } from './engine'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('@aipoch/pdf-structure', () => ({ createPdfStructureEngine: vi.fn(() => ({})) }))
vi.mock('../../process-tree', () => ({
  registerOwnedPosixProcessGroup: vi.fn(),
  terminateProcessTree: vi.fn()
}))
beforeEach(() => vi.clearAllMocks())

it('keeps process registration and confirmed termination in the host adapter', async () => {
  createPdfStructureEngine()
  const runtime = vi.mocked(createPackageEngine).mock.calls[0][0].runtime!
  const child = {} as ChildProcessWithoutNullStreams
  vi.mocked(spawn).mockReturnValue(child)
  expect(runtime.spawn('worker entry.mjs')).toBe(child)
  expect(spawn).toHaveBeenCalledWith(
    process.execPath,
    ['worker entry.mjs'],
    expect.objectContaining({
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  )
  if (process.platform !== 'win32')
    expect(registerOwnedPosixProcessGroup).toHaveBeenCalledWith(child)
  else expect(registerOwnedPosixProcessGroup).not.toHaveBeenCalled()
  vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: false } as Awaited<
    ReturnType<typeof terminateProcessTree>
  >)
  await expect(runtime.stop(child)).rejects.toThrow('termination is unconfirmed')
  vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: true } as Awaited<
    ReturnType<typeof terminateProcessTree>
  >)
  await runtime.stop(child)
  expect(terminateProcessTree).toHaveBeenLastCalledWith(child, 'SIGTERM')
})
