#!/usr/bin/env python3
"""ghost_players.py
Simple tool to maintain a WebSocket connection to a MagicCircle room URL.
Usage: python ghost_players.py --ws-url '<wss://...>' [--cookies 'name=val; ...']
"""
import asyncio
import sys
import argparse
import os
import time
from typing import Optional
import urllib.request
import urllib.parse
import re
import random
import string

# Try to import websockets; fallback to aiohttp when necessary
try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except Exception:
    websockets = None
    ConnectionClosed = Exception

try:
    import aiohttp
    from aiohttp import WSMsgType
except Exception:
    aiohttp = None
    WSMsgType = None

DEFAULT_WS = 'wss://magiccircle.gg/version/2f1b369/api/rooms/JC66/connect?surface=%22web%22&platform=%22desktop%22&playerId=%22p_CFF4UfRCQzJjGfea%22&version=%222f1b369%22&anonymousUserStyle=%7B%22color%22%3A%22Purple%22%2C%22avatarBottom%22%3A%22Bottom_DefaultGray.png%22%2C%22avatarMid%22%3A%22Mid_DefaultGray.png%22%2C%22avatarTop%22%3A%22Top_DefaultGray.png%22%2C%22avatarExpression%22%3A%22Expression_Default.png%22%2C%22name%22%3A%22Sunny+Papaya%22%7D&source=%22manualUrl%22'

LOG_TRUNC = 1000

# Preset player IDs extracted from provided sample WS URLs — convenient for reuse/testing
PRESET_PLAYER_IDS = [
    'p_7Jq8j2gkrTYsii94',
    'p_F2GVebGfKAooHpU2',
    'p_3kprq3DTK8ryiBaz',
    'p_NZmLiRZH2tNQuAPt',
    'p_CFF4UfRCQzJjGfea'
]

async def connect_with_websockets(ws_url: str, headers: Optional[list]):
    # Try to connect using the websockets package. Some versions expect 'extra_headers' or 'headers'.
    try:
        try:
            return await websockets.connect(ws_url, origin='https://magiccircle.gg', extra_headers=headers, ping_interval=20, ping_timeout=10, max_size=10*1024*1024)
        except TypeError:
            try:
                return await websockets.connect(ws_url, origin='https://magiccircle.gg', headers=headers, ping_interval=20, ping_timeout=10, max_size=10*1024*1024)
            except Exception as e2:
                # Some event loop implementations (or websockets versions) propagate headers through to loop.create_connection
                # which fails. Retry without passing headers as a final fallback.
                if 'create_connection() got an unexpected keyword argument' in str(e2):
                    return await websockets.connect(ws_url, origin='https://magiccircle.gg', ping_interval=20, ping_timeout=10, max_size=10*1024*1024)
                raise
    except Exception:
        raise

async def connect_with_aiohttp(ws_url: str, headers: Optional[dict]):
    if aiohttp is None:
        raise RuntimeError('aiohttp not available')
    session = aiohttp.ClientSession()
    try:
        ws = await session.ws_connect(ws_url, headers=headers, timeout=10)
        # attach session for later cleanup
        ws._mg_session = session
        return ws
    except Exception:
        await session.close()
        raise

