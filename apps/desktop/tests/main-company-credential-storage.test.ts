import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

function loadStorage(encryptionAvailable = true) {
  const electron = {
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (value) => Buffer.from(`sealed:${value}`, "utf8"),
      decryptString: (buffer) => {
        const text = buffer.toString("utf8");
        if (!text.startsWith("sealed:")) throw new Error("not sealed");
        return text.slice("sealed:".length);
      },
    },
  };
  return loadTypeScriptModule(
    new URL("../src/main/companyCredentialStorage.ts", import.meta.url),
    { cache: new Map(), mocks: { electron } },
  );
}

const record = (privateKeyPkcs8) => ({
  baseUrl: "https://veil.example",
  orgUid: "org_enterprise",
  orgName: "Northwind",
  userUid: "usr_alice",
  deviceUid: "dev_laptop",
  deviceLabel: "Alice laptop",
  publicKey: "public-key",
  privateKeyPkcs8,
});

test("company credentials are accepted only as OS-encrypted envelopes", () => {
  const storage = loadStorage();
  const sealed = storage.writeProtectedString("device-private-key");
  assert.equal(sealed.encoding, "electron-safe-storage-v1");

  const decoded = storage.decodeCompanyDeviceCredential(record(sealed));
  assert.equal(decoded?.privateKeyPkcs8, "device-private-key");

  // A plaintext private key would downgrade keychain protection to cleartext
  // for anything able to write the credential file.
  for (const tampered of [
    "device-private-key",
    { encoding: "plaintext", encrypted: "device-private-key" },
    { encoding: "electron-safe-storage-v1", encrypted: 42 },
    { encoding: "electron-safe-storage-v1", encrypted: Buffer.from("garbage").toString("base64") },
  ]) {
    assert.equal(storage.readProtectedString(tampered), undefined);
    assert.equal(storage.decodeCompanyDeviceCredential(record(tampered)), null);
    assert.equal(storage.companyConnectionStatusFromValue(record(tampered)).state, "not_enrolled");
  }
});

test("enrollment refuses to write credentials without OS encryption", () => {
  const storage = loadStorage(false);
  assert.throws(() => storage.assertCompanyCredentialStorageAvailable(), /Secure storage is not available/);
  assert.throws(() => storage.writeProtectedString("device-private-key"), /Secure storage is not available/);
});
