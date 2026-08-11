// Keep the existing main-process seam while sharing the YAML semantics with standalone uploads.
export {
  frontmatterFieldNames,
  parseFrontmatter,
  parseSkillDocument,
  splitFrontmatter
} from '../../shared/skill-frontmatter'
