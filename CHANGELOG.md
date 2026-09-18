# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- OMP (Oh My Pi) compatibility: `omp.extensions` manifest key, host-agnostic
  `before_agent_start` system-prompt injection (array sections for OMP, scalar
  string for Pi), and OMP install/discovery docs in README
- Modern CLI tool detection: rg, ast-grep, fd, bat, eza, jq, delta, sd, difft,
  gh, tokei, yq, xh
- Modern CLI preferences, emitted only when the tool is available:
  "prefer rg/fd/bat/eza/sd over grep/find/cat/ls/sed", plus usage hints for
  jq, delta, difft, gh, yq, and xh, and ast-grep for structural code search
- CPU model name and thread count in the system section. Threads come from
  the cgroup CPU quota (v2 `cpu.max`, v1 `cfs_quota/period`) when a quota is
  set, else `os.cpus().length` — `os.cpus()` reports host CPUs inside
  containers and would mislead parallelism hints.
- XDG base directory detection, emitted only for env vars set to absolute
  paths differing from the spec defaults
- XML escaping for externally-sourced values (XDG paths, CPU model, shell,
  tool names/versions)

### Changed

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
