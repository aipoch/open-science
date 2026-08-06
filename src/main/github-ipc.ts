import { ipcMainHandle } from './ipc-handler-registry'

import { APP } from '../shared/app-config'

type FetchFn = typeof fetch
type GithubCommandOwner = Readonly<{ getStars: () => Promise<number | null> }>

// Reads the repository star count. GitHub requires a User-Agent on API requests; anonymous requests
// are rate-limited (60/hour/IP), so the result is cached for the app session and concurrent callers
// share one in-flight request. Any failure resolves to null so the badge can degrade to icon-only.
const fetchStars = async (fetchFn: FetchFn): Promise<number | null> => {
  try {
    const response = await fetchFn(APP.links.githubApi, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'open-science-app'
      }
    })

    if (!response.ok) return null

    const body = (await response.json()) as { stargazers_count?: unknown }

    return typeof body.stargazers_count === 'number' ? body.stargazers_count : null
  } catch {
    return null
  }
}

// The cache lives in this owner. A failed attempt is not cached, so a later call may retry.
const createGithubCommandOwner = (deps: { fetch?: FetchFn } = {}): GithubCommandOwner => {
  const fetchFn = deps.fetch ?? fetch
  let cachedStars: number | null = null
  let inFlight: Promise<number | null> | null = null

  return {
    getStars: (): Promise<number | null> => {
      if (cachedStars !== null) return Promise.resolve(cachedStars)

      if (!inFlight) {
        inFlight = fetchStars(fetchFn).then((count) => {
          if (count !== null) cachedStars = count
          inFlight = null
          return count
        })
      }

      return inFlight
    }
  }
}

const registerGithubIpcHandlers = (
  deps: { fetch?: FetchFn } = {},
  owner: GithubCommandOwner = createGithubCommandOwner(deps)
): GithubCommandOwner => {
  ipcMainHandle('github:get-stars', () => owner.getStars())
  return owner
}

export type { GithubCommandOwner }
export { registerGithubIpcHandlers, createGithubCommandOwner }
