#!/usr/bin/env python3
"""
Fetch Trade Republic portfolio + cash via pytr and emit JSON to stdout.

Usage:
    python3 scripts/tr_fetch.py            # uses ~/.pytr/credentials + cookies.txt
    python3 scripts/tr_fetch.py --debug    # verbose to stderr

Prereqs:
    pip install -r requirements.txt
    pytr login         # one-time, SMS or push 2FA
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

DEBUG = False


def _log(*args, **kwargs):
    if DEBUG:
        print(*args, file=sys.stderr, **kwargs)


def _emit_error(code: str, message: str, hint: str | None = None) -> None:
    payload = {"ok": False, "error": {"code": code, "message": message}}
    if hint:
        payload["error"]["hint"] = hint
    print(json.dumps(payload))
    sys.exit(2)


try:
    from pytr.api import TradeRepublicApi  # type: ignore
except ImportError as e:
    _emit_error(
        "pytr_missing",
        f"pytr is not installed in this Python interpreter ({sys.executable}): {e}",
        "Install via: pip install -r requirements.txt",
    )


PYTR_DIR = Path(os.environ.get("PYTR_HOME") or (Path.home() / ".pytr"))
CREDENTIALS_FILE = PYTR_DIR / "credentials"


def load_credentials() -> tuple[str, str]:
    if not CREDENTIALS_FILE.exists():
        _emit_error(
            "no_session",
            f"pytr credentials file not found at {CREDENTIALS_FILE}",
            "Run `npm run sync:tr:setup` first to authenticate.",
        )
    raw = [
        line.strip()
        for line in CREDENTIALS_FILE.read_text().splitlines()
        if line.strip()
    ]
    if len(raw) < 2:
        _emit_error(
            "bad_credentials",
            f"credentials file at {CREDENTIALS_FILE} is malformed",
            "Re-run `npm run sync:tr:setup`.",
        )
    return raw[0], raw[1]


async def fetch() -> dict:
    phone, pin = load_credentials()
    _log(f"loaded credentials for phone {phone[:4]}…")

    # Let pytr resolve credentials_file / cookies_file from its own defaults
    # (BASE_DIR/cookies.<phone>.txt). Passing custom paths broke session resume
    # since the filename pattern includes the phone number.
    api = TradeRepublicApi(
        phone_no=phone,
        pin=pin,
        save_cookies=True,
    )

    # resume_websession() returns True if the saved cookies are still valid.
    # On False (or exception), we have no auth token — fail loudly so the
    # Node wrapper can fire a re-auth notification.
    try:
        ok = api.resume_websession()
    except Exception as e:
        _emit_error(
            "auth_failed",
            f"resume_websession threw: {type(e).__name__}: {e}",
            "Run `npm run sync:tr:setup` to refresh the session.",
        )
    if not ok:
        _emit_error(
            "auth_failed",
            "Saved Trade Republic session is missing or expired.",
            "Run `npm run sync:tr:setup` to refresh the session.",
        )

    _log("websocket connected, requesting portfolio + cash…")

    positions: list[dict] = []
    cash: list[dict] = []
    got_portfolio = False
    got_cash = False

    await api.compact_portfolio()
    await api.cash()

    deadline = asyncio.get_event_loop().time() + 30
    while not (got_portfolio and got_cash):
        if asyncio.get_event_loop().time() > deadline:
            _log("timeout waiting for portfolio/cash messages")
            break
        try:
            recv_result = await asyncio.wait_for(api.recv(), timeout=10)
        except asyncio.TimeoutError:
            _log("recv timeout, retrying…")
            continue

        sub_id, sub, msg = recv_result
        sub_type = sub.get("type") if isinstance(sub, dict) else str(sub)
        _log(f"  recv: type={sub_type}")

        if sub_type == "compactPortfolio":
            for p in (msg.get("positions") or []):
                positions.append(
                    {
                        "isin": p.get("instrumentId"),
                        "name": p.get("name") or p.get("instrumentId"),
                        "quantity": float(p.get("netSize", 0) or 0),
                        "value": float(p.get("netValue", 0) or 0),
                        "averagePrice": (
                            float(p["averageBuyIn"])
                            if p.get("averageBuyIn") not in (None, "", 0)
                            else None
                        ),
                        "livePrice": None,
                    }
                )
            got_portfolio = True

        elif sub_type == "cash":
            entries = msg if isinstance(msg, list) else (msg.get("cash") or [])
            for c in entries:
                cash.append(
                    {
                        "currency": c.get("currencyId") or c.get("currency") or "EUR",
                        "amount": float(c.get("amount", 0) or 0),
                    }
                )
            got_cash = True

    # ---- live prices via per-ISIN ticker subscriptions ----
    # TR exposes a "ticker" subscription that streams bid/ask for an instrument
    # on a specific exchange. LSX (Lang & Schwarz) is the default retail venue
    # and is reliable for every TR-listed instrument.
    if positions:
        _log("subscribing to ticker streams for live prices…")
        sub_ids: dict[int, dict] = {}
        for p in positions:
            isin = p.get("isin")
            if not isin:
                continue
            sub = {"type": "ticker", "id": f"{isin}.LSX"}
            try:
                sid = await api.subscribe(sub)
                sub_ids[sid] = p
            except Exception as e:
                _log(f"  ticker subscribe failed for {isin}: {e}")
                continue

        # Wait for one tick per subscription (or timeout). The ticker stream
        # is push-based — first message has the latest bid/ask; we don't need
        # to keep the subscription alive after that.
        ticker_deadline = asyncio.get_event_loop().time() + 15
        unresolved = set(sub_ids.keys())
        while unresolved and asyncio.get_event_loop().time() < ticker_deadline:
            try:
                recv_result = await asyncio.wait_for(api.recv(), timeout=4)
            except asyncio.TimeoutError:
                continue
            sid, sub, msg = recv_result
            if sid not in unresolved:
                continue
            position = sub_ids[sid]
            # message shape: {"bid": {"price": "..."}, "ask": {"price": "..."},
            #                "last": {"price": "..."}, ...}
            def _pick_price(m: dict) -> float | None:
                for key in ("last", "bid", "ask"):
                    v = m.get(key)
                    if isinstance(v, dict) and v.get("price"):
                        try:
                            return float(v["price"])
                        except (TypeError, ValueError):
                            continue
                return None
            price = _pick_price(msg) if isinstance(msg, dict) else None
            if price is not None:
                position["livePrice"] = price
                qty = position.get("quantity") or 0
                if qty:
                    position["value"] = qty * price
            unresolved.discard(sid)

        # Unsubscribe to be polite.
        for sid in list(sub_ids.keys()):
            try:
                await api.unsubscribe(sid)
            except Exception:
                pass
        _log(f"  resolved live prices for {len(sub_ids) - len(unresolved)}/{len(sub_ids)} positions")

    try:
        await api.close()
    except Exception:
        pass

    return {
        "ok": True,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "positions": positions,
        "cash": cash,
    }


def main():
    global DEBUG
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    DEBUG = args.debug or bool(os.environ.get("TR_DEBUG"))

    try:
        result = asyncio.run(fetch())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        _emit_error("unexpected", f"{type(e).__name__}: {e}")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
