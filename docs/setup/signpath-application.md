# SignPath Foundation application preparation

This is an unsubmitted application draft. It does not accept terms, create an
account or claim that signing has been granted. The owner submits the
[official application](https://signpath.org/apply) after reviewing the
[Foundation conditions](https://signpath.org/terms) and the current public
[Code signing policy](../../CODE_SIGNING_POLICY.md).

## Copy-ready project fields

Use the repository as the homepage while `umbratic.ai` still serves the former
team-services copy. Publish the policy and these release instructions before
submitting. The current application uses these field names:

| Field | Prepared answer |
| --- | --- |
| Project Name | Umbratic |
| Repository URL | https://github.com/Potirniche-Carmine/Umbratic |
| Homepage URL | https://github.com/Potirniche-Carmine/Umbratic |
| Tagline | An open-source AI harness for code, files and documents. |
| Category | AI Tools |
| Build System | GitHub Actions |
| Maintainer Type (optional) | Individual maintainer(s) |
| Privacy Policy URL (optional) | https://github.com/Potirniche-Carmine/Umbratic/blob/main/CODE_SIGNING_POLICY.md#privacy |
| Download URL (optional) | Leave blank until an actual release exists and its download page links the Code signing policy. |
| Wikipedia (optional) | Leave blank; no entry is claimed. |
| Company (optional) | Leave blank unless the owner supplies an applicable legal organization. |

Description:

> Umbratic is an MIT-licensed desktop AI harness built with Electron, React,
> Rust and Go. It works with code, files and documents in a user-selected
> workspace, with review, permissions and approvals for tools and changes.
> Model requests pass through Veil, either locally or on a server selected by
> the operator. The app has no product telemetry or automatic diagnostic
> uploads. It includes general workspace command execution; it is not designed
> as a vulnerability scanner or exploitation toolkit. We request review of the
> exact Windows signing scope, including its Electron-derived launcher and
> bundled upstream runtimes, before enabling any Foundation certificate.

Reputation:

> Umbratic is newly public. We do not claim an established user base, download
> count or independent reputation. Source, license, security policy, dependency
> inventory and CI are public. Native macOS ARM64 and Windows x64/ARM64 CI build
> production installers, exercise native resources, and verify archive and
> updater checksums. There is currently no published GitHub release. We can
> provide the public CI runs and candidate artifacts/provenance for review;
> please advise whether these satisfy initial review or what prior release and
> reputation evidence is required. We understand acceptance is discretionary.

Public evidence: [source and license](https://github.com/Potirniche-Carmine/Umbratic),
[CI runs](https://github.com/Potirniche-Carmine/Umbratic/actions/workflows/verify.yml),
[release workflow](https://github.com/Potirniche-Carmine/Umbratic/blob/main/.github/workflows/release.yml),
[security reporting](https://github.com/Potirniche-Carmine/Umbratic/security/policy),
[runtime review](../reference/runtime-security.md) and
[supply-chain rules](../reference/supply-chain.md).

Public snapshot, checked 2026-10-31 (America/Los_Angeles): the
[repository](https://github.com/Potirniche-Carmine/Umbratic) has zero stars and
forks and [no published releases](https://github.com/Potirniche-Carmine/Umbratic/releases).
GitHub records its creation on 2026-04-30; that is not a claim that it was public
then. The complete [main history](https://github.com/Potirniche-Carmine/Umbratic/commits/main/)
at `9c2b009dcddc1de87b62dc29f9707b02b5e4cec5` contains 349 commits.
Refresh these facts before submitting; none establishes adoption or acceptance.

## Owner-only fields and decisions

The owner supplies First Name, Last Name and Email, chooses the truthful
Primary Discovery Channel and any exact discovery source, and reviews the
required Code of Conduct and personal-data-processing agreements. Account
creation is part of the application. Leave the optional marketing consent
unchecked unless the owner chooses it. No contact identity, referral,
agreement or popularity claim is supplied on the owner's behalf here.

The conditions require an existing release in the intended form and verifiable
reputation. Candidate CI output does not automatically meet those conditions.
Do not present an unpublished build as a released product, promise acceptance,
or bypass the signed-publication gate to manufacture eligibility.

## Artifact scope to disclose

| Component | Derivation and proposed treatment |
| --- | --- |
| Rust runner, file-search, PDF, code-index and spreadsheet helpers; Go Veil | First-party entry points built from this repository with locked open-source dependencies; proposed project signing scope, subject to artifact review |
| Desktop launcher | Upstream Electron executable packaged with Umbratic's JavaScript/ASAR, resources and fuse settings; relabeling is not proof of own-source eligibility. Explicit Foundation approval of this derivation is required. |
| NSIS installer and uninstaller | Generated by the reviewed electron-builder/NSIS toolchain; request explicit approval for both generated artifacts and their staged signing configuration |
| llama.cpp and stable-diffusion.cpp/ggml | Pinned upstream sources with documented security/download-control patches; no separate publicly maintained fork is claimed. Do not assume project signing eligibility. |
| Native Node modules and Electron libraries | Upstream package artifacts with recorded provenance; preserve upstream signatures where valid and keep them outside unapproved project-signing scope |
| Microsoft CRT/OpenMP runtime DLLs | Original Microsoft signatures and redistribution notices are retained; ask the Foundation to confirm the applicable System Libraries exception |
| Model weights | Not included in the desktop installer. Downloads are user-directed and governed by their separate model licenses. |

The exact Windows inventory and product/version restrictions must accompany the
artifact configuration. Public provenance and a signed outer installer do not
turn an unsigned upstream component into a signed component.

## Account configuration after acceptance

Use the official GitHub trusted build system, link only this repository, require
origin verification on `main`, and use a CI submitter distinct from the human
approval role. Every signing request requires manual approval. Project roles
and MFA enrollment must match the public policy; no additional reviewer is
invented by this draft. The [SignPath project documentation](https://docs.signpath.io/projects)
and [GitHub integration](https://docs.signpath.io/trusted-build-systems/github)
describe these account controls.

Only after the Foundation confirms the project, certificate subject and exact
artifact configurations should the owner add the token and identifiers listed
in the [release guide](../guides/release-desktop.md). Keep the token in GitHub
Actions secrets. Do not upload user workspaces, credentials, or a locally built
binary as a substitute for the trusted CI artifact.

The [SignPath GitHub App](https://github.com/apps/signpath) is not installed for
this repository. Its reviewed installation screen requests read access to
Actions, code and metadata, plus read/write access to repository administration.
The owner must review this grant, select the personal account, choose **Only
select repositories**, and select **Potirniche-Carmine/Umbratic** only. Do not
select all repositories. The final **Install** action has not been performed.
Application submission, account creation, both required agreements and this
GitHub permission grant remain explicit owner actions.
