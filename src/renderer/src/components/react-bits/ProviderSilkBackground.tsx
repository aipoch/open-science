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
    {active ? (
      <Silk
        color={color}
        sheenColor={color}
        paused={false}
        rotation={0}
        mouseInteraction={false}
        clickRipple={false}
        speed={0.35}
        scale={1.2}
        noiseIntensity={1.6}
        sheen={1.1}
        depth={1.2}
        // The card background does not need the extra bloom framebuffer. Keeping it disabled
        // avoids an incomplete WebGL target turning the transparent texture into a gray wash.
        glow={0}
        intro={false}
        ripple={0}
        wave={0.45}
        dpr={1.25}
      />
    ) : null}
  </div>
)

export { ProviderSilkBackground }
