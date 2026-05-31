# pi-environment-awareness

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that injects host environment context into the system prompt, helping the LLM understand the runtime it's working in.

## Features

| Category | Detected Info |
|----------|---------------|
| **System** | OS (distro name on Linux), architecture, version, shell |
| **Runtime** | WSL, Docker, CI/CD platform |
| **Security** | Root/admin user detection (only shown when noteworthy) |
| **Dev Tools** | Package manager (from lock files) |
| **Git** | Branch, default branch, dirty/clean status with file count, recent commits |
| **Locale** | Timezone, language |

## Installation

```bash
# Clone into Pi extensions directory
git clone https://github.com/YOUR_USERNAME/pi-environment-awareness.git ~/.pi/agent/extensions/environment-awareness

# Or symlink for development
ln -s /path/to/pi-environment-awareness ~/.pi/agent/extensions/environment-awareness
```

Then reload Pi or run `/reload`.

## Usage

The extension automatically:
1. Detects your environment on session start
2. Injects `<host-environment>` XML into the system prompt
3. Shows status in the footer (e.g., `Linux/x64`)

### Commands

- `/env` — View current environment info
- `/env refresh` — Force re-detection

## Output Format

```xml
<host-environment>
<system>
<os>CachyOS (x64)</os>
<shell>/bin/fish</shell>
</system>
<package-manager>bun</package-manager>
<git>
<branch>feature-x</branch>
<default>main</default>
<status>dirty (3 files)</status>
<recent-commits>
    <commit>abc1234 fix: auth flow</commit>
    <commit>def5678 feat: add login</commit>
</recent-commits>
</git>
<locale>
<timezone>Asia/Tokyo</timezone>
<lang>en_US.UTF-8</lang>
</locale>
</host-environment>
```

## Design Decisions

- **No volatile data** — Memory/disk stats excluded (breaks prompt caching)
- **No network check** — No internet = no Pi session; check is pointless
- **Conditional sections** — Security only shown when noteworthy (root)
- **Compact XML** — Minimal token overhead

## Development

```bash
# Test output
bun -e "import { gatherEnvironment, formatEnvironment } from './detectors.ts'; console.log(formatEnvironment(gatherEnvironment(process.cwd())));"
```

## License

MIT
