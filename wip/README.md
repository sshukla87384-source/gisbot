# Work in progress (not part of the pnpm workspace)

Partial scaffolds recovered from an interrupted build session. They are parked
here (outside `apps/*`) so installs, typechecks, CI and production deploys stay
green. They resume with their phases:

- `api/` — NestJS admin API: common layer (guards, pagination, zod pipe, error
  envelope) done; modules pending (Phase: API + Admin backbone).
- `admin-panel/` — Next.js panel: client plumbing (api fetch wrapper with
  refresh flow, auth store, money utils, tailwind config) done; UI kit and
  pages pending (Phase 8).

Move a directory back under `apps/` only when it typechecks and runs.
