/** The same bounded groups drive renderer lanes and main-process prefetch. */
export function pdfTranslationBatchSourceIndices(
  sources: readonly string[],
  start: number,
  unavailable: (index: number) => boolean = () => false
): number[] {
  const indices: number[] = []
  let length = 0
  for (let index = start; index < sources.length && indices.length < 4; index++) {
    const source = sources[index]
    if (
      source.length > 600 ||
      length + source.length > 1800 ||
      !/\p{L}/u.test(source) ||
      /^[A-Z]\d+$/u.test(source.trim()) ||
      /^[<>≤≥]?\s*\d*\.\d+[a-z]$/u.test(source.trim()) ||
      unavailable(index)
    )
      break
    indices.push(index)
    length += source.length
  }
  return indices
}
