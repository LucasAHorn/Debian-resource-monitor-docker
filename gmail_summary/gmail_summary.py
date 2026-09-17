#!/usr/bin/env python3
"""
Gmail Summary Script
====================
Fetches emails from Gmail since a given date/time, scores them by importance,
and generates a concise summary of the most important ones using a local AI model.

Usage:
    python gmail_summary.py                          # defaults: last 7 days, 30 emails
    python gmail_summary.py --days 1                 # last 1 day
    python gmail_summary.py --hours 6                # last 6 hours
    python gmail_summary.py --since "2024-01-15 09:00"  # exact start
    python gmail_summary.py --max 10 --top 5         # fetch 10, summarize top 5
"""

import argparse
import imaplib
import email
from email.header import decode_header
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta
import os
import re
import json
import sys
import time

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(path=".env"):
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, val = line.split("=", 1)
                        os.environ.setdefault(key.strip(), val.strip())

import requests


def load_config():
    load_dotenv()
    return {
        "gmail_email": os.getenv("GMAIL_EMAIL", ""),
        "gmail_app_password": os.getenv("GMAIL_APP_PASSWORD", ""),
        "ai_base_url": os.getenv("AI_BASE_URL", "http://192.168.68.123:1919/v1"),
        "ai_model": os.getenv("AI_MODEL", "Qwen3.6-35B-A3B-NVFP4"),
        "ai_api_key": os.getenv("AI_API_KEY", "freetoken"),
    }


def connect_imap(config):
    imap = imaplib.IMAP4_SSL("imap.gmail.com", 993)
    imap.login(config["gmail_email"], config["gmail_app_password"])
    return imap


def decode_mime_header(raw):
    if raw is None:
        return ""
    parts = decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded.append(part)
    return " ".join(decoded)


def get_email_body(msg):
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            cdispo = str(part.get("Content-Disposition", ""))
            if ctype == "text/plain" and "attachment" not in cdispo:
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or "utf-8"
                body += payload.decode(charset, errors="replace")
            elif ctype == "text/html" and not body:
                payload = part.get_payload(decode=True)
                charset = part.get_content_charset() or "utf-8"
                html = payload.decode(charset, errors="replace")
                body += re.sub(r"<[^>]+>", "", html)
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            body = payload.decode(charset, errors="replace")
    return body.strip()[:2000]


def build_email_info(msg):
    subject = decode_mime_header(msg.get("Subject"))
    from_addr = decode_mime_header(msg.get("From"))
    to_addr = decode_mime_header(msg.get("To"))
    date_str = msg.get("Date")
    has_attachment = any(part.get_filename() for part in (msg.walk() if msg.is_multipart() else [msg]) if part.get_filename())
    try:
        date_obj = parsedate_to_datetime(date_str) if date_str else datetime.now()
    except Exception:
        date_obj = datetime.now()
    body_preview = get_email_body(msg)
    return {
        "subject": subject, "from": from_addr, "to": to_addr,
        "date": date_obj, "has_attachment": has_attachment,
        "body_preview": body_preview,
    }


def fetch_emails(imap, since_dt, max_emails=30):
    imap.select("INBOX")
    seen_ids = set()
    results = []

    def _search_and_parse(criterion):
        status, msg_ids = imap.search(None, criterion)
        if status != "OK" or not msg_ids[0]:
            return []
        id_list = msg_ids[0].split()
        emails = []
        for mid in id_list[:max_emails * 2]:
            status, data = imap.fetch(mid, "(RFC822)")
            if status != "OK":
                continue
            raw = data[0][1]
            msg = email.message_from_bytes(raw)
            uid = msg.get("Message-ID", mid.decode())
            if uid in seen_ids:
                continue
            seen_ids.add(uid)
            email_info = build_email_info(msg)
            if email_info:
                emails.append(email_info)
        return emails

    results.extend(_search_and_parse("FLAGGED SINCE"))
    results.extend(_search_and_parse(f"UNSEEN SINCE {since_dt.strftime('%d-%b-%Y')}"))
    results.sort(key=lambda e: e["date"], reverse=True)
    return results[:max_emails]


IMPORTANT_SUBJECT_KEYWORDS = [
    "urgent", "action required", "important", "deadline",
    "meeting", "interview", "offer", "invoice", "payment",
    "account", "security", "alert", "notification", "confirmation",
]


def score_email(email_info):
    score = 0
    subj_lower = email_info["subject"].lower()
    age_hours = (datetime.now() - email_info["date"]).total_seconds() / 3600
    if age_hours < 1:
        score += 20
    elif age_hours < 24:
        score += 10
    elif age_hours < 168:
        score += 5
    score += 5
    for kw in IMPORTANT_SUBJECT_KEYWORDS:
        if kw in subj_lower:
            score += 8
    if email_info["has_attachment"]:
        score += 10
    body = email_info.get("body_preview", "")
    if len(body) > 500:
        score += 5
    elif len(body) < 50:
        score -= 5
    return max(0, min(100, score))


