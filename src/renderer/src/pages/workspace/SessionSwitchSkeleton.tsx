/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · component: Session switch skeleton · genre: modern-minimal · theme: Open Science workspace · state: loading · contrast: pass · mobile: pass */

const SessionSwitchSkeleton = (): React.JSX.Element => (
  <div
    aria-hidden="true"
    data-testid="session-switch-skeleton"
    className="min-h-0 flex-1 overflow-hidden"
  >
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-8 px-4 py-5 motion-safe:animate-pulse md:px-6 md:py-8">
      <div className="ml-auto h-14 w-[min(72%,34rem)] shrink-0 rounded-2xl bg-bg-300" />

      <div className="flex flex-col gap-3">
        <div className="h-3 w-[42%] rounded-full bg-bg-300" />
        <div className="h-3 w-[96%] rounded-full bg-bg-300" />
        <div className="h-3 w-[81%] rounded-full bg-bg-300" />
        <div className="h-3 w-[88%] rounded-full bg-bg-300" />
      </div>

      <div className="flex flex-col gap-3">
        <div className="h-3 w-[31%] rounded-full bg-bg-300" />
        <div className="h-3 w-[73%] rounded-full bg-bg-300" />
        <div className="h-3 w-[62%] rounded-full bg-bg-300" />
      </div>
    </div>
  </div>
)

export { SessionSwitchSkeleton }
