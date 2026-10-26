/** Saved repositories are bookmarks; they do not confer marketplace trust. */
export type SavedSkillSource = { id: string; repository: string; ref?: string }
export type AddSkillSourceRequest = { repository: string }
export type RemoveSkillSourceRequest = { id: string }
