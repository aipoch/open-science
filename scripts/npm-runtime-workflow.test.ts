/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

const workflow = (name: string): any =>
  load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'))
describe('native npm dry-run boundary', () => {
  it('keeps manual dispatch unprivileged and reuses the native verifier', () => {
    const flow = workflow('publish-npm.yml')
    expect(Object.keys(flow.on)).toEqual(['workflow_dispatch'])
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(flow.jobs.verify.uses).toBe('./.github/workflows/npm-runtime.yml')
    expect(flow.jobs.verify.secrets).toBeUndefined()
  })
  it('verifies the packed installation and cannot publish packages', () => {
    const flow = workflow('npm-runtime.yml')
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    const steps = flow.jobs.verify.steps
    expect(steps.some((step: any) => step.run?.includes('npm run pack:npm-release'))).toBe(true)
    expect(steps.some((step: any) => step.run?.includes('npm run test:npm-installed'))).toBe(true)
    for (const step of steps) {
      for (const line of (step.run ?? '').split('\n')) {
        if (line.includes('npm publish')) expect(line).toContain('--dry-run')
      }
      expect(JSON.stringify(step)).not.toContain('secrets.')
    }
  })
})

it('gates stable publication on the same release and complete native verification', () => {
  const flow = workflow('release.yml')
  expect(flow.jobs['npm-artifacts'].needs).toEqual(['build', 'package-smoke', 'notarize-mac'])
  expect(flow.jobs['npm-artifacts'].with.desktop_run_id).toContain('github.run_id')
  expect(flow.jobs.publish.needs).toContain('npm-artifacts')
  const publish = flow.jobs['publish-npm']
  expect(publish.needs).toEqual(['publish', 'npm-artifacts'])
  expect(publish.if).toContain("github.event_name == 'push'")
  expect(publish.if).toContain('refs/tags/v')
  expect(publish.environment).toBe('npm')
  expect(publish.permissions['id-token']).toBe('write')
  expect(publish.steps.at(-1).run).toContain('--publish')
  expect(workflow('npm-runtime.yml').jobs['publication-check'].steps.at(-1).run).toContain(
    '--dry-run'
  )
})
