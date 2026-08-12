export const CUSTOM_CONNECTOR_NAME_MAX_LENGTH = 64
export const CUSTOM_CONNECTOR_NAME_PATTERN = /^[a-z0-9-]+$/

export const toCustomConnectorName = (displayName: string): string =>
  displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CUSTOM_CONNECTOR_NAME_MAX_LENGTH) || 'connector'

export const isCustomConnectorName = (value: string): boolean =>
  value.length <= CUSTOM_CONNECTOR_NAME_MAX_LENGTH && CUSTOM_CONNECTOR_NAME_PATTERN.test(value)

export const customConnectorSkillName = (name: string): string => `mcp-${name}`

export const customConnectorNameFromSkillName = (name: string): string | undefined => {
  if (!name.startsWith('mcp-')) return undefined
  const connectorName = name.slice('mcp-'.length)
  return isCustomConnectorName(connectorName) ? connectorName : undefined
}
