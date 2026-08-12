// The canonical skill document filename. Skills commonly arrive as `skill.md` from case-insensitive
// filesystems (macOS/APFS), so every "is this the skill document?" check must be case-insensitive.
// Centralizing it here keeps validation, import, listing, and export from drifting apart.
const SKILL_DOCUMENT_BASENAME = 'skill.md'

// True when `name` is the skill document filename (SKILL.md) under any casing. For a relative path
// that is just the basename (a file at the skill root), this also serves as "is this the root skill
// document"; a nested path like `references/skill.md` is not equal to the basename and won't match.
export const isSkillDocumentName = (name: string): boolean =>
  name.toLowerCase() === SKILL_DOCUMENT_BASENAME

// A directly importable Skill root may be at the archive root or under at most two wrapper
// directories. Keep this predicate shared by full discovery and prompt-time ZIP sniffing so the
// prompt never advertises a package whose preview will later contain no candidates.
const skillManifestRootPath = (path: string): string | undefined => {
  const segments = path.split('/')
  if (segments.length > 3 || !isSkillDocumentName(segments[segments.length - 1])) {
    return undefined
  }
  return segments.slice(0, -1).join('/')
}

const isSkillManifestPath = (path: string): boolean => skillManifestRootPath(path) !== undefined

// Keeps only the shallowest manifest root on each branch. A nested SKILL.md beneath another root is
// that outer Skill's resource, not a second candidate — even when the outer manifest later proves
// invalid. Both full discovery and prompt-time sniffing must apply this before parsing names.
const selectSkillManifestRoots = (paths: Iterable<string>): string[] => {
  const candidates = new Set<string>()
  for (const path of paths) {
    const root = skillManifestRootPath(path)
    if (root !== undefined) candidates.add(root)
  }

  return [...candidates]
    .filter((root) => {
      if (root === '') return true
      const segments = root.split('/')
      for (let length = 0; length < segments.length; length += 1) {
        if (candidates.has(segments.slice(0, length).join('/'))) return false
      }
      return true
    })
    .sort((left, right) => left.localeCompare(right))
}

export { isSkillManifestPath, selectSkillManifestRoots, skillManifestRootPath }
