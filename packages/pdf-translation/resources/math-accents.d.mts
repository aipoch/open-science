export type NativeMathObject = {
  i: number
  text: string
  fontName?: string
  size?: number
  glyphs?: Array<{ text: string; offset: number; bounds: [number, number, number, number] }>
  bounds: [number, number, number, number]
}
export function resolveNativeMathAccents(objects: NativeMathObject[]): Array<{
  indices: number[]
  accentIndex: number
  baseIndex: number
  label: string
  labels: string[]
  bounds: [number, number, number, number]
}>
export function resolveNativeLatinAccents(
  objects: Array<NativeMathObject & { fontIdentity?: number; size?: number }>
): Array<{
  indices: number[]
  accentIndex: number
  baseIndex: number
  offset: number
  letter: string
}>
