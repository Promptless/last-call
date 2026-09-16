# Last Call

**Your AI quota is expiring. Put it to work.**

Give Last Call a repeatable skill. It launches Claude Code or Codex sessions
near your weekly reset, using your existing subscription allowance to work
through tasks you already wanted done.

The default is a **12-hour runway and 5% weekly reserve**. If you start working
in Claude Code or Codex, new launches pause for both providers. Running agents
finish. Each agent handles one item, and your skill keeps control of its
backlog.

## Install from source

Requires macOS, Node.js 22.16 or newer, and a signed-in Claude Code or Codex CLI.
Claude Code requires version 2.1.259 or newer for unattended permission prompts.
Both providers are supported; install either or both. Node 22 reports its built-in
SQLite module as experimental.

```sh
git clone https://github.com/Promptless/last-call.git
cd last-call
npm ci
npm run check
npm install --global .
lastcall init
```

Setup asks for agent slots, skill concurrency, spacing, accounts, permissions,
and optional keep-awake behavior. It can install the standalone CodexBar helper
and a companion skill for both agents. It leaves the scheduler disabled.

Open fresh native sessions after installing activity hooks. Review and trust
the Codex hooks if prompted; Last Call waits until it observes real lifecycle
events. Existing sessions may need restarting to load changed hook settings.

```sh
lastcall doctor
lastcall skill check
lastcall service enable
```

Inside your agent, ask: “Use Last Call to run my prospect research skill before
my weekly allowance resets.” The companion skill reviews suitability and drives
the same CLI. It does not introduce another chat interface.

For configuration through an agent or script, import the starter configuration,
then bind each account using the native executable:

```sh
lastcall init --config examples/config.json
lastcall provider add claude
lastcall provider add codex
lastcall deps install
lastcall install-skill
lastcall hooks install
```

The `providers` configuration maps each selected provider to its absolute
`binary` path and the `account` returned by the native login check. Do not
construct account identity from a quota screenshot or an API key.

## Register work

```sh
lastcall skill add
# Or edit examples/skill.json with your paths and import it:
lastcall skill add --file ./my-skill.json
lastcall --json skill check prospect-research
```

A skill registration contains `id`, absolute `path` and `cwd`, invocation
`prompt`, ordered `providers`, `maxConcurrent`, `spacingSeconds`, and explicit
provider permissions. Claude settings include `permissionMode`, `allowedTools`,
and optional `model`. Codex settings include `sandbox`, `networkAccess`, and
optional native `profile` and `model`. Native permission systems remain the
enforcement mechanism; an allowlist does not remove permissions already granted
by the user's native configuration. Review the effective configuration.
Each run retains the permission settings captured when it starts. Disable its
skill to prevent held sessions from resuming.

The CLI checks paths and configuration and flags common concerns. Its companion
agent reads the skill to assess claiming, completion, approval gates, tools,
workspace isolation, and provider compatibility. Passing a path check is not a
semantic review. Launch spacing does not guarantee unique claims.

The [research](examples/prospect-research/SKILL.md) and
[Starport preparation](examples/starport-preview/SKILL.md) examples describe
single-item work. Supply your own work source and integrations. Starport needs
its own template checkout and importer; neither is bundled here.

## Control a sprint

```sh
lastcall status --refresh
lastcall config set runwayHours 12
lastcall config set reservePercent 5
lastcall config set slots 3
lastcall config set keepAwake true
lastcall config set foregroundScope provider
lastcall sprint --until 2026-09-14T21:00:00-07:00
lastcall runs
lastcall runs RUN_ID
lastcall answer RUN_ID --text 'Use the account with domain example.com.'
lastcall release RUN_ID --reason 'Resolved manually in the native session.'
lastcall skill recheck prospect-research
lastcall review RUN_ID --minutes 4 --useful yes
lastcall service disable
```

