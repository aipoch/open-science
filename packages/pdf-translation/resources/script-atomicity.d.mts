export type NativeSignedScriptRegion = Readonly<{
  nativeScriptBodySize?: number
  nativeScriptMarkers?: ReadonlyArray<{
    sourceOffset: number
    label: string
    sourceIndices: readonly number[]
    fontName: string
    baseline: number
    bounds: readonly number[]
    scale: number
    rise: number
  }>
  anchors: ReadonlyArray<{
    indices: readonly number[]
    sourceOffset: number
    targetOffset: number
    label: string
    baseline?: number
    movable?: boolean
    annotation?: unknown
    nativeFootnoteRow?: boolean
    nativeUriFootnote?: boolean
  }>
}>
export function nativeSignedScriptRanges(
  source: string,
  target: string,
  regions: readonly NativeSignedScriptRegion[]
): Array<{ start: number; scriptStart: number; end: number }>
