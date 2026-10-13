export type ChatSkillSelectorCandidate = {
  name: string
  description: string
  path: string
  source?: 'connector'
}

export type ChatSkillSelectorInput = Pick<ChatSkillSelectorCandidate, 'name' | 'path'>
