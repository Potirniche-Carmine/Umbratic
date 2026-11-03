import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(overrides = {}) {
  const values = []; const deps = []; const cleanups = []; let cursor = 0; let effects = [];
  const listeners = new Map(); const timers = new Map(); let timerId = 0; const cancelled = [];
  const api = {
    inspectCloudProvider: async ({ provider }) => ({ provider, state: "sign_in", models: [], message: "Connect" }),
    signInCloudProvider: async () => ({ message: "Finish connecting in your browser." }),
    cancelCloudSignIn: async ({ provider }) => { cancelled.push(provider); },
    ...overrides,
  };
  const same = (a, b) => a && b.every((value, i) => Object.is(value, a[i]));
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === "function" ? initial() : initial; return [values[i], next => { values[i] = typeof next === "function" ? next(values[i]) : next; }]; },
    useRef(initial) { const i = cursor++; if (!(i in values)) values[i] = { current: initial }; return values[i]; },
    useCallback(fn, next) { const i = cursor++; if (!same(deps[i], next)) { values[i] = fn; deps[i] = next; } return values[i]; },
    useEffect(fn, next) { const i = cursor++; if (!same(deps[i], next)) { deps[i] = next; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const { useCloudConnection } = loadTypeScriptModule(new URL("../src/renderer/cloud/useCloudConnection.ts", import.meta.url), {
    realm: "host", mocks: { react: hooks }, globals: {
      window: { addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener: event => listeners.delete(event) },
      setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    },
  });
  let provider = "claude";
  return {
    api, cancelled, timers,
    render(next = provider) { provider = next; cursor = 0; const result = useCloudConnection(api, provider, ""); const pending = effects; effects = []; pending.forEach(fn => fn()); return result; },
    cleanup() { cleanups.forEach(fn => fn?.()); },
  };
}

test("cancelling an unfinished browser login clears UI work and ignores its late reply", async t => {
  const login = deferred(); const f = harness({ signInCloudProvider: () => login.promise }); t.after(f.cleanup);
  f.render(); await tick(); const pending = f.render().connect();
  assert.equal(f.render().working, "connect");
  await f.render().cancel();
  assert.equal(f.render().working, ""); assert.equal(f.render().checking, false);
  assert.deepEqual(f.cancelled, ["claude"]);
  login.resolve({ message: "Late login response" }); await pending; await tick();
  assert.equal(f.render().message, ""); assert.equal(f.timers.size, 0);
});

test("switching providers cancels the abandoned login and ignores its in-flight catalog", async t => {
  const stale = deferred(); let reads = 0;
  const f = harness({ inspectCloudProvider: async ({ provider }) => {
    if (provider === "claude" && ++reads > 1) return stale.promise;
    return { provider, state: provider === "codex" ? "ready" : "sign_in", models: [{ id: provider }], message: "" };
  } }); t.after(f.cleanup);
  f.render(); await tick(); await f.render().connect();
  f.render("codex"); await tick();
  assert.deepEqual(f.cancelled, ["claude"]);
  stale.resolve({ provider: "claude", state: "ready", models: [{ id: "stale" }] }); await tick();
  const current = f.render();
  assert.equal(current.connection.provider, "codex"); assert.equal(current.connection.models[0].id, "codex");
  assert.equal(current.working, ""); assert.equal(f.timers.size, 0);
});

test("a completed login publishes its fresh catalog and stops polling", async t => {
  let ready = false;
  const f = harness({
    signInCloudProvider: async () => { ready = true; return { message: "Connected" }; },
    inspectCloudProvider: async ({ provider }) => ({ provider, state: ready ? "ready" : "sign_in", models: ready ? [{ id: "provider-model" }] : [], message: "" }),
  }); t.after(f.cleanup);
  f.render(); await tick(); await f.render().connect(); await tick();
  assert.equal(f.render().connection.models[0].id, "provider-model");
  assert.equal(f.render().working, ""); assert.equal(f.timers.size, 0);
});

test("a cancelled sign-in can be retried without reviving the previous poll", async t => {
  const f = harness(); t.after(f.cleanup); f.render(); await tick();
  await f.render().connect(); await tick(); assert.equal(f.timers.size, 1);
  await f.render().cancel(); assert.equal(f.timers.size, 0);
  await f.render().connect(); await tick(); assert.equal(f.timers.size, 1);
  assert.equal(f.render().working, "connect");
});

test("disconnect ignores an older refresh and prevents another inspection until logout settles", async t => {
  const refresh = deferred(); const logout = deferred(); let reads = 0;
  const f = harness({
    inspectCloudProvider: async () => ++reads === 1 ? { provider: "claude", state: "ready", models: [] } : refresh.promise,
    disconnectCloudProvider: () => logout.promise,
  }); t.after(f.cleanup);
  f.render(); await tick();
  const pendingRefresh = f.render().refresh();
  const pendingLogout = f.render().disconnect();
  await f.render().refresh(); assert.equal(reads, 2);
  refresh.resolve({ provider: "claude", state: "ready", models: [{ id: "stale" }] }); await pendingRefresh;
  assert.equal(f.render().working, "disconnect");
  logout.resolve({ provider: "claude", state: "sign_in", models: [] }); await pendingLogout;
  assert.equal(f.render().connection.state, "sign_in"); assert.equal(f.render().working, "");
});

test("failed logout retains the account and can be retried", async t => {
  let fail = true;
  const f = harness({
    inspectCloudProvider: async () => ({ provider: "claude", state: "ready", models: [] }),
    disconnectCloudProvider: async () => { if (fail) throw new Error("Try again"); return { provider: "claude", state: "sign_in", models: [] }; },
  }); t.after(f.cleanup);
  f.render(); await tick(); await f.render().disconnect();
  assert.equal(f.render().connection.state, "ready"); assert.equal(f.render().message, "Try again");
  fail = false; await f.render().disconnect();
  assert.equal(f.render().connection.state, "sign_in"); assert.equal(f.render().message, "");
});
