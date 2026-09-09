import assert from "node:assert/strict";
import test from "node:test";

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
