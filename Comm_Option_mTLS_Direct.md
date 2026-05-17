---
tags: [aegis, networking, security, mtls, comm-layer]
status: draft
last_updated: 2026-05-07
---

# Option A — Plain mTLS with Private CA

Index: [[Communication_Layer_Options]]. See also [[README]] (security model), [[Comm_Option_OpenZiti]] (the alternative), [[opencode_fork]], [[Things_to_do_Research]].

## What it is

The simplest secure thing. The org runs a private CA. The server (vLLM, skills, etc.) listens on HTTPS and **requires a client certificate** issued by that CA. Aegis embeds the client cert + private key (in OS keychain or — ideally — a TPM/Secure Enclave) and dials directly. Node.js's built-in `tls` / `https` does the whole thing — no extra dependency, no native binding.

No new app, no daemon, no overlay network. Just TLS 1.3 with both sides authenticated.

## Architecture

```
Aegis (Electron main, Node tls / undici)
    │  TLS 1.3, server cert pinned, client cert presented
    ▼
nginx / Caddy / vLLM-behind-reverse-proxy on the private network
    │
    ▼
vLLM, managed skills, sync
```

---

## Deep dive: the four hard questions

### 1. Revocation when a laptop is lost

There are three real mechanisms; pick **short-lived certs as the primary** with allow-list as a safety net.

- **CRL (Certificate Revocation List).** CA publishes a signed list of revoked serials. Server (or client) downloads it, refuses certs on the list. Problems: how often is the CRL refreshed on the verifier? In an air-gapped private network, CRL distribution becomes another internal endpoint to keep alive. If the verifier hasn't refreshed in 24h, a revocation made today might not bite until tomorrow.
- **OCSP / OCSP stapling.** Real-time check per cert. Stapling moves the work to the server (server fetches OCSP response from CA periodically and includes it in the TLS handshake). Better than CRL but still depends on a working OCSP responder.
- **Short-lived certs (24h–7 day lifetime, automated renewal).** The modern best-practice answer. Aegis renews its cert each session or daily. To revoke a laptop: stop signing renewals for that identity. Worst-case attacker window = the cert's remaining lifetime. With 24h certs, that's at most 24 hours.
- **Server-side allow-list (instant kill).** Optional belt-and-suspenders: the reverse proxy keeps a small list of "currently revoked serials" alongside its CRL. Kill is immediate. Add an entry, reload the proxy. Cheap to operate at small scale.

**Recommended posture:** 24-hour cert lifetime, automated renewal at the 12h mark, server-side allow-list for instant kill. Lost laptop = (a) IT adds the serial to the kill list (immediate), (b) IT marks the identity disabled at the CA so no further renewals succeed.

What this means for the user: a stolen laptop is locked out within seconds of IT acting, and even without IT acting, locked out by next renewal.

### 2. Access scope — full machine or one port?

**One port. mTLS does not grant network access.**

- The cert authenticates a TLS connection to a specific service (e.g., `vllm.internal:443`). It is *not* a network-level credential. The laptop is not "on the server's network" in any sense it wasn't before.
- TLS certs are entirely irrelevant to SSH. SSH on :22 has its own auth (SSH keys / Kerberos / etc.) — the mTLS cert plays no role there. So the chain "I stole the mTLS cert → I can SSH into the box" **does not exist directly**.
- The realistic attack chain is: "the laptop is already on the corporate LAN, so it can reach :22 over IP, and now I have the laptop, so I can attempt SSH brute force / use any SSH keys also stored on the laptop." That risk exists *without* mTLS; mTLS doesn't worsen it. But it's a reminder that mTLS is one layer, not the whole story.
- **Defense in depth on the server side:**
  - Firewall: from the client/VPN subnet, only the TLS service port is reachable. SSH/management ports live on a separate management VLAN unreachable from clients.
  - SSH key-only auth, no passwords, ideally with hardware keys for admins.
  - Reverse proxy terminates TLS and forwards to vLLM on localhost — vLLM itself never sees the public network.
  - Server-side rate limiting and per-cert quotas prevent a stolen cert from doing infinite damage during the kill-list window.

**Bottom line:** with reasonable network segmentation, an Aegis cert lets the holder talk to vLLM and nothing else. SSH is not in scope.

### 3. Air-gap reachability

"Air-gapped" needs disambiguation:

- **Sense A — "private network, no public internet ingress."** This is the realistic Aegis enterprise deployment. mTLS works perfectly: private CA on the same network, internal DNS or `/etc/hosts` for the AI host, Aegis dials over the LAN. Zero internet dependencies. Cert validation works because Aegis ships the org's CA cert pinned in its trust store — no public CA, no CT logs needed.
- **Sense B — "literally no IP path between laptop and server."** No network-based protocol can help here, mTLS or otherwise. Solutions are physical: USB sneakernet, one-way data diode, manual model-update procedure. Out of scope for this option.

**Practical air-gap setup for Sense A:**
1. CA host on the private network, disconnected from internet.
2. Server cert issued for the internal hostname (`vllm.aegis.internal`).
3. Aegis ships with the CA root cert *and* a pinned fingerprint of the expected server cert (or its issuing intermediate). The OS trust store is *not consulted* for the internal endpoint — only the pinned bundle.
4. Cert renewal: Aegis hits the CA's enrollment endpoint over the same private network. Both ends online, both inside the org.
5. CRL/OCSP, if used, also published on the private network. No internet calls anywhere.

### 4. Identity generation — and the "private key never persists" question

**Standard generation flow.** Run a private CA with [smallstep `step-ca`](https://smallstep.com/docs/step-ca/) or HashiCorp Vault PKI engine.
- Root CA: offline. Either an air-gapped VM whose key lives on a YubiHSM/Nitrokey, or a paper-backup key ceremony with restoration procedure.
- Intermediate CA: online, on the private network. This is what actually signs leaf certs.
- Per-laptop enrollment: user runs a one-time enrollment flow. Aegis generates a keypair locally, builds a CSR, posts it to the CA's enrollment endpoint authenticated with a one-time token (delivered out-of-band — same way the user got the Aegis installer). CA returns the signed cert. Private key never leaves the laptop.

**Where does the private key live?** This is the question that drives the "derived key" idea. Three options, in order of increasing security:

#### (a) OS keychain (good baseline)
- macOS Keychain, Windows DPAPI / Credential Manager, Linux Secret Service.
- Key stored encrypted at rest, ACL'd to the Aegis bundle ID.
- Decryption requires the user being logged into their OS account.
- Threat: full disk image + OS account password = key extraction.

#### (b) TPM / Secure Enclave-backed key (recommended)
- Key is **generated inside the hardware security chip and never leaves it**. TLS signing happens inside the chip.
- Stolen disk does not yield the key. Even root on the laptop cannot extract it (only use it).
- macOS: Secure Enclave (M-series and most Intel Macs with T2). Windows: TPM 2.0 (every machine sold in the last ~5 years for Win11). Linux: TPM 2.0.
- Aegis can require a user password to *unlock per-session use* of the key without the password being the key itself.
- Caveat: requires platform-specific code paths. Node bindings exist but vary in maturity.
- **This is the right answer for "key not extractable."**

#### (c) Password-derived key (the user's idea)
- `seed = Argon2id(password, salt = email || app-salt, ...strong params...)` → Curve25519 keypair.
- Public key registered with the CA at enrollment; private key re-derived in memory each time the user enters their password.
- **Pros:** no on-disk artifact (other than the salt). Stolen disk yields nothing usable directly. Easy to implement. Works on hardware without TPM.
- **Cons:**
  - **The password IS the key.** The full security of the system reduces to the entropy of the password. A 6-character password = a brute-forceable cert.
  - **Offline brute force is possible.** An attacker who learns the email (e.g., from any company directory) and sees the public key (sniffed from a TLS handshake, or pulled from the CA's issued-cert log) can run `Argon2id(guess, email||salt) → derive pubkey → compare`. Argon2id with strong params makes each guess slow (~1s on consumer hardware), but doesn't prevent the attack — it just sets a per-guess cost. Anything below a strong passphrase falls quickly.
  - **The salt has to live somewhere.** If on the laptop → stolen laptop = stolen salt = brute force without needing the email. If on the server → user must contact server before login (and you've leaked "this email is enrolled" via a username-enumeration endpoint). If derived from email alone → no real salt entropy.
  - **Password change = re-enrollment.** Cert is bound to the public key, which is bound to the password. Changing the password rotates the cert, which means a new CSR + CA signature.
  - **"Never exists anywhere" is overstated.** The key has to exist in process memory while connected (TLS signs handshake messages with it). Cold-boot attacks, memory dumps, hostile OS-level malware — all can extract it during the active session. The story is "doesn't exist on disk" rather than "never exists."
- **The properly-clever version: OPAQUE.** OPAQUE is an asymmetric password-authenticated key exchange (RFC 9807 / CFRG track). The password never leaves the client; the server stores a "password file" that **does not permit offline brute force** — that's the whole point of OPAQUE. You get a mutually-authenticated session key from password + server interaction, without the offline-attack problem of (c). Libraries exist (`@cloudflare/opaque-ts`, libopaque in C) but are young. Adds protocol complexity. **If you really want password-derived authentication done well, this is the path.**

**Recommended layering:**
1. **Default:** TPM/Secure Enclave-backed key (option b). Best security, available on virtually all hardware sold in the last few years.
2. **Fallback:** OS keychain (option a) on hardware without TPM.
3. **If a "no on-disk key" UX is genuinely required:** OPAQUE-based authentication, not naive password-derived keys.
4. **Avoid:** option (c) without OPAQUE, unless paired with a strong-passphrase requirement (and an honest UX that says "your password IS the cryptographic key — use a 4+ word passphrase").

---

## Pros (overall)

- **Smallest possible attack surface.** TLS is in Node's standard library. No native modules, no extra processes, nothing to patch separately.
- **Fastest to ship.** Client side is a few hundred lines. Server side is one nginx/Caddy block.
- **Air-gap (Sense A) trivial.** Private CA, internal DNS, done.
- **Universally understood.** Every IT team has dealt with mTLS. No specialist knowledge.
- **Standards-track crypto.** TLS 1.3 + server-cert pinning, battle-tested.
- **Doesn't paint you into a corner.** mTLS still works *inside* a Ziti or WG tunnel later if you change your mind.

## Cons (overall)

- **Server has an inbound listener.** Not listener-less like [[Comm_Option_OpenZiti]].
- **You must run a real PKI.** "Real" = offline root CA, intermediate, revocation procedure, key rotation. PKI done badly is worse than no PKI.
- **No per-service policy out of the box.** Every cert that trusts the CA can talk to every endpoint that trusts the CA. If you want "this user can hit vLLM but not skills," you build it in app logic (cert SAN/OU + server-side checks).
- **No fancy mesh.** No NAT traversal, no service-name dialing, no per-connection audit feed. Just authenticated pipes.

## Security implications — summary

**Strong points**
- Mutual authentication before any application byte hits the wire.
- Certificate-bound identity; revocation is real (kill list / CRL / short-lived).
- Server cert pinning closes rogue-CA attacks even if a public CA is compromised.
- Renderer can't construct TLS clients; everything routes through the main process bridge ([[README]]).

**Things to watch**
- **PKI hygiene is the whole game.** Root CA offline (HSM or air-gapped). Intermediate online. If the root is compromised, you're rebuilding trust everywhere.
- **CRL freshness.** Define refresh interval and the failure mode. Short-lived certs sidestep most of this.
- **Server cert pinning.** Hardcode the expected fingerprint in Aegis. Don't trust the OS trust store for the internal endpoint.
- **Cipher suite policy.** TLS 1.3 only, ChaCha20/AES-GCM only.
- **Logging.** Reverse proxy must log the client-cert subject on every request — that's your audit trail.
- **Key storage.** TPM/Secure Enclave first; OS keychain as fallback; password-derived only via OPAQUE if at all.

## Effort estimate

- Aegis client (TLS context, cert pinning, renewal, keystore integration): **3–5 days**.
- TPM/Secure Enclave key path (per platform): **1 week** — most cost is here.
- Enrollment flow (CSR generation + signed return): **1 week**.
- Server-side: nginx/Caddy + smallstep `step-ca`: **1 week**.
- Total: **~3–4 weeks** to production. Lowest cost of the two.

## When this is the right answer

Aegis needs to talk to **a known, controlled set of internal endpoints** (one or a small number), the org can run a basic PKI, and you don't need listener-less servers or per-service policy beyond "trusts our CA." **Default recommendation** unless one of OpenZiti's specific properties is a hard requirement.

## Open questions to resolve before picking this

- Existing internal CA, or bootstrap with smallstep?
- Cert lifetime and renewal cadence (recommend ≤24h with auto-renewal).
- TPM/Secure Enclave path: Node bindings or platform-specific shell-out?
- Where does the kill-list / CRL live in the air-gapped deployment, and how often does the reverse proxy refresh it?
