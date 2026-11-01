# Umbratic docs

**Start here: [Server quickstart](guides/deploy-customer.md).** This is the only guide included in the server ZIP.

The remaining pages document source development, signing, and releases.

## Set up once, ever

| Guide | What it does |
| --- | --- |
| [setup/signing-keys.md](setup/signing-keys.md) | Create and retain a deployment's server signing key |
| [setup/signpath-application.md](setup/signpath-application.md) | Prepare the unsubmitted Foundation application and account controls |
| [setup/update-feed.md](setup/update-feed.md) | How public GitHub Releases serve app updates |
| [setup/release-machine.md](setup/release-machine.md) | Inspect packages locally and configure signing |

## Do repeatedly

| Guide | What it does |
| --- | --- |
| [guides/release-desktop.md](guides/release-desktop.md) | Cut and publish a new desktop version |
| [guides/verify-release.md](guides/verify-release.md) | Verify download provenance and operating-system signatures |
| [guides/release-server.md](guides/release-server.md) | Build a signed customer server ZIP |
| [guides/test-locally.md](guides/test-locally.md) | Rehearse the whole thing on your own machine |

## Look up

| Reference | What it holds |
| --- | --- |
| [reference/storage.md](reference/storage.md) | Every path Umbratic writes, and what to back up |
| [reference/supply-chain.md](reference/supply-chain.md) | Dependency rules and the checks that enforce them |
| [Code signing policy](../CODE_SIGNING_POLICY.md) | Current signing status, ownership, scope and privacy |

`release.env.example` is the template for a [local signing identity file](setup/release-machine.md#signing-locally). Copy it,
do not edit it in place.
