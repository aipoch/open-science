export type FractionItem = {
  i: number
  text: string
  fontSize: number
  baseline: number
  bounds: [number, number, number, number]
}
export function resolveInlineFractions(
  items: FractionItem[],
  bodyBaseline: number,
  bodyFont: number
): Array<{
  indices: number[]
  label: string
  numerator: number
  denominator: number[]
  bounds: [number, number, number, number]
}>
