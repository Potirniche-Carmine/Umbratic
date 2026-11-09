import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { CloudApproval } from "../../shared/cloud";

export function CloudApprovalCard({ approval, onRespond }: { approval: CloudApproval; onRespond(allow: boolean, answers?: Record<string, string>, remember?: boolean): Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  let summary = approval.detail;
  try {
    const details = JSON.parse(approval.detail);
    summary = [details.command, details.file_path, details.url].find(value => typeof value === "string") || approval.detail;
  } catch { /* Plain-text runtime requests already have a readable summary. */ }
  async function respond(allow: boolean, remember = false) { setBusy(true); try { await onRespond(allow, answers, remember); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); } }
  return <section className="cloudApproval" aria-label="Your input is needed">
    <header><ShieldCheck size={18}/><h3>{approval.title}</h3></header>
    {!approval.questions && summary && <pre>{summary}</pre>}
    {!approval.questions && summary !== approval.detail && <details><summary>Details</summary><pre>{approval.detail}</pre></details>}
    {approval.questions?.map(question => <label className="cloudField" key={question.id}>{question.question}
      {question.options.length > 0 && <div className="cloudAnswerOptions">{question.options.map(option => <button key={option} type="button" aria-pressed={answers[question.id] === option} onClick={() => setAnswers({ ...answers, [question.id]: option })}>{option}</button>)}</div>}
      <input aria-label={question.question} value={answers[question.id] || ""} onChange={event => setAnswers({ ...answers, [question.id]: event.target.value })}/>
    </label>)}
    {approval.command && <p>Always allow remembers this exact command, directory, provider, and workspace. Revoke it in Settings → Providers → Permissions.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="cloudApprovalActions">{approval.command && <button disabled={busy} onClick={() => void respond(true, true)}>Always allow</button>}<button disabled={busy} onClick={() => void respond(false)}>Decline</button><button className="cloudPrimary" disabled={busy || approval.questions?.some(question => !answers[question.id]?.trim())} onClick={() => void respond(true)}>{approval.questions ? "Continue" : "Allow once"}</button></div>
  </section>;
}
