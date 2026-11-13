import { trustedDestinationId } from './notebook-network-settings'
import { normalizeStrictNetworkRule } from '@aipoch/notebook-network-sandbox/network-address'
import { OPEN_SCIENCE_DOMAIN_GROUPS } from './notebook-network-settings'
import type {
  NotebookNetworkSettings,
  NotebookStrictWhitelistEntry,
  NotebookWhitelistGroup
} from './notebook-network-settings'

export const BUILTIN_NETWORK_GROUP_NAMES: Readonly<Record<string, string>> = {
  packageRegistries: 'Package registries and source code',
  nih: 'NIH and NCBI',
  genomics: 'Genomics and pathways',
  proteomics: 'Proteomics and structures',
  literature: 'Scientific literature',
  clinical: 'Clinical and translational research'
}

export const normalizeStrictWhitelist = (value: unknown): NotebookStrictWhitelistEntry[] => {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const targets = new Set<string>()
  return value.flatMap((entry) => {
    const target = normalizeStrictNetworkRule(entry)
    if (!target || typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id)) return []
    const key = JSON.stringify(target)
    if (targets.has(key)) return []
    ids.add(entry.id)
    targets.add(key)
    return [
      {
        ...target,
        id: entry.id,
        origin: entry.origin === 'builtin' ? ('builtin' as const) : ('manual' as const),
        ...(typeof entry.groupId === 'string' && entry.groupId ? { groupId: entry.groupId } : {})
      }
    ]
  })
}

export const normalizeWhitelistGroups = (value: unknown): NotebookWhitelistGroup[] => {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id.trim() ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      ids.has(entry.id)
    )
      return []
    ids.add(entry.id)
    return [{ id: entry.id, name: entry.name.trim() }]
  })
}

/** Versioned settings.json migration. Explicitly empty or edited lists are never reseeded. */
export const migrateNotebookNetworkSettings = (
  settings: NotebookNetworkSettings
): NotebookNetworkSettings => {
  if (settings.strictWhitelistVersion === 1) return settings
  const groups = OPEN_SCIENCE_DOMAIN_GROUPS.filter(
    (group) => !settings.disabledOpenScienceDomainGroups.includes(group.id)
  )
  return {
    ...settings,
    mode: settings.mode ?? 'relaxed',
    strictWhitelistVersion: 1,
    ...(settings.trustedPrivateDestinations
      ? {
          trustedPrivateDestinations: settings.trustedPrivateDestinations.map((rule) => ({
            ...rule,
            id: trustedDestinationId(rule)
          }))
        }
      : {}),
    strictWhitelistGroups:
      settings.strictWhitelistGroups ??
      groups.map((group) => ({ id: group.id, name: BUILTIN_NETWORK_GROUP_NAMES[group.id]! })),
    strictWhitelist:
      settings.strictWhitelist ??
      normalizeStrictWhitelist(
        groups.flatMap((group) =>
          group.domains
            .filter(
              (hostnamePattern) => !settings.disabledOpenScienceDomains.includes(hostnamePattern)
            )
            .map((hostnamePattern) => ({
              id: `builtin:${group.id}:${hostnamePattern}`,
              protocol: 'https',
              hostnamePattern,
              port: 443,
              groupId: group.id,
              origin: 'builtin'
            }))
        )
      )
  }
}
