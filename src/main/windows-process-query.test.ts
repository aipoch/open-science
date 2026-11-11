import Module from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  getWindowsProcessCreationTime: vi.fn<(pid: number) => string | null>(),
  getWindowsProcessCommandLine: vi.fn<(pid: number) => string | null>(),
  getWindowsParentProcessId: vi.fn<(pid: number) => number | null>()
}))

async function load(): Promise<typeof import('./windows-process-query')> {
  vi.resetModules()
  const originalRequire = Module.prototype.require
  vi.spyOn(Module.prototype, 'require').mockImplementation(function (
    this: NodeJS.Module,
    id: string
  ) {
    return id === '@aipoch/process-tree-native' ? native : originalRequire.call(this, id)
  })
  return import('./windows-process-query')
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('Windows process query (portable native contract)', () => {
  it('keeps the persisted .NET Ticks start identity of earlier releases', async () => {
    const query = await load()
    // Values observed on Windows: (Get-Process).StartTime.ToFileTimeUtc() and .Ticks.
    native.getWindowsProcessCreationTime.mockReturnValue('134382374473454458')
    expect(query.windowsProcessStartTicks(42)).toBe('639293606473454458')
    expect(native.getWindowsProcessCreationTime).toHaveBeenCalledWith(42)
    native.getWindowsProcessCreationTime.mockReturnValue(null)
    expect(query.windowsProcessStartTicks(42)).toBeUndefined()
    native.getWindowsProcessCreationTime.mockReturnValue('-1')
    expect(() => query.windowsProcessStartTicks(42)).toThrow(
      'Invalid Windows process creation time.'
    )
  })

  it('uses the native creation handle to distinguish exited processes', async () => {
    const query = await load()
    native.getWindowsProcessCreationTime.mockReturnValueOnce('134382374473454458')
    expect(query.windowsProcessIsAlive(42)).toBe(true)
    native.getWindowsProcessCreationTime.mockReturnValueOnce(null)
    expect(query.windowsProcessIsAlive(42)).toBe(false)
    native.getWindowsProcessCreationTime.mockReturnValueOnce('-1')
    expect(() => query.windowsProcessIsAlive(42)).toThrow('Invalid Windows process creation time.')
  })

  it('maps missing processes to undefined and propagates other failures', async () => {
    const query = await load()
    native.getWindowsProcessCommandLine
      .mockReturnValueOnce('"node.exe" receipt')
      .mockReturnValueOnce(null)
    expect(query.windowsProcessCommandLine(7)).toBe('"node.exe" receipt')
    expect(query.windowsProcessCommandLine(7)).toBeUndefined()
    native.getWindowsParentProcessId.mockReturnValueOnce(3).mockReturnValueOnce(null)
    expect(query.windowsParentProcessId(7)).toBe(3)
    expect(query.windowsParentProcessId(7)).toBeUndefined()
    native.getWindowsParentProcessId.mockReturnValueOnce(-1)
    expect(() => query.windowsParentProcessId(7)).toThrow(
      'Invalid Windows parent process identifier.'
    )
    const denied = new Error('Open process for query failed (5)')
    native.getWindowsProcessCommandLine.mockImplementation(() => {
      throw denied
    })
    expect(() => query.windowsProcessCommandLine(7)).toThrow(denied)
  })
})
