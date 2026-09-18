/* eslint-disable @typescript-eslint/explicit-function-return-type */

export const DEFAULT_LABEL = 'ci-scheduled-failure'
const LABEL_COLOR = 'b60205'
const LABEL_DESCRIPTION = 'A scheduled workflow is failing on main'

export function trackingMarker(workflowFile) {
  return `<!-- scheduled-failure:${workflowFile} -->`
}

function runMarker(runId) {
  return `<!-- scheduled-failure-run:${runId} -->`
}

function describeRun({ runUrl, runAttempt, headSha }) {
  return `- Run: ${runUrl} (attempt ${runAttempt})\n- Commit: ${headSha}`
}

async function findTrackingIssue({ github, repo, label, marker }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    state: 'open',
    labels: label,
    per_page: 100
  })
  return issues.find((issue) => !issue.pull_request && (issue.body ?? '').includes(marker))
}

async function ensureLabel({ github, repo, label }) {
  try {
    await github.rest.issues.createLabel({
      ...repo,
      name: label,
      color: LABEL_COLOR,
      description: LABEL_DESCRIPTION
    })
  } catch (error) {
    // Another run may have created the label concurrently.
    if (![404, 409, 422].includes(error.status)) throw error
  }
}

// A re-run keeps its run id; only the newest entry decides whether it was already recorded.
async function alreadyRecorded({ github, repo, issue, runId }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: issue.number,
    per_page: 100
  })
  const latest = comments.at(-1)?.body ?? issue.body ?? ''
  return latest.includes(runMarker(runId))
}

// Maintain one open tracking issue per scheduled workflow: open or refresh it on failure and
// close it once a later scheduled run succeeds.
export async function reportScheduledOutcome({
  github,
  repo,
  workflowFile,
  workflowName = workflowFile,
  runId,
  runUrl,
  runAttempt = 1,
  headSha,
  conclusion,
  label = DEFAULT_LABEL,
  log = console.log
}) {
  if (!['success', 'failure'].includes(conclusion)) {
    throw new Error(`Unsupported conclusion: ${conclusion}`)
  }
  const marker = trackingMarker(workflowFile)
  const existing = await findTrackingIssue({ github, repo, label, marker })
  const runDetails = describeRun({ runUrl, runAttempt, headSha })

  if (conclusion === 'success') {
    if (!existing) {
      log(`${workflowName} succeeded and has no open tracking issue`)
      return { action: 'none' }
    }
    await github.rest.issues.createComment({
      ...repo,
      issue_number: existing.number,
      body: `${runMarker(runId)}\nRecovered in ${runUrl} at ${headSha}.`
    })
    await github.rest.issues.update({
      ...repo,
      issue_number: existing.number,
      state: 'closed',
      state_reason: 'completed'
    })
    log(`Closed tracking issue #${existing.number} for ${workflowName}`)
    return { action: 'closed', issueNumber: existing.number }
  }

  if (existing) {
    if (await alreadyRecorded({ github, repo, issue: existing, runId })) {
      log(`Tracking issue #${existing.number} already references run ${runId}`)
      return { action: 'none', issueNumber: existing.number }
    }
    await github.rest.issues.createComment({
      ...repo,
      issue_number: existing.number,
      body: `${runMarker(runId)}\nScheduled run failed again.\n${runDetails}`
    })
    log(`Commented on tracking issue #${existing.number} for ${workflowName}`)
    return { action: 'commented', issueNumber: existing.number }
  }

  await ensureLabel({ github, repo, label })
  const { data } = await github.rest.issues.create({
    ...repo,
    title: `ci(${workflowFile}): scheduled run failing`,
    labels: [label],
    body: [
      marker,
      runMarker(runId),
      `The scheduled **${workflowName}** workflow failed on \`main\`.`,
      '',
      runDetails,
      '',
      'To investigate, open the run above, inspect the failed jobs and their uploaded diagnostics, ' +
        'and re-run with `workflow_dispatch` after a fix. This issue is refreshed by later scheduled ' +
        'failures and closed automatically once a scheduled run succeeds.'
    ].join('\n')
  })
  log(`Opened tracking issue #${data.number} for ${workflowName}`)
  return { action: 'created', issueNumber: data.number }
}
