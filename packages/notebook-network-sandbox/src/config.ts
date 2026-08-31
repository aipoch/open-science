import { homedir } from 'node:os'
import { join } from 'node:path'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

import type { NetworkRuntimeConfig } from '../runtime/src/index.js'

import type { NotebookNetworkPolicy, NotebookNetworkSandboxOptions } from './types.js'

const WINDOWS_INSTALLATION_ID = '0f3cd2a44c3d4e4e9f1e2a5b'

const architectureDirectory = (
  architecture: NodeJS.Architecture = process.arch
): 'arm64' | 'x64' => {
  if (architecture === 'arm64') return 'arm64'
  if (architecture === 'x64') return 'x64'
  throw new Error(`Notebook network sandbox does not support architecture: ${architecture}`)
}

const normalizeDomains = (domains: readonly string[]): string[] => [
  ...new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean))
]

const validateDomainPattern = (pattern: string, allowFlexibleWildcard: boolean): void => {
  const portSeparator = pattern.lastIndexOf(':')
  const hasPortSeparator = portSeparator > 0
  const portText = hasPortSeparator ? pattern.slice(portSeparator + 1) : ''
  if (hasPortSeparator && !/^\d+$/.test(portText)) {
    throw new Error(`Invalid domain port: ${pattern}`)
  }
  const hostPattern = hasPortSeparator ? pattern.slice(0, portSeparator) : pattern
  if (hasPortSeparator) {
    const port = Number(portText)
    if (port < 1 || port > 65535) throw new Error(`Invalid domain port: ${pattern}`)
  }
  if (hostPattern === '*' && allowFlexibleWildcard) return
  const labels = hostPattern.split('.')
  const wildcard = labels.includes('*')
  const fixedLabels = labels.filter((label) => label !== '*')
  const host = fixedLabels.join('.')
  if (
    !host ||
    hostPattern.includes('/') ||
    hostPattern.includes('://') ||
    labels.some((label) => label.includes('*') && label !== '*' && !allowFlexibleWildcard)
  ) {
    throw new Error(`Invalid domain pattern: ${pattern}`)
  }
  if (
    isIP(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    !host.includes('.') ||
    (wildcard && fixedLabels.length < 2)
  ) {
    throw new Error(`Invalid domain pattern: ${pattern}`)
  }
  const ascii = domainToASCII(hostPattern.replaceAll('*', 'wildcard'))
  if (
    !ascii ||
    hostPattern.length > 253 ||
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        (label !== '*' && !/^[a-z0-9](?:[a-z0-9*-]*[a-z0-9*])?$/i.test(label))
    )
  ) {
    throw new Error(`Invalid domain pattern: ${pattern}`)
  }
}

const normalizePolicy = (policy: NotebookNetworkPolicy): NotebookNetworkPolicy => ({
  allowedDomains: normalizeDomains(policy.allowedDomains),
  deniedDomains: normalizeDomains(policy.deniedDomains),
  ...(policy.deniedDomainReasons
    ? {
        deniedDomainReasons: Object.fromEntries(
          Object.entries(policy.deniedDomainReasons)
            .map(([domain, reason]) => [domain.trim().toLowerCase(), reason] as const)
            .filter(([domain]) => domain.length > 0)
        )
      }
    : {})
})

const createRuntimeConfig = (
  options: NotebookNetworkSandboxOptions,
  architecture: NodeJS.Architecture = process.arch
): NetworkRuntimeConfig => {
  const arch = architectureDirectory(architecture)
  const policy = normalizePolicy(options.policy)
  for (const domain of policy.allowedDomains) validateDomainPattern(domain, false)
  for (const domain of policy.deniedDomains) validateDomainPattern(domain, true)
  const resourceRoot = options.resources.root
  const installationId = WINDOWS_INSTALLATION_ID
  const windowsOwnershipRoot = join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'Aipoch',
    'OpenScience',
    'notebook-sandbox',
    installationId
  )
  return {
    allowedDomains: [...policy.allowedDomains],
    deniedDomains: [...policy.deniedDomains],
    ...(policy.deniedDomainReasons
      ? { deniedDomainReasons: { ...policy.deniedDomainReasons } }
      : {}),
    ...(options.parentProxy ? { parentProxy: { ...options.parentProxy } } : {}),
    ...(options.trustBundle
      ? { trustedCaCertificates: [...options.trustBundle.certificates] }
      : {}),
    installationId,
    windowsOwnershipRoot,
    windowsHostPath: join(resourceRoot, 'windows', arch, 'notebook-appcontainer-host.exe')
  }
}

export { architectureDirectory, createRuntimeConfig, normalizePolicy }