async def maintain(ws_url: str, cookie: Optional[str] = None, room_code: Optional[str] = None, player_id: Optional[str] = None):
    """Maintain a single websocket connection.
    If room_code is provided, the function will re-scrape the room page before each connect attempt
    to obtain the most recent wss:// URL or version token and will inject the provided player_id.
    If ws_url is provided and room_code is None, it will attempt to connect directly to that URL (with player_id injected if provided).
    """
    backoff = 1.0
    max_backoff = 30.0
    running = True

    headers_list = [("User-Agent", "Mozilla/5.0 (X11; Linux x86_64)"), ("Referer", "https://magiccircle.gg/")]
    if cookie:
        headers_list.append(("Cookie", cookie))
    headers_dict = {k: v for (k, v) in headers_list}

    # helper to build a ws url from scraped value (either full wss or version token)
    def build_ws_from_scraped(scraped_val: str, room: str, pid: str) -> Optional[str]:
        try:
            if isinstance(scraped_val, str) and scraped_val.startswith('wss://'):
                # inject/replace playerId in the scraped URL
                try:
                    parsed = urllib.parse.urlparse(scraped_val)
                    q = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
                    q['playerId'] = pid
                    new_q = urllib.parse.urlencode(q)
                    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_q, parsed.fragment))
                except Exception:
                    return scraped_val
            # treat scraped as version token
            ver = str(scraped_val)
            if not ver:
                return None
            # Ensure player id is quoted like the browser (include %22 around value)
            quoted_pid = urllib.parse.quote(f'"{pid}"')
            quoted_ver = urllib.parse.quote(f'"{ver}"')
            return (f"wss://magiccircle.gg/version/{ver}/api/rooms/{room}/connect"
                    f"?surface=%22web%22&platform=%22desktop%22&playerId={quoted_pid}&version={quoted_ver}&source=%22manualUrl%22")
        except Exception:
            return None

    print(f"Maintainer starting. Target (room={room_code}): {ws_url or room_code}")

    # main loop: on each connect attempt, optionally re-scrape if room_code supplied
    while running:
        try:
            # If running in room discovery mode, fetch the latest connection info now
            effective_ws = ws_url
            if room_code:
                try:
                    scraped = await fetch_ws_url_via_http(room_code)
                except Exception:
                    scraped = None
                if scraped:
                    # Build effective ws using provided player_id (or random if none)
                    pid = player_id or generate_player_id()
                    built = build_ws_from_scraped(scraped, room_code, pid)
                    if built:
                        effective_ws = built
                else:
                    # If we couldn't scrape, fall back to any provided ws_url or wait and retry
                    if not effective_ws:
                        print(f"[maintain] Failed to discover ws for room {room_code}; retrying shortly")
                        await asyncio.sleep(min(backoff, 5.0))
                        backoff = min(backoff * 2.0, max_backoff)
                        continue

            if not effective_ws:
                print('[maintain] No ws URL available to connect to; retrying')
                await asyncio.sleep(min(backoff, 5.0))
                backoff = min(backoff * 2.0, max_backoff)
                continue

            # Attempt connection using existing logic but with effective_ws
            ws_conn = None
            use_aiohttp = False
            if aiohttp:
                try:
                    ws_conn = await connect_with_aiohttp(effective_ws, headers_dict)
                    use_aiohttp = True
                except Exception:
                    ws_conn = None
                    use_aiohttp = False
            if not ws_conn:
                if websockets:
                    try:
                        ws_conn = await connect_with_websockets(effective_ws, headers_list)
                        use_aiohttp = False
                    except Exception:
                        try:
                            ws_conn = await websockets.connect(effective_ws, origin='https://magiccircle.gg', ping_interval=20, ping_timeout=10, max_size=10*1024*1024)
                            use_aiohttp = False
                        except Exception:
                            raise
                else:
                    raise RuntimeError('neither aiohttp nor websockets is available')

            print(f"✓ Connected (via {'aiohttp' if use_aiohttp else 'websockets'}) -> {effective_ws}")
            backoff = 1.0

            recv_task = asyncio.create_task(receiver_loop(ws_conn, use_aiohttp))
            hb_task = asyncio.create_task(heartbeat_loop(ws_conn, use_aiohttp))

            done, pending = await asyncio.wait([recv_task], return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()

            try:
                if use_aiohttp:
                    try:
                        await ws_conn.close()
                        sess = getattr(ws_conn, '_mg_session', None)
                        if sess:
                            await sess.close()
                    except Exception:
                        pass
                else:
                    try:
                        await ws_conn.close()
                    except Exception:
                        pass
            except Exception:
                pass

        except KeyboardInterrupt:
            print('\nInterrupted, exiting')
            return
        except Exception as e:
            print(f"Connection error: {e}")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2.0, max_backoff)
            continue
        await asyncio.sleep(0.25)

