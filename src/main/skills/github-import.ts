import { createLogger } from '../logger'
import { SKILL_IMPORT_LIMITS } from './import-limits'
import {
  GITHUB_REPOSITORY_SEARCH_TOO_LONG_MESSAGE,
  type GitHubRepositorySearchView
} from '../../shared/settings'

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

// A minimal view of a byte stream (matches the real fetch Response.body's getReader()). Reading a
// download through this lets us stop the moment the running total crosses a limit, so a body with a
// missing or lying Content-Length can never be buffered in full.
type ByteStream = {
  getReader: () => {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>
    // The real ReadableStreamDefaultReader.cancel() returns a Promise; keep both shapes for tests.
    cancel?: () => void | Promise<void>
  }
}

// Injectable fetch so tests don't hit the network. `headers.get` and `body` are optional: the real
// fetch Response exposes both. `headers` lets us reject on Content-Length before reading anything;
// `body` lets us read with a hard byte cap. A response with neither falls back to a bounded
// arrayBuffer() read plus the post-read size guard.
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  arrayBuffer: () => Promise<ArrayBuffer>
  headers?: { get: (name: string) => string | null }
  body?: ByteStream | null
}>

export type GitHubFetchOptions = {
  signal?: AbortSignal
  requestTimeoutMs?: number
  totalTimeoutMs?: number
}

const GITHUB_HEADERS = { 'User-Agent': 'open-science', Accept: 'application/vnd.github+json' }
const GITHUB_REQUEST_TIMEOUT_MS = 30_000
const GITHUB_TOTAL_TIMEOUT_MS = 5 * 60_000

const TRUSTED_GITHUB_TOKEN_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com'])

const combineSignals = (...signals: Array<AbortSignal | undefined>): AbortSignal => {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  return active.length === 1 ? active[0] : AbortSignal.any(active)
}

// Gives every GitHub operation one overall deadline and every individual request its own deadline.
// The request signal stays alive after headers arrive, so stalled response-body reads are aborted too.
const createGitHubFlowFetch = (
  fetchImpl: FetchLike,
  options: GitHubFetchOptions = {}
): FetchLike => {
  const flowSignal = combineSignals(
    options.signal,
    AbortSignal.timeout(options.totalTimeoutMs ?? GITHUB_TOTAL_TIMEOUT_MS)
  )
  return (url, init) =>
    fetchImpl(url, {
      ...init,
      signal: combineSignals(
        init?.signal,
        flowSignal,
        AbortSignal.timeout(options.requestTimeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS)
      )
    })
}

// Adds a token only for exact HTTPS GitHub hosts used by this module. GitHub-controlled download
// metadata can never redirect the credential to an arbitrary host.
const createAuthenticatedGitHubFetch = (
  fetchImpl: FetchLike,
  token?: string,
  options?: GitHubFetchOptions
): FetchLike => {
  const request = options ? createGitHubFlowFetch(fetchImpl, options) : fetchImpl
  const trimmed = token?.trim()
  if (!trimmed) return request

  return (url, init) => {
    let trusted = false
    try {
      const parsed = new URL(url)
      trusted = parsed.protocol === 'https:' && TRUSTED_GITHUB_TOKEN_HOSTS.has(parsed.hostname)
    } catch {
      trusted = false
    }

    return request(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(trusted ? { Authorization: `Bearer ${trimmed}` } : {})
      }
    })
  }
}

type GitHubResponseMetadata = Pick<Awaited<ReturnType<FetchLike>>, 'status' | 'headers'>

const isGitHubRateLimitResponse = (response: GitHubResponseMetadata): boolean => {
  if (response.status === 429) return true
  if (response.status !== 403) return false

  const remaining = response.headers?.get('x-ratelimit-remaining')?.trim()
  const retryAfter = response.headers?.get('retry-after')?.trim()
  return remaining === '0' || Boolean(retryAfter)
}

const githubRequestError = (
  response: GitHubResponseMetadata,
  context = 'GitHub API request'
): Error =>
  isGitHubRateLimitResponse(response)
    ? new Error(
        'GitHub request was rate-limited. Configure or update the GitHub token on this page, then try again.'
      )
    : response.status === 403
      ? new Error(
          `${context} was forbidden (403). Check repository access and token permissions, then try again.`
        )
      : new Error(`${context} failed (${response.status}).`)

