#!/usr/bin/env python3
"""Gmail Summary Script
========================

This script connects to the Gmail API, retrieves all emails received after a
specified time, and sends a short summary request to a local AI model
(`http://192.168.68.123:1919`).  The summary is printed to stdout.

Prerequisites
------------
* Python 3.9+.
* The `google-api-python-client` and `google-auth` packages.  They can be
  installed with:
  ````bash
  pip install --upgrade google-api-python-client google-auth google-auth-oauthlib
  ````
* A Gmail API credential file (`credentials.json`) in the same directory.  The
  instructions for creating these credentials can be found in the Google
  Developers console.

Usage
-----
````bash
python3 summarize_gmail.py --since 2023-09-01T12:00:00Z
````
The ``--since`` argument accepts any RFC‑3339 timestamp.  If omitted the
script will default to 24 hours ago.

Note: This is a lightweight example and does not handle pagination beyond the
first 1000 messages.  For production use, add proper pagination and error
handling.
"""

import argparse
import datetime
import json
import os
import sys
from typing import List

import requests

# The Gmail API client is imported lazily to avoid import errors if the
# dependencies are not installed.  The import is wrapped in a try/except so
# that a clear error message is displayed.
try:
    from googleapiclient.discovery import build
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    import google.auth.credentials
except Exception as exc:  # pragma: no cover - executed only if missing deps
    print("Error importing Google API client libraries: {}".format(exc), file=sys.stderr)
    print("Install them with: pip install --upgrade google-api-python-client google-auth google-auth-oauthlib", file=sys.stderr)
    sys.exit(1)


SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def get_gmail_service() -> 'googleapiclient.discovery.Resource':
    """Authenticate and return a Gmail API service instance.

    The function first looks for a cached token in ``token.json``.  If it is
    missing or expired, it starts an OAuth2 flow using ``credentials.json``.
    The token is then saved for future runs.
    """
    creds = None
    token_path = os.path.join(os.path.dirname(__file__), "token.json")
    creds_path = os.path.join(os.path.dirname(__file__), "credentials.json")
    if os.path.exists(token_path):
        creds = google.auth.credentials.Credentials.from_authorized_user_file(token_path, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(creds_path):
                print("Missing credentials.json. Please create OAuth credentials for Gmail API.", file=sys.stderr)
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(creds_path, SCOPES)
            creds = flow.run_local_server(port=0)
        # Save the credentials for the next run
        with open(token_path, "w") as token_file:
            token_file.write(creds.to_json())
    service = build("gmail", "v1", credentials=creds)
    return service


def fetch_messages(service, since: datetime.datetime, max_results: int = 50) -> List[dict]:
    """Retrieve messages after ``since``.

    Parameters
    ----------
    service: Gmail API service object
    since: datetime.datetime in UTC
    max_results: maximum number of messages to fetch (default 50)
    """
    query = f"after:{since.strftime('%Y/%m/%d')}"  # Gmail uses date only
    results = service.users().messages().list(userId="me", q=query, maxResults=max_results).execute()
    messages = results.get("messages", [])
    email_summaries = []
    for msg in messages:
        msg_detail = service.users().messages().get(userId="me", id=msg["id"], format="full").execute()
        headers = msg_detail.get("payload", {}).get("headers", [])
        subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No Subject)")
        snippet = msg_detail.get("snippet", "")
        email_summaries.append({"subject": subject, "snippet": snippet})
    return email_summaries


def summarize_emails(emails: List[dict]) -> str:
    """Send the email data to the local AI model and return the summary.

    The model endpoint expects a JSON payload compatible with the OpenAI
    ChatCompletion API.  The prompt instructs the model to produce a concise
    summary of the most important emails.
    """
    if not emails:
        return "No new emails found since the specified time."

    # Build a message list for the model
    email_text = "\n\n".join(f"Subject: {e['subject']}\nSnippet: {e['snippet']}" for e in emails)
    prompt = f"Summarise the following emails in a short paragraph, highlighting the most important points:\n\n{email_text}"
    payload = {
        "model": "gpt-oss-20b",
        "messages": [{"role": "user", "content": prompt}],
    }
    try:
        response = requests.post("http://192.168.68.123:1919/v1/chat/completions", json=payload)
        response.raise_for_status()
        data = response.json()
        # The model may return multiple choices; we use the first
        return data["choices"][0]["message"]["content"].strip()
    except Exception as exc:
        print("Error calling AI model: {}".format(exc), file=sys.stderr)
        return "Error summarising emails."


def main():
    parser = argparse.ArgumentParser(description="Summarise recent Gmail messages.")
    parser.add_argument(
        "--since",
        type=str,
        default=(datetime.datetime.utcnow() - datetime.timedelta(days=1)).isoformat() + "Z",
        help="ISO 8601 timestamp (UTC) specifying the earliest message to include.",
    )
    parser.add_argument(
        "--max",
        type=int,
        default=50,
        help="Maximum number of emails to fetch (default 50).",
    )
    args = parser.parse_args()

    try:
        since_dt = datetime.datetime.fromisoformat(args.since.replace("Z", "+00:00"))
    except ValueError:
        print("Invalid --since format. Use ISO 8601 e.g. 2023-09-01T12:00:00Z", file=sys.stderr)
        sys.exit(1)

    service = get_gmail_service()
    emails = fetch_messages(service, since_dt, max_results=args.max)
    summary = summarize_emails(emails)
    print("\n=== Email Summary ===\n")
    print(summary)


if __name__ == "__main__":
    main()
