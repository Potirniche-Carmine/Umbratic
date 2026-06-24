# Umbratic

Umbratic is a desktop AI app built with Electron, Vite, React, and TypeScript.

## Getting Started

Install dependencies:

```sh
npm install
```

Run the desktop app in development:

```sh
npm run desktop:dev
```

Open the seeded composer UI fixture:

```sh
npm --workspace @umbratic/desktop run dev:composer
```

Build the desktop app:

```sh
npm run desktop:build
```

Run the full test suite:

```sh
npm run test:all
```

## Project Structure

- `apps/desktop/` - Electron desktop app
- `packages/runner/` - local runner package
- `apps/desktop/tests/` - desktop app tests
- `apps/desktop/assets/` - app assets and branding
- `infrastructure/veil/` - Go service that owns model boundary policy and runtime calls
