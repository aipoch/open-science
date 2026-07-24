import type { EnvironmentCheckId, EnvironmentCheckItem } from '../../../../shared/settings'

export type SettingsPanelId =
  | 'model'
  | 'agent'
  | 'skills'
  | 'connectors'
  | 'compute'
  | 'general'
  | 'storage'
  | 'network'
  | 'runtimes'

const AGENT_REPAIR_CHECK_IDS: readonly EnvironmentCheckId[] = ['agent', 'install-network', 'system']

export const isAgentRepairCheck = (id: EnvironmentCheckId): boolean =>
  AGENT_REPAIR_CHECK_IDS.includes(id)

export const getEnvironmentRepairPanel = (
  failures: readonly EnvironmentCheckItem[]
): Extract<SettingsPanelId, 'agent' | 'storage'> | undefined => {
  // Storage must be writable before runtime repair can persist its result, so it always wins.
  if (failures.some((failure) => failure.id === 'storage')) return 'storage'

  return failures.some((failure) => isAgentRepairCheck(failure.id)) ? 'agent' : undefined
}
