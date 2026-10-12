import { Columns3, LayoutPanelLeft, RotateCcw } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  createResearchReplayLayoutPreferences,
  getResearchReplayVisiblePaneIds,
  updateResearchReplayPaneVisibility,
  type ResearchReplayLayoutPreferences
} from './research-replay-layout'

export const ReplayLayoutMenu = ({
  preferences,
  onChange,
  panes
}: {
  preferences: ResearchReplayLayoutPreferences
  onChange: (preferences: ResearchReplayLayoutPreferences) => void
  panes: readonly { id: string; label: string }[]
}): React.JSX.Element => {
  const { t } = useTranslation()
  const ids = panes.map(({ id }) => id)
  const visible = getResearchReplayVisiblePaneIds(preferences, ids)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-replay-layout-control=""
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs"
          aria-label={t('Replay layout')}
        >
          <Columns3 className="size-3.5" aria-hidden="true" />
          {t('Replay layout')}
        </Button>
      </PopoverTrigger>
      <PopoverContent data-replay-layout-control="" align="end" className="w-64 space-y-3 p-3">
        <RadioGroup.Root
          value={preferences.mode}
          onValueChange={(mode) =>
            onChange({
              ...preferences,
              mode: mode === 'columns' ? 'columns' : 'split'
            })
          }
          aria-label={t('Replay layout')}
          className="grid gap-1"
        >
          <RadioGroup.Item value="split" asChild>
            <Button
              variant={preferences.mode === 'split' ? 'secondary' : 'ghost'}
              className="justify-start gap-2 text-xs"
            >
              <LayoutPanelLeft className="size-4" aria-hidden="true" />
              {t('Side-by-side')}
            </Button>
          </RadioGroup.Item>
          <RadioGroup.Item value="columns" asChild>
            <Button
              variant={preferences.mode === 'columns' ? 'secondary' : 'ghost'}
              className="justify-start gap-2 text-xs"
            >
              <Columns3 className="size-4" aria-hidden="true" />
              {t('Expand into columns')}
            </Button>
          </RadioGroup.Item>
        </RadioGroup.Root>
        <fieldset className="space-y-2 border-t border-border-200 pt-2">
          <legend className="px-1 text-xs text-text-300">{t('Visible panes')}</legend>
          {panes.map((pane) => (
            <label key={pane.id} className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={visible.includes(pane.id)}
                disabled={visible.length === 1 && visible.includes(pane.id)}
                onChange={(event) =>
                  onChange(
                    updateResearchReplayPaneVisibility(
                      preferences,
                      pane.id,
                      event.target.checked,
                      ids
                    )
                  )
                }
              />
              {pane.label}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-1 border-t border-border-200 pt-2">
          <Button
            variant="ghost"
            className="justify-start text-xs"
            onClick={() => onChange({ ...preferences, mode: 'columns', visiblePaneIds: ids })}
          >
            {t('Show all panes')}
          </Button>
          <Button
            variant="ghost"
            className="justify-start gap-2 text-xs"
            onClick={() => onChange(createResearchReplayLayoutPreferences(ids))}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t('Reset replay layout')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
