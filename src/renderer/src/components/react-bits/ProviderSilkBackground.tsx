import Silk from './Silk'

export function ProviderSilkBackground({
  color,
  active
}: {
  color: string
  active: boolean
}): React.JSX.Element {
  return (
    <div aria-hidden="true" className={`onboarding-provider-silk${active ? ' is-active' : ''}`}>
      <Silk color={color} paused={!active} />
    </div>
  )
}
