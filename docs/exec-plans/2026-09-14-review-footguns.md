# Close scheduler and native-runner review findings

The follow-up to PR #1 addresses the review's correctness and operational
findings while keeping the existing scheduler, SQLite store, and native runners.

1. Apply the same Claude subscription settings to authentication and execution
   in the skill's directory. Reject an effective API key or provider mismatch.
2. Check Codex hook enablement and trust through native metadata. Keep Claude
   parent and child activity separate throughout their lifecycles.
3. Use terminal Codex events to distinguish successful retries from failures.
   Resume only recognized usage-limit interruptions; retain other diagnostics.
4. Re-read configuration after asynchronous probes and before execution. Keep
   an open sprint awake during quota waits when keep-awake is enabled.
5. Preserve native configuration roots in launchd and compare service ownership
   by the exact home argument. Show work-recheck advice only for exhausted work.
6. Cover these behaviors with deterministic and child-process regression tests,
   check native metadata without model turns, and open a reviewed follow-up PR.

The changes require no database migration or new dependency. Native approvals
remain user-controlled. Real research, Starport, and closing-time acceptance
remain release requirements in [the validation record](../validation.md).
