#!/usr/bin/env python3
"""
Quick script to discover the actual WebSocket URL used by Magic Circle.
Reads from ws_log.jsonl or inspects browser dev tools output.
"""

import json
import sys

# Check if there's a ws_log.jsonl file with captured WebSocket frames
try:
    with open('ws_log.jsonl', 'r') as f:
        lines = f.readlines()
        if lines:
            print(f"Found {len(lines)} WebSocket frames in ws_log.jsonl")
            print("\nInspecting frames for connection info...")
            for i, line in enumerate(lines[:10]):
                try:
                    frame = json.loads(line)
                    print(f"\nFrame {i+1}: {json.dumps(frame, indent=2)[:500]}")
                except:
                    pass
        else:
            print("ws_log.jsonl is empty")
except FileNotFoundError:
    print("No ws_log.jsonl found")

print("\n" + "="*60)
print("To find the WebSocket URL manually:")
print("="*60)
print("""
1. Open Magic Circle in your browser
2. Open Developer Tools (F12)
3. Go to the Network tab
4. Filter by 'WS' (WebSocket)
5. Join a room (e.g., https://magiccircle.gg/r/JC66)
6. Look for the WebSocket connection
7. The URL will be something like:
   - wss://magiccircle.gg/...
   - wss://ws.magiccircle.gg/...
   - wss://game-server.magiccircle.gg/...

Copy the full WebSocket URL here:
""")

