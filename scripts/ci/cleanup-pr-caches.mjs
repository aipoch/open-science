/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Closed PR merge-ref caches cannot serve main or other PRs, but consume the same quota.
export async function cleanupPrCaches({ github, repo, dryRun = true, log = console.log }) {
  const caches = await github.paginate('GET /repos/{owner}/{repo}/actions/caches', {
    ...repo,
    per_page: 100
  })
  const states = new Map()
  const deleted = []
  for (const cache of caches) {
    const match = /^refs\/pull\/([1-9]\d*)\/merge$/.exec(cache.ref ?? '')
    if (!match) continue
    const number = Number(match[1])
    if (!Number.isSafeInteger(number)) continue
    if (!states.has(number)) {
      const { data } = await github.rest.pulls.get({ ...repo, pull_number: number })
      states.set(number, data.state)
    }
    if (states.get(number) !== 'closed') continue
    if (dryRun) {
      log(`Would delete cache ${cache.id} (${cache.ref}, ${cache.size_in_bytes} bytes)`)
      continue
    }
    try {
      await github.request('DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}', {
        ...repo,
        cache_id: cache.id
      })
      deleted.push(cache.id)
      log(`Deleted cache ${cache.id} (${cache.ref}, ${cache.size_in_bytes} bytes)`)
    } catch (error) {
      // Cache eviction or another cleanup may win after enumeration.
      if (error.status !== 404) throw error
      log(`Cache ${cache.id} was already removed`)
    }
  }
  return deleted
}
