# Signing and privacy

Download official releases from [GitHub Releases](https://github.com/Potirniche-Carmine/Umbratic/releases).

macOS releases are signed with an Apple Developer ID and notarized. Windows
installers are unsigned and may trigger Windows security warnings. Release
downloads are verified against GitHub's SHA-256 asset digests. Checksums and
GitHub artifact attestations are verified before publication and retained in
the release workflow's CI artifacts; they do not provide a Windows publisher
signature. Public release assets contain only the app packages.

The clean `v0.0.2` release is the baseline. Its existing installers use the old
YAML update feed, so existing users must manually install a build containing
the new release API updater before automatic updates can resume. GitHub adds
source-code archive links and digest labels to its release page automatically.

## Privacy

Umbratic has no product analytics or automatic diagnostic uploads. History and
redacted logs stay on the device. Network activity includes requested model
downloads, enabled release checks, optional web search, and authentication/model
requests to the selected Veil server. Server operators set their own data
policies. External services have their own policies:
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement),
[Hugging Face](https://huggingface.co/privacy) and
[Brave Search API](https://api-dashboard.search.brave.com/privacy-policy).

Report vulnerabilities or suspected release tampering through [SECURITY.md](SECURITY.md).
