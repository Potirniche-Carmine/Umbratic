# Umbratic AI Desktop

This is the Electron desktop app for Umbratic AI.

Umbratic AI is an enterprise coding-agent workbench. The desktop shell owns the
developer workspace, task lifecycle, permission prompts, IDE handoff, and review
flow while communicating with a company-managed private AI endpoint.

## Run

```powershell
npm install
npm run desktop:dev
```

The app uses an OpenAI-compatible company endpoint. Configure it before launch:

```powershell
$env:UMBRATIC_MODEL_BASE_URL='https://ai.company.internal/v1'
$env:UMBRATIC_MODEL_API_KEY='your-company-issued-secret'
$env:UMBRATIC_MODEL_ID='your-company-model-id'
npm run desktop:dev
```

`http://127.0.0.1:5173` is only the Vite web preview. It can render the UI, but
it cannot pick folders, use the Electron preload bridge, or run real tasks. Use
`npm run desktop:dev` for the actual app.
