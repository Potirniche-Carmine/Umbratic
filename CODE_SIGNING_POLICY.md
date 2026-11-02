# Signing and privacy

Download official releases from [GitHub Releases](https://github.com/Potirniche-Carmine/Umbratic/releases).

macOS releases are signed with an Apple Developer ID and notarized. Windows
installers are unsigned and may trigger Windows security warnings. Release
artifacts include SHA-256 checksums and GitHub artifact attestations, which
provide build provenance; attestations do not provide a Windows publisher
signature.

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
