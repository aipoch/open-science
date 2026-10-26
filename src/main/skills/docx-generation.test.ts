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

it('prepares the converter through the registered helper without reading its skill directory', async () => {
  const skill = (await new SkillRegistry(resolve('resources/skills')).list()).find(
    (entry) => entry.id === 'docx-generation'
  )!
  expect(skill.helpers).toEqual([
    expect.objectContaining({ id: 'docx-generation', exports: ['prepare_docx_conversion'] })
  ])
  const root = await mkdtemp(join(tmpdir(), 'docx-helper-'))
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
    const helper = await catalog.resolve('docx-generation')
    expect(helper?.source).toContain('def prepare_docx_conversion(')
    const python =
      process.env.OPEN_SCIENCE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
    const host = new NotebookHelperModuleHost(catalog)
    const epoch = { id: 'docx', processKey: 'python:docx' }
    const plan = await host.plan(epoch, await host.preflight('python', ['docx-generation'], epoch))
    const executor = new NotebookKernelExecutor({
      pythonLoopPath: resolve('resources/notebook/python_loop.py'),
      platform: process.platform
    })
    let prepared: { script_path: string; reference_path: string }
    try {
      const result = await executor.execute({
        cwd: root,
        notebookSessionRoot: join(root, 'notebook'),
        dataRoot: join(root, 'notebook/data'),
        runtimeRoot: join(root, 'runtime'),
        language: 'python',
        resolvedInterpreter: { command: python },
        helperModules: plan.injections,
        code: `import json\nprint(json.dumps(prepare_docx_conversion(${JSON.stringify(root)})))`
      })
      expect(result.status, result.traceback).toBe('completed')
      prepared = JSON.parse(result.stdout.trim())
    } finally {
      await executor.shutdown()
    }
    expect(await readFile(prepared.script_path)).toEqual(
      await readFile('resources/skills/docx-generation/scripts/convert.py')
    )
    expect(await readFile(prepared.reference_path)).toEqual(
      await readFile('resources/skills/docx-generation/assets/reference.docx')
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('projects the on-demand DOCX workflow and its executable assets together', async () => {
  const skill = (await new SkillRegistry(resolve('resources/skills')).list()).find(
    (entry) => entry.id === 'docx-generation'
  )!
  expect(skill).toBeDefined()
  expect(skill.activationPolicy).not.toBe('always-on')
  const root = await mkdtemp(join(tmpdir(), 'docx-skill-'))
  try {
    await new ClaudeCodeSkillMaterializer().sync(root, [skill])
    const projected = join(root, 'skills/os-docx-generation')
    expect(await readFile(join(projected, 'assets/reference.docx'))).toEqual(
      await readFile('resources/skills/docx-generation/assets/reference.docx')
    )
    // Execute the packaged script entry point, not an assertion about its source text.
    const python =
      process.env.OPEN_SCIENCE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
    expect(
      execFileSync(python, [join(projected, 'scripts/convert.py'), '--help'], { encoding: 'utf8' })
    ).toContain('--reference-doc')
  } finally {
    await new ClaudeCodeSkillMaterializer().sync(root, [])
    await rm(root, { recursive: true, force: true })
  }
})

it('runs the converter regression suite (Pandoc integration reports its own prerequisites)', () => {
  const python =
    process.env.OPEN_SCIENCE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  execFileSync(python, ['-m', 'unittest', 'discover', '-s', 'test/docx-generation', '-v'], {
    stdio: 'pipe'
  })
})
