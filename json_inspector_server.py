#!/usr/bin/env python3
"""
json_inspector_server.py

Standalone Flask app to inspect live JSON files in the workspace.
- GET /           -> HTML UI
- GET /list_json  -> JSON listing of .json files in the app directory
- GET /json?file= -> returns raw file content
- GET /watch?file= -> SSE stream that sends initial content and updates when file changes

Usage: pip install flask flask-cors
       python3 json_inspector_server.py

Runs on http://127.0.0.1:8000 by default.
"""

from flask import Flask, Response, request, jsonify, stream_with_context
from flask_cors import CORS
from pathlib import Path
import time
import json
import html

BASE_DIR = Path(__file__).parent
app = Flask(__name__)
CORS(app)

INDEX_HTML = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Live JSON Inspector</title>
  <style>
    body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background:#1e1e1e; color:#d4d4d4; padding:16px }
    .container { display:flex; gap:16px }
    .sidebar { width:320px; background:#252526; padding:12px; border-radius:6px }
    .content { flex:1; background:#252526; padding:12px; border-radius:6px }
    button { background:#0e639c; color:white; border:none; padding:8px 10px; border-radius:4px; cursor:pointer }
    .tree { font-family: monospace; font-size:13px; line-height:1.4; }
    .node { margin:2px 0; }
    .key { color:#9cdcfe; cursor:pointer }
    .val-string { color:#ce9178 }
    .val-number { color:#b5cea8 }
    .val-boolean { color:#569cd6 }
    .val-null { color:#808080; font-style:italic }
    .bracket { color:#d4d4d4 }
    .toggle { display:inline-block; width:16px; text-align:center; cursor:pointer; color:#d4d4d4 }
    .children { margin-left:18px; display:none }
    .controls { display:flex; gap:8px; margin-bottom:8px }
    select,input { width:100%; padding:8px; margin-bottom:8px; background:#3c3c3c; color:#d4d4d4; border:1px solid #3e3e42 }
    .status { font-size:13px; margin-top:8px }
    .small { font-size:12px; color:#9aa3ad }
  </style>
</head>
<body>
  <h2>Live JSON Inspector</h2>
  <div class="container">
    <div class="sidebar">
      <div>
        <label><strong>JSON files</strong></label>
        <select id="fileSelect" size="15"></select>
        <button id="refreshFiles">Refresh list</button>
      </div>
      <div style="margin-top:12px">
        <label><strong>Path (optional)</strong></label>
        <input id="pathInput" placeholder="e.g. data/children/0" />
        <button id="gotoPath">Go</button>
      </div>
      <div class="status" id="status">Not connected</div>
    </div>
    <div class="content">
      <div class="controls">
        <button id="openBtn">Open selected</button>
        <button id="closeBtn">Close</button>
        <button id="expandAll">Expand All</button>
        <button id="collapseAll">Collapse All</button>
        <button id="rawBtn">Show raw</button>
      </div>
      <h3 id="fileHeader">No file</h3>
      <div id="output" class="tree">Select a JSON file from the left and click Open.</div>
      <div class="small" id="info"></div>
    </div>
  </div>

<script>
const fileSelect = document.getElementById('fileSelect');
const refreshBtn = document.getElementById('refreshFiles');
const openBtn = document.getElementById('openBtn');
const closeBtn = document.getElementById('closeBtn');
const rawBtn = document.getElementById('rawBtn');
const output = document.getElementById('output');
const fileHeader = document.getElementById('fileHeader');
const statusEl = document.getElementById('status');
const pathInput = document.getElementById('pathInput');
const gotoPath = document.getElementById('gotoPath');
const expandAllBtn = document.getElementById('expandAll');
const collapseAllBtn = document.getElementById('collapseAll');
const infoEl = document.getElementById('info');

let es = null;
let currentFile = null;
let latestJson = null;
let expandedPaths = new Set(); // tracks expanded node paths for current file

function _expandedStorageKey(filename){ return 'jsonInspector:expanded:'+filename; }
function loadExpandedForFile(filename){
  expandedPaths = new Set();
  try{
    const raw = localStorage.getItem(_expandedStorageKey(filename));
    if(raw){ JSON.parse(raw).forEach(p=>expandedPaths.add(p)); }
  }catch(e){ console.warn('failed to load expanded paths', e); }
}
function saveExpandedForFile(filename){
  try{
    localStorage.setItem(_expandedStorageKey(filename), JSON.stringify([...expandedPaths]));
  }catch(e){ console.warn('failed to save expanded paths', e); }
}

async function listFiles(){
  try{
    const res = await fetch('/list_json');
    const j = await res.json();
    fileSelect.innerHTML = '';
    (j.files || []).forEach(fn=>{
      const opt = document.createElement('option'); opt.value = fn; opt.textContent = fn; fileSelect.appendChild(opt);
    });
  }catch(err){
    console.error(err); statusEl.textContent = 'Failed to list files';
  }
}

refreshBtn.addEventListener('click', listFiles);

openBtn.addEventListener('click', ()=>{
  const sel = fileSelect.value; if(!sel) return alert('Select a file');
  openFile(sel);
});

closeBtn.addEventListener('click', ()=>{
  closeStream();
});

rawBtn.addEventListener('click', async ()=>{
  if(!currentFile) return alert('Open a file first');
  try{
    const res = await fetch('/json?file='+encodeURIComponent(currentFile));
    const text = await res.text();
    output.textContent = formatJson(text);
    fileHeader.textContent = currentFile + (pathInput.value?(' @ '+pathInput.value):'');
    infoEl.textContent = 'Raw view';
  }catch(err){ console.error(err); alert('Failed to fetch raw file'); }
});

gotoPath.addEventListener('click', ()=>{
  if(!currentFile) return alert('Open a file first');
  renderForCurrentPath();
});

expandAllBtn.addEventListener('click', ()=>{ setExpandedAll(true); });
collapseAllBtn.addEventListener('click', ()=>{ setExpandedAll(false); });

function formatJson(text){
  try{ const o = JSON.parse(text); return JSON.stringify(o,null,2); }catch(e){ return text; }
}

function getValueAtPath(obj, path){
  if(!path) return obj;
  const segs = path.split('/').filter(s=>s.length);
  let cur = obj;
  for(const s of segs){
    if(cur === null || cur === undefined) return null;
    if(Array.isArray(cur)){
      const idx = parseInt(s,10);
      if(isNaN(idx)) return null;
      cur = cur[idx];
    } else if(typeof cur === 'object'){
      cur = cur[s];
    } else return null;
  }
  return cur;
}

function renderTree(rootObj){
  output.innerHTML = '';
  if(rootObj === null || rootObj === undefined){ output.textContent = 'null or undefined'; return; }
  const container = document.createElement('div');
  buildNode(container, null, rootObj, '');
  output.appendChild(container);
}

function buildNode(parent, key, value, path){
  const node = document.createElement('div'); node.className = 'node';
  const row = document.createElement('div');

  // toggle for objects/arrays
  if(typeof value === 'object' && value !== null){
    const toggle = document.createElement('span'); toggle.className = 'toggle';
    // set dataset path so we can restore state later
    toggle.dataset.path = path || '';
    // default collapsed unless in expandedPaths
    const isExpanded = expandedPaths.has(path || '');
    toggle.textContent = isExpanded ? '▼' : '▶';
    row.appendChild(toggle);

    const keySpan = document.createElement('span'); keySpan.className = 'key'; keySpan.textContent = key !== null ? (key + ' ') : '';
    row.appendChild(keySpan);

    const meta = document.createElement('span'); meta.className = 'small';
    if(Array.isArray(value)) meta.textContent = '[Array] ' + value.length + ' items';
    else meta.textContent = '{Object} ' + Object.keys(value).length + ' props';
    row.appendChild(meta);

    parent.appendChild(row);

    const children = document.createElement('div'); children.className = 'children';
    // restore expanded state
    children.style.display = isExpanded ? 'block' : 'none';
    parent.appendChild(children);

    toggle.addEventListener('click', ()=>{
      const open = children.style.display === 'block';
      if(open){ children.style.display = 'none'; toggle.textContent = '▶'; expandedPaths.delete(path || ''); }
      else { children.style.display = 'block'; toggle.textContent = '▼'; expandedPaths.add(path || ''); }
      // persist per-file
      if(currentFile) saveExpandedForFile(currentFile);
    });

    // build children
    if(Array.isArray(value)){
      value.forEach((v,i)=> buildNode(children, String(i), v, path? (path+'/'+i) : String(i)) );
    } else {
      Object.keys(value).forEach(k=> buildNode(children, k, value[k], path? (path+'/'+k) : k));
    }

  } else {
    // primitive
    const spacer = document.createElement('span'); spacer.className = 'toggle'; spacer.textContent = '';
    row.appendChild(spacer);
    if(key !== null){ const keySpan = document.createElement('span'); keySpan.className = 'key'; keySpan.textContent = key + ' : '; row.appendChild(keySpan); }
    const valSpan = document.createElement('span');
    if(typeof value === 'string'){ valSpan.className = 'val-string'; valSpan.textContent = '"'+value+'"'; }
    else if(typeof value === 'number'){ valSpan.className = 'val-number'; valSpan.textContent = String(value); }
    else if(typeof value === 'boolean'){ valSpan.className = 'val-boolean'; valSpan.textContent = String(value); }
    else if(value === null){ valSpan.className = 'val-null'; valSpan.textContent = 'null'; }
    else { valSpan.textContent = String(value); }
    row.appendChild(valSpan);
    parent.appendChild(row);
  }
}

function renderForCurrentPath(){
  if(!latestJson) return;
  const p = pathInput.value || '';
  const sub = p? getValueAtPath(latestJson, p) : latestJson;
  fileHeader.textContent = currentFile + (p?(' @ '+p):'');
  infoEl.textContent = p?('Showing path: '+p):'Showing root';
  renderTree(sub);
}

function setExpandedAll(expand){
  // collect all toggle paths from current rendered tree
  const toggles = output.querySelectorAll('.toggle');
  toggles.forEach(t=>{
    const p = t.dataset.path === undefined ? '' : t.dataset.path;
    const child = t.parentElement && t.parentElement.nextSibling;
    if(child && child.classList && child.classList.contains('children')){
      child.style.display = expand? 'block':'none';
      t.textContent = expand? '▼':'▶';
      if(expand) expandedPaths.add(p); else expandedPaths.delete(p);
    }
  });
  if(currentFile) saveExpandedForFile(currentFile);
}

function openFile(filename){
  closeStream();
  currentFile = filename;
  // load expanded state for this file
  loadExpandedForFile(filename);
  fileHeader.textContent = filename;
  statusEl.textContent = 'Connecting...';
  es = new EventSource('/watch?file='+encodeURIComponent(filename));
  es.addEventListener('init', e=>{
    try{
      const parsed = JSON.parse(e.data);
      latestJson = parsed;
      renderForCurrentPath();
    }catch(err){ output.textContent = e.data; }
    statusEl.textContent = 'Live (watching)';
  });
  es.addEventListener('change', e=>{
    try{
      const parsed = JSON.parse(e.data);
      latestJson = parsed;
      // preserve expandedPaths (already loaded/updated)
      renderForCurrentPath();
    }catch(err){ output.textContent = e.data; }
  });
  es.onerror = ev => {
    console.warn('SSE error', ev); statusEl.textContent = 'Disconnected or error';
  };
}

function closeStream(){
  if(es){ es.close(); es = null; }
  // save expanded state
  if(currentFile) saveExpandedForFile(currentFile);
  statusEl.textContent = 'Not connected';
  currentFile = null;
  fileHeader.textContent = 'No file';
  output.textContent = 'Select a JSON file from the left and click Open.';
  latestJson = null;
  expandedPaths = new Set();
}

// initial
listFiles();
</script>
</body>
</html>
"""


def _safe_path(filename: str) -> Path:
    if not filename:
        raise ValueError('empty')
    # disallow slashes and parent traversal
    if '/' in filename or '..' in filename or '\\' in filename:
        raise ValueError('invalid filename')
    if not filename.lower().endswith('.json'):
        raise ValueError('only .json allowed')
    p = (BASE_DIR / filename).resolve()
    if not str(p).startswith(str(BASE_DIR.resolve())):
        raise ValueError('invalid path')
    if not p.exists() or not p.is_file():
        raise FileNotFoundError(filename)
    return p


@app.route('/')
def index():
    return INDEX_HTML


@app.route('/list_json')
def list_json():
    try:
        files = [p.name for p in BASE_DIR.iterdir() if p.is_file() and p.suffix.lower() == '.json']
        return jsonify({'files': sorted(files)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/json')
def get_json():
    fn = request.args.get('file')
    if not fn:
        return jsonify({'error': 'file param required'}), 400
    try:
        p = _safe_path(fn)
        # return raw content (text)
        return Response(p.read_text(encoding='utf-8'), mimetype='application/json')
    except FileNotFoundError:
        return jsonify({'error': 'file not found'}), 404
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _sse_event(data: str, event: str = None) -> str:
    out = ''
    if event:
        out += f'event: {event}\n'
    for line in data.splitlines():
        out += f'data: {line}\n'
    out += '\n'
    return out


@app.route('/watch')
def watch():
    fn = request.args.get('file')
    if not fn:
        return jsonify({'error': 'file param required'}), 400
    try:
        p = _safe_path(fn)
    except FileNotFoundError:
        return jsonify({'error': 'file not found'}), 404
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    def generator(path: Path):
        last_mtime = None
        # send initial
        try:
            text = path.read_text(encoding='utf-8')
            yield _sse_event(text, event='init')
            last_mtime = path.stat().st_mtime
        except Exception as e:
            yield _sse_event(json.dumps({'error': str(e)}), event='error')
            return
        # poll
        while True:
            time.sleep(1.0)
            try:
                m = path.stat().st_mtime
            except Exception as e:
                yield _sse_event(json.dumps({'error': str(e)}), event='error')
                break
            if m != last_mtime:
                last_mtime = m
                try:
                    text = path.read_text(encoding='utf-8')
                    yield _sse_event(text, event='change')
                except Exception as e:
                    yield _sse_event(json.dumps({'error': str(e)}), event='error')

    return Response(stream_with_context(generator(p)), mimetype='text/event-stream')


if __name__ == '__main__':
    print('Serving Live JSON Inspector on http://127.0.0.1:8000')
    app.run(host='127.0.0.1', port=8000, debug=True)
