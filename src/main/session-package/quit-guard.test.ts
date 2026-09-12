import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { installSessionPackageQuitGuard } from './quit-guard'
import {
  clearApplicationShutdownTrigger,
  markApplicationShutdownTrigger
} from '../application-shutdown-trigger'

afterEach(clearApplicationShutdownTrigger)

it('blocks ordinary quit only while owned work is active and removes the listener on close', () => {
  const app = new EventEmitter()
  let active = true
  const blocked = vi.fn()
  const remove = installSessionPackageQuitGuard(app, () => active, blocked)
  const event = { preventDefault: vi.fn() }
  app.emit('before-quit', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(blocked).toHaveBeenCalledOnce()
  active = false
  app.emit('before-quit', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  active = true
  markApplicationShutdownTrigger('system')
  app.emit('before-quit', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  remove()
  expect(app.listenerCount('before-quit')).toBe(0)
})
