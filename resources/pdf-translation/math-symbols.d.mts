export function nativeMathSymbolText(
  object: { text: string; bounds: [number, number, number, number] },
  fontName: string
): string

export function nativeMathAlphabet(
  object: { text: string; bounds: [number, number, number, number] },
  fontName: string
): boolean

export function nativeTransposeSourceIndices(
  objects: Array<{
    i: number
    text: string
    fontName: string
    size: number
    baseline: number
    bounds: [number, number, number, number]
  }>,
  source: string
): number[]
