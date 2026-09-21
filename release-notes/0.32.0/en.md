## ✨ Highlights

- **Persistent PDF annotations and document notebooks.** Notes and annotations now stay with the file version they belong to: text styles, area marks, page and document notes, comments, colors, global tags, undo/redo, and native PDF annotation import — with export to a separate annotated PDF or Markdown/CSV notes while source bytes stay untouched. Library attachments share their notebook across references, projects, and sessions; project uploads and artifacts share it across sessions in the owning project. (#2853)
- **Complete RO-Crate artifact export.** A verified artifact version can now be packaged as a complete RO-Crate 1.1 archive together with its exact inputs — declared sizes and checksums are verified before bytes are included, identical content is deduplicated, and conflicting content is rejected. (#2685)
- **NCBI BLAST sequence search.** New asynchronous tools submit a nucleotide or protein query to NCBI BLAST, track the job until it completes, and retrieve the report in the format of your choice — bringing similarity search for unknown sequences into the genomes connector. (#2829)
- **Wider omics discovery.** ENA runs can be discovered by organism, library strategy, or keyword, with original submitted files (BAM, CRAM) alongside archive FASTQ; PRIDE projects expose paginated file listings; UniProt entries are discoverable by gene name, protein phrase, and organism before pulling sequences. (#2852, #2844, #2857)

## 🚀 New Features

- Local PDF parsing model installation probes verified mirror sources when the primary download is unreachable, ranking them by response time, so installations no longer fail on a single source. (#2837)
- Capability selection can target a custom TypeSafe-compatible classification service — endpoint URL, model ID, and optional API key. Keyless loopback endpoints are allowed; remote endpoints require HTTPS and credentials. (#2832)
- StepFun's Step-5 Preview joins the provider catalog with multimodal support, a one-million-token context window, and China and Global regions; existing providers keep their historical endpoint. (#2825)
- Unattended CLI task runs can now decline to wait for humans entirely, so automation never stalls on an approval or a question that will never come. (#2848)

## 🔧 Improvements

- Startup and long conversations run lighter: evidence recovery is batched with session hydration reused, Markdown presentation work defers until needed, markdown observers shed redundant passes, annotation observers pause while streams are active, subagent previews load only when shown, and idle scrollbars hide themselves. (#2826, #2629, #2831, #2841, #2822, #2823, #2843)
- The agent classifies ambiguous linked-PDF reading requests instead of always defaulting to the focused query, so indirect whole-document requests are read in full. (#2828)

## 🐛 Bug Fixes

- **Sessions and agent runtime** — OpenCode tool connections are isolated per session, so sibling sessions can no longer invoke each other's Notebook, artifact, or plan tools (#2856); recovery ownership survives artifact publication (#2839); side chats scope their conversations and queued advisories to the current application run (#2827).
- **Compute and storage** — background compute delivery is restored and job cancellation is confirmed (#2854); file-system grants are rejected after an incomplete notebook cleanup (#2851).
- **Connectors** — gnomAD no longer returns unsuitable mitochondrial datasets (#2840).
- **Interface** — text selection is preserved across PDF annotation overlays (#2860); settings quick-search jumps focus and anchor precisely (#2570); file tile focus rings stay fully visible after the preview dialog closes (#2017); inline recovery alerts fill the available width and place actions below the explanatory content (#2850, #2855).
