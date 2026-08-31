import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

const findExecutable = (
  name: string,
  pathValue: string | undefined = process.env.PATH
): string | undefined => {
  const candidates = isAbsolute(name)
    ? [name]
    : (pathValue ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, name))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH candidates.
    }
  }
  return undefined
}

export { findExecutable }
