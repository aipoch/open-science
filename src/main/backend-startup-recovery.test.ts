import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopBackendStartupError,
  backendStartupStatusSchema,
  createBackendStartupReporter
} from './backend-startup'
import { CredentialIdentityError } from './credential-identity/selection'
import type { CredentialDiagnostic } from './credential-identity/diagnostic'
const host = vi.hoisted(() => ({
  dialog: vi.fn(),
  openPath: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
  windows: [] as Array<{
    options: Electron.BrowserWindowConstructorOptions
    url?: string
    destroyed: boolean
    visible: boolean
  }>
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    state: {
      options: Electron.BrowserWindowConstructorOptions
      url?: string
      destroyed: boolean
      visible: boolean
    }
    webContents = { setWindowOpenHandler: vi.fn() }
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.state = { options, destroyed: false, visible: false }
      host.windows.push(this.state)
    }
    loadURL(url: string): Promise<void> {
      this.state.url = url
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return this.state.destroyed
    }
    destroy(): void {
      this.state.destroyed = true
    }
    showInactive(): void {
      this.state.visible = true
    }
  },
  app: { getPreferredSystemLanguages: () => ['zh-CN'], relaunch: host.relaunch, exit: host.exit },
  dialog: { showMessageBox: host.dialog },
  shell: { openPath: host.openPath }
}))
import {
  createCredentialStartupNotice,
  recoverDesktopBackendStartup
} from './backend-startup-recovery'
beforeEach(() => {
  vi.clearAllMocks()
  host.windows.length = 0
  host.openPath.mockResolvedValue('')
})
describe('backend startup recovery', () => {
  it('shows an ephemeral credential wait notice and closes it when the stage completes', async () => {
    vi.useFakeTimers()
    host.dialog.mockResolvedValue({ response: 0 })
    const notice = createCredentialStartupNotice()
    const status = {
      protocolVersion: 1,
      attemptId: '9706f945-efc7-4fe8-b52e-cd1978a126a7',
      stage: 'credentials',
      kind: 'progress'
    } as const
    try {
      notice.update(status)
      notice.update(status)
      await vi.advanceTimersByTimeAsync(1500)
      expect(host.windows).toHaveLength(1)
      const window = host.windows[0]
      expect(window.visible).toBe(true)
      expect(window.options.webPreferences).toMatchObject({
        partition: 'credential-startup-notice',
        sandbox: true,
        nodeIntegration: false
      })
      expect(decodeURIComponent(window.url!)).toContain('正在等待系统凭据访问')
      expect(decodeURIComponent(window.url!)).toContain('最多等待五分钟')
      expect(decodeURIComponent(window.url!)).toContain('超时后可重试启动')
      notice.update({ ...status, stage: 'storage' })
      expect(window.destroyed).toBe(true)
      notice.update(status)
      await vi.advanceTimersByTimeAsync(1500)
      expect(host.windows).toHaveLength(1)
    } finally {
      notice.dispose()
      vi.useRealTimers()
    }
  })
  it('does not show a credential notice after a fast launch or disposal', async () => {
    vi.useFakeTimers()
    const notice = createCredentialStartupNotice()
    try {
      notice.update({
        protocolVersion: 1,
        attemptId: '9706f945-efc7-4fe8-b52e-cd1978a126a7',
        stage: 'credentials',
        kind: 'progress'
      })
      notice.dispose()
      await vi.advanceTimersByTimeAsync(2000)
      expect(host.windows).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it.each([
    {
      reason: 'native-secret-operation-failed',
      diagnostic: { code: 'secret-timeout', systemCode: 'ETIMEDOUT', signal: 'SIGKILL' },
      details: ['系统凭据授权超时', 'SYSTEM_ERROR: ETIMEDOUT', 'HELPER_SIGNAL: SIGKILL']
    },
    {
      reason: 'windows-profile-key-unavailable',
      diagnostic: { code: 'dpapi-unprotect-failed', osStatus: 13 },
      details: ['Windows 无法解密现有凭据密钥。', 'WINDOWS_ERROR: 13']
    },
    {
      reason: 'ciphertext-inventory-unavailable',
      diagnostic: {
        code: 'inventory-failed',
        source: 'cookies',
        stage: 'read-files',
        reason: 'operation-failed',
        systemCode: 'EACCES'
      },
      details: [
        '失败对象：浏览器 Cookie',
        '失败阶段：读取文件',
        '操作系统拒绝了访问。',
        'SYSTEM_ERROR: EACCES'
      ]
    }
  ] satisfies { reason: string; diagnostic: CredentialDiagnostic; details: string[] }[])(
    'carries $reason diagnostics from the reporter through the private pipe to the dialog',
    async ({ reason, diagnostic, details }) => {
      const send = vi.fn()
      const original = process
      vi.stubGlobal(
        'process',
        Object.assign(Object.create(original), {
          env: {
            ...original.env,
            OPEN_SCIENCE_STARTUP_ATTEMPT: '9706f945-efc7-4fe8-b52e-cd1978a126a7'
          },
          connected: true,
          channel: { unref: vi.fn() },
          send
        })
      )
      try {
        const reporter = createBackendStartupReporter()
        reporter.phase('credentials')
        reporter.failed(new CredentialIdentityError(reason, undefined, diagnostic))
        const status = backendStartupStatusSchema.parse(send.mock.calls.at(-1)![0])
        expect(status.diagnostic).toEqual(diagnostic)
        host.dialog.mockResolvedValue({ response: 2 })
        await recoverDesktopBackendStartup(
          new DesktopBackendStartupError('fixture', 'credentials', true, '/logs', status)
        )
        for (const detail of details) expect(host.dialog.mock.calls[0][0].detail).toContain(detail)
        expect(host.relaunch).not.toHaveBeenCalled()
        for (const extra of [
          { signal: 'PRIVATE' },
          { systemCode: 'PRIVATE' },
          { stdout: 'PRIVATE' },
          { exitCode: 1.5 }
        ]) {
          expect(
            backendStartupStatusSchema.safeParse({
              ...status,
              diagnostic: { code: 'secret-exit-failed', ...extra }
            }).success
          ).toBe(false)
        }
        expect(
          backendStartupStatusSchema.safeParse({ ...status, diagnostic: { code: 'PRIVATE-CODE' } })
            .success
        ).toBe(false)
        expect(
          backendStartupStatusSchema.safeParse({
            ...status,
            diagnostic: { code: 'profile-read-failed', path: 'PRIVATE-PATH' }
          }).success
        ).toBe(false)
        for (const field of ['source', 'stage', 'reason', 'systemCode', 'path']) {
          expect(
            backendStartupStatusSchema.safeParse({
              ...status,
              diagnostic: {
                code: 'inventory-failed',
                source: 'cookies',
                stage: 'read-files',
                reason: 'operation-failed',
                [field]: 'PRIVATE-SECRET'
              }
            }).success
          ).toBe(false)
        }
        expect(
          backendStartupStatusSchema.safeParse({
            ...status,
            kind: 'ready',
            code: undefined,
            reason: undefined
          }).success
        ).toBe(false)
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )
  it('shows credential guidance and relaunches only after a confirmed child exit', async () => {
    host.dialog.mockResolvedValue({ response: 0 })
    const error = new DesktopBackendStartupError('fixture', 'credentials', true, '/logs', {
      protocolVersion: 1,
      attemptId: '9706f945-efc7-4fe8-b52e-cd1978a126a7',
      kind: 'failed',
      stage: 'credentials',
      code: 'credential-unavailable',
      reason: 'decryption-failed'
    })
    await recoverDesktopBackendStartup(error)
    expect(host.dialog.mock.calls[0][0]).toMatchObject({
      message: 'Open-Science 无法启动后端。',
      buttons: ['重试启动', '打开启动日志', '退出'],
      detail: expect.stringContaining('CREDENTIAL_IDENTITY: decryption-failed')
    })
    expect(host.relaunch).toHaveBeenCalledOnce()
    expect(host.exit).toHaveBeenCalledWith(1)
  })
  it('keeps logs accessible and offers no retry while a backend may survive', async () => {
    host.dialog.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    await recoverDesktopBackendStartup(
      new DesktopBackendStartupError('fixture', 'storage', false, '/logs')
    )
    expect(host.dialog.mock.calls[0][0].buttons).toEqual(['打开启动日志', '退出'])
    expect(host.openPath).toHaveBeenCalledWith('/logs')
    expect(host.relaunch).not.toHaveBeenCalled()
    expect(host.exit).toHaveBeenCalledWith(1)
  })
})
