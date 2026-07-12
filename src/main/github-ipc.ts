import { ipcMain } from 'electron'

import { APP } from '../shared/app-config'

type FetchFn = typeof fetch

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

// The cache lives in this closure. In production register runs once, so the count is fetched at most
// once per session; a failed attempt is not cached, so a later mount may retry.
const registerGithubIpcHandlers = (deps: { fetch?: FetchFn } = {}): void => {
  const fetchFn = deps.fetch ?? fetch
  let cachedStars: number | null = null
  let inFlight: Promise<number | null> | null = null

  ipcMain.handle('github:get-stars', (): Promise<number | null> => {
    if (cachedStars !== null) return Promise.resolve(cachedStars)

    if (!inFlight) {
      inFlight = fetchStars(fetchFn).then((count) => {
        if (count !== null) cachedStars = count
        inFlight = null
        return count
      })
    }

    return inFlight
  })
}

export { registerGithubIpcHandlers }
