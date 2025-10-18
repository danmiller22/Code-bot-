# Samsara → Telegram Notifier (Deno Deploy) — Polling Mode

Поллинг Samsara API по крону и DM в Telegram без БД.

## Env vars
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (пример: 5720447582)
- `SAMSARA_API_TOKEN`
- `MIN_OIL_KPA` (опц.)
- `MIN_AIR_KPA` (опц.)

## Деплой
1) Обнови репозиторий этими файлами.
2) В Deno Deploy сделай Redeploy.
3) Крон `*/2 * * * *` начнёт слать новые DTC сразу. Для давления задай пороги.

Документация:
- Samsara Fault Monitoring / Vehicle Stats (faultCodes, engineOilPressureKPa)
- Deno Deploy Cron
