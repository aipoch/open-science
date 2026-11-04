import { z } from 'zod'

export const generateResearchVideoSchema = {
  resumeJobId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Retry publication of a completed generation job returned in an earlier error; reuses its frozen sources and narration.'
    ),
  specPath: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      'Existing video.json path inside the current authorized session workspace. Read research_video_guide before authoring.'
    ),
  filename: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
    .default('research-explanation')
}
export const RESEARCH_VIDEO_GUIDE = `Create an English narrated research explanation as a dynamic HTML player and a regeneration ZIP. MP4 is optional, never required for playback. Use only research and files available in the current active conversation branch. Do not invent data, citations, successful reproduction or missing source identities. Imported source material remains read-only. Describe the planned claims and limitations before generating.

Write video.json, session.json and required animation/data files inside the authorized session workspace. A minimal video.json:
{"version":1,"title":"Research explanation","session":"session.json","files":"files","profile":"user","scenes":[{"id":"question","msg":0,"lines":[{"caption":"What does the evidence tell us?"}],"panels":[{"type":"title","text":"What does the evidence tell us?"}]}]}

session.json: {"sessionTitle":"Research title","project":"Research","messages":[{"role":"user","md":"Exact source passage","id":"actual source message ID when available"}]}. Preserve source message IDs, branch ID and referenced Artifact/version IDs in a provenance object; omit unknown IDs rather than fabricate them. This authored snapshot is not a claim of independent source verification.

Each scene has a unique id, msg (zero-based index into this frozen session snapshot), nonempty lines and panels. Keep every English narration line under 400 characters; caption and say, if present, must be identical in this version. Split long sentences. Narration and word timing are generated locally. Timing is estimated from speech synthesis and must be reviewed around quantitative claims.

Panels: title {text,eyebrow?,note?}; stats {items:[{value,label,unit?,at?}]}; bars {items:[{label,value,display?,at?}]}; checklist {items:[{text,state:"pass"|"fail"|"open",at?}]}; formula {lines:["equation"]}; quote {text,by}; compare {left:{title,value?,label?},right:{title,value?,label?,at?}}; figure {file,caption?}; end_card {text?}; animation {script:"anims/example.js",use:["anims/shared.js"],data:["table.csv"],size:"wide"|"band"|"square"}. Data and figure files are inside files/. CSV columns must exist and contain actual data. Do not use external library, subject or assets bundles in this initial authoring surface.

Panel at/until and item at cues use "0" (line start), "0.end", "0:word" (first matching caption-word prefix), "end" or an offset such as "1+0.3". Use exact numeric-word cues for numeric changes. Cue times must lie inside the scene. Repeated matching words require explicit timing review.

Animation files contain a function body called with k on every frame: k.t is scene-local seconds, k.W/k.H are dimensions, k.ctx is a cleared 2D canvas, k.dom is an overlay element. Example: const g=k.ctx; g.fillStyle='#f0b82f'; g.fillRect(40,80,Math.min(k.W-80,k.t*100),40);. Use deterministic drawing from k.t, save/restore canvas transforms, readable labels and meaningful scientific units. No network, filesystem, application API, wall-clock timers or random animation. Animation code executes only in the isolated viewer, never in the host process.

Call generate_research_video with specPath and a stable filename stem. Install Research narration in Settings → Models → Local models before the first generation. Installation downloads the model, one English voice and only the current platform’s verified Node speech engine; no inference engine ships in the default app. It uses those verified local files, creates narration and a self-contained player, and saves both outputs through the normal Artifact tool protocol. Only report outputs after the tool returns their Artifact/version receipts. Review the saved HTML using its playback controls, including all numeric transitions; correct the source and generate a new version if necessary. Preserve the source ZIP for regeneration. Never label successful generation as successful scientific replication.`
