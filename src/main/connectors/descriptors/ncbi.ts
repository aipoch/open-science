import type { ConnectorCredentials } from '../types'

// Builds the NCBI E-utilities etiquette query suffix; empty when unset (calls still work).
export function ncbiEtiquette(credentials: ConnectorCredentials): string {
  const parts: string[] = []
  if (credentials.ncbiEmail) parts.push(`email=${encodeURIComponent(credentials.ncbiEmail)}`)
  if (credentials.ncbiApiKey) parts.push(`api_key=${encodeURIComponent(credentials.ncbiApiKey)}`)
  return parts.length ? `&${parts.join('&')}` : ''
}
