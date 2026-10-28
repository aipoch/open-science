import { z } from 'zod'

const snapshotSchema = z.object({
  revision: z.string(),
  directories: z.array(
    z.object({
      name: z.string(),
      path: z.string().min(1),
      access: z.enum(['ro', 'rw']),
      grantedAt: z.string().datetime({ offset: true })
    })
  )
})

export type AuthorizedDirectorySnapshot = z.infer<typeof snapshotSchema>

// Providers persist either the snapshot itself or a JSON/MCP result envelope.
export const readAuthorizedDirectories = (
  value: unknown,
  depth = 0
): AuthorizedDirectorySnapshot | undefined => {
  if (depth > 5) return undefined
  if (typeof value === 'string') {
    try {
      return readAuthorizedDirectories(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.isError === true) return undefined
  const snapshot = snapshotSchema.safeParse(record)
  if (snapshot.success) return snapshot.data
  for (const nested of [record.structuredContent, record.result]) {
    const parsed = readAuthorizedDirectories(nested, depth + 1)
    if (parsed) return parsed
  }
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object' || block.type !== 'text') continue
      const parsed = readAuthorizedDirectories(block.text, depth + 1)
      if (parsed) return parsed
    }
  }
  return undefined
}
