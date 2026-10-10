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
    expect(flow.permissions).toEqual({ contents: 'read' })
    expect(flow.jobs.verify.uses).toBe('./.github/workflows/npm-runtime.yml')
    expect(flow.jobs.verify.secrets).toBeUndefined()
  })
  it('verifies the packed installation and cannot publish packages', () => {
    const flow = workflow('npm-runtime.yml')
    expect(flow.permissions).toEqual({ contents: 'read' })
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
