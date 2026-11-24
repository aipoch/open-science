import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { runtimeModuleSpecifiers } from '../../../../../test/module-boundary-assertions'
import type {
  ClassifiedFailure,
  FailureCategory,
  FailureReason
} from '../../../../shared/failure/contract'
import {
  formatNoticeDiagnostics,
  noticeCatalog,
  noticePresentation,
  reasonCatalog,
  type NoticeActionId
} from '@/components/notices/composer-notice-catalog'

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
  ).toEqual({
    details: `Optimize question\n${description}\nrequestId: request-id`,
    fullText: `Optimize question\n${description}\nrequestId: request-id`
  })
})

it('shows only the recorded code when the request has no diagnostic body', () => {
  const failure: ClassifiedFailure = { category: 'internal', diagnostics: { code: '-32603' } }
  expect(
    formatNoticeDiagnostics(
      { id: 'failure', source: 'turn', occurredAt: 0, failure },
      'Request failed',
      ''
    ).details
  ).toBe('code: -32603')
})

it('keeps protocol metadata when the turn error is used as fallback detail', () => {
  const failure: ClassifiedFailure = {
    category: 'configuration',
    reason: 'configuration/model-unavailable',
    diagnostics: {
      status: 400,
      protocol: 'chat-completions',
      requestId: 'request-id',
      providerExcerpt: 'Provider rejected the request',
      raw: 'Provider HTTP 400'
    }
  }
  const details = formatNoticeDiagnostics(
    { id: 'failure', source: 'turn', occurredAt: 0, failure },
    'Model configuration needs attention',
    'The selected model is unavailable. Select another model in Settings.'
  ).details
  expect(details).toContain('status: 400\n')
  expect(details).toContain('protocol: chat-completions\n')
  expect(details).toContain('requestId: request-id')
})

it('keeps an actionable title and body for an explicit provider status', () => {
  const body = JSON.stringify({
    error: {
      type: 'upstream_error',
      message: 'Insufficient Balance (request_id: request-402)',
      status: 402
    }
  })
  const failure: ClassifiedFailure = {
    category: 'configuration',
    reason: 'configuration/billing',
    responseMessage: 'Insufficient Balance (request_id: request-402)',
    diagnostics: { status: 402, raw: body }
  }
  expect(noticePresentation(failure).titleKey).toBe('Model provider quota needs attention')
  expect(
    formatNoticeDiagnostics(
      { id: 'failure', source: 'turn', occurredAt: 0, failure },
      'Model provider quota needs attention',
      'Check the model provider plan, quota or account balance, then retry.'
    ).details
  ).toContain(body)
})

it.each<[ClassifiedFailure, string]>([
  [
    {
      category: 'internal',
      reason: 'internal/reconfigure',
      diagnostics: { raw: 'Internal error: adapter reconfiguration failed' }
    },
    'Internal error: adapter reconfiguration failed'
  ],
  [
    {
      category: 'service',
      reason: 'service/connection-failed',
      diagnostics: { raw: 'Internal error: API Error: Unable to connect to API (ECONNREFUSED)' }
    },
    'Info: API Error: Unable to connect to API (ECONNREFUSED)'
  ],
  [
    {
      category: 'service',
      diagnostics: {
        status: 400,
        protocol: 'responses',
        providerExcerpt: 'Maximum call stack size exceeded'
      }
    },
    'status: 400\nprotocol: responses\nInfo: Maximum call stack size exceeded'
  ]
])('shows the recorded diagnostic for %j', (failure, expected) => {
  expect(
    formatNoticeDiagnostics({ id: 'failure', source: 'turn', occurredAt: 0, failure }, 'Title', '')
      .fullText
  ).toBe('Title\n' + expected)
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
      'src/renderer/src/components/notices/ComposerNoticeSlot.tsx',
      'src/renderer/src/components/notices/composer-notice-catalog.ts',
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
      read(join(root, 'src/renderer/src/components/notices/ComposerNoticeSlot.tsx'))
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

it('explains a reported stack overflow and offers a diagnostic export', () => {
  const presentation = noticePresentation({
    category: 'internal',
    reason: 'internal/model-request-stack-overflow',
    diagnostics: {}
  })
  expect(presentation.titleKey).toBe('Call stack limit reached during a model request')
  expect(presentation.secondaryActions).toContain('export-diagnostics')
})

it('offers diagnostics and a fresh conversation for unknown effects, never a blind retry', () => {
  const presentation = noticePresentation({
    category: 'session',
    reason: 'session/tool-outcome-unknown',
    diagnostics: {}
  })
  expect(presentation.primaryAction).toBe('export-diagnostics')
  expect(presentation.secondaryActions).toEqual(['new-session'])
  expect(presentation.descriptionKey).toContain('verified state')
})

it.each<[FailureReason, NoticeActionId, readonly NoticeActionId[]]>([
  ['configuration/model-unavailable', 'open-provider-settings', ['retry']],
  ['configuration/endpoint-invalid', 'open-provider-settings', ['retry']],
  ['configuration/auth-failed', 'open-provider-settings', ['retry']],
  ['configuration/billing', 'open-provider-settings', ['retry']],
  ['configuration/request-invalid', 'open-provider-settings', ['retry']],
  ['service/rate-limited', 'retry', []],
  ['service/unavailable', 'retry', []],
  ['service/connection-failed', 'retry', ['open-provider-settings']],
  ['service/response-interrupted', 'retry', []],
  ['service/response-invalid', 'retry', ['open-provider-settings']],
  ['service/provider-error', 'retry', ['open-provider-settings']],
  ['input/context-overflow', 'compact', ['remove-attachments']]
])('offers the recovery actions for %s', (reason, primaryAction, secondaryActions) => {
  expect(
    noticePresentation({
      category: reason.split('/')[0] as FailureCategory,
      reason,
      diagnostics: {}
    })
  ).toMatchObject({ primaryAction, secondaryActions })
})

it('explains missing image support without suggesting credential failures', () => {
  expect(
    noticePresentation({
      category: 'configuration',
      reason: 'configuration/vision-model',
      diagnostics: {}
    })
  ).toEqual({
    level: 'warning',
    titleKey: 'Image support is not configured',
    descriptionKey:
      "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support.",
    primaryAction: 'open-provider-settings',
    secondaryActions: [],
    feedback: 'none'
  })
})
