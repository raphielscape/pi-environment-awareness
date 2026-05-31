# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-01

### Added
- Initial release
- System detection (OS, architecture, shell)
- Runtime detection (WSL, Docker, CI/CD platform)
- Git context (branch, default branch, status with file count, recent commits)
- Package manager detection from lock files
- Dev tool detection with versions (bun, node, python, go, rust, java, cargo, uv, pip, docker, git)
- Source-driven tool preferences based on project config files
- Security check (root/admin detection)
- Locale info (timezone, language)
- `/env` and `/env refresh` commands
- Footer status indicator
