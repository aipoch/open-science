/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript guard. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export function inspectSkillPackageBoundary(root = process.cwd()) {
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
  const violations = []
  for (const file of new Set(files)) {
    if (!relative(packageRoot, file).startsWith('..')) continue
    const source = readFileSync(file, 'utf8')
    // Every plain specifier reaching this package contains its directory name. Escapes can
    // spell that name indirectly, so retain the scanner for those files as well.
    if (!source.includes('skills') && !source.includes('\\')) continue
    const imports = ts.preProcessFile(source, true, true).importedFiles
    if (
      imports.some(({ fileName }) => fileName.startsWith('@aipoch/skills')) &&
      !relative(resolve(root, 'src'), file).startsWith('..')
    ) {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      for (const statement of ast.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
        if (/^@aipoch\/skills(?:\/|$)/.test(statement.moduleSpecifier.text))
          violations.push(
            `${file}: import package APIs directly instead of forwarding through the host`
          )
      }
    }
    for (const { fileName: spec } of imports) {
      if (spec.startsWith('@aipoch/skills') && !allowed.has(spec))
        violations.push(`${file}: ${spec}`)
      if (spec.startsWith('.') || isAbsolute(spec)) {
        const target = resolve(dirname(file), spec)
        if (!relative(packageRoot, target).startsWith('..'))
          violations.push(`${file}: relative package bypass ${spec}`)
      }
    }
  }
  // Report the complete scan once instead of constructing assertions for every repository import.
  return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(inspectSkillPackageBoundary()))
}