// Reads a download body into a Buffer, stopping as soon as the running total crosses `limit` (so an
// oversized/endless body is never drained). Prefers the streaming reader; falls back to arrayBuffer()
// when no stream is exposed, still enforcing the cap on the buffered result. Peak memory is bounded by
// the accumulated chunks (at most `limit` plus one chunk) plus the final Buffer.concat copy — i.e. a
// small multiple of `limit`, never the whole oversized body.
const readBounded = async (
  response: { arrayBuffer: () => Promise<ArrayBuffer>; body?: ByteStream | null },
  limit: number,
  onExceeded: () => never
): Promise<Buffer> => {
  if (response.body) {
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let read = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        read += value.byteLength
        if (read > limit) {
          // Fire-and-forget the cancel: don't await it (a cancel that never settles must not keep the
          // import hanging) and don't let it mask the size error. The try/catch swallows a SYNCHRONOUS
          // throw from cancel() — which would otherwise escape before Promise.resolve wraps it — and
          // the .catch() handles an async rejection. Either way we abort with the size error next.
          try {
            void Promise.resolve(reader.cancel?.()).catch(() => {})
          } catch {
            /* ignore a synchronous cancel() failure */
          }
          onExceeded()
        }
        chunks.push(Buffer.from(value))
      }
    }
    return Buffer.concat(chunks)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > limit) onExceeded()
  return buffer
}

// Parses a GitHub URL into the repo + skill directory it points at. Accepts tree/blob URLs and trims a
// trailing SKILL.md so a link to the file resolves to its directory. Returns null when unrecognizable.
const parseGitHubSkillUrl = (input: string): GitHubSkillLocation | null => {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password) {
      return null
    }

    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (segments.length < 2) return null
    const owner = segments[0]
    const repo = segments[1].replace(/\.git$/, '')
    if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..')
      return null
    if (segments.length === 2) return { owner, repo, ref: undefined, path: '' }

    const [kind, ref, ...pathSegments] = segments.slice(2)
    if ((kind !== 'tree' && kind !== 'blob') || !ref) return null
    const path = pathSegments.join('/').replace(/\/?SKILL\.md$/i, '')
    return { owner, repo, ref, path }
  } catch {
    return null
  }
}

// Builds the GitHub contents API URL for a path within a repo. Percent-encodes each path segment
// (but not the slashes) so paths containing spaces resolve correctly.
const contentsUrl = (location: GitHubSkillLocation, path: string): string => {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const base = `https://api.github.com/repos/${location.owner}/${location.repo}/contents/${encodedPath}`
  return location.ref ? `${base}?ref=${encodeURIComponent(location.ref)}` : base
}

type ContentsEntry = { type: string; name: string; path: string; download_url: string | null }

export type FetchedSkillPreview = { skillMd: Buffer; files: string[] }

// Lists one selected skill directory and downloads only its root SKILL.md. Repo scans intentionally
// return metadata only; opening a candidate calls this helper lazily. Directory depth, file count,
// and request count share the import caps, while the rendered body uses the smaller IPC preview cap.
const fetchSkillPreview = async (
  location: GitHubSkillLocation,
  fetchImpl: FetchLike,
  options: GitHubFetchOptions = {}
): Promise<FetchedSkillPreview> => {
  const flowFetch = createGitHubFlowFetch(fetchImpl, options)
  const rootPrefix = location.path ? `${location.path}/` : ''
  const files: string[] = []
  let skillMd: Buffer | undefined
  let requests = 0

  const request: FetchLike = (url, init) => {
    requests += 1
    if (requests > SKILL_IMPORT_LIMITS.maxRequests) {
      throw new Error(`Skill preview exceeded ${SKILL_IMPORT_LIMITS.maxRequests} requests.`)
    }
    return flowFetch(url, init)
  }

  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > SKILL_IMPORT_LIMITS.maxDepth) {
      throw new Error(`Skill directory nesting exceeds ${SKILL_IMPORT_LIMITS.maxDepth} levels.`)
    }

    const response = await request(contentsUrl(location, path), { headers: GITHUB_HEADERS })
    if (!response.ok) {
      throw githubRequestError(response, `GitHub API request for ${path || 'repo root'}`)
    }

    const payload = (await response.json()) as ContentsEntry | ContentsEntry[]
    const entries = Array.isArray(payload) ? payload : [payload]
    for (const entry of entries) {
      if (entry.type === 'dir') {
        await walk(entry.path, depth + 1)
        continue
      }
      if (entry.type !== 'file') continue
      if (files.length >= SKILL_IMPORT_LIMITS.maxFiles) {
        throw new Error(`Skill has too many files (limit ${SKILL_IMPORT_LIMITS.maxFiles}).`)
      }

      const relativePath = entry.path.startsWith(rootPrefix)
        ? entry.path.slice(rootPrefix.length)
        : entry.name
      files.push(relativePath)

      if (relativePath.toLowerCase() !== 'skill.md' || !entry.download_url) continue
      const raw = await request(entry.download_url, { headers: { 'User-Agent': 'open-science' } })
      if (!raw.ok) throw githubRequestError(raw, `Download of ${entry.path}`)

      const previewTooLarge = (): never => {
        throw new Error(
          `GitHub Skill preview exceeds the ${SKILL_IMPORT_LIMITS.maxPreviewContentBytes / (1024 * 1024)} MB limit.`
        )
      }
      const declared = Number(raw.headers?.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > SKILL_IMPORT_LIMITS.maxPreviewContentBytes) {
        previewTooLarge()
      }
      skillMd = await readBounded(raw, SKILL_IMPORT_LIMITS.maxPreviewContentBytes, previewTooLarge)
    }
  }

  await walk(location.path, 0)
  if (!skillMd) throw new Error('No SKILL.md found at the linked location.')

  return { skillMd, files: files.sort() }
}

