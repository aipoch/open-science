import { spawnSync } from 'node:child_process'

// Only fixed call names and failure categories may reach diagnostics.
export class LinuxMetadataCallError extends Error {
  constructor(
    readonly method: string,
    category: string,
    readonly exitCode?: number
  ) {
    super(category)
  }
}

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
  if (result.error) {
    const timeout = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
    throw new LinuxMetadataCallError(method, timeout ? 'timeout' : 'subprocess-error')
  }
  if (result.signal) throw new LinuxMetadataCallError(method, 'terminated-by-signal')
  if (result.status !== 0)
    throw new LinuxMetadataCallError(method, 'unsuccessful-exit', result.status ?? undefined)
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new LinuxMetadataCallError(method, 'invalid-json')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('type' in value) ||
    value.type !== expectedType ||
    !('data' in value) ||
    !Array.isArray(value.data)
  )
    throw new LinuxMetadataCallError(method, 'invalid-response')
  return value.data
}
