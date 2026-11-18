/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone browser JavaScript. */
/* Host preview/export contract. The workbench has no live application bridge. */
;(() => {
  const scene = () => window.CASE_DATA.scenes.findLast((s) => s.start <= window.__layout().t)
  window.__replayState = () => ({
    time: window.__layout().t,
    sourceId: scene()?.source_ref,
    kind: scene()?.kind
  })
  // A transcript link is evidence, not permission to navigate out of the offline movie.
  document.addEventListener(
    'click',
    (event) => {
      if (event.target.closest?.('a')) event.preventDefault()
    },
    true
  )
  if (!new URLSearchParams(location.search).has('render')) {
    window.__ready.then(({ duration }) =>
      parent.postMessage({ type: 'open-science-research-video-ready', duration }, '*')
    )
  }
})()
