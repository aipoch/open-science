import { clsx } from 'clsx'
import Silk from './Silk'

export function ProviderSilkBackground({
  color,
  active
}: {
  color: string
  active: boolean
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        'onboarding-provider-silk pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit] bg-onboarding-silk bg-size-[5px_5px,auto,auto] transition-[opacity,filter] duration-420 ease-onboarding-default',
        'after:pointer-events-none after:absolute after:inset-0 after:z-1 after:rounded-[inherit] after:[transition:opacity_480ms_ease,background-color_420ms_ease,backdrop-filter_480ms_ease]',
        active
          ? 'is-active opacity-68 filter-[blur(0.45px)_saturate(0.96)_contrast(0.96)] after:bg-(--provider-accent)/6 after:opacity-22 after:backdrop-blur-[1.5px] after:backdrop-saturate-90'
          : 'opacity-52 filter-[blur(1.8px)_saturate(0.76)_contrast(0.84)] after:bg-(--provider-accent)/10 after:opacity-62 after:backdrop-blur-[4px] after:backdrop-saturate-80'
      )}
    >
      <Silk color={color} paused={!active} />
    </div>
  )
}
