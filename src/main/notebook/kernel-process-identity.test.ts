import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: f.read }))
import {
  bootTokenProvesReboot,
  isValidBootToken,
  readBootToken,
  readProcessStartToken
} from './kernel-process-identity'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const firstBoot = 'abcdef01-2345-6789-abcd-ef0123456789'
const nextBoot = 'abcdef02-2345-6789-abcd-ef0123456789'
beforeEach(() => {
  f.read.mockReset()
  Object.defineProperty(process, 'platform', { value: 'linux' })
})
afterEach(() => Object.defineProperty(process, 'platform', platform))

describe('persisted kernel process identity compatibility', () => {
  it('reads the raw field 22 token after a command containing spaces and parentheses', () => {
    f.read.mockReturnValue(`42 (analysis ) worker) S ${Array(18).fill('0').join(' ')} 12345 0`)
    expect(readProcessStartToken(42)).toBe('12345')
    expect(f.read).toHaveBeenCalledWith('/proc/42/stat', 'utf8')
  })

  it.each([
    'missing parentheses',
    '42 (worker) S',
    `42 (worker) S ${Array(18).fill('0').join(' ')} invalid`
  ])('retains unknown identity for a malformed stat: %s', (stat) => {
    f.read.mockReturnValue(stat)
    expect(readProcessStartToken(42)).toBeUndefined()
  })

  it('preserves the canonical raw boot UUID without accepting case-only reboot evidence', () => {
    f.read.mockReturnValue(`\n${firstBoot}\n`)
    expect(readBootToken()).toBe(firstBoot)
    expect(f.read).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8')
    expect(bootTokenProvesReboot(firstBoot, nextBoot)).toBe(true)
    expect(bootTokenProvesReboot(firstBoot, firstBoot)).toBe(false)
    expect(bootTokenProvesReboot(firstBoot, firstBoot.toUpperCase())).toBe(false)
  })

  it.each([undefined, '', 'up:1000', firstBoot.toUpperCase(), `linux-boot:${firstBoot}`])(
    'keeps malformed or unavailable boot evidence blocked: %s',
    (token) => {
      expect(isValidBootToken(token)).toBe(false)
      expect(bootTokenProvesReboot(token, nextBoot)).toBe(false)
      expect(bootTokenProvesReboot(firstBoot, token)).toBe(false)
      f.read.mockReturnValue(token ?? '')
      expect(readBootToken()).toBeUndefined()
    }
  )

  it('does not infer death or reboot when the OS evidence cannot be read', () => {
    f.read.mockImplementation(() => {
      throw new Error('Permission denied')
    })
    expect(readProcessStartToken(42)).toBeUndefined()
    expect(readBootToken()).toBeUndefined()
  })

  it.each(['darwin', 'win32'])('keeps legacy Linux-only receipts unknown on %s', (value) => {
    Object.defineProperty(process, 'platform', { value })
    expect(readProcessStartToken(42)).toBeUndefined()
    expect(readBootToken()).toBeUndefined()
    expect(f.read).not.toHaveBeenCalled()
  })
})
