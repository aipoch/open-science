// Shared fuzzy matcher for the composer's `/` and `@` mention popups. The old popups filtered with a
// plain case-insensitive substring test and kept the source order, so "cg" never found "clinical-
// genomics" and closer matches never floated to the top. This does an ordered subsequence match with
// relevance scoring: contiguous runs, word-boundary hits (separators and camelCase humps), and an
// early first match all score higher, and gaps are penalized.

export type FuzzyMatch = { score: number; positions: number[] }

// Separators that begin a new word. Backslash included for path-like artifact names.
const SEPARATOR = /[\s\-_/.\\]/

// Whether target[i] starts a new "word": string start, right after a separator, or a camelCase hump.
const isBoundary = (target: string, i: number): boolean => {
  if (i === 0) return true
  const prev = target[i - 1]
  if (SEPARATOR.test(prev)) return true
  const cur = target[i]
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && cur === cur.toUpperCase()
}

const BASE = 1 // per matched char
const BOUNDARY_BONUS = 8 // match lands on a word boundary
const PREFIX_BONUS = 4 // match lands on the very first char
const CONSECUTIVE_BONUS = 5 // match is adjacent to the previous match
const MAX_GAP_PENALTY = 3 // cap on how much a single gap can cost

// Score `query` against `target`, or return null when `query` is not an ordered subsequence of it. An
// empty query matches everything with a neutral score. Matching is case-insensitive; boundary
// detection uses the original casing so camelCase humps still count. Positions index into `target`.
export const fuzzyScore = (query: string, target: string): FuzzyMatch | null => {
  if (query.length === 0) return { score: 0, positions: [] }

  const q = query.toLowerCase()
  const t = target.toLowerCase()

  // Leftmost-greedy subsequence scan — complete for "is subsequence" and stable to score.
  const positions: number[] = []
  let cursor = 0
  for (let qi = 0; qi < q.length; qi++) {
    const next = t.indexOf(q[qi], cursor)
    if (next === -1) return null
    positions.push(next)
    cursor = next + 1
  }

  let score = 0
  for (let k = 0; k < positions.length; k++) {
    const pos = positions[k]
    score += BASE
    if (isBoundary(target, pos)) score += BOUNDARY_BONUS
    if (pos === 0) score += PREFIX_BONUS
    if (k === 0) {
      score -= Math.min(pos, MAX_GAP_PENALTY) // penalize how far in the first match sits
    } else {
      const gap = pos - positions[k - 1] - 1
      if (gap === 0) score += CONSECUTIVE_BONUS
      else score -= Math.min(gap, MAX_GAP_PENALTY)
    }
  }

  // Nudge tighter targets above sprawling ones when scores otherwise tie.
  score += Math.max(0, 8 - target.length / 8)
  return { score, positions }
}
