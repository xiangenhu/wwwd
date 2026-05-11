# Team Bug Fix

Automatically fetch, triage, and fix bugs from the project's bug source.

## Target: $ARGUMENTS (or "all" if not specified)

## Phase 0 — Detect the bug source

Before anything else, figure out **where bugs come from in this project.** Check in order:

1. **`CLAUDE.md`** — look for a "Bug Tracking" or similar section documenting how errors are captured.
2. **`.env` / `.env.example`** — look for variables like `SENTRY_DSN`, `BUG_LRS_ENDPOINT`, `GITHUB_TOKEN`, `LINEAR_API_KEY`, `ROLLBAR_TOKEN`, etc.
3. **`package.json` / dependencies** — look for `@sentry/*`, `rollbar`, `bugsnag`, etc.
4. **`.github/`** — if the project uses GitHub Issues as the bug tracker.
5. **Local logs** — `logs/`, `*.log`, or a logging service file.

Once detected, announce the source to the user (e.g., "Using Sentry at project `foo`" / "Using GitHub Issues with label `bug`") and confirm before proceeding if ambiguous.

If **no** bug source can be detected, ask the user where bugs are reported.

## Phase 1 — Fetch

Fetch recent bug reports using the appropriate method for the detected source:

- **Sentry**: `sentry-cli issues list` or the Sentry API
- **GitHub Issues**: `gh issue list --label bug --state open`
- **Linear**: Linear API with the stored token
- **xAPI LRS / custom endpoint**: the curl pattern documented in `CLAUDE.md`
- **Local logs**: read the configured log file(s)

Limit to the most recent ~100 reports by default, or whatever the user's `$ARGUMENTS` specifies.

## Phase 2 — Parse & Triage

Extract the following from each bug, whichever apply:

| Field | Notes |
|-------|-------|
| id | Bug / issue / event ID |
| severity | critical / error / warning / info |
| message | Error message |
| stack | Stack trace (if available) |
| source | client / server / background |
| route | URL, endpoint, or script path |
| component | Component / module name |
| firstSeen / lastSeen | Timestamps |
| occurrences | How many times the bug has been reported |
| userContext | User / session context if available |

**Triage rules:**
1. Skip empty / junk reports
2. Group duplicates by normalized message — report the count, fix once
3. Prioritize by severity: `critical` > `error` > `warning` > `info`
4. Within a severity tier, prioritize by occurrence count
5. If `$ARGUMENTS` specifies a filter (e.g., "auth", "client", "quiz"), include only matching bugs
6. Cross-check against recent commits (`git log --oneline -30`) to skip bugs that were likely already fixed

## Phase 3 — Present summary

Before touching any code, show the user a summary table and wait for confirmation:

```
## Bug Report Summary

| # | Severity | Message | Source | Count | Last Seen |
|---|----------|---------|--------|-------|-----------|

Total: X actionable bugs (Y errors, Z warnings)

Proceed to investigate and fix? [y/n]
```

## Phase 4 — Investigate (Parallel)

Launch parallel investigation agents — one per unique bug. Each agent:

1. Searches the codebase for the error message or related symbols
2. Follows any `file:line` references in the stack trace
3. If a `route` exists, finds the corresponding handler
4. Narrows the search by `source` (client vs server) when available
5. Identifies the root cause
6. Verifies the bug hasn't already been fixed in recent commits
7. Proposes a targeted fix

## Phase 5 — Fix (Sequential)

For each bug that needs fixing:

1. Read the affected file(s)
2. Apply a **minimal, targeted** fix using the Edit tool
3. Verify syntax if the language supports it (e.g., `node -c`, `python -m py_compile`, `tsc --noEmit`)
4. Run the project's tests for the affected area if a test command is documented in `CLAUDE.md` or `package.json`
5. Mark the bug as fixed in your internal tracking

**Fix guidelines:**
- Do not refactor surrounding code
- Follow existing patterns and style
- Group multi-file fixes for the same bug into one logical change
- For data issues (bad JSON, bad config), fix the data file
- For race conditions, add proper guards rather than retry loops
- For missing fallbacks, add defensive handling at the boundary

## Phase 6 — Report

```
## Bug Fix Report

### Fixed
| # | Bug | File(s) Changed | Fix Description |
|---|-----|-----------------|-----------------|

### Skipped (already fixed or not reproducible)
| # | Bug | Reason |
|---|-----|--------|

### Needs Manual Attention
| # | Bug | Reason |
|---|-----|--------|

### Files Modified
- file1 (Bug #1, #3)
- file2 (Bug #2)
```

## Filtering with Arguments

- `/team-bugfix` — fetch and fix all bugs
- `/team-bugfix errors` — only ERROR severity
- `/team-bugfix client` — only client-side
- `/team-bugfix server` — only server-side
- `/team-bugfix <keyword>` — only bugs whose message contains the keyword

## Important Notes

- **Always read files before editing them.**
- **Always check `git log`** to avoid re-fixing bugs that were addressed in recent commits.
- **Never commit automatically** — let the user decide when to commit.
- For "Failed to fetch dynamically imported module" and similar stale-cache errors, these are usually deployment artifacts, not code bugs. Skip them unless persistent.
- For transient 429 / rate limit warnings, skip unless they form a persistent pattern.
- For "Session expired" errors on pages that render before auth completes, fix by adding auth guards rather than silencing the error.
