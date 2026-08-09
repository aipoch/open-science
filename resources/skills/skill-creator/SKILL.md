---
name: skill-creator
description: Create, revise, publish, and delete Open Science Skills through the native JavaScript host.skills composer. Use when the user asks to make a reusable workflow, write or update a Skill, or turn repeated instructions into a Skill package.
---

# Skill Creator

Create one focused, reusable Skill package. Skills are application-managed packages, not Artifacts.
Use only the JavaScript control-plane REPL's `host.skills` methods for Skill lifecycle operations.
Do not call Artifact versioning, conversation import, Python, or management MCP tools for this work.

## Native composer

```javascript
await host.skills.list()
await host.skills.read(name, path = 'SKILL.md')
await host.skills.edit(name, path, content, old_string = undefined)
await host.skills.publish(name, overwrite = false)
await host.skills.delete(name)
```

`edit` writes an app-managed draft. Without `old_string`, it creates a file and fails if that file
already exists. With `old_string`, the old text must occur exactly once. `publish` promotes the whole
draft package directly into Personal Skills and removes the draft only after success. `delete` is
privileged and always asks for app approval.

## Workflow

1. Discover before editing. Call `host.skills.list()`. For an existing Skill, read `SKILL.md` and
   every file you intend to change. Built-in and Imported Skills are read-only; fork one under a new
   lowercase hyphenated name if the user wants a variant.
2. Clarify only choices that materially change the Skill's behavior, scope, dependencies, or safety.
   Do not create a plan record for Skill CRUD. Prefer one concise question at a time.
3. Draft the smallest package that does the job. Always create `SKILL.md`; add `scripts/`,
   `references/`, or `assets/` only when they earn their place. Keep detailed or optional material in
   reference files so the main instructions stay short.
4. Use frontmatter with exactly `name` and `description`. The name must equal the draft slug. Write a
   description that states both what the Skill does and when it should trigger.
5. Review the draft with the user before publishing. Summarize its behavior, boundaries, and files;
   show important instructions in chat. The chat review is confirmation for edits and publish, but
   never substitutes for the app approval required by delete.
6. Publish with `host.skills.publish(name)`. Use `overwrite: true` only when the user explicitly chose
   to replace the existing Personal Skill. Read the published `SKILL.md` back and report the actual
   returned id and origin.
7. If the user asked to attach the published Skill to the currently selected Specialist, first read
   the Specialist and Skill catalogs, then call `host.agents.attach_skill(...)` and report its real
   read-back. Do not attach automatically.

## Authoring guidance

- A Skill owns one recurring workflow or body of specialized knowledge. Split unrelated workflows.
- Put stable procedure and decision rules in `SKILL.md`; put large examples, schemas, and background
  material in `references/`; put deterministic automation in `scripts/`.
- State required inputs, outputs, success checks, and failure behavior. Prefer explicit invariants over
  vague advice.
- Re-read every edited file before publish. For scripts, add a narrow representative check when the
  current runtime can execute it; otherwise say what remains unverified.
- Never promise automatic `kernel.py` or `kernel.R` activation, per-Specialist environments, or
  Connector tool include/exclude patterns. Those capabilities are not part of the current composer.