def build_prompt(emails_with_scores):
    lines = [
        "You are an assistant that summarizes important emails for a user.",
        "Below are emails ranked by importance score. Provide a concise summary.",
        "",
        "Format your response as follows:",
        "1. A 2-3 sentence overall summary of what's happening.",
        "2. A numbered list of the top 3-5 most important emails with:",
        "   - Subject line",
        "   - From (sender)",
        "   - Date",
        "   - A one-line summary of the content",
        "   - Why it's important (score)",
        "3. Any action items or deadlines mentioned.",
        "",
        "=" * 60,
        "",
    ]
    for i, (email, score) in enumerate(emails_with_scores, 1):
        lines.append(f"--- Email #{i} (Score: {score}) ---")
        lines.append(f"Subject: {email['subject']}")
        lines.append(f"From:    {email['from']}")
        lines.append(f"Date:    {email['date']}")
        if email["has_attachment"]:
            lines.append("Attachment: YES")
        body = email.get("body_preview", "(no body)")
        if len(body) > 800:
            body = body[:800] + "..."
        lines.append(f"Content: {body}")
        lines.append("")
    lines.append("=" * 60)
    lines.append("Provide your summary now:")
    return "\n".join(lines)


def call_ai_model(prompt, config):
    url = f"{config['ai_base_url']}/chat/completions"
    payload = {
        "model": config["ai_model"],
        "messages": [
            {"role": "system", "content": "You are a helpful email summary assistant. Be concise and highlight what matters."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 20000,
        "temperature": 0.3,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['ai_api_key']}",
    }
    print(f"  -> Calling AI model at {url} ...", file=sys.stderr)
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        return f"[AI call failed: {e}]"


def parse_args():
    parser = argparse.ArgumentParser(description="Summarize important Gmail messages")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--days", type=int, default=None, help="Look back N days (default: 7)")
    group.add_argument("--hours", type=int, default=None, help="Look back N hours")
    group.add_argument("--since", type=str, default=None, help='Exact start: "YYYY-MM-DD HH:MM"')
    parser.add_argument("--max", type=int, default=30, help="Max emails to fetch (default: 30)")
    parser.add_argument("--top", type=int, default=None, help="Summarize only top N emails (default: all)")
    parser.add_argument("--dry-run", action="store_true", help="Show emails without calling AI")
    parser.add_argument("--json", action="store_true", help="Output raw JSON instead of formatted summary")
    return parser.parse_args()


def main():
    args = parse_args()
    config = load_config()

    if not config["gmail_email"] or not config["gmail_app_password"]:
        print("ERROR: Set GMAIL_EMAIL and GMAIL_APP_PASSWORD in .env file.", file=sys.stderr)
        print("  1. Create a .env file with your credentials", file=sys.stderr)
        print("  2. Generate an App Password at:", file=sys.stderr)
        print("     https://myaccount.google.com/apppasswords", file=sys.stderr)
        sys.exit(1)

    if args.since:
        since_dt = datetime.strptime(args.since, "%Y-%m-%d %H:%M")
    elif args.hours is not None:
        since_dt = datetime.now() - timedelta(hours=args.hours)
    else:
        days = args.days if args.days is not None else 7
        since_dt = datetime.now() - timedelta(days=days)

    print(f"Gmail:    {config['gmail_email']}", file=sys.stderr)
    print(f"Since:    {since_dt.strftime('%Y-%m-%d %H:%M')}", file=sys.stderr)
    print(f"AI Model: {config['ai_model']} at {config['ai_base_url']}", file=sys.stderr)
    print(f"Max emails to fetch: {args.max}", file=sys.stderr)
    print("-" * 60, file=sys.stderr)

    print("Connecting to Gmail...", file=sys.stderr)
    try:
        imap = connect_imap(config)
    except Exception as e:
        print(f"ERROR: Could not connect to Gmail: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        emails = fetch_emails(imap, since_dt, max_emails=args.max)
    finally:
        try:
            imap.logout()
        except Exception:
            pass

    if not emails:
        print("No emails found in the specified time range.", file=sys.stderr)
        sys.exit(0)

    print(f"Found {len(emails)} email(s). Scoring...", file=sys.stderr)
    scored = [(e, score_email(e)) for e in emails]
    scored.sort(key=lambda x: x[1], reverse=True)
    top_n = args.top if args.top else len(scored)

    if args.dry_run:
        print("\n=== EMAIL LIST (ranked by importance) ===\n")
        for i, (email, score) in enumerate(scored[:top_n], 1):
            print(f"  #{i}  Score: {score}")
            print(f"      From:    {email['from']}")
            print(f"      Subject: {email['subject']}")
            print(f"      Date:    {email['date']}")
            if email["has_attachment"]:
                print(f"      [ATTACHMENT]")
            body = email.get("body_preview", "")[:200]
            if body:
                print(f"      Preview: {body}...")
            print()
        if args.json:
            print(json.dumps(
                [{"subject": e["subject"], "from": e["from"], "date": str(e["date"]),
                  "score": s, "has_attachment": e["has_attachment"]}
                 for e, s in scored[:top_n]], indent=2, default=str))
        return

    top_emails = [e for e, _ in scored[:top_n]]
    top_scores = [s for _, s in scored[:top_n]]
    prompt = build_prompt(list(zip(top_emails, top_scores)))

    print(f"\nSummarizing top {top_n} email(s) with AI...", file=sys.stderr)
    time.sleep(1)
    summary = call_ai_model(prompt, config)

    print("\n" + "=" * 60)
    print(summary)
    print("=" * 60)

    if args.json:
        print(json.dumps(
            {"summary": summary, "emails_analyzed": len(emails),
             "top_emails": [{"subject": e["subject"], "from": e["from"],
                             "date": str(e["date"]), "score": s,
                             "has_attachment": e["has_attachment"]}
                            for e, s in scored[:top_n]]},
            indent=2, default=str))


if __name__ == "__main__":
    main()
