/** Samsara → Telegram Notifier (Deno Deploy)
 * Single-file HTTP server. No DB.
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SAMSARA_WEBHOOK_SECRET (optional)
 */
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";
const WEBHOOK_SECRET = Deno.env.get("SAMSARA_WEBHOOK_SECRET") ?? "";

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn("[boot] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

type SamsaraHeaders = {
  "x-samsara-signature"?: string;
  "content-type"?: string;
  [k: string]: string | undefined;
};

function hexToUint8Array(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}

async function verifySignatureIfPresent(headers: SamsaraHeaders, rawBody: Uint8Array): Promise<boolean> {
  const sig = headers["x-samsara-signature"];
  if (!sig) return true; // allow if no signature header
  if (!WEBHOOK_SECRET) return false; // signature header present but server has no secret
  // Samsara commonly uses HMAC-SHA256 of raw body with the shared secret, hex-encoded
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    hexToUint8Array(sig.replace(/^sha256=/i, "").trim()),
    rawBody,
  );
  return ok;
}

function pick<T = unknown>(obj: any, path: string[], fallback?: T): T | undefined {
  let cur = obj;
  for (const p of path) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else return fallback;
  }
  return cur as T;
}

function isoNow(): string {
  return new Date().toISOString();
}

function coerceText(payload: any): string {
  // Try to extract common fields. Fall back to compact JSON.
  const vehicle = pick<string>(payload, ["vehicle", "name"]) ||
                  pick<string>(payload, ["vehicle", "label"]) ||
                  pick<string>(payload, ["vehicleName"]) ||
                  pick<string>(payload, ["asset", "name"]) ||
                  pick<string>(payload, ["device", "name"]) ||
                  "unknown";
  const code = pick<string>(payload, ["fault", "code"]) ||
               pick<string>(payload, ["dtc", "code"]) ||
               pick<string>(payload, ["diagnostic", "code"]) ||
               pick<string>(payload, ["spn"]) && pick<string>(payload, ["fmi"])
                 ? `SPN ${pick<string>(payload, ["spn"])} FMI ${pick<string>(payload, ["fmi"])}`
                 : undefined;
  const desc = pick<string>(payload, ["fault", "description"]) ||
               pick<string>(payload, ["description"]) ||
               pick<string>(payload, ["alert", "description"]) ||
               pick<string>(payload, ["message"]);
  const metric = pick<string>(payload, ["metric", "name"]) ||
                 pick<string>(payload, ["sensor", "name"]) ||
                 pick<string>(payload, ["parameter"]) ||
                 undefined;
  const value = pick<string>(payload, ["metric", "value"]) ||
                pick<string>(payload, ["value"]) ||
                pick<string>(payload, ["reading"]) ||
                undefined;
  const severity = pick<string>(payload, ["severity"]) ||
                   pick<string>(payload, ["fault", "severity"]) ||
                   undefined;

  const parts: string[] = [];
  parts.push(`ALERT ${vehicle}`);
  if (code) parts.push(code);
  if (severity) parts.push(String(severity).toUpperCase());
  if (metric && value) parts.push(`${metric}: ${value}`);
  if (desc) parts.push(desc);
  const head = parts.join(" | ");
  // Append compact JSON for traceability
  const comp = JSON.stringify(payload);
  const body = comp.length <= 2048 ? comp : comp.substring(0, 2045) + "...";
  return `${head}
${body}`;
}

async function sendTelegram(text: string) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_notification: false,
      parse_mode: "HTML", // keep plain text safe; no special tags used
    }),
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    console.error("[telegram] send failed", r.status, err);
    return Response.json({ ok: false, error: "telegram_send_failed", status: r.status }, { status: 502 });
  }
  return Response.json({ ok: true });
}

Deno.serve(async (req: Request) => {
  const { method, url } = req;
  const u = new URL(url);
  if (method === "GET" && u.pathname === "/") {
    return new Response("ok " + isoNow(), { status: 200 });
  }

  if (method === "POST" && u.pathname === "/samsara") {
    const raw = new Uint8Array(await req.arrayBuffer());
    const headers = Object.fromEntries(req.headers) as SamsaraHeaders;

    const verified = await verifySignatureIfPresent(headers, raw);
    if (!verified) {
      return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
    }

    let payload: any;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }

    const text = coerceText(payload);
    const tgResp = await sendTelegram(text);
    return tgResp;
  }

  return new Response("Not found", { status: 404 });
});
