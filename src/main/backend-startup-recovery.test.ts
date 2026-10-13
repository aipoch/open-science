import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopBackendStartupError } from './backend-startup'
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
