export const CUSTOM_CONNECTOR_SLUG_MAX_LENGTH = 64
export const CUSTOM_CONNECTOR_SLUG_PATTERN = /^[a-z0-9-]+$/

export const toCustomConnectorSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, CUSTOM_CONNECTOR_SLUG_MAX_LENGTH) || 'connector'

export const isCustomConnectorSlug = (value: string): boolean =>
  value.length <= CUSTOM_CONNECTOR_SLUG_MAX_LENGTH && CUSTOM_CONNECTOR_SLUG_PATTERN.test(value)

export const customConnectorSlug = (server: { name: string; slug?: string }): string =>
  server.slug && isCustomConnectorSlug(server.slug)
    ? server.slug
    : toCustomConnectorSlug(server.name)
