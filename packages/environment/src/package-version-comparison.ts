// Compare observed package versions, not requirement specifiers. In particular, a local
// build suffix must never be discarded just because a requirement would accept it.
export const packageVersionsMatch = (ecosystem: string, left: string, right: string): boolean => {
  if (left === right) return true
  if (ecosystem === 'r') return left.replace(/[-_]/gu, '.') === right.replace(/[-_]/gu, '.')
  if (ecosystem !== 'python' || !/^\d+(?:\.\d+)*$/u.test(left) || !/^\d+(?:\.\d+)*$/u.test(right))
    return false
  // PEP 440 compares release segments as integers, padding missing segments with zero.
  const release = (value: string): string =>
    value.replace(/\b0+(?=\d)/gu, '').replace(/(?:\.0)+$/u, '')
  return release(left) === release(right)
}
