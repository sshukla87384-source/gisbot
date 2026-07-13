# Work in progress (not part of the pnpm workspace)

Partial scaffolds parked here (outside `apps/*`) so installs, typechecks, CI and
production deploys stay green.

- `admin-panel/` — Next.js panel: client plumbing (api fetch wrapper with refresh
  flow, auth store, money utils, tailwind config) done; UI kit and pages pending
  (Phase 8). The admin API it consumes is live in `apps/api`.

Move a directory back under `apps/` only when it typechecks and runs.
