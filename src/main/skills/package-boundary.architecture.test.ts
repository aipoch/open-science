import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute } from 'node:path'
import { expect, it } from 'vitest'
import ts from 'typescript'

it('keeps all application consumers on the four public Skill package exports', () => {
  const root = resolve(__dirname, '../../..')
  const packageRoot = resolve(root, 'packages/skills')
  const allowed = new Set([
    '@aipoch/skills',
    '@aipoch/skills/document',
    '@aipoch/skills/sources',
    '@aipoch/skills/projection'
  ])
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }
  )
    .split('\0')
    .filter(
      (file) => /^(src|test|e2e|scripts|packages)\//.test(file) && /\.[cm]?[jt]sx?$/.test(file)
    )
    .map((file) => resolve(root, file))
    .filter(existsSync)
  for (const file of new Set(files)) {
    if (!relative(packageRoot, file).startsWith('..')) continue
    const source = readFileSync(file, 'utf8')
    const imports = ts.preProcessFile(source, true, true).importedFiles
    if (
      imports.some(({ fileName }) => fileName.startsWith('@aipoch/skills')) &&
      !relative(resolve(root, 'src'), file).startsWith('..')
    ) {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      for (const statement of ast.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
        expect(
          statement.moduleSpecifier.text,
          `${file}: import package APIs directly instead of forwarding through the host`
        ).not.toMatch(/^@aipoch\/skills(?:\/|$)/)
      }
    }
    for (const { fileName: spec } of imports) {
      if (spec.startsWith('@aipoch/skills'))
        expect(allowed.has(spec), `${file}: ${spec}`).toBe(true)
      if (spec.startsWith('.') || isAbsolute(spec)) {
        const target = resolve(dirname(file), spec)
        expect(
          relative(packageRoot, target).startsWith('..'),
          `${file}: relative package bypass ${spec}`
        ).toBe(true)
      }
    }
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
