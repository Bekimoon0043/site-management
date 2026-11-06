# GitHub owner-only setup

Repository files can guide compliant AI tools, but GitHub settings enforce who can
read and change the project. Complete these steps after the first push.

## 1. Keep the repository private

In **Settings → General → Danger Zone → Change repository visibility**, select
**Private**. Do not add collaborators, outside collaborators, deploy keys with
write access, or third-party apps that do not need access.

## 2. Protect the default branch

In **Settings → Rules → Rulesets**, create an active branch ruleset targeting the
default branch and configure:

- Restrict updates.
- Restrict deletions.
- Block force pushes.
- Require a pull request before merging.
- Require approvals and dismiss stale approvals.
- Require status checks to pass: **Owner authorization**.
- Do not add bypass actors.

The workflow uses GitHub's authenticated `github.actor` and accepts only
`Bekimoon0043`. This remains true in forks. It does not trust a name, email,
password, token, commit author, issue, comment, or AI prompt as proof of identity.

## 3. Secure the owner account

- Enable passkeys or two-factor authentication on GitHub.
- Review active sessions, personal access tokens, SSH keys, GitHub Apps, and OAuth
  applications regularly.
- Use environment protection and scoped secrets for deployments.
- Enable GitHub secret scanning and push protection when available.

## 4. Understand the boundary

These controls prevent unauthorized changes to the original repository when
configured correctly. They do not make a public repository confidential, control
what a fork owner does on their own computer, detect every AI-assisted edit, or
force hostile/non-compliant AI systems to obey `AGENTS.md`. The no-AI restriction
in `LICENSE` is a condition of permission, not a technical lock.

