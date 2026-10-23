import { open } from 'node:fs/promises'

// The builder stamps the entry before execution. A running process must never read its identity
// from the entry on disk: a development rebuild can replace that file underneath it.
export function runningBackendBuildId(): string | undefined {
  const value: unknown = Reflect.get(globalThis, Symbol.for('open-science.backend-build-id'))
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}

export async function readBackendBuildId(entry: string): Promise<string> {
  const file = await open(entry, 'r')
  try {
    const prefix = Buffer.alloc(128)
    await file.read(prefix, 0, prefix.length, 0)
    const match = /^\/\/ open-science-backend-build:([a-f0-9]{64})\n/.exec(prefix.toString('utf8'))
    if (!match)
      throw new Error('The development backend needs rebuilding. Run npm run build:backend:dev.')
    return match[1]
  } finally {
    await file.close()
  }
}
