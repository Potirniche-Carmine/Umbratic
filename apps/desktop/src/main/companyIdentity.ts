import { certificateTransport, companyTLS, enrollmentDetails } from "./companyTrust";
import * as crypto from "node:crypto";
import * as os from "node:os";

import type { EndpointMtlsConfig } from "./config";
import { postProviderJson } from "./providerClient";
import {
  assertCompanyCredentialStorageAvailable,
  clearCompanyDeviceCredential,
  companyConnectionStatus,
  readCompanyDeviceCredential,
  writeCompanyDeviceCredential,
  writeUpdateFeedTokenSetting,
} from "./storage";
import type { CompanyDeviceCredential } from "./companyCredentialStorage";
import { isRecord } from "./utils";

type TransportOptions = {
  headers?: Record<string, string>;
  mtls?: EndpointMtlsConfig;
  signal?: AbortSignal;
};

type SessionCache = {
  token: string;
  expiresAt: number;
};

let sessionCache: SessionCache | null = null;
let sessionDisconnected = false;

function route(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  base.pathname = path;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function deviceLabel(input?: string): string {
  const requested = input?.trim();
  if (requested && requested.length <= 100 && !/[\r\n\0]/.test(requested)) return requested;
  const hostname = os.hostname().trim().slice(0, 100);
  return hostname || "Umbratic device";
}

function responseError(statusCode: number, value: unknown): Error {
  const code = isRecord(value) && typeof value.code === "string" ? value.code : "";
  const messages: Record<string, string> = {
    enrollment_code_invalid: "The Enrollment code is invalid.",
    enrollment_code_expired: "The Enrollment code has expired.",
    device_limit_reached: "This user has reached the enrolled device limit.",
    user_deactivated: "This user is deactivated.",
    user_expired: "This user access period has expired.",
    device_not_authorized: "This device is not authorized.",
    session_invalid: "The company session is invalid.",
    session_expired: "The company session has expired.",
    challenge_invalid: "The device challenge is invalid or expired.",
    challenge_proof_invalid: "Veil rejected the device proof.",
  };
  return new Error(messages[code] ?? `Veil rejected the connection (${statusCode}).`);
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  transport: TransportOptions,
): Promise<Record<string, unknown>> {
  const response = await postProviderJson(route(baseUrl, path), body, transport);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw responseError(response.statusCode, response.json);
  }
  if (!isRecord(response.json)) {
    throw new Error("Veil returned an invalid company access response.");
  }
  return response.json;
}

export async function enrollCompanyDevice(
  input: { baseUrl: string; enrollmentCode: string; deviceLabel?: string },
  transport: TransportOptions = {},
): Promise<CompanyDeviceCredential> {
  sessionDisconnected = false;
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const details = enrollmentDetails(baseUrl, input.enrollmentCode.trim());
  const enrollmentCode = details.code;
  transport = { ...transport, mtls: certificateTransport(details.ca, transport.mtls) };
  if (!enrollmentCode.startsWith("umbr_") || enrollmentCode.length > 512) {
    throw new Error("Enter a valid Enrollment code.");
  }
  assertCompanyCredentialStorageAvailable();
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  if (typeof publicJwk.x !== "string") {
    throw new Error("The device key could not be created.");
  }
  const label = deviceLabel(input.deviceLabel);
  const result = await post(baseUrl, "/api/enrollment/enroll", {
    enrollment_code: enrollmentCode,
    public_key: publicJwk.x,
    device_label: label,
  }, transport);
  const orgUid = typeof result.org_uid === "string" ? result.org_uid : "";
  const orgName = typeof result.org_name === "string" ? result.org_name.trim() : "";
  const userUid = typeof result.user_uid === "string" ? result.user_uid : "";
  const deviceUid = typeof result.device_uid === "string" ? result.device_uid : "";
  if (!orgUid.startsWith("org_") || !orgName || !userUid.startsWith("usr_") || !deviceUid.startsWith("dev_")) {
    throw new Error("Veil returned invalid enrollment details.");
  }
  const credential: CompanyDeviceCredential = {
    caPem: details.ca,
    baseUrl,
    orgUid,
    orgName,
    userUid,
    deviceUid,
    deviceLabel: label,
    publicKey: publicJwk.x,
    privateKeyPkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
  writeCompanyDeviceCredential(credential);
  sessionCache = null;
  await ensureCompanySession(transport);
  return credential;
}

export async function ensureCompanySession(transport: TransportOptions = {}): Promise<string> {
  if (sessionDisconnected) {
    throw new Error("The company server is disconnected.");
  }
  if (sessionCache && sessionCache.expiresAt > Date.now() + 90_000) {
    return sessionCache.token;
  }
  const credential = readCompanyDeviceCredential();
  if (!credential) {
    throw new Error("This device is not enrolled with a company server.");
  }
  transport = { ...transport, mtls: companyTLS(credential.baseUrl, transport.mtls) };
  const challenge = await post(credential.baseUrl, "/api/session/challenge", {
    device_uid: credential.deviceUid,
  }, transport);
  const challengeUid = typeof challenge.challenge_uid === "string" ? challenge.challenge_uid : "";
  const challengeText = typeof challenge.challenge === "string" ? challenge.challenge : "";
  if (!challengeUid.startsWith("chal_") || !challengeText.startsWith("umbratic-device-session-v1.")) {
    throw new Error("Veil returned an invalid device challenge.");
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(credential.privateKeyPkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.sign(null, Buffer.from(challengeText, "utf8"), privateKey).toString("base64url");
  const session = await post(credential.baseUrl, "/api/session", {
    challenge_uid: challengeUid,
    signature,
  }, transport);
  const token = typeof session.session_token === "string" ? session.session_token : "";
  const orgName = typeof session.org_name === "string" ? session.org_name.trim() : "";
  const expiresAt = typeof session.expires_at === "string" ? Date.parse(session.expires_at) : Number.NaN;
  // Veil mints this alongside the session; the update feed accepts it for
  // thirty days. Collecting it here is the whole of the app's part in it —
  // nothing asks the user for a key, and a company that stops running Veil
  // simply stops receiving new ones.
  if (typeof session.update_token === "string") writeUpdateFeedTokenSetting(session.update_token);
  if (!token.startsWith("umbs_") || !orgName || !Number.isFinite(expiresAt)) {
    throw new Error("Veil returned an invalid company session.");
  }
  if (credential.orgName !== orgName) {
    writeCompanyDeviceCredential({ ...credential, orgName });
  }
  sessionCache = { token, expiresAt };
  return token;
}

export async function renewCompanySession(transport: TransportOptions = {}): Promise<string> {
  sessionCache = null;
  return ensureCompanySession(transport);
}

export async function connectCompanySession(transport: TransportOptions = {}): Promise<string> {
  sessionDisconnected = false;
  return renewCompanySession(transport);
}

export function currentCompanySessionToken(): string {
  if (!sessionCache || sessionCache.expiresAt <= Date.now()) return "";
  return sessionCache.token;
}

export async function disconnectCompanySession(transport: TransportOptions = {}): Promise<void> {
  const credential = readCompanyDeviceCredential();
  const token = currentCompanySessionToken();
  if (credential && token) {
    await postProviderJson(route(credential.baseUrl, "/api/session/logout"), {}, {
      ...transport,
      headers: { ...(transport.headers ?? {}), Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  sessionCache = null;
  sessionDisconnected = true;
}

export async function disconnectCompanyDevice(transport: TransportOptions = {}): Promise<void> {
  await disconnectCompanySession(transport);
  clearCompanyDeviceCredential();
  sessionDisconnected = false;
}

export { companyConnectionStatus };
