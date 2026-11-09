# Telegram delivery behavior

The worker uses the Telegram Bot API sendMessage method only. It stores per-destination delivery state in the notification outbox, retries transient failures with exponential backoff, and marks deliveries failed after eight attempts. Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID or TELEGRAM_CHAT_IDS. No Telegram credentials are committed.
