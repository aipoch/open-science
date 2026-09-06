---
name: compute-env-setup
description: Prepare reproducible setup instructions and validate a user-managed named software environment on an Open Science SSH Compute Host, including direct SSH and Slurm hosts. Use when a remote job needs packages, modules, cache variables, or a repeatable activation that the host does not already provide.
license: Apache-2.0
---

# Compute environment setup

Prepare one reproducible environment definition and instructions for one small user-managed host
activation file. Open Science resolves `submitJob(..., { environment: '<name>' })` by sourcing
`~/.openscience/environments/<name>.sh` before the workload. The file contains activation only; it
does not install packages when a job starts.

The environment, package caches, images, and activation file are user-managed durable resources,
not Open Science-owned components. This Skill may inspect them and prepare exact setup/removal
commands, but must not execute commands that create, replace, or remove those resources. The user
or host administrator runs those commands outside Open Science and owns their lifecycle. Do not
interpret the `~/.openscience` path as app ownership.

Use `host.compute` only in `repl_execute` JavaScript. Python and R data kernels do not expose it.
Start from the Session catalog and do not guess a provider id:

```javascript
const hosts = await host.compute.listHosts()
const selected = hosts.filter((candidate) => candidate.role === 'selected')
const candidates = selected.length > 0 ? selected : hosts
```

Choose the requested host, or a suitable candidate when the user left the target open. Read its
knowledge and probe snapshot before changing it:

```javascript
const providerId = candidates[0].provider_id
const executionMode = candidates[0].execution_mode
const details = await host.compute.details(providerId, { mode: 'read' })
const compute = host.compute.create(providerId)
```

If no eligible host exists, or the selected host is unsuitable, explain the concrete blocker. Do
not install locally as a substitute for a requested remote environment.

## Define the environment

Keep the reproducible source in the user's project: an `environment.yml`, requirements or lock
file, container definition, or a short setup script appropriate to the stack. When installation
must run on a compute node, include exact user- or administrator-run staging and scheduler commands
in the plan; do not submit that installation through Open Science. Do not store project package
lists or secrets in the host knowledge document.

Use a logical name containing 1–64 letters, numbers, periods, underscores, or hyphens, starting with
a letter or number. Its host activation file is:

```text
~/.openscience/environments/<name>.sh
```

The activation file itself and every path it references must be visible at the same path on the
execution node. A shared home directory satisfies this. If login and compute nodes have separate
homes, copy the activation file to the compute-node home at the same path and use shared software
and data paths inside it; if the host offers no durable way to do that, explain the limitation.

Prefer the host's existing environment system:

- Conda or micromamba: create the environment from the project definition, then source the shell
  hook and activate it in the activation file.
- Modules: load the exact module versions in the activation file. Combine modules with a venv or
  conda environment when Python packages are also needed.
- Apptainer or Singularity: installation and image creation are cluster-specific. Use an existing
  shared image when possible. Do not claim that `environment` wraps an arbitrary command in a
  container; the activation contract only sources shell setup.

Set cache paths and bounded thread variables in the activation file when the workload needs them.
Keep credentials out of it. Avoid `sudo`, system package changes, shell-profile edits, and
unrequested changes to other named environments.

Before installing, use one batched, read-only probe to identify the scheduler, available environment
tools, relevant modules, quotas, and shared scratch. A typical direct/Slurm probe is:

```javascript
const probe = await compute.callCommand(
  'command -v conda || true; command -v micromamba || true; command -v module || true; command -v sbatch || true; printf "HOME=%s\\n" "$HOME"; printf "SCRATCH=%s\\n" "${SCRATCH-}"',
  'Inspect environment tooling',
  { loginShell: true, timeoutSeconds: 60 }
)
```

Ask the user only for facts the host cannot reveal, such as an allocation account, a required
module family, or permission to choose among materially different package stacks.

## Prepare user-owned installation and removal

Produce a bounded, copyable installation plan for the user or host administrator. When the host is
configured for Slurm, explain whether the plan must be run in an interactive allocation or submitted
with provider-approved `#SBATCH` directives. Do not run the bootstrap through `callCommand` or
`submitJob`: package installation, image pulls, caches, and activation files outlive the Open Science
process and have no application-owned receipt or uninstall lifecycle.

