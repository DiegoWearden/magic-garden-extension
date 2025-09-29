#!/usr/bin/env python3
"""
Quick WebSocket scanner for Magic Garden shop items.

Usage:
  python ws_scan_items.py --out discovered_items.json --timeout 6 --headless

This script opens the ROOM_URL (or provided --url), listens to CDP Network.webSocketFrameReceived
frames for Welcome and PartialState messages, extracts item names (displayName/name/species/toolId/eggId/decorId/id)
and writes a deduplicated, sorted JSON array to the output file.

Requires: playwright (pip install playwright) and playwright browsers installed (playwright install).
"""

import json
import time
import argparse
import re
from typing import List, Set

from playwright.sync_api import sync_playwright

# Canonical lists to help categorize discovered names (kept small and representative)
SEEDS_CANON = [
    "carrot","strawberry","aloe","blueberry","apple","tulip","tomato","daffodil",
    "corn","watermelon","pumpkin","echeveria","coconut","banana","lily","burros tail",
    "mushroom","cactus","bamboo","grape","pepper","lemon","passion fruit","dragon fruit",
    "lychee","sunflower","starweaver"
]
EGGS_CANON = ["commonegg","uncommonegg","rareegg","legendaryegg","mythicalegg"]
TOOLS_CANON = ["wateringcan","planterpot","shovel"]
DECOR_CANON = ["smallrock","mediumrock","largerock","woodbench","woodarch","woodbridge","woodlamppost","woodowl",
               "stonebench","stonearch","stonebridge","stonelamppost","stonegnome",
               "marblebench","marblearch","marblebridge","marblelamppost"]

def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def categorize_name(name: str) -> str:
    k = (name or "").strip()
    nk = _norm(k)
    if not nk:
        return 'decor'
    # eggs
    if 'egg' in nk or nk in EGGS_CANON:
        return 'egg'
    # tools
    if nk in TOOLS_CANON or any(x in nk for x in ('can','shovel','pot','tool')):
        return 'tool'
    # seeds: match canonical or common suffixes
    seed_suffixes = ('seed','kernel','cutting','spore','pit','pod')
    if any(nk.endswith(_norm(suf)) for suf in seed_suffixes):
        return 'seed'
    if nk in set(_norm(x) for x in SEEDS_CANON):
        return 'seed'
    # decor
    if nk in set(_norm(x) for x in DECOR_CANON) or any(x in nk for x in ('rock','bench','bridge','lamp','post','owl','gnome','bird')):
        return 'decor'
    # fallback: if single word and looks plant-like, choose seed
    if ' ' not in k and len(k) <= 20 and nk.isalpha():
        return 'seed'
    return 'decor'


def _extract_price_from_item(item: dict):
    """Try to find a numeric price in an item dict. Return float or None."""
    if not isinstance(item, dict):
        return None
    # common price keys
    candidates = ('price', 'cost', 'buyPrice', 'priceInCoins', 'value')
    for key in candidates:
        if key in item:
            v = item.get(key)
            try:
                if isinstance(v, (int, float)):
                    return float(v)
                if isinstance(v, str):
                    return float(v.replace(',', '').strip())
                if isinstance(v, dict):
                    # nested structure like { amount: 100 }
                    for subk in ('amount', 'value', 'price'):
                        if subk in v:
                            try:
                                return float(v.get(subk))
                            except Exception:
                                pass
            except Exception:
                pass
    # fallback: sometimes price is attached as item['shopPrice'] or similar
    for k, v in item.items():
        if 'price' in k.lower() or 'cost' in k.lower():
            try:
                if isinstance(v, (int, float)):
                    return float(v)
                if isinstance(v, str):
                    return float(v.replace(',', '').strip())
            except Exception:
                pass
    return None


