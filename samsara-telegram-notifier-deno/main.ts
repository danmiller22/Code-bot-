// Deno Deploy — Samsara polling → Telegram DM (webhook test enabled)
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SAMSARA_API_TOKEN, MIN_OIL_KPA?, SAMSARA_WEBHOOK_SECRET?
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const SAMSARA_TOKEN = Deno.env.get("SAMSARA_API_TOKEN") ?? "";
const MIN_OIL_KPA = parseFloat(Deno.env.get("MIN_OIL_KPA") ?? "NaN");
const WEBHOOK_SECRET = Deno.env.get("SAMSARA_WEBHOOK_SECRET") ?? "";

if (!BOT_TOKEN || !CHAT_ID) console.warn("[boot] missing Telegram env");
if (!SAMSARA_TOKEN) console.warn("[boot] missing SAMSARA_API_TOKEN");

function nowIso() { return new Date().toISOString(); }

async function sendTelegram(text: string) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  if (!r.ok) console.error("[telegram] send failed", r.status, await r.text().catch(()=>"-"));
}

// ---- Faults parsing helpers ----
function extractFaults(raw: any) {
  // Native flat list
  if (Array.isArray(raw?.faultCodes)) return raw.faultCodes;

  // J1939 nested layout from Samsara
  const j = raw?.faultCodes?.j1939?.diagnosticTroubleCodes;
  if (Array.isArray(j)) {
    return j.map((d: any) => ({
      spn: d?.spnId,
      fmi: d?.fmiId,
      code: (d?.spnId !== undefined && d?.fmiId !== undefined)
        ? `SPN ${d.spnId} FMI ${d.fmiId}`
        : undefined,
      description: d?.spnDescription,
    }));
  }
  return [];
}

function faultKey(fc: any) {
  const spn = fc?.spn ?? "";
  const fmi = fc?.fmi ?? "";
  const code = fc?.code ?? "";
  return `spn:${spn}|fmi:${fmi}|code:${code}`;
}
function coerceVehicleName(v: any) {
  return v?.vehicleName || v?.vehicleLabel || v?.name || String(v?.vehicleId ?? "unknown");
}

// ---- Polling ----
const activeFaults = new Map<string, Set<string>>();

async function fetchVehicleStats(types = "faultCodes,engineOilPressureKPa", limit = 200) {
  const items: any[] = [];
  let after: string | undefined = undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL("https://api.samsara.com/fleet/vehicles/stats");
    url.searchParams.set("types", types);
    url.searchParams.set("limit", String(limit));
    if (after) url.searchParams.set("after", after);

    const r = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${SAMsARA_TOKEN}`, accept: "application/json" },
    } as any).catch((e) => {
      throw new Error(`network: ${e?.message || e}`);
    });
    if (!r.ok) throw new Error(`[samsara] ${r.status} ${await r.text().catch(()=>"-")}`);
    const data = await r.json();
    items.push(...(data?.data || data?.results || data?.items || []));
    after = data?.pagination?.endCursor || data?.pagination?.next || undefined;
    if (!after) break;
  }
  return items;
}

function* computeAlerts(stats: any[]) {
  for (const raw of stats) {
    const v = {
      vehicleId: raw?.vehicleId ?? raw?.id,
      vehicleName: raw?.vehicleName ?? raw?.name ?? raw?.label,
      faultCodes: extractFaults(raw),
      engineOilPressureKPa:
        typeof raw?.engineOilPressureKPa === "number"
          ? raw.engineOilPressureKPa
          : (raw?.engineOilPressureKPa?.value ??
             raw?.stats?.engineOilPressureKPa?.value),
    };
    const vid = String(v.vehicleId ?? v.vehicleName ?? "unknown");
    const vname = coerceVehicleName(v);

    // New faults
    if (Array.isArray(v.faultCodes)) {
      const prev = activeFaults.get(vid) ?? new Set<string>();
      const curr = new Set<string>();
      for (const fc of v.faultCodes) {
        const k = faultKey(fc);
        curr.add(k);
        if (!prev.has(k)) {
          const code = fc?.code || ((fc?.spn ?? "") !== "" && (fc?.fmi ?? "") !== "" ? `SPN ${fc.spn} FMI ${fc.fmi}` : "DTC");
          const desc = fc?.description ? ` | ${fc.description}` : "";
          yield `🚨 ${vname} | ${code}${desc} | ${nowIso()}`;
        }
      }
      activeFaults.set(vid, curr);
    }

    // Oil pressure threshold
    if (!Number.isNaN(MIN_OIL_KPA) && typeof v.engineOilPressureKPa === "number") {
      if (v.engineOilPressureKPa < MIN_OIL_KPA) {
        yield `⚠️ ${vname} | Oil Pressure ${v.engineOilPressureKPa} kPa < ${MIN_OIL_KPA} kPa | ${nowIso()}`;
      }
    }
  }
}

async function pollOnce() {
  try {
    const stats = await fetchVehicleStats();
    let count = 0;
    for (const msg of computeAlerts(stats)) { count++; await sendTelegram(msg); }
    console.log(count ? `[poll] sent ${count} alerts ${nowIso()}` : `[poll] no new alerts ${nowIso()}`);
  } catch (e) {
    console.error("[poll] error", e?.message || e);
    await sendTelegram(`Samsara poll error: ${e?.message || e}`);
  }
}

// ---- Webhook signature verify ----
async function verifySignatureIfPresent(headers: Headers, raw: Uint8Array) {
  const sig = headers.get("x-samsara-signature");
  if (!sig) return true;
  if (!WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const hex = sig.replace(/^sha256=/i, "").trim();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return await crypto.subtle.verify("HMAC", key, bytes, raw);
}

// ---- HTTP server ----
Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/") return new Response("ok " + nowIso());

  if (u.pathname === "/samsara" && req.method === "POST") {
    const raw = new Uint8Array(await req.arrayBuffer());
    const ok = await verifySignatureIfPresent(req.headers, raw);
    if (!ok) return new Response(JSON.stringify({ ok: false, error: "invalid_signature" }), { status: 401, headers: { "content-type": "application/json" } });

    let payload: any;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { payload = { raw: new TextDecoder().decode(raw) }; }

    const vname = payload?.vehicle?.name || payload?.vehicleName || "vehicle";
    const code  = payload?.fault?.code || "";
    const desc  = payload?.fault?.description ? ` | ${payload.fault.description}` : "";
    const text  = `[webhook] ${nowIso()}\n${vname}${code ? " | "+code : ""}${desc}`;
    await sendTelegram(text);

    return new Response(JSON.stringify({ ok: true, mode: "webhook" }), { headers: { "content-type": "application/json" } });
  }

  if (u.pathname === "/poll" && req.method === "POST") {
    queueMicrotask(() => pollOnce());
    return new Response(JSON.stringify({ ok: true, queued: true }), { headers: { "content-type": "application/json" } });
  }

  return new Response("not found", { status: 404 });
});

// Run every 1 minute
Deno.cron("poll-samsara", "*/1 * * * *", async () => { await pollOnce(); });
