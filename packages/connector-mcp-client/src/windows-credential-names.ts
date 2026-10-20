const hasCaseInsensitiveNameCollision = (values: Record<string, string> | undefined): boolean => {
  const names = Object.keys(values ?? {})
  return new Set(names.map((name) => name.toLowerCase())).size !== names.length
}

export const hasAmbiguousCustomMcpCredentialNames = (
  fields: {
    transport: 'stdio' | 'streamable_http' | 'sse'
    env?: Record<string, string>
    envRefs?: Record<string, string>
    headers?: Record<string, string>
    headerRefs?: Record<string, string>
  },
  platform = process.platform
): boolean =>
  fields.transport === 'stdio'
    ? platform === 'win32' &&
      (hasCaseInsensitiveNameCollision(fields.envRefs) ||
        hasCaseInsensitiveNameCollision(fields.env))
    : hasCaseInsensitiveNameCollision(fields.headerRefs) ||
      hasCaseInsensitiveNameCollision(fields.headers)
