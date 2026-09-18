import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  env?: Record<string, string>
  id?: string
  name?: string
  run?: string
  shell?: string
  uses?: string
  with?: Record<string, unknown>
}

type Job = { outputs?: Record<string, string>; steps?: Step[] }

type Workflow = { jobs: Record<string, Job> }

type Action = {
  description?: string
  inputs?: Record<string, { default?: string; description?: string; required?: boolean }>
  outputs?: Record<string, { value?: string }>
  runs?: { using?: string; steps?: Step[] }
}

const ACTION = './.github/actions/skip-unchanged-scheduled'

const read = (...segments: string[]): string =>
  readFileSync(join(process.cwd(), ...segments), 'utf8')

const workflow = (name: string): Workflow => load(read('.github/workflows', name)) as Workflow

const step = (job: Job, predicate: (candidate: Step) => boolean): Step => {
  const result = job.steps?.find(predicate)
  if (!result) throw new Error('Missing step')
  return result
}

const callers: Array<{
  file: string
  job: string
  output: string
  with: Record<string, string>
}> = [
  {
    file: 'windows-full-test.yml',
    job: 'plan',
    output: 'should_test',
    with: { 'workflow-file': 'windows-full-test.yml', 'include-dispatch-modes': 'full' }
  },
  {
    file: 'runtime-resource-soak.yml',
    job: 'plan',
    output: 'should_test',
    with: { 'workflow-file': 'runtime-resource-soak.yml' }
  },
  {
    file: 'nightly.yml',
    job: 'plan',
    output: 'should_build',
    with: { 'workflow-file': 'nightly.yml' }
  }
]

describe('skip-unchanged-scheduled composite action', () => {
  const action = load(read('.github/actions/skip-unchanged-scheduled/action.yml')) as Action

  it('declares the shared interface and documents the dispatch-input limitation', () => {
    expect(action.runs?.using).toBe('composite')
    expect(action.inputs?.['workflow-file']).toMatchObject({ required: true })
    expect(action.inputs?.['include-dispatch-modes']).toMatchObject({
      required: false,
      default: ''
    })
    expect(action.outputs?.should_run?.value).toBe('${{ steps.decide.outputs.should_run }}')
    expect(action.outputs?.last_successful_sha?.value).toBe(
      '${{ steps.decide.outputs.last_successful_sha }}'
    )
    expect(action.description).toContain('does not expose dispatch inputs')
    expect(action.description).toContain('any successful dispatch of the same SHA counts')
  })

  it('always runs manual dispatches and compares scheduled runs with successful coverage', () => {
    const decide = step(action.runs ?? {}, (candidate) => candidate.id === 'decide')
    const script = decide.run ?? ''

    expect(decide.shell).toBe('bash')
    expect(decide.env).toEqual({
      WORKFLOW_FILE: '${{ inputs.workflow-file }}',
      INCLUDE_DISPATCH_MODES: '${{ inputs.include-dispatch-modes }}'
    })
    expect(script).toContain('"$GITHUB_EVENT_NAME" == "workflow_dispatch"')
    expect(script).toContain(
      'actions/workflows/$WORKFLOW_FILE/runs?branch=main&event=$1&status=success&per_page=1'
    )
    expect(script).toContain('last_successful_sha schedule')
    expect(script).toContain('last_successful_sha workflow_dispatch')
    expect(script).toContain('-n "$INCLUDE_DISPATCH_MODES"')
    expect(script).toContain('"$scheduled_sha" == "$GITHUB_SHA"')
    expect(script).toContain('"$dispatch_sha" == "$GITHUB_SHA"')
    expect(script.match(/should_run=false/g)).toHaveLength(2)
    expect(script.match(/should_run=true/g)).toHaveLength(2)
  })

  it.each(callers)(
    '$file plans through the shared action',
    ({ file, job, output, with: inputs }) => {
      const plan = workflow(file).jobs[job]
      const decide = step(plan, (candidate) => candidate.uses === ACTION)

      expect(decide.id).toBe('decide')
      expect(decide.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
      expect(decide.with).toEqual(inputs)
      expect(plan.outputs?.[output]).toBe('${{ steps.decide.outputs.should_run }}')
      expect(
        step(plan, (candidate) => Boolean(candidate.uses?.startsWith('actions/checkout@'))).with
      ).toMatchObject({
        'persist-credentials': false,
        'sparse-checkout': '.github/actions/skip-unchanged-scheduled'
      })
      expect(plan.steps?.filter((candidate) => candidate.run)).toEqual([])
    }
  )

  it('leaves no inline scheduled-run lookup in the callers', () => {
    for (const { file } of callers) {
      const text = read('.github/workflows', file)
      expect(text).not.toMatch(/runs\?branch=main&event=schedule/)
      expect(text).not.toContain('secrets.GITHUB_TOKEN')
    }
    expect(read('.github/workflows', 'nightly.yml')).not.toContain('commits/nightly')
    expect(read('.github/workflows', 'nightly-publish.yml')).toContain('commits/nightly')
    expect(read('.github/workflows', 'source-regression.yml')).not.toContain(ACTION)
  })
})
