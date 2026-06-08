# Autonomous Push-Through Workflow

## Overview

The push-through workflow is a V2 scheduler job (kind=workflow) that autonomously executes next actions from Luna's workspace database and creates pull requests when appropriate.

## Workflow Steps

### 1. Select Next Action
Queries the workspace DB for the highest-priority open next_action:
```sql
SELECT id, action FROM next_actions WHERE status IN ('todo','doing') ORDER BY priority DESC, created_at ASC LIMIT 1
```

### 2. Isolated Worktree Execution
Works in `/root/luna-auto`, an isolated git worktree checked out from `origin/dev` on a fresh feature branch (`auto/na-{id}`). Ensures the main Luna repository at `/root/luna` remains untouched.

### 3. Implementation via Commit-Only Prompt
Claude receives a bounded task prompt to implement exactly one next_action. Creates a minimal, focused commit in the worktree. Does NOT push or open PRs during this phase.

### 4. Deterministic Gate
Before pushing and opening a PR, two checks must pass:
- **Already merged**: `git cherry` verifies the commit isn't already in dev
- **Existing PR**: `gh pr list` checks for an open PR for this branch

If either gate fails, the workflow skips PR creation to avoid duplicates.

### 5. Push and PR Creation
When gates pass, pushes the feature branch to origin and opens a pull request against `dev`.

## Installation

Enable the push-through workflow:
```bash
apps/ui-web/scripts/push-through-install.ts --enable
```

**Requirements**: The `HOME` environment variable must be set on the systemd unit for git/gh authentication.
