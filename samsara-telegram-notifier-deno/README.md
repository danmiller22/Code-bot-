# Samsara → Telegram Notifier (Deno Deploy)

Minimal webhook receiver on Deno Deploy. Receives Samsara webhooks at `/samsara`. For each alert it sends a direct message to your Telegram user ID.

## Env vars (set in Deno Deploy → Project → Settings → Environment Variables)
- `TELEGRAM_BOT_TOKEN` — your bot token
- `TELEGRAM_CHAT_ID` — your numeric Telegram user id (e.g., 5720447582)
- `SAMSARA_WEBHOOK_SECRET` — optional. If you set a secret in Samsara Webhook config, set the same value here to verify signatures.

## Endpoints
- `GET /` — health check
- `POST /samsara` — webhook receiver. Expects `application/json`

## Deploy steps
1. Create a new GitHub repo and push these files.
2. In Deno Deploy: New Project → Link GitHub repo → Entry file: `main.ts`.
3. Set env vars in Deno Deploy settings:
   - TELEGRAM_BOT_TOKEN
   - TELEGRAM_CHAT_ID
   - SAMSARA_WEBHOOK_SECRET (if used)
4. Copy the public HTTPS URL shown by Deno Deploy, e.g. `https://<your-app>.deno.dev/samsara`.
5. In Samsara dashboard: create a Webhook pointing to `/samsara`. If you add a secret there, make sure it matches `SAMSARA_WEBHOOK_SECRET`.

## Local test (optional)
```
deno run -A main.ts
curl -X POST http://localhost:8000/samsara -H "content-type: application/json" -d '{"test":true,"vehicle":"Truck 204","fault":"Oil Pressure Low","code":"SPN 111 FMI 1","value":"18 psi"}'
```

## Telegram test
Replace `BOT_TOKEN` and `CHAT_ID`:
```
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage" -d chat_id=$TELEGRAM_CHAT_ID -d text="Test OK"
```
