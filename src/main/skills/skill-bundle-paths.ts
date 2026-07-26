// A directly importable Skill root may be at the archive root or under at most two wrapper
// directories. Keep this predicate shared by full discovery and prompt-time ZIP sniffing so the
// prompt never advertises a package whose preview will later contain no candidates.
const isSkillManifestPath = (path: string): boolean => {
  const segments = path.split('/')
  return segments.length <= 3 && segments[segments.length - 1].toLowerCase() === 'skill.md'
}

export { isSkillManifestPath }
