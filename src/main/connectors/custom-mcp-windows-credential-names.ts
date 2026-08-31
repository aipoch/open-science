import type { StoredCustomMcpServer } from '../settings/types'

const hasCaseInsensitiveNameCollision = (values: Record<string, string> | undefined): boolean => {
  const names = Object.keys(values ?? {})
  return new Set(names.map((name) => name.toLowerCase())).size !== names.length
}

export const hasAmbiguousCustomMcpCredentialNames = (
  fields: Pick<StoredCustomMcpServer, 'transport' | 'env' | 'envRefs' | 'headers' | 'headerRefs'>,
  platform = process.platform
): boolean =>
  fields.transport === 'stdio'
    ? platform === 'win32' &&
      (hasCaseInsensitiveNameCollision(fields.envRefs) ||
        hasCaseInsensitiveNameCollision(fields.env))
    : hasCaseInsensitiveNameCollision(fields.headerRefs) ||
      hasCaseInsensitiveNameCollision(fields.headers)
