import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const skillRoot = join(__dirname, '..', '..', '..', '..', 'resources', 'skills', 'skill-creator')
const require = createRequire(import.meta.url)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const listFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = []
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(relative(directory, path).replaceAll('\\', '/'))
    }
  }
  await visit(directory)
  return files.sort()
}

describe('skill-creator bundled package', () => {
  it('ships the reusable workflow as JavaScript-first progressive resources', async () => {
    await expect(listFiles(skillRoot)).resolves.toEqual(
      [
        'SKILL.md',
        'agents/analyzer.md',
        'agents/comparator.md',
        'agents/grader.md',
        'assets/eval_review.html',
        'eval-viewer/generate-review.js',
        'eval-viewer/viewer.html',
        'references/schemas.md',
        'scripts/aggregate-benchmark.js',
        'scripts/generate-report.js',
        'scripts/improve-description.js',
        'scripts/index.js',
        'scripts/quick-validate.js',
        'scripts/run-eval.js',
        'scripts/run-loop.js',
        'scripts/utils.js'
      ].sort()
    )

    const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('JavaScript control-plane REPL')
    expect(skill).toContain('host.skills.validate(')
    expect(skill).toContain('references/schemas.md')
    expect(skill).toContain('agents/grader.md')
    expect(skill).toContain('eval-viewer/generate-review.js')
    expect(skill).not.toMatch(/python -m|\.py\b/)
    expect(skill).not.toMatch(/await host\.skills\.\w+\([^)]*=/)

    const triggerReview = await readFile(join(skillRoot, 'assets', 'eval_review.html'), 'utf8')
    expect(triggerReview).toContain('schema_version: 1')
    expect(triggerReview).toContain("kind: 'trigger'")
    expect(triggerReview).toContain("link.download = 'trigger-evals.json'")
  })

  it('aggregates paired run metrics without a provider-specific CLI', () => {
    const { aggregateBenchmark } = require(join(skillRoot, 'scripts', 'index.js')) as {
      aggregateBenchmark(input: Record<string, unknown>): {
        run_summary: {
          with_skill: Record<string, { mean: number }>
          delta: Record<string, number>
        }
      }
    }
    const result = aggregateBenchmark({
      runs: [
        { configuration: 'with_skill', result: { pass_rate: 1, time_seconds: 8, tokens: 120 } },
        { configuration: 'with_skill', result: { pass_rate: 0.5, time_seconds: 12, tokens: 180 } },
        { configuration: 'without_skill', result: { pass_rate: 0.25, time_seconds: 5, tokens: 80 } }
      ]
    })

    expect(result.run_summary.with_skill.pass_rate.mean).toBe(0.75)
    expect(result.run_summary.with_skill.time_seconds.mean).toBe(10)
    expect(result.run_summary.delta.pass_rate).toBe(0.5)
  })

  it('validates the Open Science frontmatter contract without third-party packages', () => {
    const { validateSkillDocument } = require(join(skillRoot, 'scripts', 'index.js')) as {
      validateSkillDocument(
        content: string,
        expectedName?: string
      ): { valid: boolean; error?: string }
    }
    expect(
      validateSkillDocument(
        '---\nname: data-helper\ndescription: Analyze data.\n---\nBody.\n',
        'data-helper'
      )
    ).toMatchObject({ valid: true })
    expect(
      validateSkillDocument(
        '---\nname: data-helper\ndescription: Analyze data.\ncompatibility: node\n---\nBody.\n',
        'data-helper'
      )
    ).toEqual({ valid: false, error: 'Frontmatter must contain exactly name and description.' })
  })

  it('gates evaluation behind the app-owned host.skills.evals capability', async () => {
    const { runEval } = require(join(skillRoot, 'scripts', 'index.js')) as {
      runEval(input: Record<string, unknown>): Promise<unknown>
    }
    await expect(runEval({ hostSkills: {}, evalId: 'eval-1' })).rejects.toThrow(
      'host.skills.evals.run is unavailable'
    )
    const run = vi.fn(async () => ({ status: 'complete' }))
    await expect(runEval({ hostSkills: { evals: { run } }, evalId: 'eval-1' })).resolves.toEqual({
      status: 'complete'
    })
    expect(run).toHaveBeenCalledWith('eval-1')
  })

  it('gates the description loop behind the same app-owned evaluation capability', async () => {
    const { runLoop } = require(join(skillRoot, 'scripts', 'index.js')) as {
      runLoop(input: Record<string, unknown>): Promise<unknown>
    }
    await expect(runLoop({ hostSkills: {}, evalId: 'eval-1' })).rejects.toThrow(
      'host.skills.evals.run is unavailable'
    )
    const run = vi.fn(async () => ({ status: 'complete' }))
    await expect(runLoop({ hostSkills: { evals: { run } }, evalId: 'eval-1' })).resolves.toEqual({
      status: 'complete'
    })
    expect(run).toHaveBeenCalledWith('eval-1')
  })

  it('keeps both train and held-out trigger cases nonempty', () => {
    const { splitEvalSet } = require(join(skillRoot, 'scripts', 'index.js')) as {
      splitEvalSet(input: unknown[]): { train: unknown[]; test: unknown[] }
    }
    expect(splitEvalSet([1, 2, 3])).toEqual({ train: [1, 2], test: [3] })
    expect(() => splitEvalSet([1])).toThrow('at least two trigger cases')
  })

  it('generates a static review from bounded workspace outputs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'skill-creator-review-'))
    roots.push(workspace)
    const runDirectory = join(workspace, 'iteration-1', 'eval-1', 'with_skill')
    await mkdir(join(runDirectory, 'outputs'), { recursive: true })
    await writeFile(
      join(runDirectory, 'eval_metadata.json'),
      JSON.stringify({ eval_id: 'eval-1', prompt: 'Create a report.' })
    )
    await writeFile(join(runDirectory, 'outputs', 'report.txt'), '<script>alert(1)</script>')
    const oversizedOutput = join(runDirectory, 'outputs', 'large.bin')
    await writeFile(oversizedOutput, '')
    await truncate(oversizedOutput, 2 * 1024 * 1024 + 1)
    const outputPath = join(workspace, 'review.html')
    const { generateReview } = require(join(skillRoot, 'eval-viewer', 'generate-review.js')) as {
      generateReview(input: Record<string, unknown>): Promise<{
        output_path: string
        run_count: number
      }>
    }

    await expect(
      generateReview({
        workspace,
        outputPath,
        skillName: '</h1><script>alert(2)</script>',
        templatePath: join(skillRoot, 'eval-viewer', 'viewer.html')
      })
    ).resolves.toEqual({ output_path: outputPath, run_count: 1 })
    const html = await readFile(outputPath, 'utf8')
    expect(html).toContain('\\u003cscript>alert(1)\\u003c/script>')
    expect(html).not.toContain('</h1><script>alert(2)</script>')
    expect(html).toContain('&lt;/h1&gt;&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html).toContain('File exceeds the 2 MiB review limit.')
    expect(html).toContain('Content-Security-Policy')
  })
})
