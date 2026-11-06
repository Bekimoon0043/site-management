# Security and access policy

This project is owner-controlled. Do not submit security-sensitive details in a
public issue or pull request.

## Repository visibility

Keep the GitHub repository **private** if source confidentiality is required. A
public repository can be read, cloned, copied, indexed, and analyzed by anyone;
no AI instruction file can prevent that.

## Authorized changes

Only the authenticated GitHub account `Bekimoon0043` may authorize AI use or
propose changes to the original repository. This remains the designated Commander
identity in forks. The `Owner authorization` workflow rejects pull requests whose
authenticated GitHub actor is not `Bekimoon0043`. The default branch must also
require this status check and block direct pushes; see
`docs/github-owner-only.md`.

Forking grants no permission to use AI with this project. See `LICENSE`.

## Credentials

Never commit `.env` files, passwords, service-role keys, access tokens, private
keys, signing keys, database dumps, or production/customer data. If a credential
was ever committed or shared, rotate it immediately; deleting it from the latest
commit is not sufficient.

