export const RESOURCE_ID_MAX_LENGTH = 128

const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/
const RESOURCE_ID_RESERVED_PREFIXES = ['os-', 'mcp-'] as const

export const validateResourceId = (id: string): string | undefined => {
  if (!RESOURCE_ID_PATTERN.test(id)) {
    return 'ID may only contain lowercase letters, numbers, and hyphens.'
  }
  if (RESOURCE_ID_RESERVED_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    return 'IDs starting with os- or mcp- are reserved.'
  }
  return undefined
}

export const inferResourceId = (name: string): string | undefined => {
  const id = name
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return validateResourceId(id) === undefined ? id : undefined
}
