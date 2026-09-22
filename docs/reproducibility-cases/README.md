# Contributing a Reproducibility Case

A reproducibility case is one real analysis that Open-Science's agent produced — whether it worked,
failed, or needed your corrections. Cases are how the [Reproducibility Pilot (#2725)](https://github.com/aipoch/open-science/issues/2725)
turns everyday usage into better execution, analysis guidance, examples, and regression tests.

Failed runs and incomplete reports are as valuable as clean ones. Submit through the
[reproducibility case template](https://github.com/aipoch/open-science/issues/new/choose) — no pull
request, fork, or local setup is required.

## What a first submission needs

Only four things:

1. **What you were trying to do** — your research question and the original prompt, including
   relevant follow-ups.
2. **What code the agent produced** — the original Python or R script or notebook, pasted or
   linked to a public repository or a dedicated issue.
3. **What data it used** — a small shareable dataset or a public source, plus any preprocessing.
   Disclose synthetic replacements or other substitutions, and link restricted datasets instead of
   uploading them.
4. **What happened** — the result, the error, or the point where you had to intervene. If you know
   what should have happened, explain why.

It is fine to submit before every reproduction detail is available; curation can identify what is
missing.

## Keeping the original intact

- **Never overwrite the agent's output with your fix.** Submit the original code and the observed
  result as produced, and keep your corrections in a separate block, file, or comment labeled as
  human corrections. Curated examples preserve both.
- **Remove sensitive information before posting**: credentials, private paths, confidential or
  unpublished material, and personal or patient data. Share only code and data you have permission
  to share.
- **Record licenses separately** for the contributed code and for any data, and note third-party
  material you redistributed.

## Curation follow-ups

After a case is submitted, a curator may ask for:

| Field                    | Why it matters                                             |
| ------------------------ | ---------------------------------------------------------- |
| Environment details      | OS, app version, runtime and package versions for reruns   |
| Expected-result evidence | What should have happened, and how you know                |
| Human corrections        | Your fixes, kept separate from the agent's original output |
| Sharing permission       | Whether the case may be published as a curated example     |
| Attribution              | How (or whether) you want to be credited in the index      |

## Where reviewed examples live

Curated examples live in this directory, and each one gets a row in [index.md](index.md) recording
its language, analysis category, reproduction outcome, scientific-review status, and links to
follow-up issues. An initial report and a curated example are deliberately distinct: the index is
the only place a case is marked reviewed, so a reviewer can always tell what evidence is still
missing.

## How reviewers handle a case

Every submitted case is owned by one reviewer — a maintainer or a volunteer who comments on the
issue. The reviewer:

1. Confirms the four required fields are present and asks for whatever is missing.
2. Inspects the contributed code in an **isolated environment** (a fresh container or VM with no
   access to the reporter's machine, credentials, or network shares) using the recorded environment
   details.
3. Reruns the original agent output as submitted, then separately applies any human corrections.
4. Records the reproduction outcome — reproduced, reproduced with changes, or failed to reproduce;
   failures are valuable findings — and the scientific-review status in the index.
5. Files follow-up issues for product, analysis-guidance, documentation, or regression-test
   improvements the case reveals.

Reviewers do not execute unreviewed attachments outside the isolated environment, and curated
examples never include secrets, private paths, or personal data.
