import { describe, expect, it, vi } from 'vitest'

import type { Logger } from './logger'

// Capture ipcMain.handle registrations so the handler can be invoked directly.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const { registerNetworkIpcHandlers } = await import('./network-ipc')
type NetworkCommandOwner = import('./network-ipc').NetworkCommandOwner

const invoke = (channel: string): unknown => handlers.get(channel)!(undefined, undefined)

type DiagnosticLog = {
  [Method in keyof Logger]: ReturnType<typeof vi.fn<Logger[Method]>>
}

const createDiagnosticLog = (): DiagnosticLog => ({
  debug: vi.fn<Logger['debug']>(),
  info: vi.fn<Logger['info']>(),
  warn: vi.fn<Logger['warn']>(),
  error: vi.fn<Logger['error']>()
})

describe('network IPC handler', () => {
  it('delegates to an injected owner instance', async () => {
    handlers.clear()
    const info = { connectionType: 'wifi', ipAddress: '192.168.1.42' } as const
    const owner: NetworkCommandOwner = {
      getInfo: vi.fn().mockResolvedValue(info),
      checkConnectivity: vi.fn().mockResolvedValue(false)
    }

    expect(registerNetworkIpcHandlers(owner)).toBe(owner)
    await expect(invoke('network:get-info')).resolves.toEqual(info)
    await expect(invoke('network:check-connectivity')).resolves.toBe(false)
  })

  it('records connectivity probe start, outcome, and duration', async () => {
    handlers.clear()
    const owner: NetworkCommandOwner = {
      getInfo: vi.fn(),
      checkConnectivity: vi.fn().mockResolvedValue(true)
    }
    const log = createDiagnosticLog()
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(137)

    registerNetworkIpcHandlers(owner, { log, now })

    await expect(invoke('network:check-connectivity')).resolves.toBe(true)
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenNthCalledWith(1, 'operation started', {
      operation: 'connectivity-check',
      operationId: expect.any(String),
      outcome: 'started'
    })
    expect(log.info).toHaveBeenNthCalledWith(2, 'operation completed', {
      operation: 'connectivity-check',
      operationId: expect.any(String),
      outcome: 'completed',
      durationMs: 37,
      reachable: true
    })
    const startedFields = log.info.mock.calls[0][1] as Record<string, unknown>
    const completedFields = log.info.mock.calls[1][1] as Record<string, unknown>
    expect(completedFields.operationId).toBe(startedFields.operationId)
  })

  it('records a sanitized failed probe and preserves the rejection', async () => {
    handlers.clear()
    const failure = new Error('private network details')
    const owner: NetworkCommandOwner = {
      getInfo: vi.fn(),
      checkConnectivity: vi.fn().mockRejectedValue(failure)
    }
    const log = createDiagnosticLog()
    const now = vi.fn().mockReturnValueOnce(200).mockReturnValueOnce(225)

    registerNetworkIpcHandlers(owner, { log, now })

    await expect(invoke('network:check-connectivity')).rejects.toBe(failure)
    expect(log.error).toHaveBeenCalledWith('operation failed', {
      operation: 'connectivity-check',
      operationId: expect.any(String),
      outcome: 'failed',
      durationMs: 25,
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('private network details')
  })

  it('registers both network channels', () => {
    handlers.clear()
    registerNetworkIpcHandlers()

    expect(handlers.has('network:get-info')).toBe(true)
    expect(handlers.has('network:check-connectivity')).toBe(true)
  })

  it('default owner answers from local interface state', async () => {
    handlers.clear()
    registerNetworkIpcHandlers()

    // No Electron app or network access needed: the default owner reads os.networkInterfaces(),
    // so any machine (including CI) answers with the NetworkInfo shape. checkConnectivity is
    // deliberately not invoked here — the default owner would issue real HTTPS probes.
    await expect(invoke('network:get-info')).resolves.toMatchObject({
      connectionType: expect.stringMatching(/^(wifi|ethernet|unknown)$/)
    })
  })
})
