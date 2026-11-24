type ExtensionPreservingFileNameParts = {
  head: string
  tail: string
  extension: string
  isAbbreviated: boolean
}

const DEFAULT_TAIL_LENGTH = 5
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const words = new Intl.Segmenter(undefined, { granularity: 'word' })

// Measured surfaces prefer complete filename words around the omission marker.
const getExtensionPreservingFileNameParts = (
  name: string,
  layout?: { width: number; measure: (text: string) => number }
): ExtensionPreservingFileNameParts => {
  const extensionIndex = name.lastIndexOf('.')
  const hasExtension = extensionIndex > 0
  const basename = hasExtension ? name.slice(0, extensionIndex) : name
  const extension = hasExtension ? name.slice(extensionIndex) : ''

  if (layout) {
    const { width, measure } = layout
    if (measure(name) <= width) {
      return { head: basename, tail: '', extension, isAbbreviated: false }
    }
    // Reserve the extension and omission marker before allocating the basename width.
    const budget = Math.max(0, width - Math.min(measure(extension), width / 2) - measure('…'))
    // Filename separators should be word boundaries too (Unicode treats underscores as
    // part of a word). Equal-length replacement retains offsets into the original name.
    const segments = Array.from(words.segment(basename.replace(/[_\-.]/g, ' ')))
    const separator = /^[_\s.-]+$/u
    const fragments = segments.filter(({ segment }) => !separator.test(segment))
    const heads = [
      '',
      ...fragments.map(({ index, segment }) => basename.slice(0, index + segment.length))
    ]
    const tails = ['', ...fragments.reverse().map(({ index }) => basename.slice(index))]
    const fit = (candidates: string[], limit: number, maxLength = basename.length): string => {
      const eligible = candidates.filter((candidate) => candidate.length <= maxLength)
      let low = 0
      let high = eligible.length - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (measure(eligible[middle]) <= limit) low = middle
        else high = middle - 1
      }
      return eligible[low]
    }
    // Reserve a readable prefix before allocating room to the ending.
    const first = heads.find((head) => Array.from(graphemes.segment(head)).length >= 3) ?? basename
    const last = tails[1] ?? basename
    const minimumHeadWidth = measure(first)
    const minimumTailWidth = measure(last)
    const keepTail =
      first.length + last.length < basename.length && minimumHeadWidth + minimumTailWidth <= budget
    const tail = keepTail
      ? fit(
          tails,
          Math.min(Math.max(budget / 2, minimumTailWidth), budget - minimumHeadWidth),
          basename.length - first.length - 1
        )
      : ''
    let head = fit(heads, budget - measure(tail), basename.length - tail.length)
    // A single token can exceed the entire label width. Only then fall back to complete
    // graphemes, retaining the beginning rather than an arbitrary slice of its ending.
    if (!head) {
      const prefixes = ['']
      for (const { segment } of graphemes.segment(basename))
        prefixes.push(prefixes.at(-1)! + segment)
      head = fit(prefixes, budget)
    }
    return { head, tail, extension, isAbbreviated: true }
  }

  const basenameCharacters = Array.from(graphemes.segment(basename), ({ segment }) => segment)
  return {
    head: basenameCharacters.slice(0, -DEFAULT_TAIL_LENGTH).join(''),
    tail: basenameCharacters.slice(-DEFAULT_TAIL_LENGTH).join(''),
    extension,
    isAbbreviated: false
  }
}

export { getExtensionPreservingFileNameParts }
export type { ExtensionPreservingFileNameParts }
