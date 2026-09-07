// References edited by the form are portable basenames, never paths. Keep Unicode and spaces
// intact while rejecting Windows aliases/separators even when the current OS would accept them.
export const isSafeSkillReferenceName = (name: string): boolean =>
  name.length > 0 &&
  !/[<>:"/\\|?*]/.test(name) &&
  !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
  !/[. ]$/.test(name) &&
  !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
