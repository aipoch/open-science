/** Canonical host form shared by settings, grants and the renderer. IPv6 is unbracketed in storage. */
export const normalizeNetworkHostname = (value: string): string | undefined => {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '')
  if (!trimmed || /[\s/\\@?#%]/.test(trimmed)) return undefined
  if (
    (trimmed.startsWith('[') && !trimmed.endsWith(']')) ||
    (!trimmed.startsWith('[') && trimmed.endsWith(']'))
  )
    return undefined
  try {
    const authority = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed
    const hostname = new URL(`https://${authority}`).hostname.replace(/^\[|\]$/g, '')
    if (!hostname || hostname.length > 253) return undefined
    if (
      !hostname.includes(':') &&
      hostname
        .split('.')
        .some(
          (label) =>
            !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
        )
    )
      return undefined
    return hostname
  } catch {
    return undefined
  }
}

/** IPv6 is bracketed wherever a host is rendered as part of an authority or key. */
export const formatNetworkHostname = (hostname: string): string =>
  hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname

export const isNetworkIpLiteral = (hostname: string): boolean =>
  hostname.includes(':') || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname)

export const requiresNetworkException = (hostname: string, protocol?: 'http' | 'https'): boolean =>
  protocol === 'http' || isNetworkIpLiteral(hostname)
