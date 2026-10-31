# Contributing

Bug reports, focused fixes, and documentation improvements are welcome. Use [GitHub Issues](https://github.com/Potirniche-Carmine/Umbratic/issues) to describe a reproducible problem or discuss a larger change before implementing it.

Include your operating system, Umbratic version, steps to reproduce, and expected behavior. Remove credentials, private prompts, workspace content, and other sensitive information from reports and logs.

## Make a change

1. Follow the setup instructions in [README.md](README.md).
2. Read the nearest `AGENTS.md` for the area you are changing.
3. Keep the change focused and update affected callers and documentation.
4. Install a patched Python release listed in the [build prerequisites](README.md#build-from-source) for the offline kit packaging checks. Run focused checks, then `npm run test:all`. Run any additional checks required by the area's instructions.
5. Open a pull request explaining the problem, resulting behavior, and verification. Include screenshots for visible UI changes.

Dependency changes must keep versions and lockfiles pinned, follow [the supply-chain policy](docs/reference/supply-chain.md), and pass `npm run supply-chain:check`.

Do not put secrets or private infrastructure details in a contribution. For a suspected security vulnerability, email [contact@umbratic.ai](mailto:contact@umbratic.ai) instead of opening a public issue.
