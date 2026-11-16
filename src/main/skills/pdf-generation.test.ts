import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SkillRegistry } from '@aipoch/skills'
import { ClaudeCodeSkillMaterializer } from './materializer'
import { RegisteredSkillHelperCatalog } from './registered-helper-catalog'
import { NotebookHelperModuleHost } from '../notebook/helper-module-host'
import { NotebookKernelExecutor } from '../notebook/kernel-executor'

const SKILL_ID = 'pdf-generation'
const EXPORTS = [
  'register_pdf_fonts',
  'render_pdf_pages',
  'inspect_pdf',
  'pdf_form_fields',
  'fill_pdf_form'
]
const python = (): string =>
  process.env.OPEN_SCIENCE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const loadSkill = async (): Promise<Awaited<ReturnType<SkillRegistry['list']>>[number]> =>
  (await new SkillRegistry(resolve('resources/skills')).list()).find(
    (entry) => entry.id === SKILL_ID
  )!

it('injects every PDF helper export into the kernel without importing third-party packages', async () => {
  const skill = await loadSkill()
  expect(skill.helpers).toEqual([expect.objectContaining({ id: SKILL_ID, exports: EXPORTS })])
  const root = await mkdtemp(join(tmpdir(), 'pdf-helper-'))
  try {
    const catalog = new RegisteredSkillHelperCatalog({
      storageRoot: root,
      packages: async () => [
        {
          skillId: skill.id,
          packageRoot: skill.sourceDir,
          origin: 'builtin',
          helpers: [...skill.helpers!]
        }
      ]
    })
    const host = new NotebookHelperModuleHost(catalog)
    const epoch = { id: 'pdf', processKey: 'python:pdf' }
    const plan = await host.plan(epoch, await host.preflight('python', [SKILL_ID], epoch))
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: resolve('resources/notebook/python_loop.py'),
      platform: process.platform
    })
    try {
      const result = await executor.execute({
        cwd: root,
        notebookSessionRoot: join(root, 'notebook'),
        dataRoot: join(root, 'notebook/data'),
        runtimeRoot: join(root, 'runtime'),
        language: 'python',
        resolvedInterpreter: { command: python() },
        helperModules: plan.injections,
        code: `import json\nprint(json.dumps([callable(globals()[n]) for n in ${JSON.stringify(EXPORTS)}]))`
      })
      expect(result.status, result.traceback).toBe('completed')
      expect(JSON.parse(result.stdout.trim())).toEqual(EXPORTS.map(() => true))
    } finally {
      await executor.shutdown()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('projects the on-demand PDF workflow with its reference guides', async () => {
  const skill = await loadSkill()
  expect(skill.activationPolicy).not.toBe('always-on')
  const root = await mkdtemp(join(tmpdir(), 'pdf-skill-'))
  try {
    await new ClaudeCodeSkillMaterializer().sync(root, [skill])
    const projected = join(root, `skills/os-${SKILL_ID}`)
    for (const file of ['references/forms.md', 'references/processing.md']) {
      expect(await readFile(join(projected, file))).toEqual(
        await readFile(join('resources/skills', SKILL_ID, file))
      )
    }
    expect(await readFile(join(projected, 'SKILL.md'), 'utf8')).toContain('references/forms.md')
  } finally {
    await new ClaudeCodeSkillMaterializer().sync(root, [])
    await rm(root, { recursive: true, force: true })
  }
})

it('runs the PDF helper regression suite (skips when ReportLab or pypdf is unavailable)', () => {
  execFileSync(python(), ['-m', 'unittest', 'discover', '-s', 'test/pdf-generation', '-v'], {
    stdio: 'pipe'
  })
})
