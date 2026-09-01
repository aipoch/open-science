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

const foldTargetWithSourcePositions = (
  target: string
): { folded: string; sourcePositions: number[] } => {
  let folded = ''
  const sourcePositions: number[] = []
  let sourceOffset = 0

  // Lowercase expansion can change UTF-16 length, so retain the original index for every unit.
  for (const character of target) {
    const foldedCharacter = character.toLowerCase()
    folded += foldedCharacter
    for (let index = 0; index < foldedCharacter.length; index += 1) {
      sourcePositions.push(sourceOffset + Math.min(index, character.length - 1))
    }
    sourceOffset += character.length
  }

  return { folded, sourcePositions }
}

export const fuzzyScore = (query: string, target: string): FuzzyMatch | null => {
  if (query.length === 0) return { score: 0, positions: [] }

  const q = query.toLowerCase()
  const { folded: t, sourcePositions } = foldTargetWithSourcePositions(target)
  const foldedPositions: number[] = []
  let cursor = 0
  for (let qi = 0; qi < q.length; qi++) {
    const next = t.indexOf(q[qi], cursor)
    if (next === -1) return null
    foldedPositions.push(next)
    cursor = next + 1
  }

  let score = 0
  for (let k = 0; k < foldedPositions.length; k++) {
    const foldedPosition = foldedPositions[k]
    const sourcePosition = sourcePositions[foldedPosition]
    const isFirstUnitAtSource =
      k === 0 || sourcePosition !== sourcePositions[foldedPositions[k - 1]]
    score += BASE
    if (isFirstUnitAtSource && isBoundary(target, sourcePosition)) score += BOUNDARY_BONUS
    if (isFirstUnitAtSource && sourcePosition === 0) score += PREFIX_BONUS
    if (k === 0) {
      score -= Math.min(foldedPosition, MAX_GAP_PENALTY)
    } else {
      const gap = foldedPosition - foldedPositions[k - 1] - 1
      if (gap === 0) score += CONSECUTIVE_BONUS
      else score -= Math.min(gap, MAX_GAP_PENALTY)
    }
  }

  score += Math.max(0, 8 - target.length / 8)
  const positions = foldedPositions
    .map((position) => sourcePositions[position])
    .filter((position, index, allPositions) => index === 0 || position !== allPositions[index - 1])
  return { score, positions }
}
