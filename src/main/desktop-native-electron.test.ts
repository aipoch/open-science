import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createDesktopNativeHandler } from './desktop-native-electron'

const mocks = vi.hoisted(() => ({
  metrics: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  print: vi.fn(),
  windows: vi.fn(),
  parent: vi.fn(),
  openPath: vi.fn(),
  reveal: vi.fn(),
  external: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getAppMetrics: mocks.metrics },
  shell: { openPath: mocks.openPath, showItemInFolder: mocks.reveal, openExternal: mocks.external },
  BrowserWindow: { getAllWindows: mocks.windows, fromWebContents: mocks.parent },
  dialog: { showOpenDialog: mocks.open, showSaveDialog: mocks.save, showMessageBox: mocks.message }
}))
vi.mock('./session-persistence/conversation-pdf-electron', () => ({
  printConversationPdf: mocks.print
}))
beforeEach(() => vi.resetAllMocks())

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup() {
  const sender = { isDestroyed: () => false } as WebContents
  const window = { isDestroyed: () => false, webContents: sender }
  mocks.windows.mockReturnValue([window])
  mocks.parent.mockReturnValue(window)
  const resolve = vi.fn((): WebContents | undefined => sender)
  const handler = createDesktopNativeHandler(resolve, (value) => value === sender)
  const signal = new AbortController()
  return { sender, window, resolve, handler, signal, clientId: randomUUID() }
}

