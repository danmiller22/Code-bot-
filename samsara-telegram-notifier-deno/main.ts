// Deno Deploy — Samsara polling → Telegram DM
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const SAMSARA_TOKEN = Deno.env.get("SAMSARA_API_TOKEN") ?? "";
const MIN_OIL_KPA = parseFloat(Deno.env.get("MIN_OIL_KPA") ?? "NaN");
const MIN_AIR_KPA = parseFloat(Deno.env.get("MIN_AIR_KPA") ?? "NaN");

if (!BOT_TOKEN || !CHAT_ID || !SAMSARA_TOKEN) {
  console.warn("[boot] Missing env: BOT_TOKEN/CHAT_ID/SAMSARA_API_TOKEN");
}

function nowIso() { return new Date().toISOString(); }

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  if (!r.ok) {
    console.error("[telegram] send failed", r.status, await r.text().catch(()=>"-"));
  }
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
      headers: {
        "authorization": `Bearer ${SAMSARA_TOKEN}`,
        "accept": "application/json",
      },
    });
    if (!r.ok) {
      const body = await r.text().catch(()=>"-");
      throw new Error(`[samsara] ${r.status} ${body}`);
    }
    const data = await r.json();
    const pageItems = data?.data || data?.results || data?.items || [];
    items.push(...pageItems);
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
    };
    const vid = String(v.vehicleId ?? v.vehicleName ?? "unknown");
    const vname = coerceVehicleName(v);

    if (Array.isArray(v.faultCodes)) {
      const prev = activeFaults.get(vid) ?? new Set();
      const curr = new Set();
      for (const fc of v.faultCodes) {
        const k = faultKey(fc);
        curr.add(k);
        if (!prev.has(k)) {
          const code = fc?.code || ((fc?.spn || fc?.spn===0) && (fc?.fmi || fc?.fmi===0) ? `SPN ${fc.spn} FMI ${fc.fmi}` : "DTC");
          const desc = fc?.description ? ` | ${fc.description}` : "";
          yield `🚨 ${vname} | ${code}${desc} | ${nowIso()}`;
        }
      }
      activeFaults.set(vid, curr);
    }

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
    for (const msg of computeAlerts(stats)) {
      count++;
      await sendTelegram(msg);
    }
    if (count === 0) {
      console.log("[poll] no new alerts", nowIso());
    } else {
      console.log("[poll] sent", count, "alerts", nowIso());
    }
  } catch (e) {
    console.error("[poll] error", e?.message || e);
    await sendTelegram(`Samsara poll error: ${e?.message || e}`);
  }
}

// HTTP server
Deno.serve((req) => {
  const u = new URL(req.url);
  if (u.pathname === "/") return new Response("ok " + nowIso());
  if (u.pathname === "/samsara" && req.method === "POST") {
    return new Response(JSON.stringify({ ok: true, mode: "polling" }), { headers: { "content-type": "application/json" } });
  }
  if (u.pathname === "/poll" && req.method === "POST") {
    queueMicrotask(() => pollOnce());
    return new Response(JSON.stringify({ ok: true, queued: true }), { headers: { "content-type": "application/json" } });
  }
  return new Response("not found", { status: 404 });
});

// Every 2 minutes
Deno.cron("poll-samsara", "*/2 * * * *", async () => {
  await pollOnce();
});
