// Keep the existing main-process seam while sharing the YAML semantics with standalone uploads.
export {
  parseFrontmatter,
  parseSkillDocument,
  splitFrontmatter
} from '../../shared/skill-frontmatter'
