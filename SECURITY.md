# Security

This public source preview is not supported for live privileged operation.
Windows runtime startup remains blocked while adapters and hardware-independent
policy undergo qualification.

Do not post secrets, full logs, dumps, device identifiers, home paths, IP addresses,
location coordinates or screenshots of private information in public issues.
For sensitive vulnerabilities, use this repository's private vulnerability
reporting feature when available. If unavailable, ask for a private reporting
channel without disclosing the vulnerability or affected credentials publicly.

For non-sensitive defects, provide a minimal synthetic reproduction, affected
revision and expected behavior. Redact values, not just filenames.

Contributions must preserve loopback restrictions, authenticated local actions,
session ownership, bounded execution, readback and recovery. A successful command
exit alone does not establish that Windows applied a requested change.
