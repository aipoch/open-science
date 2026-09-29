import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Pause, Play, MessageSquare, FileSearch } from 'lucide-react'
import { REPLAY_SPEEDS, type ReplaySpeed } from '../../../../../shared/replay'

const formatReplayTime = (milliseconds: number): string => {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export type ReplayControlsProps = {
  playing: boolean
  ready: boolean
  positionMs: number
  durationMs: number
  stepIndex: number
  stepCount: number
  speed: ReplaySpeed
  onToggle: () => void
  onPrevious: () => void
  onNext: () => void
  onSeek: (positionMs: number) => void
  onSpeed: (speed: ReplaySpeed) => void
  onAsk: () => void
  onEvidence: () => void
}

const controlClass =
  'flex h-8 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs text-text-100 hover:bg-bg-300 focus-visible:keyboard-focus disabled:cursor-not-allowed disabled:opacity-40'

export const ReplayControls = (props: ReplayControlsProps): React.JSX.Element => {
  const { t } = useTranslation()
  const empty = props.stepCount === 0
  return (
    <div
      className="shrink-0 space-y-2 border-t border-border-200 bg-bg-000 px-3 py-2"
      data-testid="replay-controls"
    >
      <input
        type="range"
        min={0}
        max={Math.max(1, props.durationMs)}
        step={1}
        value={props.positionMs}
        onChange={(event) => props.onSeek(Number(event.currentTarget.value))}
        aria-label={t('Replay progress')}
        aria-valuetext={t('{{current}} of {{duration}}', {
          current: formatReplayTime(props.positionMs),
          duration: formatReplayTime(props.durationMs)
        })}
        disabled={empty}
        className="block w-full accent-accent-main-100"
      />
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={controlClass}
          onClick={props.onPrevious}
          disabled={empty || props.stepIndex <= 0}
          aria-label={t('Previous step')}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className={`${controlClass} bg-bg-200`}
          onClick={props.onToggle}
          disabled={empty}
          aria-label={props.playing ? t('Pause replay') : t('Play replay')}
        >
          {props.playing ? <Pause size={16} /> : <Play size={16} />}
          <span>{props.playing ? t('Pause replay') : t('Play replay')}</span>
        </button>
        <button
          type="button"
          className={controlClass}
          onClick={props.onNext}
          disabled={empty || props.stepIndex >= props.stepCount - 1}
          aria-label={t('Next step')}
        >
          <ChevronRight size={16} />
        </button>
        <span className="px-1 font-mono text-[11px] text-text-300">
          {formatReplayTime(props.positionMs)}
          {' / '}
          {formatReplayTime(props.durationMs)}
        </span>
        <select
          value={props.speed}
          onChange={(event) => props.onSpeed(Number(event.currentTarget.value) as ReplaySpeed)}
          aria-label={t('Playback speed')}
          className="h-7 rounded border border-border-200 bg-bg-000 px-1 text-xs text-text-100"
        >
          {REPLAY_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>{`${speed}×`}</option>
          ))}
        </select>
        <span className="ml-auto text-[11px] text-text-300">
          {empty
            ? t('No steps')
            : t('Step {{step}} of {{total}}', {
                step: props.stepIndex + 1,
                total: props.stepCount
              })}
        </span>
        <button
          type="button"
          className={controlClass}
          onClick={props.onEvidence}
          disabled={empty}
          aria-label={t('View step evidence')}
          title={t('View step evidence')}
        >
          <FileSearch size={15} />
        </button>
        <button type="button" className={controlClass} onClick={props.onAsk} disabled={empty}>
          <MessageSquare size={14} />
          {t('Ask about this step')}
        </button>
      </div>
      {props.playing && !props.ready ? (
        <div role="status" className="text-xs text-text-300">
          {t('Preparing recorded material…')}
        </div>
      ) : null}
    </div>
  )
}
