#!/usr/bin/env python3
import os
import json
import time
from flask import Flask, send_from_directory, request, jsonify
try:
    from flask_cors import CORS
except Exception:
    CORS = None

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_JSON = os.path.join(ROOT_DIR, 'mg_pet_diets.json')

app = Flask(__name__, static_folder=ROOT_DIR, static_url_path='')
if CORS:
    CORS(app)  # enable CORS for browser access from other origins

# In-memory cache of the default diets file to avoid reloading on every request
PET_DIETS_CACHE = None

def _load_default_cache():
    """Load DEFAULT_JSON into PET_DIETS_CACHE on startup. If the file does not exist,
    create an empty structure and write it to disk."""
    global PET_DIETS_CACHE
    try:
        if os.path.exists(DEFAULT_JSON):
            with open(DEFAULT_JSON, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # Normalize legacy shapes into { 'pets': { ... } }
            if isinstance(data, dict) and 'pets' in data and isinstance(data['pets'], dict):
                PET_DIETS_CACHE = data
            else:
                pets = {}
                if isinstance(data, dict):
                    for pid, arr in data.items():
                        if isinstance(arr, list):
                            pets[str(pid)] = { 'diets': [str(x) for x in arr] }
                        elif isinstance(arr, str):
                            pets[str(pid)] = { 'diets': [arr] }
                PET_DIETS_CACHE = { 'pets': pets }
        else:
            PET_DIETS_CACHE = { 'pets': {} }
            # create the default file so later manual edits see it
            try:
                os.makedirs(os.path.dirname(DEFAULT_JSON), exist_ok=True)
                with open(DEFAULT_JSON, 'w', encoding='utf-8') as f:
                    json.dump(PET_DIETS_CACHE, f, indent=2)
            except Exception:
                # If we can't write, still keep cache in memory
                pass
    except Exception as e:
        PET_DIETS_CACHE = { 'pets': {} }
        try:
            app.logger.warning('Failed to load %s: %s', DEFAULT_JSON, e)
        except Exception:
            pass

# Load cache at startup
_load_default_cache()

# Track last modified time and optionally start a background thread to watch the default file
LAST_MTIME = None
import threading

def _get_mtime(path):
    try:
        return os.path.getmtime(path)
    except Exception:
        return None

def _start_file_watcher(interval=1.0):
    global LAST_MTIME
    try:
        LAST_MTIME = _get_mtime(DEFAULT_JSON)
    except Exception:
        LAST_MTIME = None

    def _watch_loop():
        global LAST_MTIME, PET_DIETS_CACHE
        while True:
            try:
                m = _get_mtime(DEFAULT_JSON)
                if m is not None and LAST_MTIME is None:
                    # file appeared
                    LAST_MTIME = m
                    _load_default_cache()
                    try:
                        app.logger.info('pet_diet_server: mg_pet_diets.json appeared and was loaded (watcher)')
                    except Exception:
                        pass
                elif m is not None and LAST_MTIME is not None and m != LAST_MTIME:
                    LAST_MTIME = m
                    _load_default_cache()
                    try:
                        app.logger.info('pet_diet_server: mg_pet_diets.json changed and cache reloaded (watcher)')
                    except Exception:
                        pass
            except Exception:
                pass
            time.sleep(interval)

    t = threading.Thread(target=_watch_loop, daemon=True)
    t.start()

# Start watcher (best-effort, non-blocking)
try:
    _start_file_watcher()
except Exception:
    pass

@app.get('/')
def index():
    return send_from_directory(ROOT_DIR, 'pet_diet_manager.html')

@app.post('/save')
def save():
    """Save a single JSON file that contains everything.
    Expected body:
    { "path": "mg_pet_diets.json", "pets": { "<petId>": { "diets": [..], "maxHunger": <int> } } }
    Backward-compat: accepts { path, diets, maxHunger } or { path, data } where data maps petId -> [crops].
    """
    try:
        payload = request.get_json(force=True, silent=True) or {}
        rel_path = payload.get('path') or 'mg_pet_diets.json'
        pets_in = payload.get('pets')
        diets_only = payload.get('diets') or payload.get('data')
        max_hunger = payload.get('maxHunger')

        # Normalize incoming into pets map
        pets = {}
        if isinstance(pets_in, dict):
            for pid, cfg in pets_in.items():
                if not isinstance(cfg, dict):
                    continue
                out = {}
                if isinstance(cfg.get('diets'), list):
                    out['diets'] = [str(x) for x in cfg['diets']]
                if 'maxHunger' in cfg:
                    try:
                        out['maxHunger'] = int(cfg['maxHunger'])
                    except Exception:
                        pass
                pets[str(pid)] = out
        else:
            # Legacy shapes
            if isinstance(diets_only, dict):
                for pid, arr in diets_only.items():
                    if isinstance(arr, list):
                        pets[str(pid)] = { 'diets': [str(x) for x in arr] }
                    elif isinstance(arr, str):
                        pets[str(pid)] = { 'diets': [arr] }
            if isinstance(max_hunger, dict):
                for pid, val in max_hunger.items():
                    try:
                        mh = int(val)
                        if str(pid) not in pets:
                            pets[str(pid)] = {}
                        pets[str(pid)]['maxHunger'] = mh
                    except Exception:
                        continue

        path = rel_path if os.path.isabs(rel_path) else os.path.join(ROOT_DIR, rel_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w') as f:
            json.dump({ 'pets': pets }, f, indent=2)
        
        # Update cache if writing the default file
        if rel_path == 'mg_pet_diets.json':
            global PET_DIETS_CACHE
            PET_DIETS_CACHE = { 'pets': pets }

        return jsonify(success=True, path=path, count=len(pets))
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500

@app.get('/load')
def load():
    """Load the combined JSON file. Returns { pets: { ... } } (empty if missing)."""
    try:
        rel_path = request.args.get('path') or 'mg_pet_diets.json'
        if rel_path == 'mg_pet_diets.json' and PET_DIETS_CACHE is not None:
            return jsonify(PET_DIETS_CACHE)
        path = rel_path if os.path.isabs(rel_path) else os.path.join(ROOT_DIR, rel_path)
        if not os.path.exists(path):
            return jsonify({ 'pets': {} })
        with open(path, 'r') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return jsonify({ 'pets': {} })
        # Accept legacy raw map (petId -> [crops])
        if 'pets' not in data:
            pets = {}
            for pid, arr in (data.items() if isinstance(data, dict) else []):
                if isinstance(arr, list):
                    pets[str(pid)] = { 'diets': [str(x) for x in arr] }
                elif isinstance(arr, str):
                    pets[str(pid)] = { 'diets': [arr] }
            return jsonify({ 'pets': pets })
        if not isinstance(data.get('pets'), dict):
            return jsonify({ 'pets': {} })
        return jsonify({ 'pets': data['pets'] })
    except Exception as e:
        return jsonify({ 'pets': {}, 'error': str(e) }), 500

# Add a reload endpoint to force re-read from disk
@app.post('/reload')
def reload_default():
    try:
        _load_default_cache()
        return jsonify(success=True, loaded=True, pets_count=len(PET_DIETS_CACHE.get('pets', {})))
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500

if __name__ == '__main__':
    import socket
    host = '127.0.0.1'
    default_port = int(os.environ.get('PORT', '8765'))
    chosen_port = None

    # Try to find a free port in the range [default_port, default_port+49]
    for p in range(default_port, default_port + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind((host, p))
                s.listen(1)
                chosen_port = p
                break
            except OSError:
                continue

    if chosen_port is None:
        print(f'No free port available in range {default_port}-{default_port+49}. Cannot start server.')
    else:
        print(f'Serving pet_diet_server_flask on http://{host}:{chosen_port}')
        app.run(host=host, port=chosen_port)


