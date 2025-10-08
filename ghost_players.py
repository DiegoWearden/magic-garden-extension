#!/usr/bin/env python3
"""
Lightweight Magic Circle ghost players - keeps players present in room without full browser.
Uses minimal WebSocket connections (~5-10 MB RAM each, <1% CPU total).
"""

import asyncio
import json
import sys
import urllib.parse
from typing import Optional
from pathlib import Path
import websockets
import time
from collections import defaultdict
import os
import random

# Install: pip install websockets


class GhostPlayer:
    """Minimal WebSocket client that keeps a player connected to Magic Circle."""
    
    def __init__(self, room_code: str, player_num: int, ws_url_override: Optional[str] = None, version_override: Optional[str] = None):
        self.room_code = room_code
        self.player_num = player_num
        self.ws_url_override = ws_url_override
        self.version_override = version_override
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.player_id: Optional[str] = None
        self.room_session_id: Optional[str] = None
        self.running = False
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._activity_task: Optional[asyncio.Task] = None
        # Track observed pet positions from incoming PartialState patches
        self.pet_positions = defaultdict(lambda: {"x": None, "y": None})
        # Server-provided heartbeat interval (seconds); default to 4s
        self.server_heartbeat_secs: float = 4.0
        # Optional cookie header (from env or file)
        self.cookie_header: Optional[str] = None
        
    async def connect(self):
        """Connect to the Magic Circle room."""
        # Format: wss://magiccircle.gg/version/{version}/api/rooms/{code}/connect?params
        # For now, use a recent version number (5142885) - this may need updating
        version = "5142885"
        
        # Generate a unique player ID for this ghost player
        import random
        import string
        player_id = f"p_{''.join(random.choices(string.ascii_letters + string.digits, k=16))}"

        # If full WS URL provided, use it and only rewrite playerId per player
        ws_url = None
        if self.ws_url_override and self.ws_url_override.startswith('wss://'):
            try:
                parsed = urllib.parse.urlparse(self.ws_url_override)
                q = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
                new_q = []
                for k, v in q:
                    if k == 'playerId':
                        # parse_qsl decodes %22 to '"', so just set quoted value;
                        # urlencode will re-encode quotes to %22 (no double-encoding)
                        v = f'"{player_id}"'
                    elif k == 'version' and self.version_override:
                        v = f'"{self.version_override}"'
                    new_q.append((k, v))
                new_query = urllib.parse.urlencode(new_q)
                ws_url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, new_query, parsed.fragment))
            except Exception:
                ws_url = self.ws_url_override

        # Otherwise construct from room code + version
        if not ws_url:
            ver = str(self.version_override or version)
            ws_url = (
                f"wss://magiccircle.gg/version/{ver}/api/rooms/{self.room_code}/connect"
                f"?surface=%22web%22"
                f"&platform=%22desktop%22"
                f"&playerId=%22{player_id}%22"
                f"&version=%22{ver}%22"
                f"&source=%22manualUrl%22"
            )
        
        print(f"[Player {self.player_num}] Connecting to {ws_url}...")
        
        try:
            # Optional cookies (from env MG_COOKIES or ./cookies.txt)
            cookie = os.environ.get('MG_COOKIES')
            if not cookie:
                try:
                    cookie = (Path(__file__).parent / 'cookies.txt').read_text(encoding='utf-8').strip()
                except Exception:
                    cookie = None
            self.cookie_header = cookie

            # Browser-like headers (randomize UA a bit)
            uas = [
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15",
            ]
            ua = random.choice(uas)
            headers = [
                ("User-Agent", ua),
                ("Referer", f"https://magiccircle.gg/r/{self.room_code}"),
                ("Pragma", "no-cache"),
                ("Cache-Control", "no-cache"),
            ]
            if self.cookie_header:
                headers.append(("Cookie", self.cookie_header))
            # Try with browser-like headers; if the installed websockets version
            # doesn't support extra_headers/origin, fall back to a simple connect.
            try:
                self.ws = await websockets.connect(
                    ws_url,
                    origin="https://magiccircle.gg",
                    extra_headers=headers,
                    ping_interval=5,
                    ping_timeout=5,
                    max_size=10 * 1024 * 1024  # 10 MB max message size
                )
            except TypeError:
                # Older websockets version; retry without extra headers
                self.ws = await websockets.connect(
                    ws_url,
                    ping_interval=5,
                    ping_timeout=5,
                    max_size=10 * 1024 * 1024
                )
            self.running = True
            print(f"[Player {self.player_num}] ✓ Connected")
            # Start application-level heartbeat (client Ping -> server Pong)
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
            # Start periodic activity messages (PetPositions) to mimic real clients
            self._activity_task = asyncio.create_task(self._activity_loop())
            return True
        except Exception as e:
            print(f"[Player {self.player_num}] ✗ Connection failed: {e}")
            return False
    
    async def handle_message(self, msg_str: str):
        """Process incoming WebSocket messages."""
        try:
            msg = json.loads(msg_str)
            msg_type = msg.get('type', 'Unknown')
            
            # Log all message types to understand what the server expects
            if msg_type not in ['PartialState']:  # Don't spam with PartialState
                print(f"[Player {self.player_num}] Received: {msg_type}")
            
            # Welcome message contains initial game state
            if msg_type == 'Welcome':
                full_state = msg.get('fullState', {})
                if full_state:
                    # Extract our player ID
                    players = full_state.get('data', {}).get('players', [])
                    if players:
                        # Find ourselves (last player to join)
                        self.player_id = players[-1].get('id')
                        player_name = players[-1].get('name', 'Unknown')
                        print(f"[Player {self.player_num}] Joined as '{player_name}' (ID: {self.player_id})")
                    
                    self.room_session_id = full_state.get('data', {}).get('roomSessionId')
                    # Seed initial pet positions from full state if available
                    try:
                        self._seed_positions_from_full_state(full_state)
                    except Exception as e:
                        print(f"[Player {self.player_num}] Seed positions error: {e}")
                
                # Don't send any response - just stay quiet and listen
                # await self.send_message({
                #     "type": "PlayerReady"
                # })
            
            # PartialState messages are game state updates
            elif msg_type == 'PartialState':
                # Update pet positions map from patches
                try:
                    patches = msg.get('patches') or []
                    self._ingest_patches(patches)
                except Exception as e:
                    print(f"[Player {self.player_num}] Patch ingest error: {e}")
            
            elif msg_type == 'Config':
                try:
                    cfg = msg.get('config') or {}
                    hb = float(cfg.get('net_heartbeatIntervalSeconds', self.server_heartbeat_secs))
                    if hb > 0:
                        self.server_heartbeat_secs = hb
                except Exception:
                    pass
            
            # Server Ping -> respond with Pong (mirror id/scopePath if present)
            elif msg_type == 'Ping':
                pong = {"type": "Pong"}
                try:
                    if isinstance(msg.get('id'), (int, float, str)):
                        pong['id'] = msg['id']
                    if isinstance(msg.get('scopePath'), list):
                        pong['scopePath'] = msg['scopePath']
                except Exception:
                    pass
                await self.send_message(pong)
            
            # Server Pong in response to our Ping
            elif msg_type == 'Pong':
                pass
            
            # Server asking us to do something
            elif msg_type == 'RequestAction':
                # Acknowledge but don't take action
                pass
            
            # Handle other message types as needed
            # For a "ghost" player, we mostly just need to stay connected
            
        except json.JSONDecodeError:
            pass  # Ignore non-JSON messages
        except Exception as e:
            print(f"[Player {self.player_num}] Error handling message: {e}")
    
    async def send_message(self, message: dict):
        """Send a message to the game server."""
        if self.ws:
            try:
                await self.ws.send(json.dumps(message))
            except Exception as e:
                print(f"[Player {self.player_num}] Error sending message: {e}")

    async def send_ping(self):
        """Send a client Ping matching real browser behavior."""
        ping_msg = {
            "scopePath": ["Room", "Quinoa"],
            "type": "Ping",
            "id": int(time.time() * 1000)
        }
        await self.send_message(ping_msg)

    async def _heartbeat_loop(self):
        """Periodic client-initiated Ping; server responds with Pong."""
        try:
            while self.running:
                await self.send_ping()
                await asyncio.sleep(1.0)
        except Exception as e:
            print(f"[Player {self.player_num}] Heartbeat error: {e}")

    def _ingest_patches(self, patches: list):
        """Update self.pet_positions from PartialState patches.
        Looks for paths like /child/data/userSlots/0/petSlotInfos/<uuid>/position/x or .../y
        """
        for p in patches:
            try:
                path = p.get('path')
                if not isinstance(path, str):
                    continue
                # Fast check
                if '/petSlotInfos/' not in path or '/position/' not in path:
                    continue
                parts = path.strip('/').split('/')
                # Find index of 'petSlotInfos' and get next segment as petId
                try:
                    i = parts.index('petSlotInfos')
                    pet_id = parts[i+1]
                except Exception:
                    continue
                # Determine whether x or y updated
                if parts[-1] not in ('x', 'y'):
                    continue
                axis = parts[-1]
                val = p.get('value')
                if isinstance(val, (int, float)):
                    self.pet_positions[pet_id][axis] = int(val)
            except Exception:
                continue

    def _seed_positions_from_full_state(self, full_state: dict):
        """Seed initial pet positions from a Welcome.fullState snapshot if available."""
        try:
            child = full_state.get('child') or {}
            data = child.get('data') or {}
            infos = data.get('userSlots', [{}])[0].get('petSlotInfos', {})
            for pet_id, info in infos.items():
                pos = info.get('position') or {}
                x = pos.get('x'); y = pos.get('y')
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    self.pet_positions[str(pet_id)] = {"x": int(x), "y": int(y)}
        except Exception:
            pass

    async def send_pet_positions(self):
        """Send a PetPositions message with last-known positions (if any)."""
        # Collect positions that have both x and y
        payload = {}
        for pet_id, pos in list(self.pet_positions.items()):
            x = pos.get('x'); y = pos.get('y')
            if isinstance(x, int) and isinstance(y, int):
                payload[pet_id] = {"x": x, "y": y}
        if not payload:
            return
        msg = {
            "scopePath": ["Room", "Quinoa"],
            "type": "PetPositions",
            "petPositions": payload
        }
        await self.send_message(msg)

    async def _activity_loop(self):
        """Periodically send minimal activity messages to prevent idle disconnects."""
        try:
            # Send PetPositions every 3 seconds if we have any
            while self.running:
                await self.send_pet_positions()
                await asyncio.sleep(3.0)
        except Exception as e:
            print(f"[Player {self.player_num}] Activity error: {e}")
    
    async def listen(self):
        """Listen for incoming messages."""
        if not self.ws:
            return
        
        try:
            async for message in self.ws:
                await self.handle_message(message)
        except websockets.exceptions.ConnectionClosed as e:
            print(f"[Player {self.player_num}] Connection closed: code={e.code}, reason={e.reason}")
            self.running = False
        except Exception as e:
            print(f"[Player {self.player_num}] Error: {e}")
            self.running = False
    
    async def run(self):
        """Main loop - connect, listen, and auto-reconnect on close."""
        backoff = 1.0
        while True:
            ok = await self.connect()
            if ok:
                backoff = 1.0
                await self.listen()
            # closed or failed -> backoff and retry
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2.0, 30.0)
    
    async def disconnect(self):
        """Gracefully disconnect."""
        if self.ws:
            try:
                if self._heartbeat_task:
                    self._heartbeat_task.cancel()
                    self._heartbeat_task = None
                if self._activity_task:
                    self._activity_task.cancel()
                    self._activity_task = None
                await self.ws.close()
                print(f"[Player {self.player_num}] Disconnected")
            except:
                pass


