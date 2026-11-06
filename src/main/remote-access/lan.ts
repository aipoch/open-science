import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

const VIRTUAL_INTERFACE =
  /^(?:docker|br-|veth|utun|tun|tap|vmnet|vbox|virbr|vEthernet|wsl|tailscale|wg\d*)/i

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number)
  return (
    parts.length === 4 &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  )
}

export const lanAddresses = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string[] => {
  const candidates: string[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue
    for (const entry of entries ?? []) {
      const address = (entry as NetworkInterfaceInfo).address
      if (entry.internal || entry.family !== 'IPv4' || address.startsWith('169.254.')) continue
      if (!candidates.includes(address)) candidates.push(address)
    }
  }
  return candidates.sort((a, b) => Number(isPrivateIpv4(b)) - Number(isPrivateIpv4(a)))
}
