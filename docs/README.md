# Umbratic docs

**For customers: [Server quickstart](guides/deploy-customer.md).** This is the only guide included in the server ZIP.

The remaining pages are internal release and engineering references.

## Set up once, ever

| Guide | What it does |
| --- | --- |
| [setup/signing-keys.md](setup/signing-keys.md) | Create the two keys every release is built with |
| [setup/update-feed.md](setup/update-feed.md) | Create the bucket and Worker that serve app updates |
| [setup/release-machine.md](setup/release-machine.md) | Prepare a Mac or Windows PC to build signed releases |

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

`release.env.example` is the template for the [release machine's identity file](setup/release-machine.md#2-the-env-file-both-machines). Copy it,
do not edit it in place.
