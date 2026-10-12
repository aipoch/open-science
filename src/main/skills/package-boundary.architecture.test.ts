import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import ts from 'typescript'

it('keeps all application consumers on the four public Skill package exports', () => {
  const root = resolve(__dirname, '../../..')
  // Run the repository-wide TypeScript scanner outside Vitest's V8 coverage session.
  // The child performs the same checks; this test still fails on every reported violation.
  const output = execFileSync(process.execPath, ['scripts/check-skill-package-boundary.mjs'], {
    cwd: root,
    encoding: 'utf8'
  })
  expect(JSON.parse(output)).toEqual([])
})

it('reports private, relative and escaped imports and host forwarding from the scanner process', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-boundary-')))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/valid.ts'), "import '@aipoch/skills/document'")
    writeFileSync(join(root, 'src/private.ts'), "import '@aipoch/skills/src/private.js'")
    writeFileSync(join(root, 'src/relative.ts'), "import '../packages/skills/src/private.js'")
    writeFileSync(join(root, 'src/escaped.ts'), String.raw`import '@aipoch/\u0073kills/internal'`)
    writeFileSync(join(root, 'src/forward.ts'), "export { value } from '@aipoch/skills'")
    const output = execFileSync(
      process.execPath,
      [resolve(__dirname, '../../../scripts/check-skill-package-boundary.mjs')],
      { cwd: root, encoding: 'utf8' }
    )
    expect(JSON.parse(output).sort()).toEqual(
      [
        `${join(root, 'src/private.ts')}: @aipoch/skills/src/private.js`,
        `${join(root, 'src/relative.ts')}: relative package bypass ../packages/skills/src/private.js`,
        `${join(root, 'src/escaped.ts')}: @aipoch/skills/internal`,
        `${join(root, 'src/forward.ts')}: import package APIs directly instead of forwarding through the host`
      ].sort()
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps generic host networking independent from feature package types', () => {
  for (const name of ['network-fetch.ts', 'network-fetch-electron.ts']) {
    const file = resolve(__dirname, '..', name)
    for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
      expect(fileName, name).not.toMatch(/@aipoch\/skills|\/skills\//)
    }
  }
})

it('excludes unchanged upstream Skill units for host edits while preserving conservative fallback', async () => {
  // @ts-expect-error The repository-owned CI selector is an untyped JavaScript test utility.
  const { createPackageTestPlan } = await import('../../../scripts/ci/package-test-impact.mjs')
  const root = resolve(__dirname, '../../..')
  const registry = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/package-test-boundaries.json'), 'utf8')
  )
  for (const path of [
    'src/main/skills/host-skills-service.ts',
    'src/main/skill-marketplace/service.ts',
    'src/main/skill-marketplace/installation.ts',
    'src/renderer/src/pages/settings/SkillEditor.tsx'
  ]) {
    const plan = createPackageTestPlan([path], registry)
    expect(plan.selected).not.toContain('packages/skills')
    expect(plan.excluded).toContain('packages/skills')
  }
  expect(
    createPackageTestPlan(['packages/skills/src/skill-authoring-service.ts'], registry).selected
  ).toEqual(['packages/skills'])
  for (const path of ['package-lock.json', 'unknown-input']) {
    expect(createPackageTestPlan([path], registry).selected).toContain('packages/skills')
  }
  const module = JSON.parse(
    readFileSync(resolve(root, 'scripts/ci/module-impact/skill_package.json'), 'utf8')
  )
  expect(module.testFiles.consumer).toContain('src/main/skills/host-skills-service.test.ts')
  expect([...module.testFiles.contract, ...module.testFiles.consumer]).toContain(
    'src/main/skills/catalog.test.ts'
  )
})
