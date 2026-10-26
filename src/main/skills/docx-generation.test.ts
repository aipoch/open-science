import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SkillRegistry } from '@aipoch/skills'
import { ClaudeCodeSkillMaterializer } from './materializer'

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
