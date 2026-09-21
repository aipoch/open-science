// Registered before the first settings document loads. Weak ownership disappears on destruction.
const settingsContents = new WeakSet<object>()
export const markSettingsWebContents = (contents: object): void => {
  settingsContents.add(contents)
}
export const isSettingsWebContents = (contents: object): boolean => settingsContents.has(contents)
const SETTINGS_EVENTS = new Set([
  'settings:changed',
  'compute:hosts-changed',
  'locale:changed',
  'runtime:policy-changed',
  'permissions:changed',
  'project:created',
  'project:updated',
  'project:deleted',
  'project:deletion-cleanup-changed',
  'tags:changed',
  'memory:changed',
  'literature:changed',
  'pdf-annotations:changed',
  'skills:catalog-changed',
  'specialist:catalog-changed',
  'specialist:marketplace-download-progress',
  'settings:connector-runtime-changed',
  'remote-access:changed',
  'settings:wsl-setup-changed',
  'storage:migrate-progress',
  'update:status',
  'update:progress',
  'settings:install-log',
  'notebook-env:progress'
])
export const settingsReceivesEvent = (channel: string): boolean => SETTINGS_EVENTS.has(channel)
