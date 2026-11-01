import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { runtimeModuleSpecifiers } from '../../../../../test/module-boundary-assertions'
import type { FailureCategory, FailureReason } from '../../../../shared/failure/contract'
import { noticeCatalog, noticePresentation, reasonCatalog } from './catalog'

const root = resolve(__dirname, '../../../../..')
const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sources(path)
      : /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path)
        ? [path]
        : []
  })
const read = (path: string): string => readFileSync(path, 'utf8')
const failureRoot = join(root, 'src/shared/failure')
const contract = ts.createSourceFile(
  'contract.ts',
  read(join(failureRoot, 'contract.ts')),
  ts.ScriptTarget.Latest,
  true
)
const categories: string[] = []
for (const statement of contract.statements) {
  if (
    ts.isTypeAliasDeclaration(statement) &&
    statement.name.text === 'FailureCategory' &&
    ts.isUnionTypeNode(statement.type)
  ) {
    for (const member of statement.type.types)
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
        categories.push(member.literal.text)
  }
}

describe('composer notice boundaries', () => {
  it('has one classifier importing recognizers; projections and renderer consume its public contract', () => {
    const offenders: string[] = []
    for (const path of sources(join(root, 'src'))) {
      const source = read(path)
      // Parse possible violations (including escaped specifiers), not every application module.
      if (!/recognizers|run-error-classification|media-overflow|\\/.test(source)) continue
      for (const specifier of runtimeModuleSpecifiers(source)) {
        const target = specifier.startsWith('.')
          ? resolve(dirname(path), specifier)
          : specifier.startsWith('@/')
            ? resolve(root, 'src/renderer/src', specifier.slice(2))
            : specifier
        if (
          target.startsWith(join(failureRoot, 'recognizers')) &&
          path !== join(failureRoot, 'classify.ts')
        )
          offenders.push(relative(root, path))
        if (/run-error-classification|media-overflow/.test(specifier))
          offenders.push(relative(root, path))
      }
    }
    expect(offenders).toEqual([])
    expect(
      runtimeModuleSpecifiers(read(join(root, 'src/shared/runtime-session-projection.ts'))).some(
        (name) => name.includes('failure/classify')
      )
    ).toBe(false)
  })

  it('keeps failure matching out of the composer and renderer event consumers', () => {
    const paths = [
      'src/renderer/src/pages/workspace/ConversationPanel.tsx',
      'src/renderer/src/components/composer-notice/ComposerNoticeSlot.tsx',
      'src/renderer/src/lib/composer-notice/catalog.ts',
      'src/renderer/src/lib/composer-notice/use-composer-notices.ts',
      'src/renderer/src/lib/acp/workspace-events.ts',
      'src/renderer/src/lib/acp/workspace-runtime-session-lifecycle-owner.ts',
      'src/renderer/src/lib/acp/workspace-runtime-prompt-preparation-owner.ts'
    ]
    for (const path of paths) {
      const source = read(join(root, path))
      expect(source, path).not.toMatch(
        /\.(?:test|match|search)\(\s*(?:error|message|event\.(?:text|title))\b/
      )
      expect(source, path).not.toContain('/recognizers/')
    }
  })

  it('routes composer failure rendering through one slot and keeps the app environment banner separate', () => {
    const panel = read(join(root, 'src/renderer/src/pages/workspace/ConversationPanel.tsx'))
    expect(panel.match(/<ComposerNoticeSlot\b/g)).toHaveLength(1)
    expect(panel).not.toMatch(
      /import.*ErrorNotice|<ErrorNotice\b|<SessionInterruptedBanner\b|<TurnOutcomeNotice\b|<EnvStatusBanner\b/
    )
    expect(
      read(join(root, 'src/renderer/src/components/composer-notice/ComposerNoticeSlot.tsx'))
    ).toContain('<Notice')
  })

  it('covers every contract category and recognized reason with translated category fallback', () => {
    expect(Object.keys(noticeCatalog).sort()).toEqual(categories.sort())
    const reasons = new Set<string>(Object.keys(reasonCatalog))
    for (const path of sources(join(failureRoot, 'recognizers'))) {
      const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (
          ts.isStringLiteralLike(node) &&
          categories.some((category) => node.text.startsWith(`${category}/`))
        )
          reasons.add(node.text)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    const presentations = [
      ...Object.values(noticeCatalog),
      ...[...reasons].map((reason) =>
        noticePresentation({
          category: reason.split('/')[0] as FailureCategory,
          reason: reason as FailureReason,
          diagnostics: {}
        })
      )
    ]
    for (const entry of readdirSync(join(root, 'src/shared/i18n/locales'))) {
      if (!entry.endsWith('.json')) continue
      const locale = JSON.parse(read(join(root, 'src/shared/i18n/locales', entry))).renderer
      for (const presentation of presentations) {
        expect(locale[presentation.titleKey], `${entry}: ${presentation.titleKey}`).toBeTruthy()
        expect(
          locale[presentation.descriptionKey],
          `${entry}: ${presentation.descriptionKey}`
        ).toBeTruthy()
      }
    }
    expect(
      noticePresentation({ category: 'service', reason: 'service/future-reason', diagnostics: {} })
    ).toBe(noticeCatalog.service)
  })
})
