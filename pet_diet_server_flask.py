#!/usr/bin/env python3
import os
import json
from flask import Flask, send_from_directory, request, jsonify

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_JSON = os.path.join(ROOT_DIR, 'mg_pet_diets.json')

app = Flask(__name__, static_folder=ROOT_DIR, static_url_path='')

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
        return jsonify(success=True, path=path, count=len(pets))
    except Exception as e:
        return jsonify(success=False, error=str(e)), 500

@app.get('/load')
def load():
    """Load the combined JSON file. Returns { pets: { ... } } (empty if missing)."""
    try:
        rel_path = request.args.get('path') or 'mg_pet_diets.json'
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

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8765'))
    app.run(host='127.0.0.1', port=port)


