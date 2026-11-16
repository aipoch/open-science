import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Menu, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { ResizablePanel } from '@/components/ui/resizable'
import type { ScheduleDraft, ScheduleView } from '../../../../../shared/session-schedules'
import { ScheduleExamples } from './ScheduleExamples'
import { ScheduleDialog } from './ScheduleDialog'
import { useSchedules } from './use-schedules'
import { useScheduleSelection } from './use-schedule-selection'

export function ScheduleStarterPanel({
  projectId,
  active = true,
  openMobileSidebar,
  onOpenTask,
  children
}: {
  projectId: string
  active?: boolean
  openMobileSidebar?: () => void
  onOpenTask: (task: ScheduleView) => void
  children: React.JSX.Element
}): React.JSX.Element {
  const { t } = useTranslation()
  const { isEmpty } = useSchedules(active ? projectId : undefined)
  const { select, error } = useScheduleSelection()
  const [draft, setDraft] = useState<ScheduleDraft | null | undefined>()
  if (!active || (!isEmpty && draft === undefined && !error)) return children
  return (
    <ResizablePanel id="main-content" defaultSize="60%" minSize="30%">
      <section className="relative flex h-full flex-col overflow-auto px-6 py-8">
        {openMobileSidebar && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="absolute start-3 top-3 md:hidden"
            aria-label={t('Open navigation')}
            onClick={openMobileSidebar}
          >
            <Menu />
          </Button>
        )}
        <div className="mx-auto my-auto w-full max-w-xl py-8">
          {error ? (
            <ErrorNotice inline title={t('Schedule')} description={error} />
          ) : (
            <>
              <div className="flex flex-col items-center gap-3 text-center">
                <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                  <Clock className="size-6" />
                </span>
                <h1 className="text-2xl font-semibold">{t('Create your first scheduled task')}</h1>
                <Button onClick={() => setDraft(null)}>
                  <Plus />
                  {t('New task')}
                </Button>
              </div>
              <h2 className="mb-2 mt-9 text-xs font-medium text-muted-foreground">
                {t('Start from an example')}
              </h2>
              <ScheduleExamples onChoose={setDraft} />
            </>
          )}
        </div>
        {draft !== undefined && (
          <ScheduleDialog
            projectId={projectId}
            task={null}
            initialDraft={draft ?? undefined}
            onClose={() => setDraft(undefined)}
            onSaved={(task) => {
              setDraft(undefined)
              if (task.target.sessionId) select(task)
              else onOpenTask(task)
            }}
          />
        )}
      </section>
    </ResizablePanel>
  )
}
