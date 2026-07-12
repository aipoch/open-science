// Single source of truth for project identity and external links. Shared by the main process
// (GitHub star-count fetch) and the renderer (every entry-point link). Keep this UI-free — no
// icons, no JSX — so both processes can import it and any screen reuses the same values.

const GITHUB_OWNER = 'aipoch'
const GITHUB_REPO = 'open-science'
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

export const APP = {
  name: 'Open Science',
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  links: {
    website: 'https://www.aipoch.com/open-science',
    githubRepo: GITHUB_REPO_URL,
    githubApi: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`,
    githubIssues: `${GITHUB_REPO_URL}/issues`,
    discord: 'https://discord.gg/85dKfuGM9',
    x: 'https://x.com/aipoch_ai'
  }
} as const
