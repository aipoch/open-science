import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'

import type { NetworkConnectionType, NetworkInfo } from '../../shared/network'
import type { ManagedClaudeRegistry } from '../../shared/settings'
import { REGISTRY_URLS, probeRegistryReachability } from '../settings/environment-check'

type NetworkInterfaceMap = ReturnType<typeof networkInterfaces>

type RegistryProbe = typeof probeRegistryReachability

// Reachability of the package registries used for managed installs. Reuses the onboarding
// environment check's HTTPS HEAD probe against both registry roots (npmjs and npmmirror) —
// not a generic "is the internet usable" check. Reachable when either registry answers 2xx;
// each probe carries the probe's own 5s timeout and they run in parallel.
const checkInternetReachability = (
  probe: RegistryProbe = probeRegistryReachability
): Promise<boolean> => {
  const registries = Object.keys(REGISTRY_URLS) as ManagedClaudeRegistry[]
  return Promise.all(
    registries.map((registry) =>
      probe(registry).then(
        () => true,
        () => false
      )
    )
  ).then((results) => results.some(Boolean))
}

// First non-internal IPv4 address across the active interfaces. Internal (loopback) and
// IPv6-only interfaces are skipped; a machine with no such interface is treated as unknown.
const selectActiveIpv4 = (interfaces: NetworkInterfaceMap): string | null => {
  for (const addresses of Object.values(interfaces)) {
    const ipv4 = addresses?.find((address) => address.family === 'IPv4' && !address.internal)
    if (ipv4) return ipv4.address
  }
  return null
}

// Parses `networksetup -listallhardwareports` output into device -> hardware port name pairs,
// e.g. "Hardware Port: Wi-Fi\nDevice: en0" maps en0 to "Wi-Fi".
const parseHardwarePorts = (output: string): Map<string, string> => {
  const ports = new Map<string, string>()
  let currentPort: string | null = null

  for (const line of output.split('\n')) {
    const portMatch = /^Hardware Port: (.+)$/.exec(line.trim())
    const deviceMatch = /^Device: (.+)$/.exec(line.trim())
    if (portMatch) {
      currentPort = portMatch[1]
    } else if (deviceMatch && currentPort !== null) {
      ports.set(deviceMatch[1], currentPort)
      currentPort = null
    }
  }

  return ports
}

// macOS-only classification: the active IPv4 interface's device is looked up in the hardware
// port map. Only names explicitly identifying Wi-Fi or Ethernet are classified; other hardware
// ports remain unknown. The
// hardware port list is exec'd once and the promise cached. On other platforms (or when the
// device is virtual/unmapped or the lookup fails) classification is unknown.
const createConnectionTypeResolver = (
  execFileFn: typeof execFile = execFile
): ((interfaces: NetworkInterfaceMap) => Promise<NetworkConnectionType>) => {
  if (process.platform !== 'darwin') {
    return () => Promise.resolve('unknown')
  }

  let cachedPorts: Promise<Map<string, string>> | null = null
  const hardwarePorts = (): Promise<Map<string, string>> => {
    if (!cachedPorts) {
      cachedPorts = new Promise((resolve) => {
        execFileFn(
          'networksetup',
          ['-listallhardwareports'],
          { timeout: 5000 },
          (error, stdout) => {
            resolve(error ? new Map() : parseHardwarePorts(stdout))
          }
        )
      })
    }
    return cachedPorts
  }

  return async (interfaces) => {
    for (const [name, addresses] of Object.entries(interfaces)) {
      const hasActiveIpv4 = addresses?.some(
        (address) => address.family === 'IPv4' && !address.internal
      )
      if (!hasActiveIpv4) continue

      const portName = (await hardwarePorts()).get(name)
      if (portName === undefined) return 'unknown'
      if (portName.includes('Wi-Fi')) return 'wifi'
      if (portName.includes('Ethernet')) return 'ethernet'
      return 'unknown'
    }
    return 'unknown'
  }
}

const resolveConnectionType = createConnectionTypeResolver()

const getNetworkInfo = async (): Promise<NetworkInfo> => {
  const interfaces = networkInterfaces()
  const ipAddress = selectActiveIpv4(interfaces)

  if (ipAddress === null) return { connectionType: 'unknown', ipAddress: null }

  return { connectionType: await resolveConnectionType(interfaces), ipAddress }
}

export {
  getNetworkInfo,
  selectActiveIpv4,
  parseHardwarePorts,
  createConnectionTypeResolver,
  checkInternetReachability
}