def _extract_items_with_kinds_from_fullstate(fs: dict) -> dict:
    """Return mapping kind -> list of (name, price) by inspecting fullState-shaped payload.

    Preserves the shop keys as kinds (normalized) and gathers any numeric price found on items.
    """
    out = {}
    try:
        def find_shops(obj, depth=0):
            if depth > 8 or not isinstance(obj, dict):
                return None
            if 'shops' in obj and isinstance(obj['shops'], dict):
                return obj['shops']
            for k in ('data', 'child', 'childData'):
                v = obj.get(k)
                if isinstance(v, dict):
                    if 'data' in v and isinstance(v.get('data'), dict):
                        res = find_shops(v.get('data'), depth+1)
                        if res:
                            return res
                    res = find_shops(v, depth+1)
                    if res:
                        return res
            for v in list(obj.values()):
                if isinstance(v, dict):
                    res = find_shops(v, depth+1)
                    if res:
                        return res
            return None

        shops = find_shops(fs) or {}
        for kind, s in shops.items():
            k = _norm(kind or 'unknown')
            if k not in out:
                out[k] = []
            if not isinstance(s, dict):
                continue
            inv = s.get('inventory') or []
            for it in inv:
                if not isinstance(it, dict):
                    continue
                name = (
                    it.get('displayName') or it.get('name') or it.get('species')
                    or it.get('toolId') or it.get('eggId') or it.get('decorId') or it.get('id')
                )
                if name:
                    price = _extract_price_from_item(it)
                    out[k].append((str(name), price))
    except Exception:
        pass
    return out


def capture_items_from_ws(url: str, timeout: float = 6.0, headless: bool = True, debug: bool = False) -> dict:
    # returns mapping kind -> list(names) preserving the order items are first observed
    collected = {}  # kind -> list of names
    seen_per_kind = {}  # kind -> set of seen names to preserve first-seen order
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            ctx = browser.new_context(service_workers='allow')
            page = ctx.new_page()
            client = ctx.new_cdp_session(page)
            client.send('Network.enable')

            if debug:
                print('[DEBUG] CDP Network enabled')

            def on_ws_created(params):
                try:
                    urlc = params.get('url') or params.get('requestId') or ''
                    if debug:
                        print(f"[DEBUG] webSocketCreated: {urlc}")
                except Exception:
                    pass
            client.on('Network.webSocketCreated', on_ws_created)

            def on_ws_frame(params):
                try:
                    payload = params.get('response', {}).get('payloadData', '')
                    if not payload or not (payload.startswith('{') or payload.startswith('[')):
                        return
                    obj = json.loads(payload)
                except Exception:
                    return
                t = obj.get('type')
                if debug:
                    try:
                        excerpt = payload if len(payload) <= 1000 else payload[:1000] + '...'
                        print(f"[DEBUG] WS_FRAME type={t} len={len(payload)} payload_excerpt={excerpt}")
                    except Exception:
                        print(f"[DEBUG] WS_FRAME type={t} len={len(payload)}")
                if t == 'Welcome':
                    fs = obj.get('fullState') or {}
                    items_by_kind = _extract_items_with_kinds_from_fullstate(fs)
                    for k, items in items_by_kind.items():
                        lst = collected.setdefault(k, [])
                        seen = seen_per_kind.setdefault(k, set())
                        for name, _price in items:
                            if name in seen:
                                continue
                            seen.add(name)
                            lst.append(name)
                elif t == 'PartialState':
                    # PartialState carries patches; try to infer the shop kind from the patch path
                    patches = obj.get('patches') or []
                    try:
                        name_keys = {'displayName', 'name', 'species', 'toolId', 'eggId', 'decorId', 'id'}
                        for p in patches:
                            v = p.get('value')
                            path = p.get('path') or ''
                            kind = None
                            # look for /shops/<kind>/ in the path
                            try:
                                import re as _re
                                m = _re.search(r'/shops/([^/\]]+)', path)
                                if m:
                                    kind = _norm(m.group(1))
                            except Exception:
                                kind = None

                            # If the value is a dict and looks like a shop subtree, extract its shops
                            if isinstance(v, dict):
                                # If dict contains shops mapping, extract by-kind
                                items_by_kind = _extract_items_with_kinds_from_fullstate(v)
                                if items_by_kind:
                                    for kk, items in items_by_kind.items():
                                        lst = collected.setdefault(kk, [])
                                        seen = seen_per_kind.setdefault(kk, set())
                                        for name, _price in items:
                                            if name in seen:
                                                continue
                                            seen.add(name)
                                            lst.append(name)
                                    continue
                                # If dict looks like a single inventory item, try to grab its name and price
                                for nk in name_keys:
                                    if nk in v and v.get(nk):
                                        k2 = kind or 'unknown'
                                        lst = collected.setdefault(k2, [])
                                        seen = seen_per_kind.setdefault(k2, set())
                                        name = str(v.get(nk))
                                        if name in seen:
                                            break
                                        seen.add(name)
                                        lst.append(name)
                                        break
                            # If the value is a list, inspect elements for item dicts
                            if isinstance(v, list):
                                for item in v:
                                    if isinstance(item, dict):
                                        # attempt to extract item name and price
                                        got = False
                                        for nk in name_keys:
                                            if nk in item and item.get(nk):
                                                k2 = kind or 'unknown'
                                                lst = collected.setdefault(k2, [])
                                                seen = seen_per_kind.setdefault(k2, set())
                                                name = str(item.get(nk))
                                                if name in seen:
                                                    got = True
                                                    break
                                                seen.add(name)
                                                lst.append(name)
                                                got = True
                                                break
                                        if got:
                                            continue
                                        # fallback: try to extract nested shops from item
                                        items_by_kind = _extract_items_with_kinds_from_fullstate(item)
                                        for kk, items in items_by_kind.items():
                                            lst = collected.setdefault(kk, [])
                                            seen = seen_per_kind.setdefault(kk, set())
                                            for name, _price in items:
                                                if name in seen:
                                                    continue
                                                seen.add(name)
                                                lst.append(name)
                    except Exception:
                        pass

            client.on('Network.webSocketFrameReceived', on_ws_frame)

            # navigate to page and try to open SHOP (best-effort)
            try:
                page.goto(url, timeout=15000)
                try:
                    page.get_by_role('button', name=re.compile(r"\bSHOP\b", re.I)).click(timeout=5000)
                except Exception:
                    pass
            except Exception:
                pass

            # wait for frames
            end = time.time() + timeout
            while time.time() < end:
                time.sleep(0.1)

            try:
                browser.close()
            except Exception:
                pass
    except Exception:
        pass

    # collected is kind -> ordered list of names
    return collected


