import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { deliverDesktopEvent } from './desktop-event-delivery'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@aipoch/diagnostics/node', () => ({ createLogger: () => ({ warn }) }))

it('continues to healthy windows when a native send throws without logging private contents', () => {
  const failed = {
    isDestroyed: (): boolean => false,
    webContents: {
      isDestroyed: (): boolean => false,
      send: () => {
        throw new Error('private details')
      }
    }
  }
  const healthy = {
    isDestroyed: (): boolean => false,
    webContents: { isDestroyed: (): boolean => false, send: vi.fn() }
  }
  const invalidate = vi.fn()
  deliverDesktopEvent(
    [failed, healthy] as unknown as BrowserWindow[],
    () => true,
    'private channel',
    'private payload',
    invalidate
  )
  expect(invalidate).toHaveBeenCalledExactlyOnceWith(failed)
  expect(healthy.webContents.send).toHaveBeenCalledWith('private channel', 'private payload')
  expect(warn).toHaveBeenCalledWith('desktop event delivery failed', {
    reason: 'event-delivery-failed'
  })
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private')
})

it('skips destroyed contents and windows outside the application', () => {
  const send = vi.fn()
  const window = { isDestroyed: (): boolean => false, webContents: { isDestroyed: () => true, send } }
  deliverDesktopEvent([window] as unknown as BrowserWindow[], () => true, 'event', null)
  window.webContents.isDestroyed = () => false
  deliverDesktopEvent([window] as unknown as BrowserWindow[], () => false, 'event', null)
  expect(send).not.toHaveBeenCalled()
})

it('projects only lightweight settings events while preserving workspace payloads', async () => {
  const { markSettingsWebContents } = await import('./settings-window-policy')
  const makeWindow = (): {
    isDestroyed: () => boolean
    webContents: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
  } => ({
    isDestroyed: (): boolean => false,
    webContents: { isDestroyed: (): boolean => false, send: vi.fn() }
  })
  const settings = makeWindow()
  const workspace = makeWindow()
  markSettingsWebContents(settings.webContents)
  const windows = [settings, workspace] as unknown as BrowserWindow[]
  const session = { id: 'session', messages: ['large transcript'] }
  deliverDesktopEvent(windows, () => true, 'session:updated', session)
  expect(settings.webContents.send).toHaveBeenCalledExactlyOnceWith(
    'window:settings-catalog-changed'
  )
  expect(workspace.webContents.send).toHaveBeenCalledExactlyOnceWith('session:updated', session)
  settings.webContents.send.mockClear()
  deliverDesktopEvent(windows, () => true, 'acp:event', { content: 'large agent event' })
  expect(settings.webContents.send).not.toHaveBeenCalled()
  deliverDesktopEvent(windows, () => true, 'acp:state', {
    promptInFlight: true,
    sessions: [session]
  })
  expect(settings.webContents.send).toHaveBeenCalledExactlyOnceWith(
    'acp:prompt-in-flight-changed',
    true
  )
  settings.webContents.send.mockClear()
  const snapshot = { revision: 2 }
  deliverDesktopEvent(windows, () => true, 'settings:changed', snapshot)
  expect(settings.webContents.send).toHaveBeenCalledExactlyOnceWith('settings:changed', snapshot)
})
