import { X509Certificate, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { EndpointMtlsConfig } from "./config";
import { readRegularFileSync } from "./readFile";
import { readCompanyCertificate } from "./storage";

// Trust is supplied out of band by the administrator, never learned from an
// unauthenticated connection. It applies only to this enrolled HTTPS origin.
export function enrollmentDetails(baseUrl: string, input: string): { code: string; ca?: string } {
  if (!input.startsWith("umbr_enroll1_")) return { code: input };
  try {
    if (input.length > 16384) throw new Error();
    const value = JSON.parse(Buffer.from(input.slice("umbr_enroll1_".length), "base64url").toString("utf8"));
    const origin = new URL(baseUrl);
    if (origin.protocol !== "https:" || origin.username || origin.password || value.url !== origin.origin) throw new Error();
    if (typeof value.code !== "string" || !value.code.startsWith("umbr_") || value.code.length > 512) throw new Error();
    if (value.ca !== undefined) {
      if (typeof value.ca !== "string" || value.ca.length > 8192 || !new X509Certificate(value.ca).ca) throw new Error();
    }
    return { code: value.code, ca: value.ca };
  } catch { throw new Error("The enrollment code is invalid or belongs to a different server URL."); }
}

export function certificateTransport(ca: string | undefined, fallback?: EndpointMtlsConfig): EndpointMtlsConfig | undefined {
  if (!ca) return fallback;
  const directory = path.join(app.getPath("userData"), "company-certificates");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const caPath = path.join(directory, createHash("sha256").update(ca).digest("hex") + ".pem");
  try {
    fs.writeFileSync(caPath, ca, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    if (readRegularFileSync(caPath, 8192).toString("utf8") !== ca) throw new Error();
  } catch { throw new Error("The saved company certificate was modified. Enroll again."); }
  return { ...fallback, caPath };
}

export function companyTLS(baseUrl: string, fallback?: EndpointMtlsConfig): EndpointMtlsConfig | undefined {
  const credential = readCompanyCertificate();
  if (!credential || new URL(credential.baseUrl).origin !== new URL(baseUrl).origin) return fallback;
  return certificateTransport(credential.caPem, fallback);
}
