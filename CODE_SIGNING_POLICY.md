# Code signing policy

SignPath Foundation signing is not approved or enabled. If accepted: Free code
signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

Release page: [GitHub Releases](https://github.com/Potirniche-Carmine/Umbratic/releases).

## Release control

[Potirniche-Carmine](https://github.com/Potirniche-Carmine) is the author,
reviewer of external contributions and proposed signing approver. GitHub and
SignPath access must use multi-factor authentication. Each signing request
requires human approval.

The release workflow builds the verified current `main` commit on GitHub-hosted
runners and checks signatures before publication. Proposed Windows signing
covers Umbratic executables and its installer/uninstaller, subject to the
Foundation's approval of the exact artifacts. The Electron-derived launcher
requires explicit scope approval. Upstream libraries and runtimes are not
assumed eligible for the project's certificate; valid upstream signatures are
preserved.

## Privacy

Umbratic has no product analytics or automatic diagnostic uploads. History and
redacted logs stay on the device. Network activity includes requested model
downloads, enabled release checks, optional web search, and authentication/model
requests to the selected Veil server. Server operators set their own data
policies. External services have their own policies:
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement),
[Hugging Face](https://huggingface.co/privacy) and
[Brave Search API](https://api-dashboard.search.brave.com/privacy-policy).
Signing providers receive release binaries, not user workspaces.

Report vulnerabilities or signing abuse through [SECURITY.md](SECURITY.md).
