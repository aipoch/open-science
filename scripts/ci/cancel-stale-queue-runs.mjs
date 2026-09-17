/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Only GitHub's deleted/replaced queue refs establish that a run is obsolete.
export async function cancelStaleQueueRuns({ github, repo, log = console.log }) {
  const cancelled = []
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...repo,
      workflow_id: 'pr-gate.yml',
      event: 'merge_group',
      status,
      per_page: 100
    })
    for (const run of runs) {
      if (
        run.event !== 'merge_group' ||
        run.status === 'completed' ||
        !/^gh-readonly-queue\/main\/pr-\d+-[0-9a-f]{40}$/.test(run.head_branch ?? '')
      )
        continue
      let currentSha
      try {
        const { data } = await github.rest.git.getRef({
          ...repo,
          ref: `heads/${run.head_branch}`
        })
        currentSha = data.object.sha
      } catch (error) {
        if (error.status !== 404) throw error
      }
      if (currentSha === run.head_sha) continue
      try {
        await github.rest.actions.cancelWorkflowRun({ ...repo, run_id: run.id })
        cancelled.push(run.id)
        log(`Requested cancellation of obsolete merge-group run ${run.id}`)
      } catch (error) {
        // A run can finish between enumeration and cancellation.
        if (error.status !== 409) throw error
        log(`Run ${run.id} is no longer cancellable`)
      }
    }
  }
  return cancelled
}
