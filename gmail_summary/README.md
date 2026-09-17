# Gmail Summary Script

Summarizes your most important Gmail messages using a local AI model.

## Setup

1. Copy the example env file and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your Gmail credentials:
   - **GMAIL_EMAIL**: Your Gmail address
   - **GMAIL_APP_PASSWORD**: An [App Password](https://myaccount.google.com/apppasswords) (NOT your regular password)

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

```bash
# Default: last 7 days, up to 30 emails
python gmail_summary.py

# Last 1 day
python gmail_summary.py --days 1

# Last 6 hours
python gmail_summary.py --hours 6

# Specific time
python gmail_summary.py --since "2024-09-15 09:00"

# Fetch 10, summarize top 5
python gmail_summary.py --max 10 --top 5

# Preview emails without calling AI
python gmail_summary.py --dry-run

# Output as JSON
python gmail_summary.py --json
```

## How It Works

1. **Fetches** emails from Gmail via IMAP (starred + unread)
2. **Scores** each email by importance (recency, subject keywords, attachments, body length)
3. **Summarizes** the top emails using the local AI model at `http://192.168.68.123:1919`

## AI Model

- Uses the OpenAI-compatible API at the configured endpoint
- Default: `Qwen3.6-35B-A3B-NVFP4` via FreeToken
- Configurable via `AI_BASE_URL` and `AI_MODEL` in `.env`

## Gmail Setup

1. Enable 2-Step Verification on your Google account
2. Generate an App Password: https://myaccount.google.com/apppasswords
3. Use the 16-character app password in `.env`
