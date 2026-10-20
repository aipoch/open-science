// Languages a notebook kernel can run in this phase; each runs as a persistent exec-loop process
// (no ipykernel/IRkernel involved). Renderer IPC must parse this at runtime — TypeScript unions
// do not reject a compromised or stale client.
export const NOTEBOOK_LANGUAGES = ['python', 'r'] as const

export type NotebookLanguage = (typeof NOTEBOOK_LANGUAGES)[number]
