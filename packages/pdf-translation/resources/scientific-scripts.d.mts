export type ScientificScriptMarker = Readonly<{
  sourceOffset: number
  label: string
  scale: number
  rise: number
  sourceIndices: readonly number[]
  bounds?: readonly [number, number, number, number]
}>
export type ScientificScriptSpan = Readonly<{
  start: number
  end: number
  scale: number
  rise: number
  sourceIndices: readonly number[]
  sourceOffsets: readonly number[]
}>
export function resolveNestedScriptGroups(
  source: string,
  translation: string,
  markers: readonly ScientificScriptMarker[]
): Array<{
  sourceOffset: number
  targetOffset: number
  label: string
  sourceIndices: number[]
  baselineIndex?: number
  scriptOnly?: true
}>
export function resolveScientificScriptSpans(
  source: string,
  translation: string,
  markers: readonly ScientificScriptMarker[]
): ScientificScriptSpan[]

export function resolveExplicitTransposeIndices(
  source: string,
  translation: string,
  markers: readonly ScientificScriptMarker[]
): number[]

export function resolveExplicitPowerIndices(
  source: string,
  translation: string,
  markers: readonly ScientificScriptMarker[],
  bodySize: number
): number[]

export function resolveOrdinalSuffixIndices(
  source: string,
  markers: readonly ScientificScriptMarker[],
  bodySize: number
): number[]
