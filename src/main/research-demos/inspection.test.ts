import { describe, expect, it } from 'vitest'
import { parseResearchDemoDescription } from '../../shared/research-demo'
import { demoFixture, demoSource } from './fixtures.test-support'
import { inspectResearchDemos, researchDemoCommand } from './inspection'

describe('explicit offline demonstration discovery', () => {
  it('pins the exact descriptor and required script without using plan scope as authority', async () => {
    const fixture = demoFixture()
    const result = await inspectResearchDemos(demoSource, fixture.authority, fixture.runtimes)
    expect(result.inspection.candidates).toEqual([
      expect.objectContaining({
        demoVersionId: 'demo',
        status: 'ready',
        descriptorVersionId: 'descriptor',
        demoViewing: { mode: 'process-lifetime', timeoutMs: 10000 },
        blockers: []
      })
    ])
    expect(result.resolved[0]).toMatchObject({
      entryPath: 'demo.mjs',
      materialVersions: { script: 'script' }
    })
    fixture.authority.versions = fixture.authority.versions.filter(
      (version) => version.versionId !== 'demo'
    )
    expect(
      (await inspectResearchDemos(demoSource, fixture.authority, fixture.runtimes)).inspection
        .candidates
    ).toEqual([])
  })
  it('projects only a validated author viewing contract and its bounded execution budget', async () => {
    const fixture = demoFixture({
      editDemo: (demo) => {
        demo.localServicePort = 4173
        demo.projectView = { title: 'Project' }
        demo.viewing = { mode: 'until-stop-or-timeout' }
        demo.timeoutMs = 600000
      }
    })
    const result = await inspectResearchDemos(demoSource, fixture.authority, fixture.runtimes)
    expect(result.inspection.candidates[0]).toMatchObject({
      status: 'ready',
      demoViewing: { mode: 'until-stop-or-timeout', timeoutMs: 600000 }
    })
    for (const invalid of [
      { ...fixture.demo, projectView: undefined },
      { ...fixture.demo, timeoutMs: 600001 },
      { ...fixture.demo, viewing: { mode: 'forever' } },
      { ...fixture.demo, viewing: { mode: 'until-stop-or-timeout', deadlineAt: 1 } },
      { ...fixture.demo, viewing: { mode: 'until-stop-or-timeout', endReason: 'time-limit' } }
    ])
      expect(parseResearchDemoDescription(JSON.stringify(invalid)).status).toBe('invalid')
  })
  it.each([
    [
      'descriptor-unavailable',
      (demo: ReturnType<typeof demoFixture>['demo']) => {
        demo.descriptorSha256 = '0'.repeat(64)
      }
    ],
    [
      'entrypoint-unavailable',
      (demo: ReturnType<typeof demoFixture>['demo']) => {
        demo.entrypoint = { materialKey: 'other' }
      }
    ]
  ])('blocks %s instead of guessing a runnable command', async (reason, editDemo) => {
    const fixture = demoFixture({ editDemo })
    expect(
      (await inspectResearchDemos(demoSource, fixture.authority, fixture.runtimes)).inspection
        .candidates[0].blockers
    ).toContain(reason)
  })
  it('requires a declared entrypoint and rejects a secret-requiring plan', async () => {
    const fixture = demoFixture({
      editDescription: (description) => {
        description.plans[0].entrypoints = []
        description.secrets = [
          {
            key: 'api',
            description: 'Remote API',
            required: true,
            environmentVariable: 'EXAMPLE_API_KEY',
            planKeys: ['example']
          }
        ]
      }
    })
    expect(
      (await inspectResearchDemos(demoSource, fixture.authority, fixture.runtimes)).inspection
        .candidates[0].blockers
    ).toEqual(['entrypoint-unavailable', 'secrets-required'])
  })
  it('rejects unavailable bytes and changed hashes before a launch can be offered', async () => {
    const fixture = demoFixture()
    fixture.content.get('demo')!.bytes = Buffer.from('{}')
    await expect(
      inspectResearchDemos(demoSource, fixture.authority, fixture.runtimes)
    ).rejects.toThrow('content-mismatch')
  })
  it('reports runtime or service support separately from material availability', async () => {
    const fixture = demoFixture({
      editDemo: (demo) => {
        demo.localServicePort = 4173
      }
    })
    const result = await inspectResearchDemos(demoSource, fixture.authority, {
      ...fixture.runtimes,
      runtimes: [],
      diagnostics: { nativeServiceSupported: false, issues: [] }
    })
    expect(result.inspection.candidates[0].blockers).toEqual([
      'runtime-unavailable',
      'service-unavailable'
    ])
  })
  it('quotes literal argv rather than running shell metacharacters', async () => {
    const fixture = demoFixture({
      editDemo: (demo) => {
        demo.arguments = ["a'b", '$(touch /tmp/not-executed)', 'x;y', 'line\nnext']
      }
    })
    const { resolved } = await inspectResearchDemos(demoSource, fixture.authority, fixture.runtimes)
    expect(researchDemoCommand(resolved[0])).toBe(
      "node \"$OPEN_SCIENCE_INPUT_DIR\"/'demo.mjs' 'a'\\''b' '$(touch /tmp/not-executed)' 'x;y' 'line\nnext'"
    )
  })
})

describe('ordinary demo Artifact parsing', () => {
  it('rejects duplicate/escaped duplicate keys and reserved fields', () => {
    expect(parseResearchDemoDescription('{"version":1,"\\u0076ersion":2}').status).toBe('invalid')
    expect(parseResearchDemoDescription('{"__proto__":{}}').status).toBe('invalid')
  })
  it('admits future content as unsupported, never as an executable demo', () => {
    const demo = demoFixture().demo
    expect(parseResearchDemoDescription(JSON.stringify({ ...demo, version: 2 })).status).toBe(
      'unsupported'
    )
  })
  it('rejects paths, undeclared raw commands, excessive depth and oversized content', () => {
    const demo = demoFixture().demo
    expect(
      parseResearchDemoDescription(
        JSON.stringify({ ...demo, entrypoint: { materialKey: 'script', path: '../private' } })
      ).status
    ).toBe('invalid')
    expect(
      parseResearchDemoDescription(JSON.stringify({ ...demo, command: 'anything' })).status
    ).toBe('invalid')
    expect(parseResearchDemoDescription('['.repeat(30) + '0' + ']'.repeat(30)).status).toBe(
      'invalid'
    )
    expect(
      parseResearchDemoDescription(JSON.stringify({ ...demo, description: 'x'.repeat(100000) }))
        .status
    ).toBe('invalid')
  })
})
