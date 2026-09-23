# Security policy

## Reporting a vulnerability

Do not open a public issue for a security vulnerability. Once the public
repository exists, report it through GitHub's private vulnerability reporting
(Security tab → Report a vulnerability) so it can be fixed before disclosure.

## Scope notes

Deployment provisioning, binding registries, credentials, and runtime state
are intentionally outside this repository. Never commit a binding registry,
token file, `.env` file, workspace, native session, or bot token; keep them
in the operator's private configuration directory.
