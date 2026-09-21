// Native Settings owns a separate renderer, but never a second settings or workspace authority.
export const SETTINGS_WINDOW_CHANNELS = {
  open: 'window:open-settings',
  ready: 'window:settings-ready',
  opened: 'window:settings-opened',
  context: 'window:settings-context',
  navigate: 'window:navigate-workspace',
  navigation: 'window:workspace-navigation',
  navigated: 'window:workspace-navigated',
  catalogChanged: 'window:settings-catalog-changed'
} as const

export type SettingsWindowContext = { activeProjectId?: string }
export type SettingsWindowOpenRequest = SettingsWindowContext & {
  route?: { panel: string; view?: unknown }
}
export type SettingsWindowState = SettingsWindowOpenRequest & {
  revision: number
  visible?: boolean
}
export type SettingsWorkspaceNavigation = {
  method:
    | 'openProject'
    | 'openSessionById'
    | 'openLiteratureItem'
    | 'startCustomizeConversation'
    | 'startWslSupportConversation'
    | 'requestWslSetupProjectCreation'
  args: unknown[]
}
const METHODS = new Set<SettingsWorkspaceNavigation['method']>([
  'openProject',
  'openSessionById',
  'openLiteratureItem',
  'startCustomizeConversation',
  'startWslSupportConversation',
  'requestWslSetupProjectCreation'
])
const PANELS = new Set([
  'model',
  'agent',
  'skills',
  'connectors',
  'specialists',
  'memory',
  'tags',
  'compute',
  'permissions',
  'credentials',
  'archived',
  'usage',
  'general',
  'storage',
  'network',
  'runtimes',
  'remote-control'
])
const bounded = (value: unknown): boolean => {
  try {
    return JSON.stringify(value).length <= 64 * 1024
  } catch {
    return false
  }
}
export const isSettingsWindowRequest = (value: unknown): value is SettingsWindowOpenRequest => {
  if (!value || typeof value !== 'object' || !bounded(value)) return false
  const request = value as SettingsWindowOpenRequest
  return (
    (request.activeProjectId === undefined || typeof request.activeProjectId === 'string') &&
    (request.route === undefined || (!!request.route && PANELS.has(request.route.panel)))
  )
}
export const isSettingsWorkspaceNavigation = (
  value: unknown
): value is SettingsWorkspaceNavigation => {
  if (!value || typeof value !== 'object' || !bounded(value)) return false
  const request = value as SettingsWorkspaceNavigation
  return METHODS.has(request.method) && Array.isArray(request.args) && request.args.length <= 4
}