async def run_ghost_players(room_code: str, num_players: int = 5, stagger_delay: float = 2.0, ws_url_override: Optional[str] = None, version_override: Optional[str] = None):
    """Run multiple ghost players in parallel."""
    players = [GhostPlayer(room_code, i+1, ws_url_override=ws_url_override, version_override=version_override) for i in range(num_players)]
    
    print(f"\n🎮 Starting {num_players} ghost players for room: {room_code}\n")
    
    # Connect players with staggered delays to avoid rate limiting
    tasks = []
    for i, player in enumerate(players):
        if i > 0:
            await asyncio.sleep(stagger_delay)
        tasks.append(asyncio.create_task(player.run()))
    
    try:
        # Wait for all players
        await asyncio.gather(*tasks)
    except KeyboardInterrupt:
        print("\n\n🛑 Shutting down ghost players...")
        for player in players:
            await player.disconnect()


def extract_room_code(url: str) -> Optional[str]:
    """Extract room code from a Magic Circle URL."""
    # https://magiccircle.gg/r/JC66 -> JC66
    if '/r/' in url:
        parts = url.split('/r/')
        if len(parts) >= 2:
            code = parts[1].split('?')[0].split('#')[0]
            return code
    return None


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Run lightweight ghost players in Magic Circle')
    parser.add_argument('room', help='Room code (e.g., JC66) or URL (e.g., https://magiccircle.gg/r/JC66)')
    parser.add_argument('-n', '--num-players', type=int, default=5, help='Number of ghost players (default: 5)')
    parser.add_argument('--ws-url', help='Full wss:// URL to use (copy from DevTools WS)')
    parser.add_argument('--ws-version', help='Override version string in WS URL (e.g., 5142885)')
    
    args = parser.parse_args()
    
    # Extract room code from URL if needed
    room_code = extract_room_code(args.room) if '/' in args.room else args.room
    
    if not room_code:
        print(f"Error: Could not extract room code from '{args.room}'")
        print("Usage: python ghost_players.py JC66")
        print("   or: python ghost_players.py https://magiccircle.gg/r/JC66")
        sys.exit(1)
    
    print(f"Room code: {room_code}")
    print(f"Players: {args.num_players}")
    print("\nPress Ctrl+C to stop\n")
    
    try:
        asyncio.run(run_ghost_players(room_code, args.num_players, ws_url_override=args.ws_url, version_override=args.ws_version))
    except KeyboardInterrupt:
        print("\n\nShutdown complete.")

