import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

/** Main-owned ceiling. Membership never grants access; the normal policy still decides. */
export type ExecutionConfinement = Readonly<{
  mode: 'offline-demo' | 'research'
  allowedNetworkHosts?: readonly string[]
}>

const normalizeHost = (value: string): string => {
  if (typeof value !== 'string') throw new Error('Invalid execution network host.')
  const input = value.trim().toLowerCase().replace(/\.$/, '')
  if (isIP(input)) return input
  const ascii = domainToASCII(input)
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error('Execution network hosts must be exact hostnames, without ports or wildcards.')
  return ascii
}

export const normalizeExecutionConfinement = (
  input: ExecutionConfinement
): ExecutionConfinement => {
  if (!input || !['offline-demo', 'research'].includes(input.mode))
    throw new Error('Invalid execution confinement mode.')
  if (input.allowedNetworkHosts !== undefined && !Array.isArray(input.allowedNetworkHosts))
    throw new Error('Invalid execution network hosts.')
  const hosts = [...new Set((input.allowedNetworkHosts ?? []).map(normalizeHost))].sort()
  if (input.mode === 'offline-demo' && hosts.length)
    throw new Error('Offline demonstrations cannot allow external network hosts.')
  return Object.freeze({ mode: input.mode, allowedNetworkHosts: Object.freeze(hosts) })
}

export const executionConfinementAllowsHost = (
  confinement: ExecutionConfinement,
  host: string
): boolean => {
  if (confinement.mode === 'offline-demo') return false
  try {
    return confinement.allowedNetworkHosts?.includes(normalizeHost(host)) === true
  } catch {
    return false
  }
}
