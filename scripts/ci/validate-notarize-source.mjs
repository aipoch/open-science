/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const validateNotarizeSource = (run, repository, comparison) => {
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.path !== '.github/workflows/release.yml' ||
    run.event !== 'push' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') ||
    !['ahead', 'identical'].includes(comparison.status)
  ) {
    throw new Error(
      'Reused artifacts must come from a same-repository Release push on main history.'
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repository = process.env.GITHUB_REPOSITORY
  const id = process.env.SOURCE_RUN
  if (!/^[1-9]\d*$/.test(id ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) {
    throw new Error('A numeric source run and GitHub repository are required.')
  }
  const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))
  const run = api(`repos/${repository}/actions/runs/${id}`)
  if (!/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) throw new Error('Invalid source revision.')
  const comparison = api(`repos/${repository}/compare/${run.head_sha}...main`)
  validateNotarizeSource(run, repository, comparison)
  console.log(
    `Reusing Release run ${id}, source ${run.head_sha}; artifacts remain in the source run.`
  )
}
