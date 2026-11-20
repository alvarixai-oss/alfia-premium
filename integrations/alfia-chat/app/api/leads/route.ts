import { createHmac, randomBytes } from "node:crypto";

// Server-only lead capture. Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// in Vercel server environment (never NEXT_PUBLIC_).
export const runtime = "nodejs";
const salt = randomBytes(32);
const buckets = new Map<string, { since: number; count: number }>();
const allowed = new Set(["information", "quote", "hire", "other"]);
const trim = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== new URL(request.url).origin)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Response.json({ error: "Invalid content type" }, { status: 415 });
  }
  const text = await request.text();
  if (text.length > 8192) return Response.json({ error: "Too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Honeypot field is expected to be empty.
  if (trim(body.website, 100)) return Response.json({ ok: true }, { status: 200 });
  // Consent must be a positive, explicit visitor action, not inferred by the model.
  if (body.consent !== true || body.consentVersion !== "alfia-leads-v1") {
    return Response.json({ error: "Consent required" }, { status: 400 });
  }
  const name = trim(body.fullName, 120);
  const company = trim(body.companyName, 160);
  const email = trim(body.email, 254);
  const phone = trim(body.phone, 40);
  if (!email && !phone) return Response.json({ error: "Contact required" }, { status: 400 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "Invalid email" }, { status: 400 });
  if (phone && !/^[+\d\s().-]{6,40}$/.test(phone)) return Response.json({ error: "Invalid phone" }, { status: 400 });
  const ip = (process.env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for") : null) ?? "local";
  const key = createHmac("sha256", salt).update(ip.slice(0, 128)).digest("hex");
  const now = Date.now();
  const prior = buckets.get(key);
  const bucket = !prior || now - prior.since > 60_000 ? { since: now, count: 0 } : prior;
  if (++bucket.count > 4) return Response.json({ error: "Too many requests" }, { status: 429 });
  buckets.set(key, bucket);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.since > 60_000) buckets.delete(k);
  }
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret || !url.startsWith("https://")) {
    return Response.json({ error: "Service unavailable" }, { status: 503 });
  }
  const intent = trim(body.leadIntent, 24);
  const row = {
    full_name: name || null, company_name: company || null,
    email: email || null, phone: phone || null,
    requested_service: trim(body.requestedService, 160) || null,
    business_need: trim(body.businessNeed, 600) || null,
    current_tools: trim(body.currentTools, 200) || null,
    approximate_volume: trim(body.approximateVolume, 120) || null,
    lead_intent: allowed.has(intent) ? intent : "information",
    contact_preference: ["whatsapp", "phone", "email", "unspecified"].includes(trim(body.contactPreference, 24))
      ? trim(body.contactPreference, 24) : "unspecified",
    consent_given: true,
    consent_at: new Date().toISOString(),
    consent_version: "alfia-leads-v1",
    source: "alfia_chat",
  };
  try {
    const response = await fetch(`${url}/rest/v1/commercial_leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": secret,
        "Authorization": `Bearer ${secret}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(row),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return Response.json({ error: "Could not save contact" }, { status: 502 });
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Service unavailable" }, { status: 503 });
  }
}