def main():
    parser = argparse.ArgumentParser(description='Scan Magic Garden WebSocket for shop item names')
    parser.add_argument('--url', '-u', default='https://magiccircle.gg/r/LDQK', help='Room URL to open')
    parser.add_argument('--timeout', '-t', type=float, default=6.0, help='Seconds to listen for WS frames')
    parser.add_argument('--out', '-o', default='discovered_items.json', help='Output JSON file path')
    parser.add_argument('--headless', action='store_true', help='Run browser headless (default false)')
    parser.add_argument('--debug', action='store_true', help='Print CDP/WebSocket debug output')
    args = parser.parse_args()

    # default headless True unless flag provided? Keep flag semantics: if --headless present run headless, else headful.
    headless_mode = bool(args.headless)

    names_by_kind = capture_items_from_ws(args.url, timeout=args.timeout, headless=headless_mode, debug=bool(args.debug))

    # Preserve observed order from the websocket; normalize keys
    grouped = {}
    if isinstance(names_by_kind, dict):
        for raw_k, arr in names_by_kind.items():
            nk = _norm(raw_k)
            if not isinstance(arr, list):
                continue
            # dedupe while preserving order just in case
            seen = set()
            out = []
            for v in arr:
                if not v:
                    continue
                s = str(v)
                if s in seen:
                    continue
                seen.add(s)
                out.append(s)
            grouped[nk] = out

    # write grouped JSON to file
    try:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(grouped, f, indent=2, ensure_ascii=False)
        total = sum(len(v) for v in grouped.values())
        print(f'Wrote {total} items into groups to {args.out}')
    except Exception as e:
        print('Failed to write output:', e)


if __name__ == '__main__':
    main()