Use an actual future deadline for a manual sprint. It starts eligibility
immediately, retaining normal quota and activity checks. Its deadline stops
automatic launches for that provider's current weekly period; an explicit new
manual sprint can replace it.

**A run waiting for input keeps its slot.** Other slots keep working, including
on the same skill. Repeated problems fill the available slots and stop further
launches. Answers continue the same native session when gates permit. Release
relinquishes a slot without marking the external work complete. It refuses to
release a run that may still be executing.

`foregroundScope` decides how wide the foreground pause reaches. The default
`any` pauses every provider whenever either native agent is active, which is
what you want when the concern is your machine and working tree: an agent
editing files under you is equally disruptive whichever tool you are sitting
in. Setting it to `provider` pauses only the provider you are using, so working
in Claude does not hold an expiring Codex allowance idle. Sessions Last Call
owns are excluded either way, so its own agents never pause it.

Short-term or model limits pause admission until measured capacity returns.
They do not start sprints. With both providers allowed, Last Call selects the
earliest weekly reset, then the greater remaining percentage, then provider
order. Skills share slots round-robin, with one admission per poll.

At the deadline, weekly reset, or foreground return, running agents finish.
The reserve is an admission threshold, not a spending cap: active agents can
consume beyond it or into a new allowance period. Last Call does not guarantee
an exact final usage percentage.

## State, permissions, and recovery

Configuration lives at `~/.lastcall/config.json`. SQLite stores run receipts,
slot ownership, activity metadata, and sprint state. Native agents retain their
own sessions. Last Call's private run directories contain result schemas and
diagnostic logs. `--home` selects an independent installation directory.

Last Call checks native account identity before reading quota and executing a
run. It uses CodexBar's native CLI transport and measured weekly percentages,
not estimated token costs. Missing, stale, or mismatched quota pauses that
provider. A probe failure is shown by `doctor` and `status`. When native CLI
quota output omits identity, Last Call pins the helper to the configured native
executable and verifies that executable's login both before and after the
measurement. Quota snapshots in `doctor` and JSON status label this identity
basis explicitly. An unused
short-term window can omit its reset time; a used window cannot.

The CLI uses subscription authentication and removes inherited API credential
overrides from native runner environments. It does not buy credits, enable
overage, or switch to API billing. A skill's own API calls, cloud services, and
other external tools may have separate costs and permissions.

Activity hooks store session IDs, timestamps, ownership and turn state; they
discard prompt and tool content. Hook installation preserves other handlers.
Detached workers survive scheduler restarts. Lost ownership or ambiguous
outcomes hold their slots for inspection instead of rerunning external actions.
An uncertain run requires `answer --after-inspection` after checking for any
surviving native execution. A normal answer does not bypass this check.

Keep-awake is off by default. When enabled, it prevents idle sleep on AC power
while a sprint or execution is active. It does not wake a sleeping Mac or keep
a closed laptop awake. Desktop notifications cover sprint closure and required
attention; macOS notification settings control their delivery.

```sh
lastcall uninstall
npm uninstall --global lastcall-cli
```

Uninstall removes this installation's service and hooks, and removes unchanged
companion skill files. It preserves configuration, receipts, edited skills, and
active runs. After active runs finish, remove the private state directory
yourself if you no longer need it.

## Development and release

```sh
npm ci
npm run check
npm pack --dry-run
```

Tests use fixed clocks, quota fixtures, SQLite, and actual child processes with
fake native runners. They do not spend subscription allowance. Live acceptance
is documented in [the release checklist](docs/release.md). Publish only after
both native runners, both example use cases, and a real closing-time sprint
have been reviewed.

Provider references:
[Claude programmatic execution](https://code.claude.com/docs/en/headless),
[Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode),
[CodexBar CLI](https://github.com/steipete/CodexBar/blob/main/docs/cli.md).

MIT licensed. The separately downloaded CodexBar helper is also MIT licensed;
Last Call includes its upstream license and copies it alongside the helper.
