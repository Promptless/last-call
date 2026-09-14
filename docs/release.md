# Release acceptance

Before publishing an npm release or presenting Last Call as ready for unattended
use, complete the following checks and retain sanitized receipts.

- Run `npm run check` and inspect `npm pack --dry-run` for private material.
- Confirm current native CLI versions can execute and resume structured runs
  using subscription authentication and the intended permission settings.
- Confirm CodexBar returns fresh, account-matched weekly quota for each provider.
  A provider with missing quota must remain paused.
- Install hooks in a test installation. Observe foreground activity in both
  native clients, owned-session exclusion, and the idle delay. Test removal
  while preserving unrelated user hooks.
- Run a real prospect-research item. Review its citations and record usefulness
  and human review time.
- Prepare a real Starport preview in an authorized isolated checkout. Confirm
  local checks and the human review boundary; preserve publishing gates.
- Observe a real closing-time sprint: admission opens within its configured
  window, respects reserves and activity, stops at closure, and lets active
  tasks finish. Record remaining allowance, completed artifacts, blocked items,
  failures and human review time.
- Test launchd enable/disable, sleep/wake, and scheduler restart with an active
  worker. Confirm the worker is not duplicated.
- Verify repository ownership and npm publishing identity before release. Use
  `npm publish --access public` only after acceptance is complete.

## Launch material

Show a short recording: unused allowance, registering an existing skill, a
sprint filling slots, an input-blocked slot while peers continue, and the actual
deliverables. Use synthetic account names in screenshots and obtain permission
before sharing prospect material.

Draft post:

> Show HN: Last Call — put expiring Claude Code and Codex quota to work
>
> I kept ending the week with most of my AI allowance unused. I wanted to keep
> it available for real work, then use what remained before it reset.
>
> Last Call runs skills you already use during that closing window. A run
> waiting for your input holds its slot while the others keep working. The
> first workflows are prospect research and preview preparation.
>
> [Add the repository link, a real demo, measured results, and current limits
> after acceptance.]
