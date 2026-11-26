import type {
  NotebookNetworkSettings,
  NotebookStrictWhitelistEntry,
  TrustedPrivateDestination
} from '../../../../shared/notebook-network-settings'
import { normalizeTrustedPrivateDestinations } from '../../../../shared/notebook-network'
import { trustedDestinationId } from '../../../../shared/notebook-network-settings'

type NotebookRuleTarget = Pick<
  NotebookStrictWhitelistEntry,
  'hostnamePattern' | 'port' | 'protocol'
>
type NotebookRuleLike = NotebookRuleTarget | TrustedPrivateDestination

const sameDestination = (rule: TrustedPrivateDestination, target: NotebookRuleLike): boolean =>
  rule.hostname === ('hostnamePattern' in target ? target.hostnamePattern : target.hostname) &&
  rule.port === target.port &&
  (rule.protocol ?? 'https') === (target.protocol ?? 'https')

const sharedRuleForId = (
  settings: NotebookNetworkSettings,
  ruleId: string
): TrustedPrivateDestination | undefined =>
  (settings.trustedPrivateDestinations ?? []).find(
    (rule) => rule.sharedWithAgent && !rule.managedGrantId && trustedDestinationId(rule) === ruleId
  )

export const removeNotebookNetworkRule = (
  settings: NotebookNetworkSettings,
  ruleId: string
): NotebookNetworkSettings => {
  const shared = sharedRuleForId(settings, ruleId)
  if (!shared)
    return {
      ...settings,
      strictWhitelist: (settings.strictWhitelist ?? []).filter((rule) => rule.id !== ruleId)
    }
  return {
    ...settings,
    strictWhitelist: (settings.strictWhitelist ?? []).filter(
      (rule) => !sameDestination(shared, rule)
    ),
    trustedPrivateDestinations: (settings.trustedPrivateDestinations ?? []).filter(
      (rule) => rule !== shared && !sameDestination(rule, shared)
    )
  }
}

export const updateNotebookNetworkRule = (
  settings: NotebookNetworkSettings,
  ruleId: string,
  target: NotebookRuleTarget
): NotebookNetworkSettings | 'duplicate' | 'invalid-address' => {
  const shared = sharedRuleForId(settings, ruleId)
  if (!shared)
    return {
      ...settings,
      strictWhitelist: (settings.strictWhitelist ?? []).map((rule) =>
        rule.id === ruleId ? { ...rule, ...target } : rule
      )
    }
  if (target.hostnamePattern.startsWith('*.')) return 'invalid-address'
  if (
    (settings.trustedPrivateDestinations ?? []).some(
      (rule) => rule !== shared && sameDestination(rule, target)
    ) ||
    (settings.strictWhitelist ?? []).some(
      (rule) =>
        !sameDestination(shared, rule) &&
        rule.hostnamePattern === target.hostnamePattern &&
        rule.port === target.port &&
        rule.protocol === target.protocol
    )
  )
    return 'duplicate'
  const withoutSharedFlag = { ...shared }
  delete withoutSharedFlag.sharedWithAgent
  const updated: TrustedPrivateDestination = {
    ...withoutSharedFlag,
    hostname: target.hostnamePattern,
    port: target.port,
    protocol: target.protocol,
    approvedAddresses: [],
    ...(target.protocol === 'http' ? { sharedWithAgent: true } : {})
  }
  return {
    ...settings,
    strictWhitelist:
      settings.mode !== 'strict' || target.protocol === 'http'
        ? (settings.strictWhitelist ?? []).filter((rule) => !sameDestination(shared, rule))
        : [
            ...(settings.strictWhitelist ?? []).filter((rule) => !sameDestination(shared, rule)),
            { ...target, id: ruleId, origin: 'manual' as const }
          ],
    trustedPrivateDestinations: normalizeTrustedPrivateDestinations(
      (settings.trustedPrivateDestinations ?? []).filter((rule) => rule !== shared).concat(updated)
    )
  }
}
