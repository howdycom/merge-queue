# Security

Report a vulnerability through GitHub private vulnerability reporting on this
repository: Security → Advisories → Report a vulnerability.

Do not open a public issue for a security problem, and do not include tokens,
PATs, or customer data in the report.

The merge queue stores claim state in `state.json` on the `merge-queue-state`
branch of the consumer repository. That file contains pull request numbers and
commit SHAs, not credentials. Callers should still avoid granting the workflow
token more permission than the README lists.
