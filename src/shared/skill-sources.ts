/** Saved repositories are bookmarks; they do not confer marketplace trust. */
export type SavedSkillSource = { id: string; repository: string; ref?: string }
export type AddSkillSourceRequest = { repository: string }
export type RemoveSkillSourceRequest = { id: string }

const invalidSource = (): Error => new Error('Enter a GitHub repository URL or owner/repo@ref.')

export function parseSavedSkillRepository(input: string): Omit<SavedSkillSource, 'id'> {
  const value = input.trim()
  let parsed: { owner: string; repo: string; ref?: string } | null = null
  if (value.includes('://')) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw invalidSource()
    }
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1)
    // A subtree URL is ambiguous with slash-containing refs. Use owner/repo@ref for those.
    if (
      url.protocol !== 'https:' ||
      url.host !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(parts.length === 2 || (parts.length === 4 && parts[2] === 'tree'))
    )
      throw invalidSource()
    try {
      const segments = parts.map(decodeURIComponent)
      parsed = { owner: segments[0], repo: segments[1].replace(/\.git$/, ''), ref: segments[3] }
    } catch {
      throw invalidSource()
    }
  } else {
    const match = /^([^/\s@]+)\/([^/\s@]+)(?:@([^\s]+))?$/.exec(value)
    if (match) parsed = { owner: match[1], repo: match[2].replace(/\.git$/, ''), ref: match[3] }
  }
  if (
    !parsed ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(parsed.owner) ||
    !/^[a-zA-Z0-9_.-]+$/.test(parsed.repo) ||
    ['.', '..'].includes(parsed.repo) ||
    (parsed.ref !== undefined &&
      (!parsed.ref ||
        parsed.ref.length > 255 ||
        // eslint-disable-next-line no-control-regex -- Git refs cannot contain ASCII controls.
        /[\s\x00-\x1f\x7f~^:?*[\\]/.test(parsed.ref) ||
        parsed.ref.includes('..') ||
        parsed.ref.includes('@{') ||
        parsed.ref.startsWith('/') ||
        parsed.ref.endsWith('/') ||
        parsed.ref
          .split('/')
          .some(
            (part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')
          )))
  )
    throw invalidSource()
  const repository = `${parsed.owner}/${parsed.repo}`.toLowerCase()
  return {
    repository,
    ...(parsed.ref ? { ref: parsed.ref } : {})
  }
}
