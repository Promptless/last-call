# Validation record

Checked locally on macOS with Node.js 22.22.0, Claude Code 2.1.270,
Codex CLI 0.153.0, and CodexBar CLI 0.60.1.

## Completed

- TypeScript type checking and production compilation pass.
- 35 automated tests pass across scheduling, quotas, native event contracts,
  hooks, CLI operations, durable recovery, and actual child-process execution.
- Both native subscription account checks work.
- Both real providers returned measured weekly quota. Codex supplied identity
  in its snapshot. Claude required pinning the helper's executable and checking
  that executable's login before and after quota collection.
- Both real native agents read a local input and wrote a product brief. Each
  session was then resumed and updated its existing file. The session IDs were
  preserved across continuation, and both runs produced valid result receipts.
- A launchd service was loaded, inspected, and removed using an isolated
  configuration with no live tasks or providers.
- The companion skill passes the Skill Creator frontmatter validator.
- The production dependency audit reported no known vulnerabilities.
- The npm package excludes local configuration, account data, smoke artifacts,
  native diagnostics, and node_modules.
- The packaged tarball installed into a temporary npm prefix, printed CLI help,
  and initialized a configuration successfully without enabling a service.

Live test material remains in the ignored `.lastcall/` directory. It is not
part of the source distribution or npm package.

## Release checks still open

- A real prospect brief reviewed for usefulness and citation quality.
- Starport preview preparation in an authorized isolated checkout, reviewed
  through its existing human approval boundary.
- Native activity-hook verification in both actual clients, including user
  return while Last Call runs and a real sleep/wake cycle.
- A real closing-time sprint observed through weekly reset.
- An authenticated npm publishing account and publication after acceptance.

The native brief tests establish execution, result parsing, artifact creation,
and session resumption. They do not stand in for the research, Starport, or
weekly-reset acceptance checks above.
