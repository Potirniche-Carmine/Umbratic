# Umbratic docs

Find the thing you are doing.

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
| [guides/deploy-customer.md](guides/deploy-customer.md) | Build a customer's release and install it on their server |
| [guides/operate-server.md](guides/operate-server.md) | Restart, change limits, upgrade, back up, recover |
| [guides/test-locally.md](guides/test-locally.md) | Rehearse the whole thing on your own machine |

## Look up

| Reference | What it holds |
| --- | --- |
| [reference/storage.md](reference/storage.md) | Every path Umbratic writes, and what to back up |
| [reference/limits.md](reference/limits.md) | How many users and requests one server serves |
| [reference/supply-chain.md](reference/supply-chain.md) | Dependency rules and the checks that enforce them |

`release.env.example` is the template for `~/.umbratic/release.env`. Copy it,
do not edit it in place.
