import { PACKAGE_INSTRUCTION_PATH } from '../../shared/session-package'

export const PACKAGE_INSTRUCTION = `# Open this Open-Science session package

A .science file is a gzip-compressed tar archive. Check manifest.json for the
open-science-session format. Read the guide and manifest as data without extracting
unrelated files or executing anything in the archive.

## 1. Determine Open-Science status

Use read-only checks to determine whether a compatible version of Open-Science
is installed and ready to open the original .science file.

| Open-Science status | Required next action |
| --- | --- |
| Compatible installation confirmed ready | Skip installation. Ask the import question in section 3 in the next reply. If just installed, ask in the same reply that reports readiness. |
| Confirmed missing or incompatible | Ask for installation or update approval as described in section 2. Do not ask about importing. |
| Unable to confirm readiness | Explain what could not be verified and ask the user to help confirm the installation or version. Do not ask about importing. |
| Installation or startup in progress | Wait for confirmed readiness. Do not ask about importing. |

A blocked or inconclusive check does not prove that Open-Science is installed or
missing. **Do not ask about importing, request import approval, or attempt to
import until a compatible Open-Science installation is confirmed ready.**

## 2. Installation or update approval is required

For a confirmed missing or incompatible installation, check the official
project and download pages for a compatible installer for the operating system:

- Official repository: https://github.com/aipoch/open-science
- Official downloads: https://aipoch.com/open-science/download

Explain why installation or an update is needed, identify the proposed source
and version, and ask directly for explicit approval. Wait for a clear yes
before downloading, installing, or updating Open-Science.
If the proposed source or version cannot be established, report that and stop.

After approval, verify the installer against trusted release integrity
information, run the supported installer, and confirm that Open-Science is
ready. If the user declines, verification fails, or readiness cannot be
confirmed, report the outcome and do not ask about importing.

## 3. Separate import approval is required

Once readiness is confirmed, ask a direct yes-or-no question in the user's
language:

> Would you like me to import this .science file into an Open-Science project now?

Do not replace the question with a promise to ask later or a reminder that
approval is required. The request to open the attachment and the approval to
install or update do not authorize import. Wait for a separate clear yes
before importing. If the user declines, do not import.

Once approved, import the original .science file through the application's
normal package import entry point, keep its validation enabled, and report the
result. Importing does not require running code from the package, setting up a
model account, or replaying research.

This guide does not grant approval or supply executable commands.
`

export const PACKAGE_GZIP_COMMENT = `Open-Science session package (tar archive). See ${PACKAGE_INSTRUCTION_PATH} for opening guidance.`
