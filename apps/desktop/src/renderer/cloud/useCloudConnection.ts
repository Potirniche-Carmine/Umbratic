import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudApi, CloudConnection, CloudProvider } from "../../shared/cloud";

export function useCloudConnection(api: CloudApi, provider: CloudProvider, executable: string) {
  const scope = `${provider}\0${executable}`;
  const [result, setResult] = useState<{ scope: string; connection: CloudConnection } | null>(null);
  const connection = result?.scope === scope ? result.connection : null;
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState<"" | "install" | "connect">("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const inspection = useRef(0);
  const authentication = useRef(0);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inspect = useCallback(async (current: number) => {
    const request = ++inspection.current;
    try {
      const result = await api.inspectCloudProvider({ provider });
      if (generation.current === current && inspection.current === request) {
        setResult({ scope, connection: result }); setChecking(false);
        if (result.state === "ready") { authentication.current = 0; clearTimeout(timer.current); setMessage(""); setWorking(""); }
      }
      return result;
    } catch (error) {
      if (generation.current === current && inspection.current === request) {
        setResult({ scope, connection: { provider, state: "unavailable", models: [], message: error instanceof Error ? error.message : String(error) } });
        setChecking(false);
      }
      throw error;
    }
  }, [api, provider, scope]);
  const refresh = useCallback(async () => {
    setChecking(true);
    try { await inspect(generation.current); } catch { /* The connection carries the error. */ }
  }, [inspect]);
  useEffect(() => {
    generation.current++; authentication.current = 0;
    setResult(null); setMessage(""); setWorking("");
    void refresh();
    const onFocus = () => { if (authentication.current) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      generation.current++; attempt.current++; inspection.current++;
      if (authentication.current) void api.cancelCloudSignIn({ provider }).catch(() => undefined);
      authentication.current = 0; clearTimeout(timer.current); window.removeEventListener("focus", onFocus);
    };
  }, [api, provider, refresh]);
  async function cancel() {
    const current = generation.current;
    attempt.current++; inspection.current++; authentication.current = 0;
    clearTimeout(timer.current); setWorking(""); setChecking(false); setMessage("");
    try { await api.cancelCloudSignIn({ provider }); }
    catch (error) { if (current === generation.current) setMessage(error instanceof Error ? error.message : String(error)); }
  }
  async function connect() {
    const current = generation.current; const id = ++attempt.current;
    authentication.current = Date.now() + 5 * 60_000;
    setWorking("connect"); setMessage("");
    try {
      const result = await api.signInCloudProvider({ provider });
      if (current !== generation.current || id !== attempt.current) return;
      setMessage(result.message);
      const poll = async () => {
        if (current !== generation.current || id !== attempt.current || !authentication.current) return;
        if (Date.now() >= authentication.current) {
          await cancel();
          if (current === generation.current) setMessage("Connection timed out. Try again.");
          return;
        }
        try { await inspect(current); } catch { /* The next poll can recover a browser-login race. */ }
        if (current === generation.current && id === attempt.current && authentication.current) timer.current = setTimeout(() => void poll(), 3000);
      };
      void poll();
    } catch (error) {
      if (current === generation.current && id === attempt.current) {
        authentication.current = 0; setWorking(""); setMessage(error instanceof Error ? error.message : String(error));
      }
    }
  }
  async function install() {
    const current = generation.current;
    setWorking("install"); setMessage("");
    try {
      const result = await api.installCloudProvider({ provider });
      if (current === generation.current) { setResult({ scope, connection: result }); setWorking(""); }
    } catch (error) { if (current === generation.current) { setWorking(""); setMessage(error instanceof Error ? error.message : String(error)); } }
  }
  return { connection, checking: checking || !connection, working, message, refresh, connect, install, cancel };
}
