from flask import Flask, send_from_directory, request, jsonify, abort
from flask_cors import CORS
from pathlib import Path
import json
import time
import sys

BASE_DIR = Path(__file__).parent
app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path='')
CORS(app)  # Enable CORS for all routes

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
    """WebSocket logging disabled - just return success without writing to file."""
    return jsonify({'ok': True}), 200

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
            # Normalize: ensure every value is a list
            normalized = {}
            for k, v in data.items():
                if isinstance(v, list):
                    normalized[k] = v
                elif isinstance(v, str):
                    normalized[k] = [v]
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
        val = data.get(pet_id)
        if isinstance(val, list):
            return jsonify(val), 200
        if isinstance(val, str):
            return jsonify([val]), 200
        return jsonify([]), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, host='127.0.0.1', port=5000)
