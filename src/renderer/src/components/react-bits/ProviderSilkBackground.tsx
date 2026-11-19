import Silk from './Silk'

type ProviderSilkBackgroundProps = {
  color: string
  active: boolean
}

const ProviderSilkBackground = ({
  color,
  active
}: ProviderSilkBackgroundProps): React.JSX.Element => (
  <div aria-hidden="true" className={`onboarding-provider-silk${active ? ' is-active' : ''}`}>
    <Silk
      color={color}
      sheenColor={color}
      paused={!active}
      rotation={0}
      mouseInteraction={false}
      clickRipple={false}
      speed={0.35}
      scale={1.2}
      noiseIntensity={1.6}
      sheen={1.1}
      depth={1.2}
      glow={0.35}
      intro={false}
      ripple={0}
      wave={0.45}
      dpr={1.25}
    />
  </div>
)

export { ProviderSilkBackground }
