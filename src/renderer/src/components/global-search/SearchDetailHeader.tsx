import { useTranslation } from 'react-i18next'
import {
  BookOpenText,
  ChevronLeft,
  File,
  Folder,
  MessageCircle,
  PanelRightClose,
  Upload
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDateTime, formatRelativeTime } from '@/lib/format-datetime'
import { resolveLocaleFromTags } from '../../../../shared/locale'
import { formatBytes } from '../../../../shared/update'
import type { Project } from '../../../../shared/projects'
import {
  resultTitle,
  messageTitle,
  fileFormatLabel,
  type SearchResult,
  type SearchSession
} from './search-result'

const icons = {
  messages: MessageCircle,
  sessions: MessageCircle,
  projects: Folder,
  uploads: Upload,
  generated: File,
  library: BookOpenText
}

type Props = {
  result: SearchResult
  projects: Project[]
  sessions: SearchSession[]
  fileCount?: number
  fileCountUnavailable: boolean
  onCollapse: () => void
}

export const SearchDetailHeader = ({
  result,
  projects,
  sessions,
  fileCount,
  fileCountUnavailable,
  onCollapse
}: Props): React.JSX.Element => {
  const { t, i18n } = useTranslation()
  const locale = resolveLocaleFromTags([i18n.resolvedLanguage ?? i18n.language])
  const Icon = result.kind === 'library' && !('item' in result.item) ? Folder : icons[result.kind]
  const title =
    result.kind === 'messages'
      ? messageTitle(result.item) || t('Matched message')
      : resultTitle(result)
  const projectIds =
    result.kind === 'library' && 'item' in result.item
      ? result.item.projectIds
      : 'projectId' in result.item
        ? [result.item.projectId]
        : []
  const linkedProjects = projects.filter((project) => projectIds.includes(project.id))
  const sessionItem = 'sessionId' in result.item ? result.item : undefined
  const session =
    result.kind === 'sessions'
      ? result.item
      : sessionItem
        ? sessions.find(
            (session) =>
              session.id === sessionItem.sessionId && session.projectId === sessionItem.projectId
          )
        : undefined
  const sessionLabel =
    result.kind === 'messages'
      ? `#${result.item.sessionNumber} ${result.item.sessionTitle}`
      : session
        ? `#${session.number}${result.kind === 'sessions' ? '' : ` ${session.title}`}`
        : result.kind === 'uploads' || result.kind === 'generated'
          ? result.item.originSession?.title
          : undefined
  const fileCountLabel = fileCountUnavailable
    ? t('Some results are unavailable.')
    : fileCount === undefined
      ? t('Loading…')
      : t('{{count}} files', { count: fileCount, defaultValue_one: '{{count}} file' })
  const paper = result.kind === 'library' && 'item' in result.item ? result.item.item : undefined
  const bibliography = paper
    ? [
        paper.creators
          .map((creator) =>
            creator.nameMode === 'organization'
              ? creator.literalName
              : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
          )
          .join(', '),
        paper.issuedText || paper.issuedYear,
        paper.containerTitle
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined

  return (
    <header className="search-detail-header">
      <button
        type="button"
        className="search-detail-back focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onCollapse}
      >
        <ChevronLeft aria-hidden="true" />
        {t('Back to results')}
      </button>
      <div className="search-detail-title-row">
        <Icon className="search-detail-kind-icon" aria-hidden="true" />
        <h3 className="search-detail-title" title={title}>
          {title}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="search-detail-collapse size-[26px] shrink-0 text-action-panel-toggle"
          aria-label={t('Collapse details')}
          title={t('Collapse details')}
          onClick={onCollapse}
        >
          <PanelRightClose className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="search-detail-context">
        {result.kind === 'projects' ? (
          <>
            <span>
              {t('{{count}} sessions', {
                count: sessions.filter((session) => session.projectId === result.item.id).length,
                defaultValue_one: '{{count}} session'
              })}
            </span>
            <span aria-hidden="true">·</span>
            <span>{fileCountLabel}</span>
            <span aria-hidden="true">·</span>
            <time
              dateTime={new Date(result.item.updatedAt).toISOString()}
              title={formatDateTime(result.item.updatedAt, locale, 'full')}
            >
              {formatRelativeTime(result.item.updatedAt, locale)}
            </time>
          </>
        ) : (
          linkedProjects.map((project) => (
            <span key={project.id} className="search-detail-context-part" title={project.name}>
              <Folder aria-hidden="true" />
              <span>{project.name}</span>
            </span>
          ))
        )}
        {result.kind === 'library' && linkedProjects.length === 0 && (
          <span className="search-detail-context-part">
            <BookOpenText aria-hidden="true" />
            <span>{t('Library')}</span>
          </span>
        )}
        {sessionLabel && (
          <span className="search-detail-context-part" title={sessionLabel}>
            <MessageCircle aria-hidden="true" />
            <span>{sessionLabel}</span>
          </span>
        )}
        {result.kind === 'messages' && (
          <span>
            {result.item.role === 'user' ? t('You') : t('Agent')}
            {' · '}
            <time
              dateTime={new Date(result.item.createdAt).toISOString()}
              title={formatDateTime(result.item.createdAt, locale, 'full')}
            >
              {formatDateTime(result.item.createdAt, locale)}
            </time>
          </span>
        )}
        {(result.kind === 'uploads' || result.kind === 'generated') && (
          <span>
            {[fileFormatLabel(result.item), formatBytes(result.item.size)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {bibliography && (
          <span className="search-detail-bibliography" title={bibliography}>
            {bibliography}
          </span>
        )}
      </div>
      {result.kind === 'sessions' && (
        <div className="search-detail-metrics">
          <span>
            {t('{{count}} messages', {
              count: result.item.activeMessageCount,
              defaultValue_one: '{{count}} message'
            })}
          </span>
          <span>{fileCountLabel}</span>
        </div>
      )}
    </header>
  )
}
