import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createPdfStructureEngine as createPackageEngine,
  createPdfStructureNodeRuntime
} from '@aipoch/pdf-structure'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../../process-tree'
import { createPdfStructureEngine } from './engine'

vi.mock('@aipoch/pdf-structure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aipoch/pdf-structure')>()
  return {
    ...actual,
    createPdfStructureNodeRuntime: vi.fn(actual.createPdfStructureNodeRuntime),
    createPdfStructureEngine: vi.fn(() => ({}))
  }
})
vi.mock('../../process-tree', () => ({
  registerOwnedPosixProcessGroup: vi.fn(),
  terminateProcessTree: vi.fn()
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!,
  roots: string[] = [],
  children: ChildProcessWithoutNullStreams[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close')
      child.kill('SIGKILL')
      await closed
    }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function runtime(): NonNullable<Parameters<typeof createPackageEngine>[0]['runtime']> {
  createPdfStructureEngine()
  return vi.mocked(createPackageEngine).mock.calls.at(-1)![0].runtime!
}
async function host(
  owned: ReturnType<typeof runtime>,
  program: string
): Promise<ChildProcessWithoutNullStreams> {
  const root = await mkdtemp(join(tmpdir(), 'pdf-adapter-'))
  roots.push(root)
  const entry = join(root, 'host.mjs')
  await writeFile(entry, program)
  const child = owned.spawn(entry)
  children.push(child)
  child.stdout.resume()
  child.stderr.resume()
  await once(child, 'close')
  return child
}
it('keeps application environment, POSIX registration and confirmed fallback in the adapter', async () => {
  const owned = runtime(),
    child = await host(owned, 'process.exit(1)')
  expect(createPdfStructureNodeRuntime).toHaveBeenCalledWith(
    expect.objectContaining({ detached: process.platform !== 'win32', env: expect.any(Object) })
  )
  if (process.platform !== 'win32')
    expect(registerOwnedPosixProcessGroup).toHaveBeenCalledWith(child)
  else expect(registerOwnedPosixProcessGroup).not.toHaveBeenCalled()
  vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: false })
  await expect(owned.stop(child)).rejects.toThrow('termination is unconfirmed')
  vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: true })
  await owned.stop(child)
  expect(terminateProcessTree).toHaveBeenLastCalledWith(child, 'SIGTERM')
})
it.each(['ipc', 'stdout', 'missing'])(
  'checks actual native IPC and close through the Windows adapter: %s',
  async (mode) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const owned = runtime(),
      child = await host(
        owned,
        mode === 'ipc'
          ? `process.send({type:'pdf:stopped'},()=>process.exit(0))`
          : mode === 'stdout'
            ? `console.log('{"type":"pdf:stopped"}')`
            : 'process.exit(0)'
      )
    vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: false })
    if (mode === 'ipc') {
      await owned.stop(child)
      await owned.stop(child)
      expect(terminateProcessTree).not.toHaveBeenCalled()
    } else {
      await expect(owned.stop(child)).rejects.toThrow('termination is unconfirmed')
      expect(terminateProcessTree).toHaveBeenCalledOnce()
    }
    expect(child.exitCode).toBe(0)
    expect(createPdfStructureNodeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ detached: false })
    )
    expect(registerOwnedPosixProcessGroup).not.toHaveBeenCalled()
  }
)
it('does not use another host acknowledgement to certify an unexpectedly killed Windows host', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const owned = runtime(),
    good = await host(owned, `process.send({type:'pdf:stopped'},()=>process.exit(0))`),
    bad = await host(owned, `process.kill(process.pid,'SIGKILL')`)
  vi.mocked(terminateProcessTree).mockResolvedValue({ reaped: false })
  await owned.stop(good)
  await expect(owned.stop(bad)).rejects.toThrow('termination is unconfirmed')
  expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(bad, 'SIGTERM')
})
