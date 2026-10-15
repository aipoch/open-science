import { describe, expect, it } from 'vitest'
import { validateNotarizeSource } from './validate-notarize-source.mjs'

const repository = 'aipoch/open-science'
const source = {
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  path: '.github/workflows/release.yml',
  event: 'push',
  head_sha: 'a'.repeat(40)
}
describe('notarization dry-run artifact trust', () => {
  it.each(['ahead', 'identical'])(
    'accepts a Release push whose source belongs to main: %s',
    (status) => {
      expect(() => validateNotarizeSource(source, repository, { status })).not.toThrow()
    }
  )
  it.each([
    { repository: { full_name: 'other/repo' } },
    { head_repository: { full_name: 'fork/repo' } },
    { path: '.github/workflows/pr.yml' },
    { event: 'pull_request' },
    { head_sha: 'main' }
  ])('rejects untrusted source metadata %j', (change) => {
    expect(() =>
      validateNotarizeSource({ ...source, ...change }, repository, { status: 'ahead' })
    ).toThrow()
  })
  it.each(['behind', 'diverged', undefined])(
    'rejects a source outside main history: %s',
    (status) => {
      expect(() => validateNotarizeSource(source, repository, { status })).toThrow()
    }
  )
})
