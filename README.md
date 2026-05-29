# Umbratic AI

Umbratic AI is a secure enterprise desktop app for AI-assisted software work.

It is designed for companies that want the leverage of coding agents without
sending proprietary code, prompts, telemetry, or engineering context to public
AI services. A business runs its own Umbratic AI server infrastructure, such as
a private rack or internal model cluster, and the desktop app communicates with
that company-controlled environment over a hardened private connection.

The goal is not to replace developers. The goal is to give developers a better
workbench: one that helps them inspect, change, test, and review code faster
while keeping final judgment in human hands.

## What It Is

Umbratic AI is a private coding-agent platform for engineering teams.

Developers work in the desktop app. The company operates the server-side model
and telemetry environment. The app sends task context only to the configured
company endpoint, receives agent actions and model responses from that private
infrastructure, and keeps the developer in control of what changes are accepted.

The workflow is built around visibility. A developer can choose a repository or
folder, ask for a change, watch the task progress, inspect command results, and
review the final diff before approving anything.

## Why It Exists

Most AI coding tools force a bad tradeoff: productivity or confidentiality.
Umbratic AI is meant to remove that tradeoff for businesses that need privacy,
control, and auditability.

The product is built around a few beliefs:

- Developers should be empowered, not replaced.
- Company code and telemetry should stay under company control.
- The model endpoint should be private, explicit, and governed by the business.
- Agent work should be reviewable before it becomes real work.
- Telemetry should help the company improve its own workflows and models without
  leaking engineering context outside the organization.

## Enterprise Architecture

Umbratic AI is intended to run as a company-owned system:

- **Desktop app:** The developer-facing workspace for chats, tasks, review, and
  approval.
- **Private server endpoint:** The company-managed model gateway or internal AI
  service that the app talks to.
- **Secure transport:** A confidential channel between the app and the company
  server, with support for hardened private endpoint configuration.
- **Company telemetry store:** Task outcomes, approvals, feedback, and
  operational signals live on the company's server.
- **Periodic fine-tuning loop:** Every few months, the company can use its own
  telemetry to adapt models or workflows to its engineering standards, codebase
  patterns, and review expectations.

## What Developers Can Do

- Open a project or repository.
- Start a coding task from a chat prompt.
- Attach relevant files for context.
- Let the agent inspect, edit, and test inside the selected workspace.
- Watch task progress through visible events.
- Review changed files in the app.
- Open the task in an IDE for manual inspection.
- Approve, reject, or keep the generated work.
- Give feedback that helps the company improve future model behavior.

## The Workflow

1. A developer selects the project they are working on.
2. They describe the change, fix, or investigation.
3. Umbratic AI sends the task through the configured private company endpoint.
4. The company-managed AI infrastructure performs the agent work.
5. The developer reviews the resulting diff and task evidence.
6. The developer decides whether to accept, revise, or discard the work.
7. Company-owned telemetry records the outcome for audit, analytics, and future
   improvement.

## Secure, Confidential, Private

Umbratic AI is designed for organizations that need strong boundaries around
their engineering data.

The desktop app should communicate only with the company's approved endpoint.
Telemetry belongs to the company. Fine-tuning and evaluation should happen from
that company's own data, according to that company's governance rules.

This keeps the AI system close to the business: private code stays private,
team-specific feedback becomes useful, and improvements compound around how the
company actually builds software.

## How To Run It

Install dependencies:

```powershell
npm install
```

Start the desktop app:

```powershell
npm run desktop:dev
```

Configure the company endpoint before starting the app:

```powershell
$env:UMBRATIC_MODEL_BASE_URL='https://ai.company.internal/v1'
$env:UMBRATIC_MODEL_API_KEY='your-company-issued-secret'
$env:UMBRATIC_MODEL_ID='your-company-model-id'
npm run desktop:dev
```

For private mTLS deployments, configure the issued CA and client credential:

```powershell
$env:UMBRATIC_MODEL_MTLS_CA_PATH='C:\path\to\ca.pem'
$env:UMBRATIC_MODEL_MTLS_PFX_PATH='C:\path\to\client.pfx'
$env:UMBRATIC_MODEL_MTLS_PASSPHRASE='credential-passphrase'
$env:UMBRATIC_MODEL_TLS_SERVER_NAME='ai.company.internal'
```

## Notes

Use `npm run desktop:dev` for the real app experience. The Vite browser preview
can render the interface, but it cannot pick folders, use the Electron preload
bridge, run tasks, or talk to the runner the same way the desktop app can.

Umbratic AI is still early, but the direction is clear: secure company-owned AI
infrastructure that makes developers more capable while keeping engineering data
confidential and private.
