import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { runtimeModuleSpecifiers } from '../../../../../test/module-boundary-assertions'
import type { FailureCategory, FailureReason } from '../../../../shared/failure/contract'
import {
  formatNoticeDiagnostics,
  readableNoticeDetails,
  noticeCatalog,
  noticePresentation,
  reasonCatalog
} from './catalog'

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

it('does not repeat the displayed description when an operation uses it as its raw diagnostic', () => {
  const description = 'Could not optimize your question. Your draft was kept. Please try again.'
  expect(
    formatNoticeDiagnostics(
      {
        id: 'optimization',
        source: 'operation',
        occurredAt: 0,
        failure: {
          category: 'service',
          diagnostics: { raw: description, requestId: 'request-id' }
        }
      },
      'Optimize question',
      description
    )
  ).toBe(`Optimize question\n${description}\nrequestId: request-id`)
})

describe('composer notice boundaries', () => {
  it('has one classifier importing recognizers; projections and renderer consume its public contract', () => {
    const offenders: string[] = []
    for (const path of sources(join(root, 'src'))) {
      const source = read(path)
      // Parse possible violations (including escaped specifiers), not every application module.
      if (
        !path.startsWith(join(failureRoot, 'recognizers')) &&
        !/recognizers|run-error-classification|media-overflow|\\/.test(source)
      )
        continue
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

it('offers uncertain-tool Retry only through an owner-provided capability', () => {
  const presentation = noticePresentation({
    category: 'session',
    reason: 'session/tool-outcome-unknown',
    diagnostics: {}
  })
  expect(presentation.primaryAction).toBe('retry')
  expect(presentation.secondaryActions).toEqual(['new-session'])
  const panel = read(join(root, 'src/renderer/src/pages/workspace/ConversationPanel.tsx'))
  expect(panel).toContain(
    "'retry' in conversation.actions && typeof conversation.actions.retry === 'function'"
  )
})

it.each([
  [
    { category: 'internal', diagnostics: { code: '-32603' } },
    "Couldn't complete your request",
    'Please try again.'
  ],
  [
    { category: 'internal', diagnostics: { code: 'internalServerError' } },
    "Couldn't complete your request",
    'Please try again.'
  ],
  [
    {
      category: 'service',
      reason: 'service/unavailable',
      responseMessage: 'API Error: 503',
      diagnostics: {}
    },
    "The model service couldn't respond",
    'Try again in a moment.'
  ],
  [
    { category: 'service', reason: 'service/connection-failed', diagnostics: {} },
    "Couldn't connect to the model service",
    'Check your connection, then try again.'
  ],
  [
    { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} },
    'Model authentication failed',
    'Check your sign-in or credentials in Settings, then retry.'
  ],
  [
    {
      category: 'input',
      reason: 'input/media-invalid',
      diagnostics: {
        raw: 'This conversation needs image replay, but the selected model does not support image input.'
      }
    },
    "This model can't read images",
    'Choose a model that supports images, then retry.'
  ],
  [
    {
      category: 'environment',
      reason: 'environment/runtime-unavailable',
      diagnostics: { raw: 'Notebook kernel failed to start' }
    },
    "Notebook couldn't start",
    'Check the Notebook setup in Settings, then retry.'
  ],
  [
    { category: 'session', reason: 'session/tool-outcome-unknown', diagnostics: {} },
    'An operation needs checking',
    'Check the affected file or service before repeating the operation.'
  ]
] as const)(
  'selects reviewed copy from actual classified fields: %s',
  (failure, title, description) => {
    const presentation = noticePresentation(failure)
    expect(presentation.titleKey).toBe(title)
    expect(presentation.descriptionKey).toBe(description)
  }
)

it('requires specific evidence for image, Notebook and completed-publication claims', () => {
  expect(
    noticePresentation({
      category: 'input',
      reason: 'input/media-invalid',
      diagnostics: { raw: 'The attached image is invalid.' }
    }).titleKey
  ).toBe('The message needs adjustment')
  expect(
    noticePresentation({
      category: 'environment',
      reason: 'environment/runtime-unavailable',
      diagnostics: { raw: 'WSL is unavailable' }
    }).titleKey
  ).toBe('The local environment needs attention')
  const failure = {
    category: 'environment' as const,
    reason: 'environment/filesystem' as const,
    diagnostics: {}
  }
  expect(noticePresentation(failure).titleKey).toBe('The local environment needs attention')
  expect(noticePresentation(failure, { recovery: 'retry-artifact-publication' }).titleKey).toBe(
    "Couldn't save the results"
  )
})

it.each([
  '{"error":"secret payload"}',
  '["secret payload"]',
  'API Error: 503 {"error":"secret payload"}',
  'Error: {"error":"secret payload"}',
  'Traceback (most recent call last):',
  'Stack trace: secret',
  'at secret (/private/path.js:10)'
])('keeps serialized payloads and stacks out of readable details (%s)', (raw) => {
  const details = readableNoticeDetails(
    {
      id: 'detail',
      source: 'turn',
      occurredAt: 0,
      failure: { category: 'internal', diagnostics: { raw, requestId: 'secret-id' } }
    },
    'Title',
    'Description'
  )
  const text = JSON.stringify(details)
  expect(text).not.toContain('secret')
  expect(text).not.toContain('payload')
  expect(text).not.toContain('requestId')
})

it('deduplicates actual fields and omits first-layer copy from readable diagnostics', () => {
  const details = readableNoticeDetails(
    {
      id: 'detail',
      source: 'turn',
      occurredAt: 0,
      failure: {
        category: 'internal',
        responseMessage: 'Description',
        diagnostics: { raw: 'Other wrapper', model: 'model', provider: 'model', code: 'Title' }
      }
    },
    'Title',
    'Description'
  )
  expect(details).toEqual([{ label: 'Model', value: 'model' }])
})

it.each(['', 'Internal error: '])(
  'keeps production uncertain-tool names without their invocation identities (%s)',
  (prefix) => {
    const raw =
      prefix +
      'Built-in Agent tool outcome is unknown: repl_execute (provider/attempt/call-17), read_file (0a3fba01-a781-4654-907a-3cd49bad51e9)'
    const notice = {
      id: 'tool',
      source: 'turn' as const,
      occurredAt: 1,
      failure: {
        category: 'session' as const,
        reason: 'session/tool-outcome-unknown' as const,
        diagnostics: { raw }
      }
    }
    expect(readableNoticeDetails(notice, 'Title', 'Description')).toEqual([
      {
        label: 'Error',
        value: prefix + 'Built-in Agent tool outcome is unknown: repl_execute, read_file'
      }
    ])
    expect(formatNoticeDiagnostics(notice, 'Title', 'Description')).toContain(raw)
  }
)

it.each([
  undefined,
  { recoveryState: 'ready' as const },
  { recoveryState: 'retry-failed' as const },
  { recovery: 'retry-artifact-publication' as const }
])('preserves provider-response report suppression through recovery presentation (%s)', (owner) => {
  const failure = {
    category: 'configuration' as const,
    reason: 'configuration/auth-failed' as const,
    responseMessage: 'Provider authentication diagnostic',
    diagnostics: {}
  }
  expect(noticePresentation(failure, owner).feedback).toBe('none')
})
