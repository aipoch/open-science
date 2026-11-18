import { BookOpen, ChartNoAxesCombined } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type {
  ScheduleAction,
  ScheduleDraft,
  ScheduleRule
} from '../../../../../shared/session-schedules'

type MessageExample = ScheduleDraft & {
  action: Extract<ScheduleAction, { kind: 'send_session_message' }>
  rule: Extract<ScheduleRule, { kind: 'daily' | 'weekly' }>
}

export function ScheduleExamples({
  onChoose
}: {
  onChoose: (example: MessageExample) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const examples = [
    {
      icon: ChartNoAxesCombined,
      draft: {
        name: t('Summarize experiment progress'),
        action: {
          kind: 'send_session_message',
          message: t(
            'Review experiment records added or updated in this project in the last 24 hours. List completed experiments, changes in key metrics, and failures, with the relevant file paths. If nothing changed, say so.'
          )
        },
        rule: { kind: 'daily', time: '09:00', timeZone }
      }
    },
    {
      icon: BookOpen,
      draft: {
        name: t('Review this week’s literature'),
        action: {
          kind: 'send_session_message',
          message: t(
            'Review papers and reading notes added to this project in the last seven days. For each paper, summarize its main finding and link to its source or project file. If nothing was added, say so.'
          )
        },
        rule: { kind: 'weekly', weekdays: [5], time: '16:00', timeZone }
      }
    }
  ] as const satisfies ReadonlyArray<{ icon: typeof BookOpen; draft: MessageExample }>
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {examples.map(({ icon: Icon, draft: example }) => (
        <Button
          key={example.rule.kind}
          variant="outline"
          className="h-auto justify-start gap-3 px-4 py-3 text-start whitespace-normal"
          type="button"
          onClick={() => onChoose(example)}
        >
          <Icon className="text-primary" />
          <span>
            <span className="block">{example.name}</span>
            <span className="block text-xs font-normal text-muted-foreground">
              {example.rule.kind === 'weekly'
                ? t('Every Friday at {{time}}', { time: example.rule.time })
                : t('Daily at {{time}}', { time: example.rule.time })}
            </span>
          </span>
        </Button>
      ))}
    </div>
  )
}
