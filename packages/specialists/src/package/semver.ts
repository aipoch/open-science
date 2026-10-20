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
