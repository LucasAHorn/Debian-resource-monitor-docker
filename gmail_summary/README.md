# Gmail Summary Script

This script connects to your Gmail account, retrieves emails since a specified timestamp, and uses an AI model to generate a short summary of the most important emails.

## Prerequisites

- Python 3.9+
- Gmail API credentials (OAuth2).  
  - Create OAuth client ID in Google Cloud Console.  
  - Obtain a **refresh token** for the Gmail scope (`https://www.googleapis.com/auth/gmail.readonly`).  
  - Export the following environment variables before running the script:
    - `GOOGLE_CLIENT_ID`
    - `GOOGLE_CLIENT_SECRET`
    - `GOOGLE_REFRESH_TOKEN`

- The AI model service running at `http://192.168.68.123:1919`.  
  The endpoint should accept a JSON payload:
  ```json
  {
    "prompt": "Summarize the following email content:\n\n<email_text>"
  }
  ```
  and return a JSON object with a `summary` field.

## Installation

```bash
pip install -r gmail_summary/requirements.txt
```

## Usage

```bash
python gmail_summary/summarize_emails.py --since 2024-01-01T00:00:00Z
```

The script will:
1. Fetch unread or starred emails after the provided timestamp.  
2. Send each email's body to the AI model for summarization.  
3. Print the summaries to stdout.

---

Enjoy!