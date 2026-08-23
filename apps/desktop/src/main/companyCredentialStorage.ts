import { safeStorage } from "electron";

import type { CompanyConnectionStatus } from "../shared/desktopApi";
import { isRecord } from "./utils";

export type StoredProtectedString = {
  encoding: "electron-safe-storage-v1";
  encrypted: string;
};

type StoredCompanyDeviceCredential = {
  baseUrl: string;
  orgUid: string;
  orgName: string;
  userUid: string;
  deviceUid: string;
  deviceLabel: string;
  publicKey: string;
  privateKeyPkcs8: StoredProtectedString;
};

export type CompanyDeviceCredential = Omit<StoredCompanyDeviceCredential, "privateKeyPkcs8"> & {
  privateKeyPkcs8: string;
};

/**
 * Only an OS-encrypted envelope is a valid secret. A bare string would let
 * anything that can write the settings file downgrade keychain protection to
 * cleartext, and nothing binds a record to this installation, so a tampered
 * file would be indistinguishable from a legitimate one.
 */
export function readProtectedString(value: unknown): string | undefined {
  if (!isRecord(value) || value.encoding !== "electron-safe-storage-v1" || typeof value.encrypted !== "string") {
    return undefined;
  }
  try {
    return safeStorage.decryptString(Buffer.from(value.encrypted, "base64"));
  } catch {
    return undefined;
  }
}

export function writeProtectedString(
  value: string,
  unavailableMessage = "Secure storage is not available, so endpoint tokens were not saved.",
): "" | StoredProtectedString {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error(unavailableMessage);
  return {
    encoding: "electron-safe-storage-v1",
    encrypted: safeStorage.encryptString(value).toString("base64"),
  };
}

export function decodeCompanyDeviceCredential(value: unknown): CompanyDeviceCredential | null {
  if (!isRecord(value) || "version" in value) return null;
  const required = ["baseUrl", "orgUid", "orgName", "userUid", "deviceUid", "deviceLabel", "publicKey"] as const;
  if (required.some((name) => typeof value[name] !== "string" || !value[name])) return null;
  const privateKeyPkcs8 = readProtectedString(value.privateKeyPkcs8);
  if (!privateKeyPkcs8) return null;
  return {
    baseUrl: value.baseUrl as string,
    orgUid: value.orgUid as string,
    orgName: value.orgName as string,
    userUid: value.userUid as string,
    deviceUid: value.deviceUid as string,
    deviceLabel: value.deviceLabel as string,
    publicKey: value.publicKey as string,
    privateKeyPkcs8,
  };
}

export function encodeCompanyDeviceCredential(input: CompanyDeviceCredential): StoredCompanyDeviceCredential {
  return {
    baseUrl: input.baseUrl,
    orgUid: input.orgUid,
    orgName: input.orgName,
    userUid: input.userUid,
    deviceUid: input.deviceUid,
    deviceLabel: input.deviceLabel,
    publicKey: input.publicKey,
    privateKeyPkcs8: writeProtectedString(
      input.privateKeyPkcs8,
      "Secure storage is not available, so the device credential was not saved.",
    ) as StoredProtectedString,
  };
}

export function assertCompanyCredentialStorageAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure storage is not available, so this device cannot enroll.");
  }
}

export function companyConnectionStatusFromValue(value: unknown): CompanyConnectionStatus {
  const credential = decodeCompanyDeviceCredential(value);
  if (!credential) return { state: "not_enrolled" };
  return {
    state: "enrolled",
    baseUrl: credential.baseUrl,
    orgName: credential.orgName,
    deviceLabel: credential.deviceLabel,
  };
}
