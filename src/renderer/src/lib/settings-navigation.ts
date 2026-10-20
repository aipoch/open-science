import type {
  EnvironmentCheckId,
  EnvironmentCheckItem,
  ConnectorTemplateDefinition
} from '../../../shared/settings'
import type { CreateSpecialistInput } from '@aipoch/specialists'

export type ArchivedView = { kind: 'list' } | { kind: 'project'; projectId: string }

export type ComputeView =
  | { kind: 'list' }
  | { kind: 'add' }
  | {
      kind: 'detail'
      providerId: string
      authenticationFocus?: import('@aipoch/compute').ComputeAuthenticationErrorCode
      authenticationRequestId?: number
    }

export type CredentialsServiceId = 'github' | 'literature' | 'openalex' | 'unpaywall'

export type CredentialsView =
  | { kind: 'list' }
  | { kind: 'service'; serviceId: CredentialsServiceId }
  | { kind: 'create' }
  | { kind: 'credential'; id: string }

export type ConnectorsView =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | {
      kind: 'add'
      transport: 'local' | 'remote'
      template?: ConnectorTemplateDefinition
      credentialView?: 'create'
    }
  | { kind: 'edit'; id: string; credentialView?: 'create' }
  | { kind: 'import' }
  | { kind: 'export'; id: string }

export type MemoryView =
  { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; categoryId: string }

export type SkillsView =
  | SkillMarketplaceView
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'create' }
  | { kind: 'edit'; id: string }
  | { kind: 'import' }
  | { kind: 'import-agent-home' }
  | { kind: 'upload' }

export type SpecialistsView =
  | { kind: 'list' }
  | { kind: 'create'; draft?: CreateSpecialistInput }
  | { kind: 'edit'; id: string }
  | { kind: 'export'; id: string }
  | { kind: 'import' }
  | { kind: 'builtin'; id: string }
  | SpecialistMarketplaceView

export type TagsView =
  { kind: 'list'; tagId?: string } | { kind: 'create' } | { kind: 'edit'; tagId: string }

export type ModelView =
  | ClassificationView
  | { kind: 'list' }
  | { kind: 'local-models' }
  | { kind: 'create' }
  | { kind: 'edit'; providerId: string }

export type SkillMarketplaceView =
  | { kind: 'marketplace' }
  | { kind: 'marketplace-batch' }
  | { kind: 'marketplace-detail'; id: string; displayName: string; snapshotId: string }

export type SpecialistMarketplaceView =
  | { kind: 'marketplace' }
  | { kind: 'marketplace-sources' }
  | {
      kind: 'marketplace-release'
      sourceId: string
      sourceName?: string
      sourceTrust?: 'official' | 'user-approved'
      id: string
      version: string
      installedVersion?: string
      updateAvailable?: boolean
    }

export type ClassificationView =
  | { kind: 'classification' }
  | { kind: 'classification-create' }
  | { kind: 'classification-edit'; serviceId: string }

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
  panel: 'general'
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
