import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("company enrollment stores only the encrypted-device input and renews opaque sessions", async () => {
  let stored = null;
  let cleared = false;
  const calls = [];
  let sessionNumber = 0;
  const storage = {
    assertCompanyCredentialStorageAvailable() {},
    writeCompanyDeviceCredential(value) {
      stored = value;
      return value;
    },
    readCompanyCertificate() { return stored; },
    readCompanyDeviceCredential() {
      return stored;
    },
    clearCompanyDeviceCredential() {
      cleared = true;
      stored = null;
    },
    companyConnectionStatus() {
      return stored
        ? {
            state: "enrolled",
            baseUrl: stored.baseUrl,
            orgName: stored.orgName,
            deviceLabel: stored.deviceLabel,
          }
        : { state: "not_enrolled" };
    },
  };
  const providerClient = {
    async postProviderJson(url, body, options = {}) {
      calls.push({ url, body, options });
      if (url.endsWith("/api/enrollment/enroll")) {
        return {
          statusCode: 201,
          statusMessage: "Created",
          text: "",
          json: {
            org_uid: "org_enterprise",
            org_name: "Northwind",
            user_uid: "usr_alice",
            device_uid: "dev_laptop",
          },
        };
      }
      if (url.endsWith("/api/session/challenge")) {
        return {
          statusCode: 201,
          statusMessage: "Created",
          text: "",
          json: {
            challenge_uid: `chal_${sessionNumber + 1}`,
            challenge: `umbratic-device-session-v1.dev_laptop.challenge-${sessionNumber + 1}`,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        };
      }
      if (url.endsWith("/api/session")) {
        sessionNumber += 1;
        return {
          statusCode: 201,
          statusMessage: "Created",
          text: "",
          json: {
            session_token: `umbs_${"a".repeat(30)}${sessionNumber}`,
            expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
            org_name: sessionNumber === 1 ? "Northwind" : "Contoso",
          },
        };
      }
      return { statusCode: 204, statusMessage: "No Content", text: "", json: null };
    },
  };
  const identity = loadTypeScriptModule(
    new URL("../src/main/companyIdentity.ts", import.meta.url),
    { cache: new Map(), mocks: { "./storage": storage, "./providerClient": providerClient } },
  );

  const credential = await identity.enrollCompanyDevice({
    baseUrl: "https://veil.example.com/",
    enrollmentCode: `umbr_${"x".repeat(40)}`,
    deviceLabel: "Work laptop",
  });
  assert.equal(credential.deviceUid, "dev_laptop");
  assert.equal(stored.baseUrl, "https://veil.example.com");
  assert.equal(stored.orgName, "Northwind");
  assert.ok(stored.privateKeyPkcs8.length > 40);
  assert.equal(calls[0].body.enrollment_code, `umbr_${"x".repeat(40)}`);
  assert.equal(typeof calls[0].body.private_key, "undefined");
  assert.equal(calls.some((call) => JSON.stringify(call.body).includes(stored.privateKeyPkcs8)), false);

  const cached = await identity.ensureCompanySession();
  assert.equal(cached, `umbs_${"a".repeat(30)}1`);
  assert.equal(sessionNumber, 1);
  const renewed = await identity.renewCompanySession();
  assert.equal(renewed, `umbs_${"a".repeat(30)}2`);
  assert.equal(sessionNumber, 2);
  assert.equal(stored.orgName, "Contoso");

  await identity.disconnectCompanySession();
  await assert.rejects(
    identity.ensureCompanySession(),
    /company server is disconnected/i,
  );
  const reconnected = await identity.connectCompanySession();
  assert.equal(reconnected, `umbs_${"a".repeat(30)}3`);

  await identity.disconnectCompanyDevice();
  assert.equal(cleared, true);
  assert.equal(calls.at(-1).options.headers.Authorization, `Bearer ${reconnected}`);
});

function sessionHarness() {
  const pair = crypto.generateKeyPairSync("ed25519");
  const credential = {
    baseUrl: "https://veil.example", deviceUid: "dev_laptop", orgName: "Example",
    privateKeyPkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
  let challenges = 0;
  let sessions = 0;
  let latestChallenge = "";
  let fail = false;
  let release;
  let wait = Promise.resolve();
  const identity = loadTypeScriptModule(new URL("../src/main/companyIdentity.ts", import.meta.url), {
    mocks: {
      "./companyTrust": { companyTLS: () => undefined },
      "./storage": {
        readCompanyDeviceCredential: () => credential,
      },
      "./providerClient": {
        async postProviderJson(url, body) {
          if (url.endsWith("/challenge")) {
            latestChallenge = `chal_${++challenges}`;
            return { statusCode: 201, json: { challenge_uid: latestChallenge, challenge: "umbratic-device-session-v1.test" } };
          }
          if (url.endsWith("/logout")) return { statusCode: 204 };
          sessions++;
          await wait;
          if (fail || body.challenge_uid !== latestChallenge) {
            return { statusCode: 401, json: { code: "challenge_invalid" } };
          }
          assert.equal(crypto.verify(null, Buffer.from("umbratic-device-session-v1.test"), pair.publicKey, Buffer.from(body.signature, "base64url")), true);
          return { statusCode: 201, json: {
            session_token: `umbs_session${sessions}`, org_name: "Example",
            expires_at: new Date(Date.now() + 900_000).toISOString(),
          } };
        },
      },
    },
  });
  return { identity, counts: () => ({ challenges, sessions }), fail: (value) => { fail = value; }, hold: () => { wait = new Promise((done) => { release = done; }); }, release: () => release() };
}

test("concurrent status, discovery and renewal share one device challenge", async () => {
  const { identity, counts } = sessionHarness();
  const tokens = await Promise.all([identity.ensureCompanySession(), identity.ensureCompanySession(), identity.renewCompanySession(), identity.connectCompanySession()]);
  assert.equal(new Set(tokens).size, 1);
  assert.deepEqual(counts(), { challenges: 1, sessions: 1 });
  await Promise.all([identity.renewCompanySession(), identity.ensureCompanySession(), identity.renewCompanySession()]);
  assert.deepEqual(counts(), { challenges: 2, sessions: 2 });
});

test("a failed shared exchange can be retried without refreshing the connection", async () => {
  const h = sessionHarness();
  h.fail(true);
  const results = await Promise.allSettled([h.identity.ensureCompanySession(), h.identity.ensureCompanySession()]);
  assert.ok(results.every((result) => result.status === "rejected"));
  h.fail(false);
  assert.match(await h.identity.ensureCompanySession(), /^umbs_/);
  assert.deepEqual(h.counts(), { challenges: 2, sessions: 2 });
});

test("disconnect prevents an in-flight session from restoring credentials", async () => {
  const h = sessionHarness();
  h.hold();
  const pending = h.identity.ensureCompanySession();
  const rejected = assert.rejects(pending, /connection changed/);
  await new Promise((resolve) => setImmediate(resolve));
  const disconnect = h.identity.disconnectCompanySession();
  h.release();
  await Promise.all([rejected, disconnect]);
  assert.equal(h.identity.currentCompanySessionToken(), "");
  await assert.rejects(h.identity.ensureCompanySession(), /disconnected/);
  assert.match(await h.identity.connectCompanySession(), /^umbs_/);
});
