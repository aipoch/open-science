/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
const workflow = (name: string): any =>
  load(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'))
describe('runtime distribution boundary', () => {
  it('defaults the existing manual dispatcher to archives without publish permissions or secrets', () => {
    const flow = workflow('publish-npm.yml')
    expect(Object.keys(flow.on)).toEqual(['workflow_dispatch'])
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(flow.on.workflow_dispatch.inputs.distribution.default).toBe('archive')
    expect(flow.jobs.verify.uses).toBe('./.github/workflows/runtime-packages.yml')
    expect(flow.jobs.verify.secrets).toBeUndefined()
  })
  it('shares native build/extraction while testing both distributions without publication', () => {
    const flow = workflow('runtime-packages.yml')
    expect(flow.permissions).toEqual({ contents: 'read', actions: 'read' })
    expect(flow.on.workflow_call.inputs.distribution.default).toBe('archive')
    const steps = flow.jobs.verify.steps
    expect(steps.find((s: any) => s.name === 'Pack standalone archive').run).toBe(
      'npm run pack:runtime-archive'
    )
    expect(
      steps.find((s: any) => s.name === 'Stage pinned Node for independent archives').run
    ).toBe('npm run stage:node-runtime')
    expect(steps.some((s: any) => s.run?.includes('npm run test:runtime-archive-installed'))).toBe(
      true
    )
    expect(steps.some((s: any) => s.run?.includes('npm run test:npm-installed'))).toBe(true)
    expect(steps.find((s: any) => s.name === 'Extract and verify signed backend').if).toBe(
      "inputs.desktop_run_id != ''"
    )
    for (const step of steps) {
      for (const line of (step.run ?? '').split('\n'))
        if (line.includes('npm publish')) expect(line).toContain('--dry-run')
      expect(JSON.stringify(step)).not.toContain('secrets.')
    }
    expect(
      flow.jobs['publication-check'].steps.some(
        (s: any) => s.run === 'npm run verify:runtime-archives -- out/distributions'
      )
    ).toBe(true)
  })
  it('requires same-run signed inputs, all five archives and checksums before Release publication', () => {
    const flow = workflow('release.yml')
    expect(flow.jobs['cli-artifacts'].needs).toEqual(['build', 'package-smoke', 'notarize-mac'])
    expect(flow.jobs['cli-artifacts'].uses).toBe('./.github/workflows/runtime-packages.yml')
    expect(flow.jobs['cli-artifacts'].with.desktop_run_id).toContain('github.run_id')
    expect(flow.jobs['cli-artifacts'].with.distribution ?? 'archive').toBe('archive')
    expect(flow.jobs.publish.needs).toContain('cli-artifacts')
    expect(flow.jobs['publish-npm']).toBeUndefined()
    const steps = flow.jobs.publish.steps
    const verify = steps.findIndex((s: any) => s.name === 'Verify standalone release archive set')
    const publish = steps.findIndex((s: any) => s.name === 'Publish GitHub Release')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(publish)
    expect(steps.find((s: any) => s.name === 'Generate checksums').run).toContain('*.tar.gz')
    for (const name of ['Attest build provenance', 'Publish GitHub Release']) {
      const entry = steps.find((s: any) => s.name === name)
      const patterns = entry.with['subject-path'] ?? entry.with.files
      expect(patterns).toContain('artifacts/open-science-*.tar.gz')
      expect(patterns).toContain('artifacts/*.zip')
    }
    expect(JSON.stringify(flow)).not.toContain('NPM_TOKEN')
  })
})
