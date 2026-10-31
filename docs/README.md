# Umbratic docs

**Start here: [Server quickstart](guides/deploy-customer.md).** This is the only guide included in the server ZIP.

The remaining pages document source development, signing, and releases.

## Set up once, ever

| Guide | What it does |
| --- | --- |
| [setup/signing-keys.md](setup/signing-keys.md) | Create the two keys every release is built with |
| [setup/update-feed.md](setup/update-feed.md) | How public GitHub Releases serve app updates |
| [setup/release-machine.md](setup/release-machine.md) | Inspect packages locally and configure signing |

## Do repeatedly

| Guide | What it does |
| --- | --- |
| [guides/release-desktop.md](guides/release-desktop.md) | Cut and publish a new desktop version |
| [guides/release-server.md](guides/release-server.md) | Build a signed customer server ZIP |
| [guides/test-locally.md](guides/test-locally.md) | Rehearse the whole thing on your own machine |

## Look up

| Reference | What it holds |
| --- | --- |
| [reference/storage.md](reference/storage.md) | Every path Umbratic writes, and what to back up |
| [reference/supply-chain.md](reference/supply-chain.md) | Dependency rules and the checks that enforce them |
| [reviews/production-readiness-2026-09-19.md](reviews/production-readiness-2026-09-19.md) | Structural review, fixes, verification evidence, and remaining release qualifications |

`release.env.example` is the template for a [local signing identity file](setup/release-machine.md#signing-locally). Copy it,
do not edit it in place.
