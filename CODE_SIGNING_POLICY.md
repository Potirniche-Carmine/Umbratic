# Code signing policy

SignPath Foundation signing is not approved or enabled. Application material is
being prepared; no application or terms agreement has been submitted by this
project. The Windows policy below is proposed and remains subject to the
Foundation's acceptance of the project, artifacts and signing scope.

If accepted, the attribution will be: Free code signing provided by
[SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

## Release control

Release candidates come from the public [Umbratic repository](https://github.com/Potirniche-Carmine/Umbratic),
at the exact current `main` commit after its complete CI succeeds. Only
GitHub-hosted runners may submit signing artifacts. Each signing request needs
human approval; publication waits for all platforms and verifies the resulting
signatures, artifact provenance and updater checksums.

| Role | Member | Responsibility |
| --- | --- | --- |
| Author and reviewer | [Potirniche-Carmine](https://github.com/Potirniche-Carmine) | Maintain source and build scripts; review external contributions |
| Proposed signing approver | [Potirniche-Carmine](https://github.com/Potirniche-Carmine) | Review the exact source, build and signing request before approving |

GitHub and SignPath access for these roles must use multi-factor authentication.
The SignPath role is not active until account setup and project approval finish.

## What may be signed

The proposed project scope covers Umbratic-maintained executable code and its
installer/uninstaller. The final artifact configuration must be approved by the
Foundation and enforce the project name and matching release version.

The desktop launcher derives from Electron: changing its name, resources or
fuses does not establish eligibility as Umbratic-maintained source. Electron,
llama.cpp, stable-diffusion.cpp, ggml, native Node modules and Microsoft runtime
DLLs are upstream components. Their derivation, patches, licenses and signature
status are disclosed in the [application preparation](docs/setup/signpath-application.md)
and [runtime review](docs/reference/runtime-security.md). They are not covered by
an assumed right to apply the project's certificate. Preserve valid upstream
signatures and require explicit scope review for any upstream-derived launcher.

A signed installer can contain unsigned upstream code. Neither a signature nor
a GitHub attestation guarantees that Windows Smart App Control permits every
component, or that software contains no vulnerabilities.

## Privacy

Umbratic has no product analytics or automatic diagnostic uploads. Local history
and redacted logs stay on the device. Network activity includes requested model
downloads, GitHub release checks when updates are enabled, optional web search,
and authentication/model requests to the selected Veil server. A company server
has its operator's data policy. External services can retain requests according
to their own policies: [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement),
[Hugging Face](https://huggingface.co/privacy) and the
[Brave Search API](https://api-dashboard.search.brave.com/privacy-policy).
Signing and notarization send release binaries, not user workspaces, to their
signing providers.

Report suspected signing abuse or vulnerabilities through [SECURITY.md](SECURITY.md).
Maintainer setup and download verification are in the
[desktop release guide](docs/guides/release-desktop.md).