Name every path the plan will create, its expected storage/network impact, and a matching idempotent
removal command. Preserve shared modules, package caches, base Conda installations, and images unless
the user explicitly identifies them as exclusively theirs. Never use recursive deletion on a path
derived only from an environment name; give the user the exact canonical path to verify first.

The user-run plan should create the environment before installing its activation file. It should
write the activation file atomically: create a temporary file, set mode `600`, and rename it to
`<name>.sh` only after the environment succeeds. A conda activation file can be as small as:

```bash
source "$HOME/miniforge3/etc/profile.d/conda.sh" || return $?
conda activate protein-gpu || return $?
export HF_HOME="${SCRATCH:-$HOME/.cache}/huggingface"
export OMP_NUM_THREADS="${SLURM_CPUS_PER_TASK:-1}"
```

Guard every required setup command with `|| return $?` so a missing module, activation failure, or
invalid export stops before the workload. Open Science also treats any non-zero result from sourcing
the activation file as a job failure. Do not append repeatedly or put activation in `.bashrc`; the
named file makes job behavior deterministic without changing the user's interactive shell.

End the plan with an explicit removal procedure for the exact activation file and exclusively
user-owned environment prefix. Removal must be safe to repeat and must not scan for similarly named
resources. If ownership or sharing is unclear, remove only the activation file after the user
verifies its contents and leave the environment/cache/image for the administrator.

## Validate where jobs run

Validate the exact activation file, the imports or executables the task needs, and a small output
witness. An import alone is insufficient for compiled or GPU software.

For direct SSH, run the witness with `callCommand`:

```javascript
const witness = await compute.callCommand(
  '. "$HOME/.openscience/environments/protein-gpu.sh" && python -c "import sys; print(sys.executable)"',
  'Validate protein-gpu environment',
  { loginShell: true, timeoutSeconds: 120 }
)
```

For Slurm, run the witness through the same job path users will use. Put the provider-known
`#SBATCH` directives first, select the new logical environment, and request a small text output:

```javascript
const job = await compute.submitJob(
  'Validate protein-gpu on one Slurm node',
  '#SBATCH --partition=<provider-known-partition>\n#SBATCH --time=00:05:00\npython -c "import sys; print(sys.executable)" > environment-witness.txt',
  {
    environment: 'protein-gpu',
    outputs: ['environment-witness.txt'],
    timeoutSeconds: 600
  }
)
await new Promise((resolve) => setTimeout(resolve, 2000))
return compute.attachJob(job.job_id).result()
```

The immediate result read is a single non-blocking failure check. End the cell afterward; Open
Science polls and harvests the job in the background and starts the analysis turn when it finishes.
Do not poll.

When validation fails, diagnose the layer identified by the error: environment definition,
activation, shared filesystem visibility, scheduler request, binary compatibility, or cache
population. Prepare revised user-run commands; do not mutate the durable environment, add a
readiness flag, or bypass the named activation file.

## Record reusable host facts

After a successful witness, append a concise host-scoped note with the environment name, activation
path, environment system, shared paths, scheduler requirements, and validation date. Keep the
project definition in the project and reference its path rather than copying it into the note.

Record only facts established by host documentation or an explicit check. A successful witness
proves that the environment was visible on that allocation; it does not by itself prove that home
directories or software paths are shared across every compute node. Describe filesystem scope as
unknown or limited to the observed allocation unless stronger evidence establishes it. Likewise,
do not infer `sudo`, package-manager, network, quota, or administrator permissions from a missing
tool or one failed install command. Separate known host facts, this witness's observations, and
assumptions that still need confirmation in both the project reproduction notes and host knowledge.

```javascript
await host.compute.details(providerId, {
  mode: 'append',
  text: '\n### Environment: protein-gpu\nActivation: ~/.openscience/environments/protein-gpu.sh\nDefinition: environment.yml in the project\nValidated: <date>, direct or Slurm witness succeeded\n'
})
```

If the requested environment already exists and the exact witness passes, leave it unchanged and
record only genuinely new host knowledge.