async def receiver_loop(ws_conn, use_aiohttp: bool):
    try:
        if use_aiohttp:
            # aiohttp WS
            while True:
                msg = await ws_conn.receive()
                if msg is None:
                    print('[recv] None message -> connection closed')
                    return
                if msg.type == WSMsgType.TEXT:
                    s = msg.data
                    print('[in]', (s[:LOG_TRUNC] + ('...' if len(s) > LOG_TRUNC else '')))
                elif msg.type == WSMsgType.BINARY:
                    b = msg.data
                    print(f'[in][binary] {len(b)} bytes')
                elif msg.type == WSMsgType.CLOSE:
                    print('[in] CLOSE frame received')
                    return
                elif msg.type == WSMsgType.ERROR:
                    print('[in] ERROR frame')
                    return
                else:
                    print('[in] unknown msg type', msg.type)
        else:
            # websockets package
            async for message in ws_conn:
                if isinstance(message, bytes):
                    print(f'[in][binary] {len(message)} bytes')
                else:
                    s = str(message)
                    print('[in]', (s[:LOG_TRUNC] + ('...' if len(s) > LOG_TRUNC else '')))
    except ConnectionClosed as e:
        print(f'[receiver] connection closed: {e}')
    except asyncio.CancelledError:
        return
    except Exception as e:
        print(f'[receiver] error: {e}')

async def heartbeat_loop(ws_conn, use_aiohttp: bool):
    try:
        while True:
            await asyncio.sleep(10)
            try:
                if use_aiohttp:
                    # aiohttp: try ping if supported, else send textual noop
                    try:
                        await ws_conn.ping()
                    except Exception:
                        await ws_conn.send_str('"ping"')
                else:
                    # websockets: ping
                    try:
                        await ws_conn.ping()
                    except Exception:
                        # fallback send
                        await ws_conn.send('"ping"')
                print('[hb] sent')
            except Exception as e:
                print(f'[hb] heartbeat error: {e}')
                return
    except asyncio.CancelledError:
        return

async def fetch_ws_url_via_http(room_code: str, timeout: float = 3.0) -> Optional[str]:
    """Scrape the room page to find a full wss:// connect URL or a /version/<token> string.
    Returns either a full wss URL (preferred) or a version token string, or None.
    """
    def _scrape():
        try:
            url = f'https://magiccircle.gg/r/{room_code}'
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (compatible; maintain-ws/1.0)',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                txt = resp.read().decode('utf-8', errors='ignore')

            # 1) look for any explicit full wss URL on the page
            m = re.search(r'(wss://[^"\'<>\s]+)', txt)
            if m:
                return m.group(1)

            # 2) look for /version/<token> occurrences
            ver = None
            m2 = re.search(r'/version/([0-9A-Za-z_-]{6,})', txt)
            if m2:
                ver = m2.group(1)
                return ver

            # 3) fetch a few script bundles and search them
            script_srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', txt, re.IGNORECASE)
            abs_srcs = []
            for s in script_srcs:
                try:
                    a = urllib.parse.urljoin(url, s)
                    if a not in abs_srcs:
                        abs_srcs.append(a)
                except Exception:
                    continue
            for s in abs_srcs[:6]:
                try:
                    req2 = urllib.request.Request(s, headers={'User-Agent': 'Mozilla/5.0', 'Referer': url})
                    with urllib.request.urlopen(req2, timeout=timeout) as r2:
                        jtxt = r2.read().decode('utf-8', errors='ignore')
                    m3 = re.search(r'(wss://[^"\'<>\s]+)', jtxt)
                    if m3:
                        return m3.group(1)
                    m4 = re.search(r'/version/([0-9A-Za-z_-]{6,})', jtxt)
                    if m4:
                        return m4.group(1)
                except Exception:
                    continue

            return None
        except Exception:
            return None

    return await asyncio.to_thread(_scrape)

def generate_player_id():
    return 'p_' + ''.join(random.choices(string.ascii_letters + string.digits, k=16))


def replace_or_inject_playerid(ws_url: str, player_id: str) -> str:
    try:
        parsed = urllib.parse.urlparse(ws_url)
        q = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
        # strip surrounding quotes if present in provided player_id
        pid = str(player_id or '').strip()
        pid = pid.strip('"')
        q['playerId'] = pid
        new_q = urllib.parse.urlencode(q)
        return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_q, parsed.fragment))
    except Exception:
        # fallback: if parsing fails, try simple replace of p_ pattern
        if 'playerId=' in ws_url:
            return re.sub(r'(playerId=)[^&]+', r'\1' + urllib.parse.quote(pid), ws_url)
        sep = '&' if '?' in ws_url else '?'
        return ws_url + sep + 'playerId=' + urllib.parse.quote(pid)


