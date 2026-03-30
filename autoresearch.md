# Autoresearch: OpenMAIC classroom generation reliability (smoke)

## Metrics
- Primary: `job_success` (higher is better)
  - 1 = classroom job reached `succeeded|completed` within the polling window
  - 0 = failed / timed out / HTTP error
- Secondary: `job_wall_time_s` (lower is better)
  - Wall-clock seconds for the smoke run

## Runner
- `./autoresearch.sh`

Environment variables (optional):
- `OPENMAIC_BASE_URL` (default: `http://127.0.0.1:3006`)
- `OPENMAIC_ENV_FILE` (default: `$HOME/.config/papertok-study/openmaic.env`)
- `STUDY_API_BEARER_TOKEN` (if the API is protected)
- `CLASSROOM_SMOKE_REQUIREMENT` / `CLASSROOM_SMOKE_LANG`

## Notes
- OpenMAIC may run from a Next.js standalone cwd (e.g. `.next/standalone`), so job JSON files may land under `data/classroom-jobs` relative to that cwd.
- When running via `run_experiment`, set `timeout_seconds` >= 1800 to allow the full polling window.

## History
See `autoresearch.jsonl` / `autoresearch.ideas.md`.
