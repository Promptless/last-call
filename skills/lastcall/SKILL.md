---
name: lastcall
description: Use when setting up Last Call, registering repeatable skills, checking expiring Claude Code or Codex allowance, starting a closing-time sprint, or handling Last Call run receipts and questions.
---

# Last Call

Use the `lastcall` CLI to configure and inspect the local scheduler. Begin with
`lastcall --help` and the relevant subcommand's help. Use `--json` for structured
results. If the CLI is unavailable, locate the user's Last Call checkout or
installation before proposing installation commands.

## Setup

Read existing configuration with `lastcall --json config show`. For a new
installation, collect the total agent slots, selected providers, and whether to
keep the Mac awake on AC power. Suggest a 12-hour weekly runway, 5% weekly
reserve, five-minute foreground idle delay, notifications on, and keep-awake off.
Keep the user's explicit choices.

Native logins own credentials. Use `provider add` and `doctor` to bind and check
them. Never copy credentials into Last Call configuration. `init --config` can
import a complete JSON configuration when conversational setup is preferable
to terminal prompts. It leaves the service disabled. Enable it when the user
has requested unattended operation and configuration is ready.

## Register and review a skill

Ask for the skill, its working directory, invocation arguments, allowed
providers, maximum simultaneous runs, launch spacing, and unattended permissions.
Set `enabled` to `false` in the registration JSON, then import it through
`skill add --file` using the schema documented in the README.

Run `skill check`, then perform its semantic review by reading the skill and
relevant referenced instructions. Explain concrete problems found and the
invocation that makes the skill suitable. The CLI's advisory scan is not a
semantic review or a guarantee that a skill is safe to repeat.

Confirm that one invocation handles one work item, claims it before expensive
work, excludes items awaiting input, and records completion in the skill's own
source of work. With parallel runs, check claiming and workspace isolation.
Spacing reduces claim races but does not replace claiming. A skill that creates
its own sweep, cron job, or recursive loop needs a single-item invocation.

Preserve approval gates. For preview or publishing skills, identify a useful
review boundary and report required input there. Only modify another skill if
the user's request includes that change. Flag separately billed tools or API
calls made by a skill; Last Call manages native subscription allowance only.

After resolving the review findings and confirming the user's unattended
permissions, enable the registration with `skill enable <id>`.

## Operate and handle results

Use `status --refresh` for measured quota and reasons launches are paused. Use
`runs` for receipts and native session IDs. Foreground activity pauses new
launches; active runs finish. A run needing input keeps its slot while other
slots continue. Do not release blocked slots merely to make the queue move.

Present a waiting run's actual question. Pass the user's answer with
`answer <id> --file <path>` or `--text`; do not invent approval. Answers resume
the same session when scheduling gates permit. A gate requiring a native chat
reply must be completed in that native session. After the user resolves it,
release the slot with an explicit reason; release does not mark external work
complete.

For surprise resets, resolve the user's deadline to an ISO timestamp with a
timezone offset and call `sprint --until`. Keep quota and activity gates in
effect. Report completed deliverables, questions, failures, and remaining
allowance. Record review time and usefulness through `review` when the user
provides them. Do not equate allowance consumption with productive work.
