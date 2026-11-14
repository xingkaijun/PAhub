/**
 * kjx-auth-client v1.0.0
 * Source: github.com/xingkaijun/kjx-auth  client/kjx-auth-client.ts  @ 0fef219d3d08be37bc691b243fffcb11e9d6d7c6
 *
 * Zero-dependency verifier for kjx-auth tokens (node:crypto only). Copy this single file into each app.
 *
 *   const verifier = createKjxVerifier({
 *     jwksUrl: "http://127.0.0.1:8090/.well-known/jwks.json",   // internal URL, not the public one
 *     issuer: "https://auth.kjxing.com",
 *     audience: "pahub",
 *   });
 *   const user = await verifier.verify(req.headers["x-auth-token"]);   // KjxUser | null → null = 401
 *
 * Checks: alg=EdDSA (Ed25519) only, kid known (unknown kid forces one JWKS refresh), iss, aud, exp/nbf
 * with clock skew, typ is not the service-token type. Any failure returns null; treat it as 401.
 */
import { createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

export const KJX_CLIENT_VERSION = "1.0.0";
export const SERVICE_TOKEN_TYP = "svc+jwt";

export interface KjxUser {
  id: string;
  username: string;
  name: string;
  title: string | null;
  disciplines: string[];
  role: string;
  authAdmin: boolean;
  /** First 16 hex chars of the session id hash (for logs/correlation). */
  sid: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export interface KjxServiceCaller {
  clientId: string;
  scopes: string[];
  exp: number;
}

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
}
export interface Jwks {
  keys: Jwk[];
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface KjxVerifierOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  clockSkewSec?: number;
  jwksTtlSec?: number;
  /** Minimum gap between forced refreshes caused by unknown kids (default 10 s). */
  minRefreshIntervalSec?: number;
  /** Injected fetch (tests); defaults to global fetch. */
  fetch?: FetchLike;
  /** Injected clock in ms (tests). */
  now?: () => number;
  /** Called on verification failures (reason only, never the token). */
  onError?: (reason: string) => void;
}

export interface KjxVerifier {
  verify(token: string | null | undefined): Promise<KjxUser | null>;
  /** Verifies a service token (typ svc+jwt) addressed to this app; optional required scope. */
  verifyService(token: string | null | undefined, requiredScope?: string): Promise<KjxServiceCaller | null>;
  /** Forces a JWKS reload (e.g. after a key rotation). */
  refresh(): Promise<void>;
}

interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

const B64URL = /^[A-Za-z0-9_-]*$/;

function decodePart(part: string): Record<string, unknown> | null {
  if (!B64URL.test(part)) return null;
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function splitJwt(token: string): JwtParts | null {
  if (typeof token !== "string" || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = decodePart(h);
  const payload = decodePart(p);
  if (!header || !payload || !B64URL.test(s) || !s) return null;
  return { header, payload, signingInput: Buffer.from(`${h}.${p}`), signature: Buffer.from(s, "base64url") };
}

function audMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.includes(expected);
}

export function createKjxVerifier(opts: KjxVerifierOptions): KjxVerifier {
  const skew = opts.clockSkewSec ?? 30;
  const ttlMs = (opts.jwksTtlSec ?? 300) * 1000;
  const minRefreshMs = (opts.minRefreshIntervalSec ?? 10) * 1000;
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? (() => Date.now());
  const report = (reason: string) => opts.onError?.(reason);

  let keys = new Map<string, KeyObject>();
  let loadedAt = -Infinity;
  let lastForced = -Infinity;
  let inflight: Promise<void> | null = null;

  async function load(): Promise<void> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        let res;
        try {
          res = await doFetch(opts.jwksUrl, { headers: { accept: "application/json" }, signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
        const body = (await res.json()) as Jwks;
        const next = new Map<string, KeyObject>();
        for (const k of body?.keys ?? []) {
          if (k.kty !== "OKP" || k.crv !== "Ed25519" || !k.x || !k.kid) continue;
          if (k.alg && k.alg !== "EdDSA") continue;
          try {
            next.set(k.kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }));
          } catch {
            /* skip malformed key */
          }
        }
        keys = next;
        loadedAt = now();
      } catch (err) {
        report(`jwks_fetch_failed: ${(err as Error).message}`);
        // Keep the old keys; retry on the next call.
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | null> {
    if (now() - loadedAt >= ttlMs) await load();
    let key = keys.get(kid);
    if (!key && now() - lastForced >= minRefreshMs) {
      lastForced = now();
      await load();
      key = keys.get(kid);
    }
    return key ?? null;
  }

  async function check(token: string | null | undefined, wantService: boolean): Promise<Record<string, unknown> | null> {
    if (!token) return null;
    const jwt = splitJwt(token.trim());
    if (!jwt) return report("malformed"), null;
    const { header, payload } = jwt;
    if (header.alg !== "EdDSA") return report("bad_alg"), null;
    if (typeof header.kid !== "string" || !header.kid) return report("no_kid"), null;
    if (header.crit !== undefined) return report("crit_unsupported"), null;
    const isService = header.typ === SERVICE_TOKEN_TYP;
    if (isService !== wantService) return report(wantService ? "not_service_token" : "service_token_as_user"), null;
    const key = await keyFor(header.kid);
    if (!key) return report("unknown_kid"), null;
    let ok = false;
    try {
      ok = edVerify(null, jwt.signingInput, key, jwt.signature);
    } catch {
      ok = false;
    }
    if (!ok) return report("bad_signature"), null;
    const t = Math.floor(now() / 1000);
    if (payload.iss !== opts.issuer) return report("bad_iss"), null;
    if (!audMatches(payload.aud, opts.audience)) return report("bad_aud"), null;
    if (typeof payload.exp !== "number" || t > payload.exp + skew) return report("expired"), null;
    if (typeof payload.nbf === "number" && t + skew < payload.nbf) return report("not_yet_valid"), null;
    if (typeof payload.iat === "number" && t + skew < payload.iat) return report("issued_in_future"), null;
    if (typeof payload.sub !== "string" || !payload.sub) return report("no_sub"), null;
    return payload;
  }

  return {
    async verify(token) {
      const p = await check(token, false);
      if (!p) return null;
      if (typeof p.role !== "string" || typeof p.username !== "string") return report("missing_claims"), null;
      return {
        id: p.sub as string,
        username: p.username,
        name: typeof p.name === "string" ? p.name : p.username,
        title: typeof p.title === "string" ? p.title : null,
        disciplines: Array.isArray(p.disciplines) ? p.disciplines.filter((d): d is string => typeof d === "string") : [],
        role: p.role,
        authAdmin: p.auth_admin === true,
        sid: typeof p.sid === "string" ? p.sid : "",
        exp: p.exp as number,
      };
    },
    async verifyService(token, requiredScope) {
      const p = await check(token, true);
      if (!p) return null;
      const sub = p.sub as string;
      if (!sub.startsWith("client:")) return report("bad_service_sub"), null;
      const scopes = typeof p.scope === "string" ? p.scope.split(/\s+/).filter(Boolean) : [];
      if (requiredScope && !scopes.includes(requiredScope)) return report("insufficient_scope"), null;
      return { clientId: sub.slice("client:".length), scopes, exp: p.exp as number };
    },
    async refresh() {
      await load();
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Service-token client: fetches and caches client_credentials tokens (for directory sync).    */
/* ------------------------------------------------------------------------------------------ */

export interface KjxServiceTokenClientOptions {
  tokenUrl: string; // http://127.0.0.1:8090/oauth/token
  clientId: string;
  clientSecret: string;
  audience: string; // "kjx-auth" for /api/directory/users
  fetch?: typeof fetch;
  now?: () => number;
}

export function createKjxServiceTokenClient(opts: KjxServiceTokenClientOptions): { getToken(): Promise<string> } {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  let cached: { token: string; until: number } | null = null;
  return {
    async getToken() {
      if (cached && now() < cached.until) return cached.token;
      const res = await doFetch(opts.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          audience: opts.audience,
        }).toString(),
      });
      if (!res.ok) throw new Error(`kjx-auth token request failed: HTTP ${res.status}`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      cached = { token: body.access_token, until: now() + Math.max(0, body.expires_in - 60) * 1000 };
      return body.access_token;
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Test signer — TESTS ONLY. Never import from production code paths.                          */
/* ------------------------------------------------------------------------------------------ */

export interface KjxTestSigner {
  /** Current kid. */
  readonly kid: string;
  /** Signs arbitrary claims; header defaults to {alg:"EdDSA", kid, typ:"JWT"} and can be overridden. */
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): string;
  /** Convenience: a valid app token for `audience` with sensible defaults (overridable). */
  signUser(audience: string, claims?: Partial<Record<string, unknown>>, opts?: { issuer?: string; ttlSec?: number; now?: number }): string;
  /** In-memory JWKS of all keys this signer still publishes. */
  jwks(): Jwks;
  /** fetch-compatible function serving jwks() (pass as `fetch` to createKjxVerifier). Counts calls. */
  fetch: FetchLike;
  readonly fetchCount: number;
  /** Adds a new key and makes it current; the old key stays published unless `dropOld`. */
  rotate(dropOld?: boolean): string;
}

export function createKjxTestSigner(): KjxTestSigner {
  const all: Array<{ kid: string; priv: KeyObject; jwk: Jwk }> = [];
  let count = 0;
  const add = () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const kid = `test-${randomBytes(4).toString("hex")}`;
    const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
    all.push({ kid, priv: privateKey, jwk: { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" } });
    return kid;
  };
  add();
  const current = () => all[all.length - 1]!;
  const signer: KjxTestSigner = {
    get kid() {
      return current().kid;
    },
    sign(claims, header) {
      const h = { alg: "EdDSA", kid: current().kid, typ: "JWT", ...header };
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const input = `${enc(h)}.${enc(claims)}`;
      const sig = edSign(null, Buffer.from(input), current().priv).toString("base64url");
      return `${input}.${sig}`;
    },
    signUser(audience, claims = {}, o = {}) {
      const iat = Math.floor((o.now ?? Date.now()) / 1000);
      return signer.sign({
        iss: o.issuer ?? "https://auth.kjxing.com",
        aud: audience,
        sub: "user-1",
        sid: "0123456789abcdef",
        username: "tester",
        name: "Test User",
        title: null,
        disciplines: [],
        role: "viewer",
        auth_admin: false,
        iat,
        exp: iat + (o.ttlSec ?? 300),
        ...claims,
      });
    },
    jwks() {
      return { keys: all.map((k) => ({ ...k.jwk })) };
    },
    fetch: async () => {
      count++;
      const body = signer.jwks();
      return { ok: true, status: 200, json: async () => body };
    },
    get fetchCount() {
      return count;
    },
    rotate(dropOld = false) {
      const kid = add();
      if (dropOld) all.splice(0, all.length - 1);
      return kid;
    },
  };
  return signer;
}
