import type { EnvironmentCheckId, EnvironmentCheckItem } from '../../../../shared/settings'
import type { ArchivedView } from './ArchivedPanel'
import type { ComputeView } from './ComputePanel'
import type { CredentialsView } from './CredentialsPanel'
import type { ConnectorsView } from './ConnectorsPanel'
import type { MemoryView } from './MemoryPanel'
import type { SkillsView } from './SkillsPanel'
import type { SpecialistsView } from './SpecialistsPanel'
import type { TagsView } from './TagsPanel'

export type SettingsPanelId =
  | 'model'
  | 'agent'
  | 'skills'
  | 'connectors'
  | 'specialists'
  | 'memory'
  | 'tags'
  | 'compute'
  | 'permissions'
  | 'credentials'
  | 'archived'
  | 'usage'
  | 'general'
  | 'storage'
  | 'network'
  | 'runtimes'
  | 'remote-control'

export type ModelView = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; providerId: string }

export type NetworkView = { kind: 'list' | 'mirror' | 'proxy' | 'domains' }

// A Settings history entry contains only the active panel's state. This sum type prevents unrelated
// panel views from forming impossible combinations or leaking into every navigation transition.
export type SettingsRoute = {
  [Panel in SettingsPanelId]: Panel extends 'skills'
    ? { panel: Panel; view: SkillsView }
    : Panel extends 'model'
      ? { panel: Panel; view: ModelView }
      : Panel extends 'connectors'
        ? { panel: Panel; view: ConnectorsView }
        : Panel extends 'network'
          ? { panel: Panel; view: NetworkView }
          : Panel extends 'compute'
            ? { panel: Panel; view: ComputeView }
            : Panel extends 'credentials'
              ? { panel: Panel; view: CredentialsView }
              : Panel extends 'specialists'
                ? { panel: Panel; view: SpecialistsView }
                : Panel extends 'archived'
                  ? { panel: Panel; view: ArchivedView }
                  : Panel extends 'memory'
                    ? { panel: Panel; view: MemoryView }
                    : Panel extends 'tags'
                      ? { panel: Panel; view: TagsView }
                      : { panel: Panel }
}[SettingsPanelId]

export const INITIAL_SETTINGS_ROUTE: SettingsRoute = {
  panel: 'model',
  view: { kind: 'list' }
}

export const settingsPanelRoute = (panel: SettingsPanelId): SettingsRoute => {
  switch (panel) {
    case 'skills':
    case 'model':
    case 'connectors':
    case 'network':
    case 'compute':
    case 'credentials':
    case 'specialists':
    case 'archived':
    case 'memory':
    case 'tags':
      return { panel, view: { kind: 'list' } }
    default:
      return { panel }
  }
}

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
