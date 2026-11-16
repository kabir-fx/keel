# Security reference

Used by the security lens, and by the `architect` skill when a design crosses a trust boundary.

## Trust boundaries

A trust boundary is any place where data or control passes between parties with different privileges: the network edge, a user's input, a file someone else wrote, another service, a subprocess, a model's output, a dependency. Input from across a boundary is hostile until it has been validated on the inside.

## Threat sweep

For each boundary the change touches, answer each row in a line.

| Threat | Question |
|---|---|
| Spoofing | Can someone pretend to be another user or service? |
| Tampering | Can data be changed in transit or at rest without detection? |
| Repudiation | Could someone deny an action because nothing recorded it? |
| Information disclosure | Can someone read what they should not, in responses, errors, or logs? |
| Denial of service | Can one caller exhaust memory, CPU, disk, connections, or money? |
| Elevation of privilege | Can a caller do what only a higher role should? |

## What to hunt

- **Injection.** Input that reaches SQL, a shell, a template, a file path, HTML, a regex, or a deserialiser as code instead of data. Look for string-built queries and commands, `eval`, `pickle`, unsafe YAML loading, `shell=True`.
- **Missing authorisation.** The caller is authenticated, but nothing checks that this caller may touch this object. Check every new endpoint and every lookup by id.
- **Secrets.** Keys, tokens, or passwords in code, config, logs, error messages, test fixtures, or git history. Secrets compared with `==` instead of a constant-time compare.
- **Unsafe defaults.** Debug mode, wide-open CORS, disabled TLS verification, world-readable files, permissive deserialisation.
- **Path and URL handling.** Path traversal with `..`, followed symlinks, requests to a URL the attacker chose, open redirects.
- **Resource limits.** Unbounded input size, loops or recursion driven by input, missing timeouts, no rate limit on a costly operation.
- **Cryptography.** Hand-rolled crypto, fast hashes for passwords, predictable randomness for tokens.
- **Dependencies.** For a new dependency: is it needed, maintained, and pinned? Run the ecosystem's audit: `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`.
- **Model and agent input.** Text from a model, a web page, a file, or a tool result that reaches a prompt, a shell, or a tool call is untrusted input. It must not be able to choose commands, paths, or recipients.
- **Error handling.** Errors that leak internals to the caller, and checks that fail open: the check throws, so access is granted.

## Ask first

Each of these needs my decision, recorded, before it ships:

- a new dependency, or a major version bump;
- a change to authentication, sessions, or permission checks;
- new storage or logging of personal data;
- a new network listener, a public endpoint, or an outbound call to a new host;
- disabling or weakening a security control, even temporarily;
- handling payment data or credentials.
