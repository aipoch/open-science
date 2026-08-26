import { describe, expect, it, vi } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'

import {
  createConnectionTypeResolver,
  checkInternetReachability,
  parseHardwarePorts,
  selectActiveIpv4
} from './network-info'

const ipv4 = (address: string, internal = false): NetworkInterfaceInfo => ({
  address,
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal,
  cidr: `${address}/24`
})

const ipv6 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: `${address}/64`,
  scopeid: 0
})

const HARDWARE_PORTS_OUTPUT = `Hardware Port: Wi-Fi
Device: en0
Hardware Port: Ethernet
Device: en6
Hardware Port: Thunderbolt Bridge
Device: bridge0
`

describe('selectActiveIpv4', () => {
  it('returns the first non-internal IPv4 address', () => {
    const interfaces = {
      lo0: [ipv4('127.0.0.1', true), ipv6('::1')],
      en0: [ipv6('fe80::1'), ipv4('192.168.1.10')]
    }
    expect(selectActiveIpv4(interfaces)).toBe('192.168.1.10')
  })

  it('skips interfaces without a non-internal IPv4 address', () => {
    const interfaces = {
      lo0: [ipv4('127.0.0.1', true)],
      utun3: [ipv6('fe80::2')]
    }
    expect(selectActiveIpv4(interfaces)).toBeNull()
  })

  it('returns null when there are no interfaces', () => {
    expect(selectActiveIpv4({})).toBeNull()
  })
})

describe('parseHardwarePorts', () => {
  it('maps devices to their hardware port names', () => {
    const ports = parseHardwarePorts(HARDWARE_PORTS_OUTPUT)
    expect(ports.get('en0')).toBe('Wi-Fi')
    expect(ports.get('en6')).toBe('Ethernet')
    expect(ports.get('bridge0')).toBe('Thunderbolt Bridge')
  })

  it('returns an empty map for empty output', () => {
    expect(parseHardwarePorts('')).toEqual(new Map())
  })
})

// The resolver shells out to networksetup, which only exists on macOS; the injected execFile
// seam is exercised on darwin only.
describe('createConnectionTypeResolver', () => {
  it('keeps an active interface missing from the hardware-port table unknown', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const execFile = vi.fn((_cmd, _args, _options, callback) => {
      callback(null, HARDWARE_PORTS_OUTPUT, '')
    })

    try {
      const resolve = createConnectionTypeResolver(execFile as never)
      await expect(resolve({ utun3: [ipv4('10.8.0.2')] })).resolves.toBe('unknown')
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform!)
    }
  })

  it('keeps a known non-Wi-Fi and non-Ethernet hardware port unknown', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const execFile = vi.fn((_cmd, _args, _options, callback) => {
      callback(null, HARDWARE_PORTS_OUTPUT, '')
    })

    try {
      const resolve = createConnectionTypeResolver(execFile as never)
      await expect(resolve({ bridge0: [ipv4('10.0.0.3')] })).resolves.toBe('unknown')
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform!)
    }
  })

  it.runIf(process.platform === 'darwin')('classifies a Wi-Fi hardware port as wifi', async () => {
    const execFile = vi.fn((_cmd, _args, _options, callback) => {
      callback(null, HARDWARE_PORTS_OUTPUT, '')
    })
    const resolve = createConnectionTypeResolver(execFile as never)

    await expect(resolve({ en0: [ipv4('192.168.1.10')] })).resolves.toBe('wifi')
  })

  it.runIf(process.platform === 'darwin')(
    'classifies a non-Wi-Fi active interface as ethernet',
    async () => {
      const execFile = vi.fn((_cmd, _args, _options, callback) => {
        callback(null, HARDWARE_PORTS_OUTPUT, '')
      })
      const resolve = createConnectionTypeResolver(execFile as never)

      await expect(resolve({ en6: [ipv4('10.0.0.2')] })).resolves.toBe('ethernet')
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps the type unknown when the port lookup fails and caches the attempt',
    async () => {
      const execFile = vi.fn((_cmd, _args, _options, callback) => {
        callback(new Error('not found'), '', '')
      })
      const resolve = createConnectionTypeResolver(execFile as never)

      await expect(resolve({ en0: [ipv4('192.168.1.10')] })).resolves.toBe('unknown')
      await expect(resolve({ en0: [ipv4('192.168.1.10')] })).resolves.toBe('unknown')
      expect(execFile).toHaveBeenCalledTimes(1)
    }
  )

  it.runIf(process.platform === 'darwin')(
    'returns unknown when no interface has an active IPv4 address',
    async () => {
      const execFile = vi.fn()
      const resolve = createConnectionTypeResolver(execFile as never)

      await expect(resolve({ lo0: [ipv4('127.0.0.1', true)] })).resolves.toBe('unknown')
      expect(execFile).not.toHaveBeenCalled()
    }
  )
})

// The checker reuses the onboarding probe; tests inject a fake probe so no real HTTPS happens.
describe('checkInternetReachability', () => {
  it('is reachable when any registry probe succeeds', async () => {
    const probe = vi.fn((registry: string) =>
      registry === 'npmjs' ? Promise.reject(new Error('down')) : Promise.resolve(12)
    )

    await expect(checkInternetReachability(probe as never)).resolves.toBe(true)
  })

  it('is unreachable when every registry probe fails', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('down')))

    await expect(checkInternetReachability(probe as never)).resolves.toBe(false)
  })

  it('probes every registry', async () => {
    const probe = vi.fn(() => Promise.resolve(5))

    await expect(checkInternetReachability(probe as never)).resolves.toBe(true)
    expect(probe).toHaveBeenCalledWith('npmjs')
    expect(probe).toHaveBeenCalledWith('npmmirror')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
