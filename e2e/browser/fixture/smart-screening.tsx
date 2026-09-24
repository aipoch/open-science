import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { LiteratureLibraryPage } from '@/pages/literature/LiteratureLibraryPage'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import {
  literatureItemInputSchema,
  type LiteratureCatalogCommand,
  type LiteratureChangedEvent
} from '../../../src/shared/literature'
import type {
  SmartCollectionView,
  SmartRunProgress,
  SmartRunProgressRow
} from '../../../src/shared/literature-smart-collections'

const parameters = new URLSearchParams(location.search)
const chinese = parameters.get('lang') === 'zh-Hans'
const requestedRate = Number(parameters.get('rate') ?? 8)
const demoRate = Number.isFinite(requestedRate) ? Math.min(40, Math.max(1, requestedRate)) : 8
const requestedSize = Number(parameters.get('size') ?? 16)
const demoSize = Number.isFinite(requestedSize)
  ? Math.min(1000, Math.max(16, Math.floor(requestedSize)))
  : 16
const listeners = new Set<(event: LiteratureChangedEvent) => void>()
let eventRevision = 0
const emit = (): void => {
  eventRevision++
  listeners.forEach((listener) =>
    listener({ revision: eventRevision, collectionIds: ['screening'] })
  )
}
const titles = [
  'Deep learning for pulmonary nodule detection in low-dose chest CT',
  'Prospective validation of AI-assisted lung cancer screening',
  'Diagnostic performance of chest radiography in primary care',
  'Radiologist and AI collaboration in early lung cancer diagnosis',
  'Longitudinal assessment of pulmonary nodule growth on CT',
  'A review of machine learning in thoracic imaging',
  'Reducing false positives in population-based lung screening',
  'External validation across eight community hospitals',
  'Patient perspectives on automated imaging reports',
  'Clinical outcomes after AI-assisted detection of small nodules',
  'Multimodal risk prediction from CT and clinical history',
  'AI triage for emergency chest imaging',
  'Robust detection under low-radiation imaging protocols',
  'A randomized evaluation of AI-assisted screening workflows',
  'Model calibration in diverse lung screening populations',
  'Reader agreement in computer-assisted nodule assessment'
]
const papers = Array.from({ length: demoSize }, (_, i): SmartRunProgressRow => ({
  id: `paper-${i}`,
  title: titles[i % titles.length],
  state: 'pending',
  ...(parameters.has('overrides') && i % 3 !== 0
    ? { override: i % 3 === 1 ? 'include' : 'exclude' }
    : {})
}))
let runNumber = 0
let progress: SmartRunProgress = {
  runId: 'fixture-run',
  state: 'running',
  total: papers.length,
  done: 0,
  counts: { match: 0, review: 0, noMatch: 0, pending: papers.length, error: 0, unavailable: 0 },
  candidates: papers.slice(0, 4),
  outcomes: []
}
const collection = {
  id: 'screening',
  name: chinese ? '肺癌筛查中的 AI' : 'AI in lung cancer screening',
  revision: 1,
  description: JSON.stringify({
    description: '',
    inclusion: 'Clinical studies of AI-assisted lung cancer screening using low-dose CT.',
    exclusion: 'Reviews and non-clinical studies.'
  }),
  smart: true,
  itemCount: 0,
  createdAt: 1,
  updatedAt: 1
}
const summary = (): SmartCollectionView => ({
  scope: { kind: 'library' },
  sourceAvailable: true,
  configured: true,
  sourceName: '',
  total: papers.length,
  matches: progress.counts.match,
  pending: progress.counts.pending,
  counts: {
    match: progress.counts.match,
    review: progress.counts.review,
    'no-match': progress.counts.noMatch,
    pending: progress.counts.pending
  },
  overrides: 0,
  rows: [],
  run: {
    id: progress.runId,
    kind: 'refresh',
    state: progress.state,
    total: papers.length,
    done: progress.done,
    inputTokens: progress.done * 420,
    outputTokens: progress.done * 18,
    usageIncomplete: false,
    updatedAt: progress.done + 1
  }
})
const commands: LiteratureCatalogCommand[] = []
function advance(count = 1): void {
  for (let i = 0; i < count && progress.done < papers.length && progress.state === 'running'; i++) {
    const index = progress.done
    const distribution = parameters.get('distribution')
    const verdict =
      distribution === 'no-match'
        ? 'no-match'
        : distribution === 'all'
          ? (['match', 'no-match', 'uncertain', undefined] as const)[index % 4]
          : index % 5 === 2
            ? 'no-match'
            : index % 5 === 4
              ? 'uncertain'
              : 'match'
    const outcome: SmartRunProgressRow = {
      ...papers[index],
      state: verdict ? 'done' : 'error',
      ...(verdict ? { verdict } : {}),
      evaluatedAt: Date.now()
    }
    const counts = { ...progress.counts, pending: progress.counts.pending - 1 }
    counts[
      !verdict
        ? 'error'
        : verdict === 'match'
          ? 'match'
          : verdict === 'uncertain'
            ? 'review'
            : 'noMatch'
    ]++
    const groupSizes = new Map<string, number>()
    progress = {
      ...progress,
      done: index + 1,
      counts,
      candidates: papers.slice(index + 1, index + 5),
      outcomes: [outcome, ...progress.outcomes].filter((row) => {
        const group = row.verdict ?? 'unavailable'
        const count = (groupSizes.get(group) ?? 0) + 1
        groupSizes.set(group, count)
        return count <= 6
      })
    }
  }
  if (progress.done === papers.length) progress.state = 'completed'
  emit()
}
Object.assign(window, { screeningFixture: { advance, commands } })
window.api = {
  platform: 'darwin',
  literature: {
    onChanged: (listener: (event: LiteratureChangedEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    search: async (request: { scope: string }) => ({
      entries:
        request.scope === 'collections'
          ? [{ ...collection, itemCount: progress.counts.match }]
          : request.scope === 'library'
            ? progress.outcomes
                .filter((row) => row.verdict === 'match')
                .map((row) => ({
                  id: row.id,
                  item: literatureItemInputSchema.parse({
                    itemType: 'journalArticle',
                    title: row.title
                  }),
                  createdAt: 1,
                  updatedAt: 1,
                  metadataRevision: 1,
                  attachments: [],
                  tags: [],
                  projects: [],
                  collections: [],
                  smartDecision: {
                    id: row.id,
                    title: row.title,
                    verdict: 'match',
                    decisionSource: 'ai'
                  }
                }))
            : [],
      totalCount: progress.counts.match
    }),
    transact: async (command: LiteratureCatalogCommand) => {
      commands.push(command)
      if (command.kind === 'read-smart-run-progress')
        return {
          kind: 'collection',
          id: collection.id,
          smartRunProgress: structuredClone(progress)
        }
      if (
        command.kind === 'smart-collection' &&
        (command.action === 'refresh' || command.action === 'recompute')
      ) {
        const delay = Number(parameters.get('startDelay') ?? 0)
        if (Number.isFinite(delay) && delay > 0)
          await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 5000)))
        progress = {
          runId: `fixture-run-${++runNumber}`,
          state: 'running',
          total: papers.length,
          done: 0,
          counts: {
            match: 0,
            review: 0,
            noMatch: 0,
            pending: papers.length,
            error: 0,
            unavailable: 0
          },
          candidates: papers.slice(0, 4),
          outcomes: []
        }
        emit()
      }
      if (command.kind === 'smart-collection' && command.action === 'resume') {
        progress.state = 'running'
        emit()
      }
      if (command.kind === 'smart-collection' && command.action === 'cancel') {
        progress.state = 'cancelled'
        emit()
      }
      return { kind: 'collection', id: collection.id, smart: summary() }
    },
    jobs: async () => ({ jobs: [], summaries: [] }),
    citationStyles: async () => ({ styles: [] })
  },
  tags: {
    snapshot: async () => ({ revision: 1, tags: [], assignments: [] }),
    onChanged: () => () => {}
  }
} as unknown as typeof window.api
useNavigationStore.setState({ view: 'library', pendingLiteratureCollectionId: collection.id })
useProjectStore.setState({ projects: [], isLoaded: true })
useTagStore.setState({ status: 'ready', revision: 1, tags: [], assignments: [] })
let timer: ReturnType<typeof setInterval> | undefined
const demoTick = (): void => {
  if (progress.state !== 'running') return
  if (document.querySelector('[data-slot="smart-screening-process"]')) advance()
}
if (parameters.has('autoplay')) {
  timer = setInterval(demoTick, 1000 / demoRate)
}
void Promise.resolve(prepareI18nLocale(chinese ? 'zh-Hans' : 'en')).then(() => {
  initI18n(chinese ? 'zh-Hans' : 'en')
  createRoot(document.getElementById('root')!).render(
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1">
        <LiteratureLibraryPage />
      </div>
      <div className="relative z-50 flex shrink-0 flex-wrap items-center gap-4 border-t bg-background p-3 text-xs text-muted-foreground">
        <span>
          {chinese
            ? `模拟筛选演示 · 每秒 ${demoRate} 篇 · 不调用模型`
            : `Synthetic screening fixture · ${demoRate} papers/s · no model calls`}
        </span>
        <button onClick={() => advance()}>{chinese ? '完成下一篇' : 'Complete next paper'}</button>
        <button onClick={() => advance(papers.length)}>
          {chinese ? '完成剩余论文' : 'Complete remaining papers'}
        </button>
        <button
          onClick={() => {
            if (timer) {
              clearInterval(timer)
              timer = undefined
            } else timer = setInterval(demoTick, 1000 / demoRate)
          }}
        >
          {chinese ? '播放 / 暂停自动演示' : 'Toggle automatic demo'}
        </button>
      </div>
    </div>
  )
})
