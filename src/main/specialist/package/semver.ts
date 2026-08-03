type Version = { major: number; minor: number; patch: number; prerelease: readonly string[] }

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

const parseVersion = (value: string): Version | undefined => {
  const match = VERSION.exec(value)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? []
  }
}

const compare = (left: Version, right: Version): number => {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === rightPart) continue
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined)
      return leftNumber < rightNumber ? -1 : 1
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

export const compareSemver = (leftValue: string, rightValue: string): number | undefined => {
  const left = parseVersion(leftValue)
  const right = parseVersion(rightValue)
  return left && right ? compare(left, right) : undefined
}

const satisfiesComparator = (version: Version, token: string): boolean | undefined => {
  if (token === '*' || /^x$/i.test(token)) return true
  const wildcard = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(token)
  if (
    wildcard &&
    (wildcard[2] === undefined ||
      /^(x|\*)$/i.test(wildcard[2]) ||
      /^(x|\*)$/i.test(wildcard[3] ?? ''))
  ) {
    if (version.major !== Number(wildcard[1])) return false
    return wildcard[2] === undefined || /^(x|\*)$/i.test(wildcard[2])
      ? true
      : version.minor === Number(wildcard[2])
  }
  const operatorMatch = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
  if (!operatorMatch) return undefined
  const operator = operatorMatch[1] ?? '='
  const target = parseVersion(operatorMatch[2])
  if (!target) return undefined
  const order = compare(version, target)
  if (operator === '=') return order === 0
  if (operator === '>=') return order >= 0
  if (operator === '<=') return order <= 0
  if (operator === '>') return order > 0
  if (operator === '<') return order < 0
  if (operator === '~') {
    return order >= 0 && version.major === target.major && version.minor === target.minor
  }
  const upper =
    target.major > 0
      ? { major: target.major + 1, minor: 0, patch: 0, prerelease: [] }
      : target.minor > 0
        ? { major: 0, minor: target.minor + 1, patch: 0, prerelease: [] }
        : { major: 0, minor: 0, patch: target.patch + 1, prerelease: [] }
  return order >= 0 && compare(version, upper) < 0
}

export const satisfiesSemverRange = (versionValue: string, range: string): boolean | undefined => {
  const version = parseVersion(versionValue)
  if (!version || !range.trim()) return undefined
  let valid = false
  for (const clause of range.split('||')) {
    const tokens = clause.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return undefined
    let matches = true
    for (const token of tokens) {
      const result = satisfiesComparator(version, token)
      if (result === undefined) return undefined
      valid = true
      if (!result) matches = false
    }
    if (matches) return true
  }
  return valid ? false : undefined
}

export const isValidSemverRange = (range: string): boolean =>
  satisfiesSemverRange('0.0.0', range) !== undefined
