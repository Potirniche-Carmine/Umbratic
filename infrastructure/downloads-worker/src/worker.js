/**
 * The update feed at downloads.umbratic.ai.
 *
 * The release bucket has no public route of its own: this Worker is the only
 * way to its bytes. It serves a request that carries a current update token,
 * and nothing else.
 *
 * A token is `org_uid.unix_seconds.signature`, minted by that company's Veil
 * and carried here by their desktop apps. Veil holds only its own key —
 * HMAC(master, org_uid) — which this Worker derives again to check the
 * signature, so no customer list has to be kept in sync and no key leaves the
 * server it was built into. Tokens stop being accepted thirty days after they
 * are minted, so a company whose Veil stops running stops receiving updates on
 * its own. REVOKED is the immediate version of that: an org UID written there
 * is refused from the next check onward, whatever runs on their side.
 */

const TOKEN_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 300;
const encoder = new TextEncoder();

function decodeBase64Url(text) {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hmacKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The org UID a valid token names, or "" for anything else. */
async function authorize(token, masterKeyText) {
  const [orgUID, stamp, signature] = String(token).split(".");
  if (!/^org_[A-Za-z0-9_-]{8,76}$/.test(orgUID ?? "") || !/^\d{10,11}$/.test(stamp ?? "") || !signature) {
    return "";
  }
  const age = Math.floor(Date.now() / 1000) - Number(stamp);
  if (age > TOKEN_LIFETIME_SECONDS || age < -CLOCK_SKEW_SECONDS) return "";
  let customerKey;
  try {
    const master = await hmacKey(decodeBase64Url(masterKeyText));
    customerKey = await hmacKey(await crypto.subtle.sign("HMAC", master, encoder.encode(orgUID)));
    const valid = await crypto.subtle.verify("HMAC", customerKey, decodeBase64Url(signature), encoder.encode(`${orgUID}.${stamp}`));
    return valid ? orgUID : "";
  } catch {
    return "";
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Not found", { status: 404 });
    }
    const key = new URL(request.url).pathname.replace(/^\//, "");
    if (!key.startsWith("releases/") || key.includes("..")) {
      return new Response("Not found", { status: 404 });
    }
    const orgUID = await authorize(request.headers.get("X-Umbratic-Update-Token") ?? "", env.FEED_MASTER_KEY);
    if (!orgUID || (await env.REVOKED.get(orgUID)) !== null) {
      return new Response("Forbidden", { status: 403 });
    }
    const object = request.method === "HEAD"
      ? await env.BUCKET.head(key)
      : await env.BUCKET.get(key, { range: request.headers, onlyIf: request.headers });
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    if (!("body" in object)) return new Response(null, { status: 200, headers });
    if (!object.body) return new Response(null, { status: 304, headers });
    if (object.range && "offset" in object.range) {
      headers.set("content-range", `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { status: 200, headers });
  },
};