describe('native operations requested by the Node runtime', () => {
  it('parents native dialogs to the current document and strips Electron-only result fields', async () => {
    const value = setup()
    const path = join(tmpdir(), 'chosen.science')
    mocks.save.mockResolvedValue({ canceled: false, filePath: path, bookmark: 'not-in-protocol' })
    await expect(
      value.handler(
        {
          kind: 'native-request',
          id: 1,
          clientId: value.clientId,
          request: { operation: 'save-dialog', options: { title: 'Export' } }
        },
        value.signal.signal
      )
    ).resolves.toEqual({ canceled: false, filePath: path })
    expect(mocks.save).toHaveBeenCalledWith(value.window, { title: 'Export' })
    expect(value.resolve).toHaveBeenCalledWith(value.clientId)
  })

  it('does not fall back to another window for a released document', async () => {
    const value = setup()
    value.resolve.mockReturnValue(undefined)
    await expect(
      value.handler(
        {
          kind: 'native-request',
          id: 1,
          clientId: value.clientId,
          request: { operation: 'open-dialog', options: {} }
        },
        value.signal.signal
      )
    ).rejects.toThrow('no longer available')
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it.each(['release', 'disconnect'] as const)(
    'discards a late native selection on %s',
    async (reason) => {
      const value = setup()
      let finish!: (value: unknown) => void
      mocks.open.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const pending = value.handler(
        {
          kind: 'native-request',
          id: 1,
          clientId: value.clientId,
          request: { operation: 'open-dialog', options: {} }
        },
        value.signal.signal
      )
      if (reason === 'release') value.resolve.mockReturnValue(undefined)
      else value.signal.abort()
      const result = expect(pending).rejects.toThrow()
      finish({ canceled: false, filePaths: [join(tmpdir(), 'chosen.science')] })
      await result
    }
  )

  it('passes cancellation to the native message dialog', async () => {
    const value = setup()
    mocks.message.mockResolvedValue({ response: 1, checkboxChecked: false })
    const options = { message: 'Replace?', buttons: ['Replace', 'Cancel'], cancelId: 1 }
    await expect(
      value.handler(
        { kind: 'native-request', id: 1, request: { operation: 'message-box', options } },
        value.signal.signal
      )
    ).resolves.toEqual({ response: 1 })
    expect(mocks.message).toHaveBeenCalledWith(value.window, {
      ...options,
      signal: value.signal.signal
    })
  })

  it('hands a PDF back through the runtime-owned temporary directory without overwriting files', async () => {
    const value = setup()
    const directory = await mkdtemp(join(tmpdir(), 'desktop-native-'))
    try {
      const htmlPath = join(directory, 'conversation.html')
      const request = {
        operation: 'conversation-pdf' as const,
        htmlPath,
        timeoutMs: 120_000,
        timeoutMessage: 'Print timed out'
      }
      mocks.print.mockResolvedValue(Buffer.from('%PDF-test'))
      const result = await value.handler(
        { kind: 'native-request', id: 1, clientId: value.clientId, request },
        value.signal.signal
      )
      expect(result).toBe(`${htmlPath}.pdf`)
      expect(await readFile(`${htmlPath}.pdf`, 'utf8')).toBe('%PDF-test')
      if (process.platform !== 'win32')
        expect((await stat(`${htmlPath}.pdf`)).mode & 0o777).toBe(0o600)
      await expect(
        value.handler(
          { kind: 'native-request', id: 2, clientId: value.clientId, request },
          value.signal.signal
        )
      ).rejects.toThrow('EEXIST')
      expect(mocks.print).toHaveBeenCalledWith(request, undefined, value.signal.signal)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not write a PDF after its caller disconnects during printing', async () => {
    const value = setup()
    const directory = await mkdtemp(join(tmpdir(), 'desktop-native-'))
    try {
      const htmlPath = join(directory, 'conversation.html')
      mocks.print.mockImplementation(async () => {
        value.signal.abort()
        return Buffer.from('%PDF')
      })
      await expect(
        value.handler(
          {
            kind: 'native-request',
            id: 1,
            request: {
              operation: 'conversation-pdf',
              htmlPath,
              timeoutMs: 120_000,
              timeoutMessage: 'Timeout'
            }
          },
          value.signal.signal
        )
      ).rejects.toThrow()
      await expect(stat(`${htmlPath}.pdf`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('native shell operations', () => {
  it('opens only validated local paths and HTTP(S) authorization URLs for a live document', async () => {
    const value = setup()
    const path = join(tmpdir(), 'artifact.csv')
    mocks.openPath.mockResolvedValue('')
    const invoke = (request: unknown): Promise<unknown> =>
      value.handler(
        { kind: 'native-request', id: 1, clientId: value.clientId, request } as Parameters<
          typeof value.handler
        >[0],
        value.signal.signal
      )
    await expect(invoke({ operation: 'open-path', path })).resolves.toBe('')
    await expect(invoke({ operation: 'reveal-path', path })).resolves.toBeNull()
    await expect(
      invoke({ operation: 'open-external', url: 'https://example.test/authorize?state=nonce' })
    ).resolves.toBeNull()
    expect(mocks.openPath).toHaveBeenCalledWith(path)
    expect(mocks.reveal).toHaveBeenCalledWith(path)
    expect(mocks.external).toHaveBeenCalledWith('https://example.test/authorize?state=nonce')
    for (const url of ['file:///tmp/unsafe', 'javascript:alert(1)', 'data:text/html,unsafe']) {
      await expect(invoke({ operation: 'open-external', url })).rejects.toThrow()
    }
    await expect(invoke({ operation: 'open-path', path: 'relative.txt' })).rejects.toThrow()
    expect(mocks.external).toHaveBeenCalledOnce()
    value.resolve.mockReturnValue(undefined)
    await expect(invoke({ operation: 'open-path', path })).rejects.toThrow('no longer available')
    expect(mocks.openPath).toHaveBeenCalledOnce()
  })
})

describe('native Office process evidence', () => {
  it('resolves the exact iframe from the live document and reads actual process metrics', async () => {
    const value = setup()
    const runtimeUrl = 'open-science-office-preview://runtime/office-preview.html?sessionId=one'
    Object.assign(value.sender, {
      id: 7,
      mainFrame: {
        osProcessId: 70,
        framesInSubtree: [
          { url: runtimeUrl, osProcessId: 91 },
          { url: runtimeUrl.replace('one', 'two'), osProcessId: 92 }
        ]
      }
    })
    const invoke = (request: unknown): Promise<unknown> =>
      value.handler(
        { kind: 'native-request', id: 1, clientId: value.clientId, request } as Parameters<
          typeof value.handler
        >[0],
        value.signal.signal
      )
    await expect(invoke({ operation: 'office-frame', runtimeUrl })).resolves.toEqual({
      frameProcessId: 91,
      parentProcessId: 70
    })
    await expect(
      invoke({ operation: 'office-frame', runtimeUrl: runtimeUrl.replace('one', 'missing') })
    ).resolves.toBeNull()
    await expect(
      invoke({
        operation: 'office-frame',
        runtimeUrl: 'https://example.test/office-preview.html?sessionId=one'
      })
    ).rejects.toThrow()
    await expect(
      invoke({ operation: 'office-frame', runtimeUrl, frameProcessId: 100 })
    ).rejects.toThrow()
    mocks.metrics.mockReturnValue([{ pid: 91, memory: { privateBytes: 1024 } }])
    await expect(invoke({ operation: 'process-memory', processId: 91 })).resolves.toBe(1024 * 1024)
    value.resolve.mockReturnValue(undefined)
    await expect(invoke({ operation: 'office-frame', runtimeUrl })).rejects.toThrow(
      'no longer available'
    )
  })
})
