export type ViewRow = [string, string, number]
export type PackedGeneration = [number, number, string, string]
export type EvidenceBody = Record<string, unknown> & {
  relations: Array<Record<string, unknown>>
  predecessorGenerations?: unknown[]
}
export function mapGenerations(
  sidecar: EvidenceBody,
  transform: (generation: unknown) => unknown
): EvidenceBody
export function jsonBytesWithinLimit(value: unknown, maxBytes: number, pretty?: boolean): number
export function expandProjection(
  packed: EvidenceBody,
  views: ViewRow[][],
  prefix: string,
  maxBytes?: number
): Buffer
