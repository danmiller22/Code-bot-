// Deno Deploy — Samsara polling → Telegram DM (webhook test enabled)
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const SAMSARA_TOKEN = Deno.env.get("SAMSARA_API_TOKEN") ?? "";
const MIN_OIL_KPA = parseFloat(Deno.env.get("MIN_OIL_KPA") ?? "NaN");
const MIN_AIR_KPA = parseFloat(Deno.env.get("MIN_AIR_KPA") ?? "NaN");
const WEBHOOK_SECRET = Deno.env.get("SAMSARA_WEBHOOK_SECRET") ?? "";

if (!BOT_TOKEN || !CHAT_ID) console.warn("[boot] missing Telegram env");
if (!SAMSARA_TOKEN) console.warn("[boot] missing SAMSARA_API_TOKEN");

function nowIso() { return new Date().toISOString(); }

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  if (!r.ok) console.error("[telegram] send failed", r.status, await r.text().catch(()=>"-"));
}

const activeFaults = new Map();

function faultKey(fc) {
  const spn = fc?.spn ?? "";
  const fmi = fc?.fmi ?? "";
  const code = fc?.code ?? "";
  return `spn:${spn}|fmi:${fmi}|code:${code}`;
}
function coerceVehicleName(v) {
  return v?.vehicleName || v?.vehicleLabel || v?.name || String(v?.vehicleId ?? "unknown");
}

async function fetchVehicleStats(types = "faultCodes,engineOilPressureKPa", limit = 200) {
  const items = [];
  let after = undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL("https://api.samsara.com/fleet/vehicles/stats");
    url.searchParams.set("types", types);
    url.searchParams.set("limit", String(limit));
    if (after) url.searchParams.set("after", after);
    const r = await fetch(url.toString(), {
      headers: { "authorization": `Bearer ${SAMSARA_TOKEN}`, "accept": "application/json" },
    });
    if (!r.ok) throw new Error(`[samsara] ${r.status} ${await r.text().catch(()=>"-")}`);
    const data = await r.json();
    items.push(...(data?.data || data?.results || data?.items || []));
    after = data?.pagination?.endCursor || data?.pagination?.next || undefined;
    if (!after) break;
  }
  return items;
}

function* computeAlerts(stats) {
  for (const raw of stats) {
    const v = {
      vehicleId: raw?.vehicleId ?? raw?.id,
      vehicleName: raw?.vehicleName ?? raw?.name ?? raw?.label,
      faultCodes: raw?.faultCodes ?? raw?.stats?.faultCodes ?? raw?.dtc,
      engineOilPressureKPa: raw?.engineOilPressureKPa ?? raw?.stats?.engineOilPressureKPa,
      airPressureKPa: raw?.airPressureKPa ?? raw?.stats?.airPressureKPa,
    };
    const vid = String(v.vehicleId ?? v.vehicleName ?? "unknown");
    const vname = coerceVehicleName(v);

    if (Array.isArray(v.faultCodes)) {
      const prev = activeFaults.get(vid) ?? new Set();
      const curr = new Set();
      for (const fc of v.faultCodes) {
        const k = faultKey(fc); curr.add(k);
        if (!prev.has(k)) {
          const code = fc?.code || ((fc?.spn || fc?.spn===0) && (fc?.fmi || fc?.fmi===0) ? `SPN ${fc.spn} FMI ${fc.fmi}` : "DTC");
          const desc = fc?.description ? ` | ${fc.description}` : "";
          yield `🚨 ${vname} | ${code}${desc} | ${nowIso()}`;
        }
      }
      activeFaults.set(vid, curr);
    }

    if (!Number.isNaN(MIN_OIL_KPA) && typeof v.engineOilPressureKPa === "number" && v.engineOilPressureKPa < MIN_OIL_KPA) {
      yield `⚠️ ${vname} | Oil Pressure ${v.engineOilPressureKPa} kPa < ${MIN_OIL_KPA} kPa | ${nowIso()}`;
    }
    if (!Number.isNaN(MIN_AIR_KPA) && typeof v.airPressureKPa === "number" && v.airPressureKPa < MIN_AIR_KPA) {
      yield `⚠️ ${vname} | Air Pressure ${v.airPressureKPa} kPa < ${MIN_AIR_KPA} kPa | ${nowIso()}`;
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

// Verify Samsara signature if present
async function verifySignatureIfPresent(headers, raw) {
  const sig = headers.get("x-samsara-signature");
  if (!sig) return true;
  if (!WEBHOOK_SECRET) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const hex = sig.replace(/^sha256=/i, "").trim();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i=0;i<hex.length;i+=2) bytes[i/2] = parseInt(hex.slice(i,i+2), 16);
  return await crypto.subtle.verify("HMAC", key, bytes, raw);
}

// HTTP server
Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/") return new Response("ok " + nowIso());
  if (u.pathname === "/samsara" && req.method === "POST") {
    const raw = new Uint8Array(await req.arrayBuffer());
    const ok = await verifySignatureIfPresent(req.headers, raw);
    if (!ok) return new Response(JSON.stringify({ ok: false, error: "invalid_signature" }), { status: 401, headers: { "content-type": "application/json" } });
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { payload = { raw: new TextDecoder().decode(raw) }; }
    const text = `[webhook] ${nowIso()}\n` + (payload?.fault?.code ? `${payload?.vehicle?.name || payload?.vehicleName || "vehicle"} | ${payload.fault.code}${payload?.fault?.description ? " | "+payload.fault.description : ""}` : JSON.stringify(payload).slice(0, 1800));
    await sendTelegram(text);
    return new Response(JSON.stringify({ ok: true, mode: "webhook" }), { headers: { "content-type": "application/json" } });
  }
  if (u.pathname === "/poll" && req.method === "POST") { queueMicrotask(() => pollOnce()); return new Response(JSON.stringify({ ok: true, queued: true }), { headers: { "content-type": "application/json" } }); }
  return new Response("not found", { status: 404 });
});

// Every 2 minutes
Deno.cron("poll-samsara", "*/1 * * * *", async () => { await pollOnce(); });
