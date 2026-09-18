import type {
  ScientificComparisonPolicy,
  ScientificComparisonReport
} from '../../shared/output-comparison'

// Serializable worker function. CSV parsing/budgets are owned by the content comparator. Names,
// contrasts and thresholds come from explicit user policy; this makes no global scientific claim.
export const compareScientificTables = (
  expected: string[][],
  actual: string[][],
  policy: ScientificComparisonPolicy
): ScientificComparisonReport => {
  const result: ScientificComparisonReport = {
    kind: policy.kind,
    outcome: 'unavailable',
    identifiers: 0,
    missingIdentifiers: 0,
    addedIdentifiers: 0
  }
  const idColumn = policy.kind === 'cell-clusters' ? policy.cellColumn : policy.geneColumn
  const required =
    policy.kind === 'cell-clusters'
      ? [idColumn, policy.clusterColumn]
      : [idColumn, policy.effectColumn, policy.adjustedPColumn]
  if (
    new Set(required).size !== required.length ||
    required.some((name) => !expected[0]?.includes(name) || !actual[0]?.includes(name))
  )
    return { ...result, reason: 'missing-column' }
  const index = (table: string[][]): Map<string, string[]> => {
    const positions = required.map((name) => table[0]!.indexOf(name))
    const rows = new Map<string, string[]>()
    for (const row of table.slice(1)) {
      const key = row[positions[0]!]!
      if (!key) throw new Error('missing-id')
      if (rows.has(key)) throw new Error('duplicate-id')
      rows.set(
        key,
        positions.slice(1).map((position) => row[position]!)
      )
    }
    return rows
  }
  let left: Map<string, string[]>, right: Map<string, string[]>
  try {
    left = index(expected)
    right = index(actual)
  } catch (error) {
    return {
      ...result,
      reason: String(error).includes('duplicate-id') ? 'duplicate-id' : 'missing-id'
    }
  }
  result.identifiers = left.size
  result.missingIdentifiers = [...left.keys()].filter((key) => !right.has(key)).length
  result.addedIdentifiers = [...right.keys()].filter((key) => !left.has(key)).length
  if (result.missingIdentifiers || result.addedIdentifiers)
    return { ...result, outcome: 'does-not-meet', reason: 'different-identifiers' }
  if (left.size < 2) return { ...result, reason: 'no-comparable-results' }

  if (policy.kind === 'cell-clusters') {
    const cells = new Map<string, number>(),
      a = new Map<string, number>(),
      b = new Map<string, number>()
    for (const [id, row] of left) {
      const first = row[0]!,
        second = right.get(id)![0]!
      if (!first || !second || first === 'NA' || second === 'NA')
        return { ...result, reason: 'invalid-value' }
      const key = JSON.stringify([first, second])
      cells.set(key, (cells.get(key) ?? 0) + 1)
      a.set(first, (a.get(first) ?? 0) + 1)
      b.set(second, (b.get(second) ?? 0) + 1)
    }
    const pairs = (n: number): number => (n * (n - 1)) / 2
    const sumPairs = (counts: Map<string, number>): number =>
      [...counts.values()].reduce((sum, n) => sum + pairs(n), 0)
    const observed = sumPairs(cells),
      total = pairs(left.size),
      first = sumPairs(a),
      second = sumPairs(b)
    const chanceNumerator = BigInt(first) * BigInt(second)
    const denominator = BigInt(first + second) * BigInt(total) - 2n * chanceNumerator
    // Both all-singleton and both all-one-cluster partitions have zero denominator and agree.
    result.adjustedRand =
      denominator === 0n
        ? 1
        : Math.max(
            -1,
            Math.min(
              1,
              Number(2n * (BigInt(observed) * BigInt(total) - chanceNumerator)) /
                Number(denominator)
            )
          )
    result.outcome =
      result.adjustedRand >= policy.minimumAdjustedRand ? 'meets-criteria' : 'does-not-meet'
    return result
  }

  const number = (value: string): number | undefined =>
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value) && Number.isFinite(Number(value))
      ? Number(value)
      : undefined
  const missing = (value: string): boolean => value === '' || value === 'NA' || value === 'NaN'
  let expectedCount = 0,
    actualCount = 0,
    common = 0,
    direction = 0,
    missingChanges = 0
  for (const [id, row] of left) {
    const other = right.get(id)!
    const values = [...row, ...other]
    if (values.some((value) => !missing(value) && number(value) === undefined))
      return { ...result, reason: 'invalid-value' }
    if (row.some((value, i) => missing(value) !== missing(other[i]!))) missingChanges++
    const effectA = number(row[0]!),
      pA = number(row[1]!),
      effectB = number(other[0]!),
      pB = number(other[1]!)
    if ([pA, pB].some((p) => p !== undefined && (p < 0 || p > 1)))
      return { ...result, reason: 'invalid-value' }
    const significantA =
      effectA !== undefined &&
      pA !== undefined &&
      pA < policy.adjustedPThreshold &&
      Math.abs(effectA) >= policy.minimumAbsoluteEffect
    const significantB =
      effectB !== undefined &&
      pB !== undefined &&
      pB < policy.adjustedPThreshold &&
      Math.abs(effectB) >= policy.minimumAbsoluteEffect
    if (significantA) expectedCount++
    if (significantB) actualCount++
    if (significantA && significantB) {
      common++
      if (Math.sign(effectA!) === Math.sign(effectB!)) direction++
    }
  }
  result.expectedSignificant = expectedCount
  result.actualSignificant = actualCount
  result.commonSignificant = common
  result.missingValueChanges = missingChanges
  const union = expectedCount + actualCount - common
  if (!union || !common)
    return {
      ...result,
      outcome: union ? 'does-not-meet' : 'unavailable',
      reason: 'no-comparable-results'
    }
  result.geneJaccard = common / union
  result.directionAgreement = direction / common
  result.outcome =
    !missingChanges &&
    result.geneJaccard >= policy.minimumGeneJaccard &&
    result.directionAgreement >= policy.minimumDirectionAgreement
      ? 'meets-criteria'
      : 'does-not-meet'
  return result
}
