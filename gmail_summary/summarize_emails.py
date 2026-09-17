import os
import sys
import argparse
from datetime import datetime, timezone
from typing import List, Dict

import requests
from dateutil import parser as dateparser
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# Constants
AI_ENDPOINT = "http://192.168.68.123:1919"

def get_gmail_service() -> 'Resource':
    """
    Builds the Gmail API service using OAuth2 credentials.
    Expects the following environment variables to be set:
      - GOOGLE_CLIENT_ID
      - GOOGLE_CLIENT_SECRET
      - GOOGLE_REFRESH_TOKEN
    """
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    refresh_token = os.getenv("GOOGLE_REFRESH_TOKEN")

    if not all([client_id, client_secret, refresh_token]):
        raise EnvironmentError(
            "Missing Gmail OAuth2 credentials. "
            "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN."
        )

    creds = Credentials(
        None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=["https://www.googleapis.com/auth/gmail.readonly"],
    )
    # Refresh the access token
    creds.refresh(Request())

    service = build("gmail", "v1", credentials=creds)
    return service

def list_messages(service, user_id: str = "me", query: str = "", max_results: int = 100) -> List[Dict]:
    """
    Retrieve a list of message IDs matching the query.
    """
    try:
        response = service.users().messages().list(userId=user_id, q=query, maxResults=max_results).execute()
    except HttpError as error:
        print(f"An error occurred: {error}", file=sys.stderr)
        return []

    messages = response.get("messages", [])
    return messages

def get_message_details(service, msg_id: str, user_id: str = "me") -> Dict:
    """
    Fetch the full content of a message.
    """
    try:
        msg = service.users().messages().get(userId=user_id, id=msg_id, format="full").execute()
    except HttpError as error:
        print(f"An error occurred while fetching message {msg_id}: {error}", file=sys.stderr)
        return {}

    payload = msg.get("payload", {})
    parts = payload.get("parts", [])
    body = ""

    # Helper to recursively extract body text
    def extract_part(part):
        nonlocal body
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            data = part["body"]["data"]
            body += _base64url_decode(data)
        elif part.get("parts"):
            for sub in part["parts"]:
                extract_part(sub)

    extract_part(payload)

    # Fallback to snippet if body empty
    if not body:
        body = payload.get("snippet", "")

    return {
        "id": msg_id,
        "threadId": msg.get("threadId"),
        "snippet": payload.get("snippet", ""),
        "body": body,
        "headers": payload.get("headers", []),
    }

def _base64url_decode(data: str) -> str:
    """
    Decodes Gmail's base64url encoded strings.
    """
    import base64
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding).decode("utf-8", errors="ignore")

def summarize_text(text: str) -> str:
    """
    Sends the provided text to the AI model and returns the summary.
    """
    payload = {"prompt": f"Summarize the following email content:\n\n{text}"}
    try:
        resp = requests.post(AI_ENDPOINT, json=payload, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"AI request failed: {e}", file=sys.stderr)
        return "Error summarizing."

    data = resp.json()
    return data.get("summary", "No summary returned.")

def main():
    parser = argparse.ArgumentParser(description="Summarize recent Gmail emails.")
    parser.add_argument(
        "--since",
        required=True,
        help="ISO 8601 timestamp (e.g., 2024-01-01T00:00:00Z) to start fetching emails.",
    )
    parser.add_argument(
        "--max",
        type=int,
        default=20,
        help="Maximum number of emails to process.",
    )
    args = parser.parse_args()

    # Convert to Gmail's query format
    since_dt = dateparser.isoparse(args.since)
    if since_dt.tzinfo is None:
        since_dt = since_dt.replace(tzinfo=timezone.utc)
    query = f"after:{since_dt.strftime('%Y/%m/%d')} (is:unread OR is:starred)"

    service = get_gmail_service()

    messages = list_messages(service, query=query, max_results=args.max)
    if not messages:
        print("No matching emails found.")
        return

    summaries = []
    for msg_meta in messages:
        details = get_message_details(service, msg_meta["id"])
        body = details.get("body", "")
        if not body.strip():
            continue
        summary = summarize_text(body)
        summaries.append(
            f"Subject: {next((h['value'] for h in details.get('headers', []) if h['name'] == 'Subject'), 'No Subject')}\n"
            f"From: {next((h['value'] for h in details.get('headers', []) if h['name'] == 'From'), 'Unknown')}\n"
            f"Summary: {summary}\n"
            f"{'-'*40}"
        )

    print("\n".join(summaries))

if __name__ == "__main__":
    main()