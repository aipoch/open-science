export { TaskRunTracingError } from '../../shared/task-api'

type TaskControlPorts = {
  findSessionAfterCatalogHydration?(sessionId: string): Promise<{ projectId: string } | undefined>
  findArtifactSessions?(
    artifactId: string
  ): Promise<Array<{ projectId: string; sessionId: string }>>
  specialists: {
    resolve(reference: string): Promise<{ id: string }>
  }
}

export type { TaskControlPorts }

export const MAX_TRACE_METADATA_KEYS = 8
export const MAX_TRACE_METADATA_VALUE_LENGTH = 128

/** Returns a user-facing error, or undefined when the Run trace metadata is acceptable. */
export function traceMetadataError(metadata: unknown, otelTraces: boolean): string | undefined {
  if (!otelTraces) return 'traceMetadata requires otelTraces.'
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return 'traceMetadata must be an object of string values.'
  const entries = Object.entries(metadata)
  if (entries.length === 0 || entries.length > MAX_TRACE_METADATA_KEYS)
    return `traceMetadata must have 1 to ${MAX_TRACE_METADATA_KEYS} keys.`
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key))
      return 'traceMetadata keys must match [a-z][a-z0-9_]{0,31}.'
    if (typeof value !== 'string' || value.length > MAX_TRACE_METADATA_VALUE_LENGTH)
      return `traceMetadata values must be strings up to ${MAX_TRACE_METADATA_VALUE_LENGTH} characters.`
  }
  return undefined
}
