import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Pure parser: turns the text of a ~/.ssh/config into the list of concrete Host aliases a user can
// register as a compute provider. It intentionally does NOT resolve HostName/User/etc. — the real
// connection details are resolved later via `ssh -G <alias>` (see design.md §1). Keeping this a pure
// string→string[] function makes it trivial to unit-test the tricky exclusion rules.
//
// Rules (design.md §7, issue AC):
// - Only `Host` lines contribute aliases.
// - Wildcard/pattern tokens (`*`, `?`) and negated tokens (`!foo`) are NOT selectable aliases and are
//   dropped; a Host line that is only patterns yields nothing.
// - `Match` blocks declare no alias of their own and are skipped (their own tokens are never aliases).
// - Leading whitespace/tabs, blank lines, and `#` comments are ignored.
// - The `Host` keyword is case-insensitive; `Host=foo` (key=value form) is tolerated.
// - Results are de-duplicated, preserving first-seen order.

// True when a token is an OpenSSH pattern rather than a concrete, connectable alias.
const isPatternToken = (token: string): boolean =>
  token.includes('*') || token.includes('?') || token.startsWith('!')

// Strips a trailing `# ...` comment and surrounding whitespace from a raw config line.
const stripComment = (line: string): string => {
  const hashIndex = line.indexOf('#')
  const withoutComment = hashIndex === -1 ? line : line.slice(0, hashIndex)
  return withoutComment.trim()
}

export const parseSshConfigHostAliases = (configText: string): string[] => {
  const aliases: string[] = []
  const seen = new Set<string>()

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = stripComment(rawLine)
    if (line === '') continue

    // Split "keyword rest" — also tolerate the `keyword=value` form OpenSSH allows.
    const match = /^(\S+?)[\s=]+(.*)$/.exec(line) ?? /^(\S+)$/.exec(line)
    if (!match) continue

    const keyword = match[1]!.toLowerCase()
    const rest = (match[2] ?? '').trim()

    // Match blocks contribute no alias; skip the directive entirely.
    if (keyword === 'match') continue
    if (keyword !== 'host') continue

    for (const token of rest.split(/\s+/)) {
      if (token === '' || isPatternToken(token)) continue
      if (seen.has(token)) continue
      seen.add(token)
      aliases.push(token)
    }
  }

  return aliases
}

// Reads and parses the user's ~/.ssh/config. A missing or unreadable file is not an error — it just
// means there are no aliases to suggest (the user can still type one). Never throws.
export const readSshConfigHostAliases = async (
  configPath = join(homedir(), '.ssh', 'config')
): Promise<string[]> => {
  try {
    const text = await readFile(configPath, 'utf8')
    return parseSshConfigHostAliases(text)
  } catch {
    return []
  }
}
