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
    for (const { fileName: spec } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
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
