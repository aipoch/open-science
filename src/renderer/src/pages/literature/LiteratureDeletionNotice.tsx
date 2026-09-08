import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureDeletionDiagnostic } from '../../../../shared/literature-deletion'
import { Button } from '@/components/ui/button'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'

export function LiteratureDeletionNotice({
  diagnostic,
  onNavigate
}: {
  diagnostic: LiteratureDeletionDiagnostic
  onNavigate?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const projects = useProjectStore((state) => state.projects)
  const [expanded, setExpanded] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const referenced = diagnostic.reason === 'referenced'
  const openRecovery = async (projectId: string): Promise<void> => {
    setActionError(undefined)
    try {
      if (!window.api.sessions.openRecoveryFolder) throw new Error('Unavailable')
      await window.api.sessions.openRecoveryFolder({ projectId })
    } catch {
      setActionError(t('Could not open that folder.'))
    }
  }
  return (
    <LiteratureErrorNotice
      tone={referenced ? 'amber' : 'red'}
      title={t('Deletion blocked')}
      description={
        referenced
          ? t(
              'This PDF is referenced by a chat or its message history and cannot be removed. Unlinking the current chat does not remove historical references.'
            )
          : t(
              'Saved conversations could not be checked completely. No attachments were deleted. Review the recovery details before trying again.'
            )
      }
      primaryButton={{
        label: expanded
          ? t('Hide details')
          : referenced
            ? t('View affected conversations')
            : t('View recovery details'),
        onClick: () => setExpanded(!expanded)
      }}
    >
      {expanded ? (
        <div className="space-y-3 text-sm">
          {diagnostic.references.length ? (
            <ul className="max-h-64 space-y-3 overflow-y-auto">
              {diagnostic.references.map((reference, index) => (
                <li key={index} className="space-y-1 break-words">
                  <p className="font-medium">{reference.sessionTitle || reference.sessionId}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('Project: {{projectId}}', {
                      projectId:
                        projects.find(({ id }) => id === reference.projectId)?.name ??
                        reference.projectId
                    })}
                  </p>
                  <p>
                    {reference.location === 'runtime-context'
                      ? t('Current chat context')
                      : t('Historical message')}
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {reference.sessionId}
                  </p>
                  {reference.messageId ? (
                    <p className="break-all text-xs text-muted-foreground">
                      {t('Message: {{messageId}}', { messageId: reference.messageId })}
                    </p>
                  ) : null}
                  {reference.branchId ? (
                    <p className="break-all text-xs text-muted-foreground">
                      {t('Branch: {{branchId}}', { branchId: reference.branchId })}
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setActionError(undefined)
                      if (
                        !useNavigationStore
                          .getState()
                          .openSession(reference.projectId, reference.sessionId, 'user', onNavigate)
                      )
                        setActionError(
                          t(
                            'This conversation is unavailable here. It may be archived or not loaded.'
                          )
                        )
                    }}
                  >
                    {t('View conversation')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {diagnostic.issues.length ? (
            <ul className="max-h-64 space-y-3 overflow-y-auto">
              {diagnostic.issues.map((issue, index) => (
                <li key={index} className="space-y-1">
                  {issue.projectId ? (
                    <p className="break-words">
                      {t('Project: {{projectId}}', {
                        projectId:
                          projects.find(({ id }) => id === issue.projectId)?.name ?? issue.projectId
                      })}
                    </p>
                  ) : null}
                  <p className="break-all font-mono text-xs">
                    {issue.fileName === '.' ? t('Conversation folder') : issue.fileName}
                  </p>
                  <p>
                    {issue.kind === 'corrupt' || issue.kind === 'manifest-corrupt'
                      ? t('Conversation data is damaged.')
                      : issue.kind === 'unsupported-version'
                        ? t('Conversation data requires a newer app version.')
                        : issue.kind === 'too-large'
                          ? t('Conversation data exceeds the storage limit.')
                          : t('Conversation data could not be read.')}
                  </p>
                  {issue.recovered ? (
                    <p className="text-xs text-muted-foreground">
                      {t('The damaged file was moved aside; its references are still unknown.')}
                    </p>
                  ) : null}
                  {issue.projectId && window.api.sessions.openRecoveryFolder ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void openRecovery(issue.projectId!)}
                    >
                      {t('Open recovery folder')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {!referenced ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'Inspect or recover the affected conversation files. Retrying deletion alone will not repair them.'
              )}
            </p>
          ) : null}
          {diagnostic.truncated || (!diagnostic.references.length && !diagnostic.issues.length) ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'Complete locations are unavailable. Check conversation storage diagnostics; deletion remains blocked.'
              )}
            </p>
          ) : null}
          {actionError ? (
            <p role="alert" className="text-sm text-danger-000">
              {actionError}
            </p>
          ) : null}
        </div>
      ) : null}
    </LiteratureErrorNotice>
  )
}
