import { createLogger } from '../logger'

const log = createLogger('skills')

// A file fetched from a GitHub skill directory, with its path relative to that directory.
export type FetchedSkillFile = { relativePath: string; content: Buffer }

export type GitHubSkillLocation = {
  owner: string
  repo: string
  ref?: string
  // Path to the skill directory within the repo (no leading/trailing slash), '' for the repo root.
  path: string
}

// Injectable fetch so tests don't hit the network.
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  arrayBuffer: () => Promise<ArrayBuffer>
}>

const GITHUB_HEADERS = { 'User-Agent': 'open-science', Accept: 'application/vnd.github+json' }

// Parses a GitHub URL into the repo + skill directory it points at. Accepts tree/blob URLs and trims a
// trailing SKILL.md so a link to the file resolves to its directory. Returns null when unrecognizable.
const parseGitHubSkillUrl = (input: string): GitHubSkillLocation | null => {
  const match =
    /github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(?:tree|blob)\/([^/\s]+)((?:\/[^?#]*)?))?/.exec(
      input.trim()
    )
  if (!match) return null

  const owner = match[1]
  const repo = match[2].replace(/\.git$/, '')
  const ref = match[3]
  // Decode so a pasted %20 and a literal space both normalize to a real space; the path may contain spaces.
  let path = decodeURIComponent(match[4] ?? '').replace(/^\/+|\/+$/g, '')
  path = path.replace(/\/?SKILL\.md$/i, '')

  return { owner, repo, ref, path }
}

// Builds the GitHub contents API URL for a path within a repo. Percent-encodes each path segment
// (but not the slashes) so paths containing spaces resolve correctly.
const contentsUrl = (location: GitHubSkillLocation, path: string): string => {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const base = `https://api.github.com/repos/${location.owner}/${location.repo}/contents/${encodedPath}`
  return location.ref ? `${base}?ref=${encodeURIComponent(location.ref)}` : base
}

type ContentsEntry = { type: string; name: string; path: string; download_url: string | null }

// Recursively downloads every file under a skill directory via the public GitHub contents API.
const fetchSkillFiles = async (
  location: GitHubSkillLocation,
  fetchImpl: FetchLike
): Promise<FetchedSkillFile[]> => {
  const rootPrefix = location.path ? `${location.path}/` : ''

  const walk = async (path: string): Promise<FetchedSkillFile[]> => {
    const response = await fetchImpl(contentsUrl(location, path), { headers: GITHUB_HEADERS })
    if (!response.ok) {
      throw new Error(`GitHub API request failed (${response.status}) for ${path || 'repo root'}`)
    }

    const payload = (await response.json()) as ContentsEntry | ContentsEntry[]
    const entries = Array.isArray(payload) ? payload : [payload]
    const files: FetchedSkillFile[] = []

    for (const entry of entries) {
      if (entry.type === 'dir') {
        files.push(...(await walk(entry.path)))
      } else if (entry.type === 'file' && entry.download_url) {
        const raw = await fetchImpl(entry.download_url, {
          headers: { 'User-Agent': 'open-science' }
        })
        if (!raw.ok) {
          throw new Error(`Failed to download ${entry.path} (${raw.status})`)
        }
        const content = Buffer.from(await raw.arrayBuffer())
        const relativePath = entry.path.startsWith(rootPrefix)
          ? entry.path.slice(rootPrefix.length)
          : entry.name
        files.push({ relativePath, content })
      }
    }

    return files
  }

  const files = await walk(location.path)

  if (!files.some((file) => file.relativePath.toLowerCase() === 'skill.md')) {
    throw new Error('No SKILL.md found at the linked location.')
  }

  log.info('fetched skill files from GitHub', {
    owner: location.owner,
    repo: location.repo,
    path: location.path,
    count: files.length
  })

  return files
}

// A repo reference for a batch scan: owner/repo plus an optional ref (branch/tag/sha).
export type GitHubRepoRef = { owner: string; repo: string; ref?: string }

// One skill directory discovered by a repo scan.
export type ScannedSkill = { name: string; path: string; url: string }

// Parses a repo reference: `owner/repo`, `owner/repo@ref`, or a full github.com URL.
const parseGitHubRepo = (input: string): GitHubRepoRef | null => {
  const trimmed = input.trim()
  const short = /^([^/\s@]+)\/([^/\s@]+)(?:@([^\s]+))?$/.exec(trimmed)
  if (short) {
    return { owner: short[1], repo: short[2].replace(/\.git$/, ''), ref: short[3] || undefined }
  }

  const location = parseGitHubSkillUrl(trimmed)
  return location ? { owner: location.owner, repo: location.repo, ref: location.ref } : null
}

// Scans a repo's git tree for every directory containing a SKILL.md, returning an importable URL for
// each. Uses the public Git Trees API (recursive); resolves the default branch when no ref is given.
const scanRepoForSkills = async (
  repo: GitHubRepoRef,
  fetchImpl: FetchLike
): Promise<ScannedSkill[]> => {
  let ref = repo.ref
  if (!ref) {
    const meta = await fetchImpl(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
      headers: GITHUB_HEADERS
    })
    if (!meta.ok) throw new Error(`GitHub API request failed (${meta.status}).`)
    ref = ((await meta.json()) as { default_branch?: string }).default_branch ?? 'main'
  }

  const treeResponse = await fetchImpl(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers: GITHUB_HEADERS }
  )
  if (!treeResponse.ok) throw new Error(`GitHub API request failed (${treeResponse.status}).`)

  const tree = (await treeResponse.json()) as { tree?: { path: string; type: string }[] }
  const skills: ScannedSkill[] = []

  for (const entry of tree.tree ?? []) {
    if (entry.type === 'blob' && /(^|\/)SKILL\.md$/i.test(entry.path)) {
      const dir = entry.path.replace(/\/?SKILL\.md$/i, '')
      const name = dir.split('/').filter(Boolean).pop() ?? repo.repo
      // Percent-encode each segment so the url round-trips when later imported (e.g. spaces in dir names).
      const encodedRef = encodeURIComponent(ref)
      const encodedDir = dir.split('/').map(encodeURIComponent).join('/')
      const url = dir
        ? `https://github.com/${repo.owner}/${repo.repo}/tree/${encodedRef}/${encodedDir}`
        : `https://github.com/${repo.owner}/${repo.repo}/tree/${encodedRef}`
      skills.push({ name, path: dir, url })
    }
  }

  return skills
}

export { parseGitHubSkillUrl, parseGitHubRepo, fetchSkillFiles, scanRepoForSkills }
