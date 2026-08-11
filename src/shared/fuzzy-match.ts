// Shared fuzzy matcher for the composer's `/` and `@` mention popups and main-process file search.
// It performs an ordered subsequence match with stable relevance scoring: contiguous runs, word
// boundaries, and early matches score higher while gaps are penalized.

export type FuzzyMatch = { score: number; positions: number[] }

const SEPARATOR = /[\s\-_/.\\]/

const isBoundary = (target: string, i: number): boolean => {
  if (i === 0) return true
  const prev = target[i - 1]
  if (SEPARATOR.test(prev)) return true
  const cur = target[i]
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && cur === cur.toUpperCase()
}

const BASE = 1
const BOUNDARY_BONUS = 8
const PREFIX_BONUS = 4
const CONSECUTIVE_BONUS = 5
const MAX_GAP_PENALTY = 3

export const fuzzyScore = (query: string, target: string): FuzzyMatch | null => {
  if (query.length === 0) return { score: 0, positions: [] }

  const q = query.toLowerCase()
  const t = target.toLowerCase()
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
      score -= Math.min(pos, MAX_GAP_PENALTY)
    } else {
      const gap = pos - positions[k - 1] - 1
      if (gap === 0) score += CONSECUTIVE_BONUS
      else score -= Math.min(gap, MAX_GAP_PENALTY)
    }
  }

  score += Math.max(0, 8 - target.length / 8)
  return { score, positions }
}
