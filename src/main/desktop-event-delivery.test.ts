import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { deliverDesktopEvent } from './desktop-event-delivery'

const warn = vi.hoisted(() => vi.fn())
vi.mock('./logger', () => ({ createLogger: () => ({ warn }) }))

it('continues to healthy windows when a native send throws without logging private contents', () => {
  const failed = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: () => {
        throw new Error('private details')
      }
    }
  }
  const healthy = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() }
  }
  deliverDesktopEvent(
    [failed, healthy] as unknown as BrowserWindow[],
    () => true,
    'private channel',
    'private payload'
  )
  expect(healthy.webContents.send).toHaveBeenCalledWith('private channel', 'private payload')
  expect(warn).toHaveBeenCalledWith('desktop event delivery failed', {
    reason: 'event-delivery-failed'
  })
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private')
})

it('skips destroyed contents and windows outside the application', () => {
  const send = vi.fn()
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => true, send } }
  deliverDesktopEvent([window] as unknown as BrowserWindow[], () => true, 'event', null)
  window.webContents.isDestroyed = () => false
  deliverDesktopEvent([window] as unknown as BrowserWindow[], () => false, 'event', null)
  expect(send).not.toHaveBeenCalled()
})
