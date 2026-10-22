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
  exit: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => ['zh-CN'], relaunch: host.relaunch, exit: host.exit },
  dialog: { showMessageBox: host.dialog },
  shell: { openPath: host.openPath }
}))
import { recoverDesktopBackendStartup } from './backend-startup-recovery'
beforeEach(() => {
  vi.clearAllMocks()
  host.openPath.mockResolvedValue('')
})
describe('backend startup recovery', () => {
  it.each([
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