async def run_many(ws_url_base: str, cookie: Optional[str], count: int = 1, stagger: float = 0.5, player_id_arg: Optional[str] = None, use_presets: bool = False, room: Optional[str] = None):
    tasks = []
    for i in range(count):
        # decide player id for this instance
        if use_presets:
            pid = PRESET_PLAYER_IDS[i % len(PRESET_PLAYER_IDS)]
        else:
            if player_id_arg:
                if '%d' in player_id_arg:
                    pid = player_id_arg % (i+1)
                elif '{i}' in player_id_arg:
                    pid = player_id_arg.replace('{i}', str(i+1))
                else:
                    pid = f"{player_id_arg}_{i+1}"
            else:
                pid = generate_player_id()

        # If room mode is active, do not pre-build instance ws URL; instead pass room and pid to maintain()
        await asyncio.sleep(stagger if i > 0 else 0)
        if room:
            t = asyncio.create_task(maintain(None, cookie, room_code=room, player_id=pid))
        else:
            instance_ws = replace_or_inject_playerid(ws_url_base, pid)
            t = asyncio.create_task(maintain(instance_ws, cookie, room_code=None, player_id=pid))
        tasks.append(t)
    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        for t in tasks:
            t.cancel()
        raise

def parse_args():
    p = argparse.ArgumentParser(description='Maintain a WebSocket connection to a MagicCircle URL')
    group = p.add_mutually_exclusive_group(required=False)
    group.add_argument('--ws-url', help='WebSocket URL to connect to')
    group.add_argument('--room', help='Room code (e.g. JC66) to auto-discover the ws connect URL')
    p.add_argument('--refresh-interval', type=float, default=30.0, help='If using --room, how often (s) to refresh discovery when reconnecting (default: 30s)')
    p.add_argument('--player-id', help='Optional playerId to inject into the generated ws URL (e.g. p_ABC123). If not provided a random id will be used when building from room')
    p.add_argument('-n', '--count', type=int, default=1, help='Number of concurrent connections to open (default: 1)')
    p.add_argument('--stagger', type=float, default=0.5, help='Seconds to stagger starting each connection')
    p.add_argument('--use-presets', action='store_true', help='Cycle through built-in preset player IDs for each connection')
    p.add_argument('--cookies', help='Cookie header string to send (e.g. "name=val; name2=val2")')
    return p.parse_args()

if __name__ == '__main__':
    args = parse_args()
    cookie = args.cookies or os.environ.get('MG_COOKIES')

    ws_url = None
    room = None
    if args.ws_url:
        ws_url = args.ws_url
    elif args.room:
        room = args.room.strip()
        # do not pre-scrape here; maintain() will fetch fresh before each connect
        # but try a quick initial scrape to build a primary URL if possible
        try:
            scraped = asyncio.run(fetch_ws_url_via_http(room))
        except Exception:
            scraped = None
        if scraped and isinstance(scraped, str) and scraped.startswith('wss://'):
            ws_url = scraped
        elif scraped:
            # keep ws_url None and let maintain() build from version token each attempt
            ws_url = None
        else:
            # still allow proceed; maintain will retry discovery
            ws_url = None
    else:
        ws_url = DEFAULT_WS

    try:
        if getattr(args, 'count', 1) and int(args.count) > 1:
            asyncio.run(run_many(ws_url, cookie, count=int(args.count), stagger=float(getattr(args, 'stagger', 0.5)), player_id_arg=args.player_id, use_presets=bool(getattr(args, 'use_presets', False)), room=room))
        else:
            # single connection: if room mode requested, hand room and optional player id
            if room:
                pid = args.player_id or None
                asyncio.run(maintain(ws_url if ws_url else None, cookie, room_code=room, player_id=pid))
            else:
                asyncio.run(maintain(ws_url, cookie))
    except KeyboardInterrupt:
        print('\nExiting')
        try: sys.exit(0)
        except SystemExit: pass
