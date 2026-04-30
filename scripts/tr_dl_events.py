#!/usr/bin/env python3
"""
Download Trade Republic timeline events via pytr.

Uses pytr's `dl_docs` machinery, but only the event-export side (no PDF
downloads) so it's fast and idempotent. Writes to a directory passed by
the Node wrapper; that wrapper then parses `events_with_documents.json`.

Usage:
    python3 scripts/tr_dl_events.py <output-dir>
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def _emit_error(code: str, message: str, hint: str | None = None) -> None:
    payload = {"ok": False, "error": {"code": code, "message": message}}
    if hint:
        payload["error"]["hint"] = hint
    print(json.dumps(payload))
    sys.exit(2)


try:
    from pytr.api import TradeRepublicApi  # type: ignore
    from pytr.dl import DL  # type: ignore
except ImportError as e:
    _emit_error(
        "pytr_missing",
        f"pytr is not installed in this Python interpreter ({sys.executable}): {e}",
        "Install via: pip install -r requirements.txt",
    )


PYTR_DIR = Path(os.environ.get("PYTR_HOME") or (Path.home() / ".pytr"))
CREDENTIALS_FILE = PYTR_DIR / "credentials"


def main():
    if len(sys.argv) < 2:
        _emit_error("bad_args", "usage: tr_dl_events.py <output-dir>")
    out_dir = Path(sys.argv[1]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not CREDENTIALS_FILE.exists():
        _emit_error(
            "no_session",
            f"pytr credentials not found at {CREDENTIALS_FILE}",
            "Run `npm run sync:tr:setup` first.",
        )

    raw = [
        line.strip()
        for line in CREDENTIALS_FILE.read_text().splitlines()
        if line.strip()
    ]
    phone, pin = raw[0], raw[1]

    tr = TradeRepublicApi(phone_no=phone, pin=pin, save_cookies=True)

    try:
        ok = tr.resume_websession()
    except Exception as e:
        _emit_error(
            "auth_failed",
            f"resume_websession threw: {type(e).__name__}: {e}",
            "Run `npm run sync:tr:setup` to refresh.",
        )
    if not ok:
        _emit_error(
            "auth_failed",
            "Saved Trade Republic session is missing or expired.",
            "Run `npm run sync:tr:setup` to refresh.",
        )

    dl = DL(
        tr=tr,
        output_path=str(out_dir),
        filename_fmt="{iso_date}_{title}",
        max_workers=1,
        format_export="json",
        export_transactions=True,
        store_event_database=True,
        scan_for_duplicates=False,
        dump_raw_data=True,
        flat=True,
    )

    dl.do_dl()

    # dl writes events_with_documents.json + other_events.json + account_transactions.json
    print(json.dumps({
        "ok": True,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "output_dir": str(out_dir),
    }))


if __name__ == "__main__":
    main()
