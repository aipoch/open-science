/** Native discussion lives outside Replay. Leave only our read-only fullscreen before handing
 * an already captured reference to the conversation/chooser; ordinary fullscreen is untouched. */
export const exitResearchReplayFullscreen = (): Promise<void> | undefined =>
  document.fullscreenElement?.getAttribute('data-replay-presentation') === 'research'
    ? document.exitFullscreen()
    : undefined
