# PC Control Plane

A local Windows PC control application combining telemetry, workload-aware power
policy, audit history, network diagnostics, Desktop Comfort and a desktop shell.
The design separates observations, policy decisions, execution and verified outcomes.

**Public source preview, not a production release or installer.** This repository
is a sanitized snapshot with fresh Git history. It does not contain the original
workstation's settings, telemetry, diagnoses, credentials or qualification records.

## What Is Included

- Browser cockpit, Performance Lab and Desktop Comfort interfaces.
- Node.js policy, learning, status, audit and control-boundary source.
- Windows desktop shell source using .NET and WebView2.
- Isolated tests for frontend state, request ownership, lifecycle and recovery.

## Important Limits

Windows runtime startup is deliberately blocked in this public preview.
Suspended PowerShell adapters, machine-specific external helper scripts,
installers and signed release artifacts are not distributed here.
Some policy constants and legacy control code still require hardware-independent
review. Do not treat the source's thermal thresholds or power-plan names as
recommendations for your computer. Do not remove the startup block to use this
preview on a live PC.

The desktop shell is developmental; building it does not create a qualified
installer. This snapshot is neither feature-parity acceptance nor a claim that
every advertised historical feature works on arbitrary hardware.

## Validate the Source

Use Node.js 22 or newer. The default checks use Node's built-in tools and do not
require dependency installation or Windows adapter execution:

```sh
npm test
npm run check
```

The check command creates an ignored local data directory. The public test list is
explicit; do not glob-run other legacy tests or invoke privileged adapters.
Browser fixtures need a separately installed Playwright package and browser;
inspect their configuration before running them. Browser tests use mock data and
are not proof of hardware control.

## Documentation

- [Architecture and feature status](docs/architecture.html)
- [Privacy and publication boundaries](docs/privacy.html)
- [Development and validation](docs/development.html)
- [Frontend verification scope](docs/frontend-verification.html)
- [Security reporting](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## License

Original project code is under the [MIT License](LICENSE).
Third-party components retain their respective licenses. No vendor tools or
proprietary binaries are bundled. Privacy sanitization is a best-effort review,
not a guarantee that arbitrary future contributions contain no sensitive data.
