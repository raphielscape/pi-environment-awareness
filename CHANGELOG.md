# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-27

### Fixed

- `bun.lock`-only projects now report `use bun (project has bun lockfile)`
  instead of falling through to `use node with npm` (lockfile list drift
  between package-manager and project-context detection)
- `java` is now detected: its `-version` banner goes to stderr, which the
  version probe previously did not capture

### Added

- Node version pin in project config (`<node-version>`): content of
  `.nvmrc`/`.node-version`, falling back to `engines.node` from
  `package.json`; comment-only pin files are skipped
- OMP (Oh My Pi) compatibility: `omp.extensions` manifest key, host-agnostic
  `before_agent_start` system-prompt injection (array sections for OMP, scalar
  string for Pi), and OMP install/discovery docs in README. Install with
  `omp plugin install .` (add `--scope=project` for project scope) or
  `omp plugin link <path>` for live development
- Modern CLI tool detection: rg, ast-grep, fd, bat, eza, jq, fzf, shellcheck,
  delta, sd, difft, gh, yq, xh
- Modern CLI preferences, emitted only when the tool is available:
  role-scoped directives with agent-relevant caveats, such as "use rg
  instead of grep for text search (recursive, respects .gitignore); pass an
  explicit path or file list to avoid stdin fallback in sandboxed
  environments" and "use ast-grep ... exit code 1 means no matches, not
  failure", plus usage hints for jq, fzf (non-interactive `--filter` mode
  only, never the TTY-driven UI from agent commands), shellcheck (run it on
  authored shell scripts), delta, difft, gh, yq, and xh
- CPU model name and thread count in the system section. Threads come from
  the cgroup CPU quota (v2 `cpu.max`, v1 `cfs_quota/period`) when a quota is
  set, else `os.cpus().length` — `os.cpus()` reports host CPUs inside
  containers and would mislead parallelism hints.
- Cgroup memory limit, emitted as `<memory-limit>` only when the cgroup
  enforces one (v2 `memory.max`, v1 `memory.limit_in_bytes`). Labeled as a
  limit, never as available memory. Parsers are pure functions so tests
  never touch `/sys/fs/cgroup`.
- XDG base directory detection, emitted only for env vars set to absolute
  paths differing from the spec defaults
- XML escaping for all externally-sourced values rendered into the prompt
  (OS name, tool names/versions, package manager, preferences,
  project-config fields, locale, XDG paths)

### Changed

- Runtime and modern-CLI tool preferences are now prohibitive: `use bun
  ... do not use node/npm/yarn here`, `use rg instead of grep for
  search/listing/text ops`, etc. Coding agent guides recommend stating
  forbidden alternatives as clearly as the required tool, because bare
  `package.json` files otherwise pull models toward `npm install` defaults
- Preference injection honors the `packageManager` field in `package.json`
  as the project's own declaration; it wins over lockfile inference (lock
  files can be stale after a pm switch) and its preference text says
  "declared in package.json" instead of claiming a lockfile was seen.
  Unsupported declared names (anything besides npm/pnpm/yarn/bun) fall
  back to lockfile inference.
- Missing toolchains are now called out: a bun/Deno project without its
  runtime on PATH, or a node project whose declared package manager is not
  installed, produces an explicit warning preference instead of silence
- Deno projects (`deno.json`, `deno.jsonc`, `deno.lock`) are detected;
  `deno.lock` also feeds `<package-manager>`
- Tool detection is now concurrent (`Promise.all`) instead of ~50 sequential
  spawns, and drops the separate `which` pass: the version call itself proves
  PATH presence. Measured ~695 ms → ~240 ms per detection on the dev host.
- `python` is omitted from the tool list only when it reports the same
  version as `python3` (same interpreter); distinct versions are kept
- `deno` added to the probed tool list
- Container detection now recognizes Podman (`/run/.containerenv`, `libpod`,
  `$container`) in addition to Docker markers
- `tsconfig.json` parsing tolerates comments and trailing commas (JSONC
  dialect) so `tsconfig-strict` is no longer silently missed on common
  hand-edited configs
- npm scripts list is capped at 20 entries with a `+N more` tail so
  script-heavy `package.json` files cannot bloat the prompt
- Footer status now shows only noteworthy runtimes (WSL, Docker, CI) when
  detected; the always-on OS/arch label (e.g. "Linux/x64") was removed
- TypeScript 5.7.0 → 7.0.2, @types/node ^22.0.0 → ^26.6.1, added @types/bun
  (also fixes pre-existing `bun:test` type errors in `npm run check`)

### Removed

- Git branch, dirty status, and recent commits from the injected prompt:
  they change mid-session and break prompt caching. Git repo membership is
  still detected internally but never injected.

## [1.0.0] - 2026-06-01

### Added

- Initial release
- System detection (OS, architecture, shell)
- Runtime detection (WSL, Docker, CI/CD platform)
- Git context (branch, default branch, status with file count, recent commits)
- Package manager detection from lock files
- Dev tool detection with versions (bun, node, python, go, rust, java,
  cargo, uv, pip, docker, git)
- Source-driven tool preferences based on project config files
- Security check (root/admin detection)
- Locale info (timezone, language)
- `/env` and `/env refresh` commands
- Footer status indicator