// Recursively downloads every file under a skill directory via the public GitHub contents API.
const fetchSkillFiles = async (
  location: GitHubSkillLocation,
  fetchImpl: FetchLike,
  options: GitHubFetchOptions = {}
): Promise<FetchedSkillFile[]> => {
  const flowFetch = createGitHubFlowFetch(fetchImpl, options)
  const rootPrefix = location.path ? `${location.path}/` : ''

  // Bound the recursive download so a huge (or maliciously deep) repository can't freeze or exhaust
  // the app: cap directory depth, file count, per-file size, total bytes, AND the number of requests.
  // The request budget is charged for every fetch — including directory listings — so a wide or
  // mostly-empty directory tree can't drive an unbounded number of API calls before hitting a byte or
  // file limit (empty dirs cost nothing against those).
  let fileCount = 0
  let totalBytes = 0
  let requests = 0

  const request: FetchLike = (url, init) => {
    requests += 1
    if (requests > SKILL_IMPORT_LIMITS.maxRequests) {
      throw new Error(`Skill import exceeded ${SKILL_IMPORT_LIMITS.maxRequests} requests.`)
    }
    return flowFetch(url, init)
  }

  const walk = async (path: string, depth: number): Promise<FetchedSkillFile[]> => {
    if (depth > SKILL_IMPORT_LIMITS.maxDepth) {
      throw new Error(`Skill directory nesting exceeds ${SKILL_IMPORT_LIMITS.maxDepth} levels.`)
    }

    const response = await request(contentsUrl(location, path), { headers: GITHUB_HEADERS })
    if (!response.ok) {
      throw githubRequestError(response, `GitHub API request for ${path || 'repo root'}`)
    }

    const payload = (await response.json()) as ContentsEntry | ContentsEntry[]
    const entries = Array.isArray(payload) ? payload : [payload]
    const files: FetchedSkillFile[] = []

    for (const entry of entries) {
      if (entry.type === 'dir') {
        files.push(...(await walk(entry.path, depth + 1)))
      } else if (entry.type === 'file' && entry.download_url) {
        if (fileCount >= SKILL_IMPORT_LIMITS.maxFiles) {
          throw new Error(`Skill has too many files (limit ${SKILL_IMPORT_LIMITS.maxFiles}).`)
        }
        const raw = await request(entry.download_url, { headers: { 'User-Agent': 'open-science' } })
        if (!raw.ok) {
          throw githubRequestError(raw, `Download of ${entry.path}`)
        }

        // The most this file may add: the smaller of the per-file cap and what remains of the total
        // budget. Reading is bounded by this, so no single body is ever buffered beyond it — even with
        // a missing or dishonest Content-Length.
        const remainingTotal = SKILL_IMPORT_LIMITS.maxTotalBytes - totalBytes
        const perFileLimit = Math.min(SKILL_IMPORT_LIMITS.maxFileBytes, remainingTotal)
        // Report which cap actually bound, so the error tells the user whether one file is too big or
        // the whole skill has outgrown its budget.
        const tooLarge = (): never => {
          const message =
            remainingTotal < SKILL_IMPORT_LIMITS.maxFileBytes
              ? `File ${entry.path} exceeds the ${SKILL_IMPORT_LIMITS.maxTotalBytes}-byte total limit.`
              : `File ${entry.path} exceeds the ${SKILL_IMPORT_LIMITS.maxFileBytes}-byte per-file limit.`
          throw new Error(message)
        }

        // Reject on the advertised Content-Length before reading a single byte when possible.
        const declared = Number(raw.headers?.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > perFileLimit) tooLarge()

        const content = await readBounded(raw, perFileLimit, tooLarge)
        totalBytes += content.length
        fileCount += 1
        const relativePath = entry.path.startsWith(rootPrefix)
          ? entry.path.slice(rootPrefix.length)
          : entry.name
        files.push({ relativePath, content })
      }
    }

    return files
  }

  const files = await walk(location.path, 0)

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

const searchGitHubSkillRepositories = async (
  input: string,
  fetchImpl: FetchLike,
  options: GitHubFetchOptions = {}
): Promise<GitHubRepositorySearchView[]> => {
  const keywords = input.trim()
  const searchTerms = `${keywords} SKILL.md`
  if (searchTerms.length > 256) {
    throw new Error(GITHUB_REPOSITORY_SEARCH_TOO_LONG_MESSAGE)
  }
  const query = `${searchTerms} in:name,description,topics,readme`
  const response = await createGitHubFlowFetch(fetchImpl, options)(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=10`,
    { headers: GITHUB_HEADERS }
  )
  if (!response.ok) throw githubRequestError(response)

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('GitHub returned an invalid repository search response.')
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { items?: unknown }).items)
  ) {
    throw new Error('GitHub returned an invalid repository search response.')
  }

  const repositories: GitHubRepositorySearchView[] = []
  for (const item of (payload as { items: unknown[] }).items.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue
    const repository = item as Record<string, unknown>
    if (
      typeof repository.full_name !== 'string' ||
      (repository.description !== null && typeof repository.description !== 'string') ||
      typeof repository.html_url !== 'string' ||
      typeof repository.stargazers_count !== 'number'
    ) {
      continue
    }
    repositories.push({
      fullName: repository.full_name,
      description: repository.description,
      url: repository.html_url,
      stars: repository.stargazers_count
    })
  }
  return repositories
}

// Scans a repo's git tree for every directory containing a SKILL.md, returning an importable URL for
// each. Resolve branch/tag refs to a commit first so a later preview and import read the same snapshot.
const scanRepoForSkills = async (
  repo: GitHubRepoRef,
  fetchImpl: FetchLike,
  options: GitHubFetchOptions = {}
): Promise<ScannedSkill[]> => {
  const flowFetch = createGitHubFlowFetch(fetchImpl, options)
  let ref = repo.ref
  if (!ref) {
    const meta = await flowFetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
      headers: GITHUB_HEADERS
    })
    if (!meta.ok) throw githubRequestError(meta)
    ref = ((await meta.json()) as { default_branch?: string }).default_branch ?? 'main'
  }

  const commitResponse = await flowFetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`,
    { headers: GITHUB_HEADERS }
  )
  if (!commitResponse.ok) throw githubRequestError(commitResponse)
  const commitSha = ((await commitResponse.json()) as { sha?: string }).sha
  if (!commitSha) throw new Error('GitHub did not return a commit SHA for that ref.')

  const treeResponse = await flowFetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    { headers: GITHUB_HEADERS }
  )
  if (!treeResponse.ok) throw githubRequestError(treeResponse)

  const tree = (await treeResponse.json()) as {
    tree?: { path: string; type: string }[]
    truncated?: boolean
  }
  if (tree.truncated) {
    throw new Error(
      'This repository is too large to scan completely. Paste a link to the Skill folder instead.'
    )
  }
  const skills: ScannedSkill[] = []

  for (const entry of tree.tree ?? []) {
    if (entry.type === 'blob' && /(^|\/)SKILL\.md$/i.test(entry.path)) {
      const dir = entry.path.replace(/\/?SKILL\.md$/i, '')
      const name = dir.split('/').filter(Boolean).pop() ?? repo.repo
      // Percent-encode each segment so the url round-trips when later imported (e.g. spaces in dir names).
      const encodedRef = encodeURIComponent(commitSha)
      const encodedDir = dir.split('/').map(encodeURIComponent).join('/')
      const url = dir
        ? `https://github.com/${repo.owner}/${repo.repo}/tree/${encodedRef}/${encodedDir}`
        : `https://github.com/${repo.owner}/${repo.repo}/tree/${encodedRef}`
      skills.push({ name, path: dir, url })
    }
  }

  return skills
}

export {
  GITHUB_TOTAL_TIMEOUT_MS,
  parseGitHubSkillUrl,
  parseGitHubRepo,
  createAuthenticatedGitHubFetch,
  isGitHubRateLimitResponse,
  searchGitHubSkillRepositories,
  fetchSkillPreview,
  fetchSkillFiles,
  scanRepoForSkills
}
