import { spawnSync } from 'node:child_process'

// Metadata-only calls: callers supply fixed service/method/signature contracts. Do not add
// secret reads, wallet opens/unlocks or writes to this pre-ready transport.
export const callLinuxCredentialMetadata = (
  service: string,
  path: string,
  iface: string,
  method: string,
  signature: string,
  args: string[],
  expectedType: string
): unknown[] => {
  const result = spawnSync(
    '/usr/bin/busctl',
    [
      '--user',
      '--json=short',
      '--timeout=5s',
      '--allow-interactive-authorization=no',
      'call',
      service,
      path,
      iface,
      method,
      signature,
      ...args
    ],
    { encoding: 'utf8', timeout: 6_000, maxBuffer: 16_384, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  if (result.error || result.status !== 0 || result.signal) throw new Error('metadata-unavailable')
  const value: unknown = JSON.parse(result.stdout)
  if (!value || typeof value !== 'object') throw new Error('invalid-response')
  const response = value as { type?: unknown; data?: unknown }
  if (response.type !== expectedType || !Array.isArray(response.data))
    throw new Error('invalid-response')
  return response.data
}
