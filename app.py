from flask import Flask, send_from_directory, request, jsonify, abort
from flask_cors import CORS
from pathlib import Path
from contextlib import contextmanager
import os
import fcntl
import json
import time
import sys

BASE_DIR = Path(__file__).parent
app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')
CORS(app)  # Enable CORS for all routes

WELCOME_RECEIVED = False  # runtime gate: enable patching only after Welcome

STATE_LOCK_PATH = (BASE_DIR / 'full_game_state.json.lock')

@contextmanager
def _state_lock():
    """Advisory exclusive lock around state read/modify/write."""
    os.makedirs(str(BASE_DIR), exist_ok=True)
    lock_file = open(STATE_LOCK_PATH, 'a+')
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()

def _atomic_write_json(target_path: Path, obj):
    tmp_path = Path(str(target_path) + '.tmp')
    with tmp_path.open('w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(str(tmp_path), str(target_path))

def _json_pointer_tokens(pointer: str):
    """Split a JSON Pointer into decoded tokens per RFC 6901.
    Supports '~1' => '/', '~0' => '~'.
    """
    if pointer is None:
        return []
    if pointer == "":
        return []
    if not pointer.startswith('/'):
        # Not a pointer; treat whole as single token
        return [pointer]
    parts = pointer.split('/')[1:]
    return [p.replace('~1', '/').replace('~0', '~') for p in parts]

def _is_int_token(token: str) -> bool:
    try:
        int(token)
        return True
    except Exception:
        return False

def _get_parent_and_key(document, pointer: str, create_missing: bool):
    """Traverse document following pointer and return (parent_container, final_key_token).
    If create_missing is True, intermediate containers are created as dicts or lists
    based on whether the next token looks like an array index ('-' or integer).
    Raises KeyError if path cannot be traversed.
    """
    tokens = _json_pointer_tokens(pointer)
    if not tokens:
        raise KeyError('Empty pointer')

    current = document
    # Traverse all but last
    for i in range(len(tokens) - 1):
        token = tokens[i]
        next_token = tokens[i + 1] if i + 1 < len(tokens) else None

        if isinstance(current, dict):
            missing = token not in current or current[token] is None
            if missing:
                if not create_missing:
                    raise KeyError(f"Missing key: {token}")
                # Decide container type for next level
                if next_token is not None and (next_token == '-' or _is_int_token(next_token)):
                    current[token] = []
                else:
                    current[token] = {}
            current = current[token]
        elif isinstance(current, list):
            if token == '-':
                # '-' not permitted in intermediate tokens
                raise KeyError("'-' not allowed except as final token in add op")
            if not _is_int_token(token):
                raise KeyError(f"Expected array index, got: {token}")
            idx = int(token)
            if idx < 0:
                raise KeyError(f"Negative index not allowed: {idx}")
            # Ensure capacity if creating
            if idx >= len(current):
                if not create_missing:
                    raise KeyError(f"Index out of range: {idx}")
                while len(current) <= idx:
                    current.append(None)
            if current[idx] is None:
                if not create_missing:
                    raise KeyError(f"Missing element at index: {idx}")
                if next_token is not None and (next_token == '-' or _is_int_token(next_token)):
                    current[idx] = []
                else:
                    current[idx] = {}
            current = current[idx]
        else:
            # Non-container encountered mid-traversal
            if not create_missing:
                raise KeyError('Cannot traverse non-container value')
            # If we must create, replace with a dict by default
            replacement = [] if (next_token is not None and (next_token == '-' or _is_int_token(next_token))) else {}
            # We cannot assign into primitive without knowing its parent; this should not occur if root is dict
            raise KeyError('Invalid traversal state')

    return current, tokens[-1]

def _apply_single_patch(document, patch: dict):
    """Apply a single RFC6902-like patch to the document in-place.
    Supports ops: add, replace, remove. Returns (applied: bool, reason: str|None).
    """
    try:
        op = str(patch.get('op', '')).lower()
        path = patch.get('path')
        if not op or not isinstance(path, str):
            return False, 'missing op/path'

        # Root ops not supported for now
        tokens = _json_pointer_tokens(path)
        if not tokens:
            return False, 'root path not supported'

        # Only 'add' can create missing containers; 'replace' is strict
        create = (op == 'add')
        parent, key_token = _get_parent_and_key(document, path, create_missing=create)

        if op == 'remove':
            if isinstance(parent, dict):
                if key_token in parent:
                    del parent[key_token]
                    return True, None
                return False, 'key not found'
            if isinstance(parent, list):
                if key_token == '-':
                    # Not standard, but treat as remove last if exists
                    if parent:
                        parent.pop()
                        return True, None
                    return False, 'array empty'
                if not _is_int_token(key_token):
                    return False, 'invalid index token'
                idx = int(key_token)
                if 0 <= idx < len(parent):
                    parent.pop(idx)
                    return True, None
                return False, 'index out of range'
            return False, 'cannot remove from non-container'

        value = patch.get('value')

        if op == 'add':
            if isinstance(parent, dict):
                parent[key_token] = value
                return True, None
            if isinstance(parent, list):
                if key_token == '-':
                    parent.append(value)
                    return True, None
                if not _is_int_token(key_token):
                    return False, 'invalid index token'
                idx = int(key_token)
                if idx < 0:
                    return False, 'index out of range'
                if idx <= len(parent):
                    parent.insert(idx, value)
                    return True, None
                # Extend with nulls up to idx then append
                while len(parent) < idx:
                    parent.append(None)
                parent.append(value)
                return True, None
            return False, 'cannot add into non-container'

        if op == 'replace':
            if isinstance(parent, dict):
                if key_token in parent:
                    parent[key_token] = value
                    return True, None
                return False, 'key not found for replace'
            if isinstance(parent, list):
                if not _is_int_token(key_token):
                    return False, 'invalid index token'
                idx = int(key_token)
                if 0 <= idx < len(parent):
                    parent[idx] = value
                    return True, None
                return False, 'index out of range'
            return False, 'cannot replace in non-container'

        return False, f'unsupported op: {op}'
    except Exception as e:
        return False, str(e)

def _collect_patches_from_body(body) -> list:
    """Extract a flat list of patches from posted body.
    Accepts: a single frame object, an array of frames, or an object with 'frames' array.
    Each frame may be either the raw ws log entry {dir, msg, ...} or just {type, patches}.
    """
    frames = []
    patches = []

    if isinstance(body, dict):
        if isinstance(body.get('frames'), list):
            frames = body['frames']
        elif 'type' in body and isinstance(body.get('patches'), list):
            frames = [body]
        elif 'msg' in body:
            frames = [body]
        elif isinstance(body.get('patches'), list):
            frames = [body]
    elif isinstance(body, list):
        frames = body

    for fr in frames:
        msg = fr.get('msg') if isinstance(fr, dict) else None
        if isinstance(msg, dict) and msg.get('type') == 'PartialState' and isinstance(msg.get('patches'), list):
            patches.extend(msg['patches'])
            continue
        # Fallback: direct object with patches
        if isinstance(fr, dict) and fr.get('type') == 'PartialState' and isinstance(fr.get('patches'), list):
            patches.extend(fr['patches'])

    return patches

@app.route('/')
def index():
    # Serve the editor HTML as the app entrypoint
    return send_from_directory(BASE_DIR, 'grid_editor.html')

@app.route('/<path:filename>')
def static_files(filename):
    # Serve files from the extension folder (grid_editor, scripts, json files, etc.)
    file_path = BASE_DIR / filename
    if file_path.exists() and file_path.is_file():
        return send_from_directory(BASE_DIR, filename)
    abort(404)

@app.route('/api/walls', methods=['GET', 'POST'])
def api_walls():
    # Simple JSON API to read and overwrite mg_walls.json
    file_path = BASE_DIR / 'mg_walls.json'
    if request.method == 'GET':
        if not file_path.exists():
            return jsonify([]), 200
        try:
            data = json.loads(file_path.read_text(encoding='utf-8'))
            return jsonify(data)
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    # POST -> overwrite the mg_walls.json file with provided JSON body
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    data = request.get_json()
    try:
        file_path.write_text(json.dumps(data, indent=2), encoding='utf-8')
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/crops', methods=['GET', 'POST'])
def api_crops():
    """Simple JSON API to read and overwrite mg_crops.json
    Format: [{"x": <int>, "y": <int>, "crop": <str>}, ...]
    """
    file_path = BASE_DIR / 'mg_crops.json'
    if request.method == 'GET':
        if not file_path.exists():
            return jsonify([]), 200
        try:
            data = json.loads(file_path.read_text(encoding='utf-8'))
            return jsonify(data)
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    data = request.get_json()
    try:
        file_path.write_text(json.dumps(data, indent=2), encoding='utf-8')
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/eggs', methods=['GET', 'POST'])
def api_eggs():
    """Simple JSON API to read and overwrite mg_eggs.json
    Format: [{"x": <int>, "y": <int>, "egg": <str>}, ...]
    """
    file_path = BASE_DIR / 'mg_eggs.json'
    if request.method == 'GET':
        if not file_path.exists():
            return jsonify([]), 200
        try:
            data = json.loads(file_path.read_text(encoding='utf-8'))
            return jsonify(data)
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    data = request.get_json()
    try:
        file_path.write_text(json.dumps(data, indent=2), encoding='utf-8')
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/inventory', methods=['GET', 'POST'])
def api_inventory():
    """Simple JSON API to read and overwrite mg_inventory.json
    Stored format: an array of item objects (same as game inventory.items)
    - GET returns [] if file is missing
    - POST accepts either {"items": [...]} or a raw array [...]
    """
    file_path = BASE_DIR / 'mg_inventory.json'
    if request.method == 'GET':
        if not file_path.exists():
            return jsonify([]), 200
        try:
            data = json.loads(file_path.read_text(encoding='utf-8'))
            # Normalize to array
            if isinstance(data, dict) and 'items' in data:
                data = data.get('items') or []
            if not isinstance(data, list):
                data = []
            return jsonify(data)
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    # POST
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    payload = request.get_json()
    try:
        items = []
        if isinstance(payload, dict) and 'items' in payload:
            items = payload.get('items') or []
        elif isinstance(payload, list):
            items = payload
        file_path.write_text(json.dumps(items, indent=2), encoding='utf-8')
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/inventory/add', methods=['POST'])
def api_inventory_add():
    """Add/set an inventory item at a specific index.
    Body: {"index": <int>, "value": <object>}
    If index == len(items) -> append. If index < len(items) -> set at index.
    If index > len(items) -> extend with nulls up to index, then set.
    """
    file_path = BASE_DIR / 'mg_inventory.json'
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    body = request.get_json() or {}
    if 'index' not in body or 'value' not in body:
        return jsonify({'error': 'Expected {index, value}'}), 400
    try:
        idx = int(body['index'])
        if idx < 0:
            return jsonify({'error': 'index must be >= 0'}), 400
    except Exception:
        return jsonify({'error': 'index must be int'}), 400
    value = body['value']
    try:
        if file_path.exists():
            try:
                items = json.loads(file_path.read_text(encoding='utf-8'))
                if isinstance(items, dict) and 'items' in items:
                    items = items.get('items') or []
                if not isinstance(items, list):
                    items = []
            except Exception:
                items = []
        else:
            items = []
        # ensure capacity
        if idx == len(items):
            items.append(value)
        elif idx < len(items):
            items[idx] = value
        else:
            # extend with nulls then set
            while len(items) < idx:
                items.append(None)
            items.append(value)
        file_path.write_text(json.dumps(items, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'count': len(items)}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/inventory/replace', methods=['POST'])
def api_inventory_replace():
    """Replace (overwrite) an inventory item at a specific index.
    Body: {"index": <int>, "value": <object>}
    If index beyond length, extend with nulls and set.
    """
    file_path = BASE_DIR / 'mg_inventory.json'
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    body = request.get_json() or {}
    if 'index' not in body or 'value' not in body:
        return jsonify({'error': 'Expected {index, value}'}), 400
    try:
        idx = int(body['index'])
        if idx < 0:
            return jsonify({'error': 'index must be >= 0'}), 400
    except Exception:
        return jsonify({'error': 'index must be int'}), 400
    value = body['value']
    try:
        if file_path.exists():
            try:
                items = json.loads(file_path.read_text(encoding='utf-8'))
                if isinstance(items, dict) and 'items' in items:
                    items = items.get('items') or []
                if not isinstance(items, list):
                    items = []
            except Exception:
                items = []
        else:
            items = []
        # ensure capacity and replace
        if idx < len(items):
            items[idx] = value
        elif idx == len(items):
            items.append(value)
        else:
            while len(items) < idx:
                items.append(None)
            items.append(value)
        file_path.write_text(json.dumps(items, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'count': len(items)}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/inventory/remove', methods=['POST'])
def api_inventory_remove():
    """Remove an inventory item at a specific index.
    Body: {"index": <int>}
    If index out of range, no-op.
    """
    file_path = BASE_DIR / 'mg_inventory.json'
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    body = request.get_json() or {}
    if 'index' not in body:
        return jsonify({'error': 'Expected {index}'}), 400
    try:
        idx = int(body['index'])
        if idx < 0:
            return jsonify({'error': 'index must be >= 0'}), 400
    except Exception:
        return jsonify({'error': 'index must be int'}), 400
    try:
        if file_path.exists():
            try:
                items = json.loads(file_path.read_text(encoding='utf-8'))
                if isinstance(items, dict) and 'items' in items:
                    items = items.get('items') or []
                if not isinstance(items, list):
                    items = []
            except Exception:
                items = []
        else:
            items = []
        if 0 <= idx < len(items):
            items.pop(idx)
        file_path.write_text(json.dumps(items, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'count': len(items)}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/inventory/remove_id', methods=['POST'])
def api_inventory_remove_id():
    """Remove the first inventory item with matching id.
    Body: {"id": "<uuid>"}
    If not found, no-op.
    """
    file_path = BASE_DIR / 'mg_inventory.json'
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    body = request.get_json() or {}
    item_id = body.get('id')
    if not item_id:
        return jsonify({'error': 'Expected {id}'}), 400
    try:
        if file_path.exists():
            try:
                items = json.loads(file_path.read_text(encoding='utf-8'))
                if isinstance(items, dict) and 'items' in items:
                    items = items.get('items') or []
                if not isinstance(items, list):
                    items = []
            except Exception:
                items = []
        else:
            items = []
        removed = False
        for i, it in enumerate(list(items)):
            try:
                if isinstance(it, dict) and it.get('id') == item_id:
                    items.pop(i)
                    removed = True
                    break
            except Exception:
                continue
        file_path.write_text(json.dumps(items, indent=2), encoding='utf-8')
        return jsonify({'ok': True, 'removed': removed, 'count': len(items)}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/wslog', methods=['POST'])
def api_wslog():
    """Accept websocket frames, log them, and if a Welcome frame is present,
    write its fullState to full_game_state.json.
    Body may be:
      - a single ws frame {dir, msg, ts}
      - an array of such frames
      - {frames: [...]} wrapper
      - or directly {type: 'Welcome', fullState: {...}}.
    All frames are logged.
    """
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400

    body = request.get_json()

    # Extract frames for logging
    frames_to_log = []
    if isinstance(body, dict):
        if isinstance(body.get('frames'), list):
            frames_to_log = body['frames']
        elif 'type' in body:
            # Direct message object - wrap it for logging
            frames_to_log = [{'dir': 'in', 'msg': body, 'ts': time.time()}]
        elif 'msg' in body:
            frames_to_log = [body]
    elif isinstance(body, list):
        frames_to_log = body

    # Log frames to ws_log.jsonl
    log_path = BASE_DIR / 'ws_log.jsonl'
    try:
        with log_path.open('a', encoding='utf-8') as f:
            for frame in frames_to_log:
                if isinstance(frame, dict):
                    # Ensure frame has timestamp
                    if 'ts' not in frame:
                        frame['ts'] = time.time()
                    # f.write(json.dumps(frame, ensure_ascii=False) + "\n")
    except Exception as e:
        return jsonify({'error': f'Failed to log frames: {str(e)}'}), 500

    # Detect Welcome frames and persist their fullState to full_game_state.json
    def _get_msg(frame):
        if isinstance(frame, dict):
            if isinstance(frame.get('msg'), dict):
                return frame['msg']
            if 'type' in frame:
                return frame
        return None

    scan_frames = frames_to_log if frames_to_log else ([body] if isinstance(body, dict) else [])
    welcome_full_state = None
    if isinstance(scan_frames, list):
        for fr in scan_frames:
            msg = _get_msg(fr)
            if isinstance(msg, dict) and msg.get('type') == 'Welcome' and isinstance(msg.get('fullState'), dict):
                welcome_full_state = msg['fullState']

    welcome_saved = False
    welcome_error = None
    if isinstance(welcome_full_state, dict):
        try:
            with _state_lock():
                _atomic_write_json(BASE_DIR / 'full_game_state.json', welcome_full_state)
            welcome_saved = True
            global WELCOME_RECEIVED
            WELCOME_RECEIVED = True
        except Exception as e:
            welcome_error = str(e)

    # Collect PartialState patches from frames
    patches = _collect_patches_from_body(body)

    # If no patches, just report result
    if not patches:
        out = {'ok': True, 'logged': len(frames_to_log), 'applied': 0, 'skipped': 0}
        if welcome_saved:
            out['welcomeSaved'] = True
        if welcome_error:
            out['welcomeError'] = welcome_error
        return jsonify(out), 200

    # Gate: require Welcome first
    if not WELCOME_RECEIVED:
        out = {
            'ok': True,
            'logged': len(frames_to_log),
            'applied': 0,
            'skipped': len(patches),
            'requiresWelcome': True
        }
        if welcome_saved:
            out['welcomeSaved'] = True
        if welcome_error:
            out['welcomeError'] = welcome_error
        return jsonify(out), 200

    # Load current state, apply patches, and persist
    state_path = BASE_DIR / 'full_game_state.json'
    with _state_lock():
        if state_path.exists():
            try:
                state = json.loads(state_path.read_text(encoding='utf-8'))
            except Exception as e:
                out = {'error': 'state_unreadable', 'detail': str(e), 'logged': len(frames_to_log), 'applied': 0, 'skipped': len(patches)}
                if welcome_saved:
                    out['welcomeSaved'] = True
                if welcome_error:
                    out['welcomeError'] = welcome_error
                return jsonify(out), 503
        else:
            out = {'error': 'state_missing', 'logged': len(frames_to_log), 'applied': 0, 'skipped': len(patches), 'requiresWelcome': True}
            if welcome_saved:
                out['welcomeSaved'] = True
            if welcome_error:
                out['welcomeError'] = welcome_error
            return jsonify(out), 503

    applied = 0
    skipped = 0
    reasons = []

    for p in patches:
        ok, reason = _apply_single_patch(state, p if isinstance(p, dict) else {})
        if ok:
            applied += 1
        else:
            skipped += 1
            if reason:
                reasons.append(reason)

    try:
        with _state_lock():
            _atomic_write_json(state_path, state)
    except Exception as e:
        out = {'error': str(e), 'logged': len(frames_to_log), 'applied': applied, 'skipped': skipped}
        if welcome_saved:
            out['welcomeSaved'] = True
        if welcome_error:
            out['welcomeError'] = welcome_error
        return jsonify(out), 500

    out = {'ok': True, 'logged': len(frames_to_log), 'applied': applied, 'skipped': skipped}
    if welcome_saved:
        out['welcomeSaved'] = True
    if welcome_error:
        out['welcomeError'] = welcome_error
    if reasons:
        out['reasons'] = reasons[-5:]
    return jsonify(out), 200

@app.route('/api/log', methods=['POST'])
def api_log():
    """Append a JSON log line to server_output.txt for debugging.
    Body: any JSON. We'll add ts.
    """
    file_path = BASE_DIR / 'server_output.txt'
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    entry = request.get_json() or {}
    entry['ts'] = time.time()
    try:
        with file_path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/pet_diets', methods=['GET', 'POST'])
def api_pet_diets():
    """Read/overwrite mg_pet_diets.json
    Format: {"<petId>": ["CropA", "CropB", ...], ...}
    GET -> returns {} if missing
    POST -> expects full mapping as JSON object; overwrites file
    """
    file_path = BASE_DIR / 'mg_pet_diets.json'
    if request.method == 'GET':
        if not file_path.exists():
            return jsonify({}), 200
        try:
            data = json.loads(file_path.read_text(encoding='utf-8'))
            if not isinstance(data, dict):
                data = {}
            # Accept both legacy flat-map and new { pets: { id: { diets: [...] } } }
            pet_map = data.get('pets') if isinstance(data.get('pets'), dict) else data
            # Normalize: ensure every value is a list
            normalized = {}
            for k, v in pet_map.items():
                diets_val = v.get('diets') if isinstance(v, dict) else v
                if isinstance(diets_val, list):
                    normalized[k] = diets_val
                elif isinstance(diets_val, str):
                    normalized[k] = [diets_val]
                else:
                    normalized[k] = []
            return jsonify(normalized), 200
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    # POST -> overwrite entire mapping
    if not request.is_json:
        return jsonify({'error': 'Expected application/json'}), 400
    body = request.get_json()
    if not isinstance(body, dict):
        return jsonify({'error': 'Expected JSON object mapping petId -> diets'}), 400
    try:
        # Normalize values to list
        out = {}
        for k, v in body.items():
            if isinstance(v, list):
                out[k] = v
            elif isinstance(v, str):
                out[k] = [v]
            else:
                out[k] = []
        file_path.write_text(json.dumps(out, indent=2), encoding='utf-8')
        return jsonify({'ok': True}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/pet_diet/<pet_id>', methods=['GET'])
def api_pet_diet_single(pet_id: str):
    """Return the diet array for a specific pet id. Returns [] if none.
    """
    file_path = BASE_DIR / 'mg_pet_diets.json'
    if not file_path.exists():
        return jsonify([]), 200
    try:
        data = json.loads(file_path.read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            return jsonify([]), 200
        # Accept both shapes
        pet_map = data.get('pets') if isinstance(data.get('pets'), dict) else data
        val = pet_map.get(pet_id)
        # If nested object with diets
        if isinstance(val, dict):
            diets_val = val.get('diets')
            if isinstance(diets_val, list):
                return jsonify(diets_val), 200
            if isinstance(diets_val, str):
                return jsonify([diets_val]), 200
            return jsonify([]), 200
        # If direct list or string
        if isinstance(val, list):
            return jsonify(val), 200
        if isinstance(val, str):
            return jsonify([val]), 200
        return jsonify([]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5001)
