import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeCodeSkillMaterializer } from './materializer'
import { SkillRegistry } from './registry'
import { loadSkillDocument } from './runtime-mcp-server'

const registry = new SkillRegistry(join(process.cwd(), 'resources', 'skills'))
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await new ClaudeCodeSkillMaterializer().sync(root, [], { directoryLayout: 'agent-facing' })
    await rm(root, { recursive: true, force: true })
  }
})

describe('bundled biomodel compute guidance', () => {
  it.each(['app-owned', 'agent-facing'] as const)(
    'projects usable compute guidance and resolvable Skill references through %s',
    async (directoryLayout) => {
      const root = await mkdtemp(join(tmpdir(), 'biomodel-guidance-'))
      roots.push(root)
      const skills = await registry.list()
      const names = new Set(skills.map((skill) => skill.name))
      const models = skills.filter((skill) => skill.category === 'biomodels')
      expect(models.length).toBeGreaterThan(0)
      expect(names.has('remote-compute-ssh')).toBe(true)
      expect(names.has('compute-env-setup')).toBe(true)
      await new ClaudeCodeSkillMaterializer().sync(root, skills, { directoryLayout })

      for (const skill of models) {
        const directory = directoryLayout === 'app-owned' ? `os-${skill.id}` : skill.name
        const doc = await readFile(join(root, 'skills', directory, 'SKILL.md'), 'utf8')
        expect(doc, skill.name).not.toContain('Compute environment unavailable in this app')
        expect(doc, skill.name).toContain('remote-compute-ssh')
        expect(doc, skill.name).toContain('compute-env-setup')
        for (const [, reference] of doc.matchAll(/`((?:remote-compute-|compute-env-)[a-z-]+)`/g)) {
          expect(names.has(reference!), `${skill.name} references ${reference}`).toBe(true)
        }
      }
    }
  )

  it.each(['scgpt', 'borzoi', 'evo2', 'fair-esm2'])(
    '%s keeps Python workloads separate from the JavaScript compute control plane',
    async (name) => {
      const doc = await registry.body(name)
      for (const [, python] of doc.matchAll(/```python\n([\s\S]*?)```/g)) {
        expect(python, name).not.toMatch(/\bhost\.compute\b/)
      }
      expect(doc).not.toContain('compute_details')
      expect(doc).not.toMatch(/\b(?:submit_job|dst_filename|timeout_seconds|attach_job)\b/)
      expect(doc).toContain('remote-compute-ssh')
    }
  )

  it('does not advertise a bundled Modal environment that the catalog cannot provide', async () => {
    expect(await registry.body('esmfold2')).not.toContain('The bundled `esmfold2_gpu` Modal env')
    for (const name of ['esmfold2', 'scgpt', 'scvi-tools']) {
      expect(await registry.body(name)).not.toContain('remote-compute-modal')
    }
  })
})

it('keeps shared guidance conditional on a restricted Specialist scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'biomodel-specialist-scope-'))
  roots.push(root)
  await new ClaudeCodeSkillMaterializer().sync(root, await registry.list(), {
    directoryLayout: 'agent-facing'
  })
  const environment = {
    root,
    skillsDirectory: join(root, 'skills'),
    allowedNames: new Set(['scgpt'])
  }
  const model = await loadSkillDocument(environment, 'scgpt')
  expect(model).toContain('References below do not expand the current Skill or tool scope')
  expect(model).toContain('ask the user to include it or hand off')
  for (const dependency of ['remote-compute-ssh', 'compute-env-setup']) {
    await expect(loadSkillDocument(environment, dependency)).rejects.toThrow('Unknown skill')
  }
})

it.each(['proteinmpnn', 'ligandmpnn', 'solublempnn'])(
  '%s retains its model-specific CPU instructions',
  async (name) => {
    expect(await registry.body(name)).toContain('run on CPU')
  }
)

it('keeps the scVI remote execution link aligned with its heading', async () => {
  const doc = await registry.body('scvi-tools')
  expect(doc).toContain('[Remote compute](#remote-compute)')
  expect(doc).toContain('## Remote compute\n')
  expect(doc).not.toContain('#remote-compute-rent-a-gpu')
})
