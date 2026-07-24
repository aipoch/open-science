import { describe, expect, it, vi } from 'vitest'

describe('Office preview Electron adapter', () => {
  it('resolves the exact runtime frame and compares operating-system process ids', async () => {
    const module = await import('./office-preview-electron').catch(() => undefined)
    expect(module).toBeDefined()
    if (!module) return

    const runtimeUrl =
      'open-science-office-preview://runtime/office-preview.html?sessionId=session-1'
    const unrelatedFrame = { url: `${runtimeUrl}-other`, osProcessId: 201 }
    const runtimeFrame = { url: runtimeUrl, osProcessId: 202 }
    const mainFrame = {
      url: 'http://localhost:5173/',
      osProcessId: 101,
      framesInSubtree: [unrelatedFrame, runtimeFrame]
    }
    const resolveFrameProcess = module.createOfficePreviewFrameProcessResolver({
      fromId: vi.fn().mockReturnValue({ mainFrame })
    })

    expect(resolveFrameProcess(7, runtimeUrl)).toEqual({
      frameProcessId: 202,
      parentProcessId: 101
    })
    expect(resolveFrameProcess(7, `${runtimeUrl}-missing`)).toBeUndefined()
  })

  it('reads private process memory from Electron metrics using the frame OS pid', async () => {
    const module = await import('./office-preview-electron').catch(() => undefined)
    expect(module).toBeDefined()
    if (!module) return

    const getProcessMemoryUsageBytes = module.createOfficePreviewProcessMemoryReader({
      getAppMetrics: vi
        .fn()
        .mockReturnValue([{ pid: 202, memory: { privateBytes: 321, workingSetSize: 654 } }])
    })

    expect(getProcessMemoryUsageBytes(202)).toBe(321 * 1024)
    expect(getProcessMemoryUsageBytes(999)).toBe(0)
  })
})
