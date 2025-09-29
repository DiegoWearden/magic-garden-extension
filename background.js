// Background script for Character Movement API Chrome Extension

// Handle extension installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Character Movement API extension installed');
    
    // Set default settings
    chrome.storage.sync.set({
      speed: 10,
      enabled: true
    });
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSettings') {
    chrome.storage.sync.get(['speed', 'enabled'], (result) => {
      sendResponse({
        speed: result.speed || 10,
        enabled: result.enabled !== false
      });
    });
    return true; // Keep message channel open for async response
  }
  
  if (request.action === 'updateSettings') {
    chrome.storage.sync.set({
      speed: request.speed,
      enabled: request.enabled
    }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Handle requests from content script to inject page script into main world (avoids CSP inline script issues)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'injectPageScript') {
    // sender.tab is expected when the content script sends the message
    const tabId = sender && sender.tab && sender.tab.id;
    const frameId = (typeof sender.frameId !== 'undefined') ? sender.frameId : null;
    if (!tabId) {
      sendResponse({ success: false, error: 'no-tab' });
      return true;
    }

    // The function below will be serialized and executed in the page's main world
    const pageScript = function() {
      if (window.__mg_page_injected) return;
      window.__mg_page_injected = true;

      function getKeyCode(code) {
        const map = { 'KeyW': 87, 'KeyA': 65, 'KeyS': 83, 'KeyD': 68 };
        return map[code] || 0;
      }

      function dispatchKey(code, type) {
        type = type || 'keydown';
        try {
          const key = (code || '').replace('Key', '').toLowerCase();
          const keyCode = getKeyCode(code);
          const ev = new KeyboardEvent(type, {
            key: key,
            code: code,
            keyCode: keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
            composed: true
          });

          document.dispatchEvent(ev);
          window.dispatchEvent(ev);
          const active = document.activeElement || document.body;
          if (active) try { active.dispatchEvent(ev); } catch (e) {}

          const canvases = document.querySelectorAll('canvas, [role="application"], .game, #game');
          canvases.forEach(function(c) { try { c.dispatchEvent(ev); } catch (e) {} });
        } catch (e) {
          // ignore
        }
      }

      // Maintain separate last-known positions for player vs other entities (pets etc.)
      let __mg_last_player_pos = null;
      let __mg_last_other_pos = null;
      // store detected playerId from the WebSocket URL if available
      let __mg_player_id = null;

      function isNumericLike(v) {
        return (typeof v === 'number' && !isNaN(v)) || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));
      }

      function isXY(o) {
        return o && (isNumericLike(o.x) && isNumericLike(o.y));
      }

      // tryExtractPos now returns { x, y, src, kind } where kind is 'player'|'pet'|'unknown'
      function tryExtractPos(obj, path = '', depth = 4) {
        if (depth <= 0 || obj == null) return null;

        // helper: check whether an object contains an id that matches our detected player id
        function hasPlayerIdMatch(o) {
          if (!o || !__mg_player_id) return false;
          try {
            const candidates = [];
            // common fields
            ['playerId','player','id','ownerId','owner','userId'].forEach(k => { try { if (k in o) candidates.push(o[k]); } catch(e){} });
            // scopePath arrays
            if (Array.isArray(o.scopePath)) candidates.push(o.scopePath.join('|'));
            // inspect nested value objects
            if (o.value && typeof o.value === 'object') {
              ['playerId','player','id','ownerId','owner','userId'].forEach(k => { try { if (k in o.value) candidates.push(o.value[k]); } catch(e){} });
              if (Array.isArray(o.value.scopePath)) candidates.push(o.value.scopePath.join('|'));
            }
            return candidates.some(c => c && String(c).indexOf(String(__mg_player_id)) !== -1);
          } catch (e) { return false; }
        }

        // arrays: support [x,y] tuples and scan elements
        if (Array.isArray(obj)) {
          if (obj.length >= 2 && isNumericLike(obj[0]) && isNumericLike(obj[1])) {
            return { x: Number(obj[0]), y: Number(obj[1]), src: path + '[tuple]', kind: 'unknown' };
          }
          for (let i = 0; i < obj.length; i++) {
            const res = tryExtractPos(obj[i], path + '[' + i + ']', depth - 1);
            if (res) return res;
          }
          return null;
        }

        if (typeof obj !== 'object') return null;

        // Special-case: handle server 'patches' arrays (many games send multiple entity updates)
        // Example path observed: patches[0].value.position
        try {
          if (obj.patches && Array.isArray(obj.patches)) {
            for (let i = 0; i < obj.patches.length; i++) {
              try {
                const p = obj.patches[i];
                if (p && p.value) {
                  // if this patch contains a position, prefer it when it matches our playerId
                  if (p.value.position && isXY(p.value.position)) {
                    const kind = hasPlayerIdMatch(p) ? 'player' : 'unknown';
                    if (kind === 'player') return { x: Number(p.value.position.x), y: Number(p.value.position.y), src: path + '.patches[' + i + '].value.position', kind: kind };
                    // otherwise keep scanning — but if no player match exists, record the first seen position as fallback
                    const fallback = { x: Number(p.value.position.x), y: Number(p.value.position.y), src: path + '.patches[' + i + '].value.position', kind: 'unknown' };
                    // continue scanning for explicit player match; if none found we'll return fallback at the end
                    if (!obj.__mg_fallback) obj.__mg_fallback = fallback;
                  }
                }
              } catch (e) {}
            }
            if (obj.__mg_fallback) return obj.__mg_fallback;
          }
        } catch (e) {}

        // direct position shapes
        if (obj.position && isXY(obj.position)) {
          // if this object itself contains id fields that match our player id, mark as player
          const kind = hasPlayerIdMatch(obj) ? 'player' : (/pet/i.test(path) || /pet/i.test(JSON.stringify(obj.position)) ? 'pet' : 'unknown');
          return { x: Number(obj.position.x), y: Number(obj.position.y), src: path + '.position', kind: kind };
        }
        if (obj.pos && isXY(obj.pos)) {
          const kind = hasPlayerIdMatch(obj) ? 'player' : (/pet/i.test(path) || /pet/i.test(JSON.stringify(obj.pos)) ? 'pet' : 'unknown');
          return { x: Number(obj.pos.x), y: Number(obj.pos.y), src: path + '.pos', kind: kind };
        }
        if (isXY(obj)) {
          const kind = hasPlayerIdMatch(obj) ? 'player' : (/pet/i.test(path) ? 'pet' : 'unknown');
          return { x: Number(obj.x), y: Number(obj.y), src: path || 'root', kind: kind };
        }

        // Teleport / ClientToServer wrappers are likely player-driven
        if (obj.type && /Teleport/i.test(String(obj.type)) && obj.position && isXY(obj.position)) {
          // if payload includes an explicit playerId, honor it
          if (hasPlayerIdMatch(obj)) {
            return { x: Number(obj.position.x), y: Number(obj.position.y), src: obj.type || path, kind: 'player' };
          }
          // otherwise still treat Teleport as player by default (game may only send Teleport for the player)
          return { x: Number(obj.position.x), y: Number(obj.position.y), src: obj.type || path, kind: 'player' };
        }

        // scan object properties but favor keys that suggest 'pet' vs 'player'
        try {
          const keys = Object.keys(obj).slice(0, 30);
          for (let k of keys) {
            try {
              const val = obj[k];
              const res = tryExtractPos(val, path ? path + '.' + k : k, depth - 1);
              if (res) {
                // if the property name or path looks like pet data, mark as pet
                if (/pet|petPositions|pets/i.test(k) || /pet|petPositions|pets/i.test(path)) {
                  res.kind = 'pet';
                }
                // if property contains an id that matches our detected player id, mark as player
                try {
                  const maybeId = (obj.playerId || obj.player || obj.id || obj.ownerId || obj.owner || null);
                  if (!res.kind || res.kind === 'unknown') {
                    if (maybeId && __mg_player_id && String(maybeId).includes(String(__mg_player_id))) res.kind = 'player';
                  }
                } catch (e) {}
                return res;
              }
            } catch (e) { /* ignore property access errors */ }
          }
        } catch (e) {}

        return null;
      }

      function reportPos(pos) {
        if (!pos) return;
        try {
          // Normalise ambiguous captures: if kind is unknown but src includes '.position', treat as player
          if ((!pos.kind || pos.kind === 'unknown') && pos.src && String(pos.src).toLowerCase().indexOf('.position') !== -1) {
            pos.kind = 'player';
          }

          // Only accept and report positions that are explicitly identified as the player
          if (pos.kind !== 'player' && !/player/i.test(String(pos.src || ''))) {
            return; // ignore non-player captures (pets, other entities)
          }

          __mg_last_player_pos = Object.assign({}, pos, { capturedAt: Date.now() });
          window.postMessage({ source: 'mg-extension-page', type: 'playerPosition', pos: Object.assign({}, pos, { capturedAt: Date.now() }) }, '*');
        } catch (e) {}
      }

      // Helper to retrieve the best player position: prefer explicit player pos, otherwise any other recent pos
      function _getBestPlayerPos() {
        // Only return explicit player positions
        return __mg_last_player_pos || null;
      }

      // Hook console methods to capture game debug logs that include ClientToServer/Teleport objects
      try {
        ['log','debug','info','warn','error'].forEach(function(method) {
          try {
            const native = console[method] && console[method].bind(console);
            if (!native) return;
            console[method] = function() {
              try {
                const args = Array.prototype.slice.call(arguments);
                // quick heuristic: if format string mentions ClientToServer/Teleport and next arg is object
                if (args.length >= 2 && typeof args[0] === 'string' && /ClientToServer|Teleport/i.test(args[0]) && typeof args[1] === 'object') {
                  const p = tryExtractPos(args[1]); if (p) reportPos(p);
                }
                // scan all object args for positions
                for (let i = 0; i < args.length; i++) {
                  const a = args[i];
                  if (typeof a === 'object' && a !== null) {
                    const pos2 = tryExtractPos(a);
                    if (pos2) { reportPos(pos2); break; }
                  }
                }
              } catch (e) {}
              return native.apply(console, arguments);
            };
          } catch (e) {}
        });
      } catch (e) {}

      function decodePayload(data) {
        try {
          if (typeof data === 'string') {
            try { return JSON.parse(data); } catch(e) { return null; }
          }
          if (data instanceof ArrayBuffer) {
            try { return JSON.parse(new TextDecoder().decode(data)); } catch(e) { return null; }
          }
          if (data && data.data) return decodePayload(data.data);
        } catch(e) {}
        return null;
      }

      function maybeRelayFarmEvent(dir, msg) {
        try {
          if (!msg || typeof msg !== 'object') return;
          // Scope filter
          const sp = Array.isArray(msg.scopePath) ? msg.scopePath : [];
          if (sp.length >= 2 && String(sp[1]) === 'Quinoa') {
            const t = String(msg.type || '');
            if (t === 'PlantSeed' || t === 'RemoveGardenObject' || t === 'GardenObjectPlaced' || t === 'GardenObjectRemoved' || t === 'GardenStateUpdated' || t === 'PlantEgg' || t === 'HatchEgg' || t === 'PotPlant' || t === 'PlantGardenPlant') {
              window.postMessage({ source: 'mg-extension-page', type: 'farmEvent', dir, msg }, '*');
              try { console.log('[MG farm]', dir, msg); } catch(e) {}
            }
          }
        } catch(e) {}
      }

      // Hook WebSocket.send to inspect outgoing messages for positions and farm actions
      try {
        const NativeWS = window.WebSocket;
        if (NativeWS && NativeWS.prototype && !NativeWS.prototype.__mg_ws_hooked) {
          const origSend = NativeWS.prototype.send;
          NativeWS.prototype.send = function(data) {
            try {
              let parsed = decodePayload(data);
              const pos = tryExtractPos(parsed);
              if (pos) reportPos(pos);
              if (parsed) maybeRelayFarmEvent('out', parsed);
              try {
                if (parsed) {
                  window.postMessage({ source: 'mg-extension-page', type: 'wsAll', dir: 'out', msg: parsed }, '*');
                } else {
                  const rawMeta = { raw: true, rawType: (typeof data === 'string') ? 'string' : (data instanceof ArrayBuffer ? 'arraybuffer' : typeof data) };
                  if (typeof data === 'string') rawMeta.rawPreview = data.slice(0, 300);
                  if (data instanceof ArrayBuffer) rawMeta.byteLength = data.byteLength;
                  window.postMessage({ source: 'mg-extension-page', type: 'wsAll', dir: 'out', msg: rawMeta }, '*');
                }
              } catch(e) {}
            } catch (e) {}
            return origSend.apply(this, arguments);
          };
          NativeWS.prototype.__mg_ws_hooked = true;
        }
      } catch (e) {}

      // Also wrap the WebSocket constructor to intercept incoming messages for the MagicCircle connection
      try {
        const OriginalWS = window.WebSocket;
        if (OriginalWS && !OriginalWS.__mg_ctor_wrapped) {
          class MGWrappedWS extends OriginalWS {
            constructor(url, protocols) {
              super(url, protocols);
              try {
                const u = String(url || '');
                // detect playerId from the connection URL so we can prefer our player
                try {
                  const m = u.match(/[?&]playerId=([^&]+)/);
                  if (m && m[1]) {
                    try { __mg_player_id = decodeURIComponent(m[1]).replace(/^\"|\"$/g, ''); } catch(e) { __mg_player_id = m[1]; }
                  }
                } catch (e) {}
                if (u.includes('magiccircle.gg') || u.includes('/api/rooms/')) {
                  // Store this WebSocket connection for later use
                  window.__mg_ws_connection = this;
                  
                  // listen for incoming messages
                  this.addEventListener('message', function(ev) {
                    try {
                      let parsed = decodePayload(ev && ev.data);
                      const pos = tryExtractPos(parsed);
                      if (pos) reportPos(pos);
                      if (parsed) maybeRelayFarmEvent('in', parsed);
                      try {
                        if (parsed) {
                          window.postMessage({ source: 'mg-extension-page', type: 'wsAll', dir: 'in', msg: parsed }, '*');
                        } else {
                          const d = ev && ev.data;
                          const rawMeta = { raw: true, rawType: (typeof d === 'string') ? 'string' : (d instanceof ArrayBuffer ? 'arraybuffer' : typeof d) };
                          if (typeof d === 'string') rawMeta.rawPreview = d.slice(0, 300);
                          if (d instanceof ArrayBuffer) rawMeta.byteLength = d.byteLength;
                          window.postMessage({ source: 'mg-extension-page', type: 'wsAll', dir: 'in', msg: rawMeta }, '*');
                        }
                      } catch(e) {}
                    } catch (e) {
                      // ignore
                    }
                  });
                }
              } catch (e) {}
            }
          }
          // copy static props
          try { Object.keys(OriginalWS).forEach(k => { try { MGWrappedWS[k] = OriginalWS[k]; } catch(e){} }); } catch(e){}
          MGWrappedWS.prototype = OriginalWS.prototype;
          MGWrappedWS.__mg_ctor_wrapped = true;
          window.WebSocket = MGWrappedWS;
        }
      } catch (e) {}

      // Hook fetch to inspect JSON payloads
      try {
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
          try {
            let body = null;
            if (init && init.body) {
              try { body = JSON.parse(init.body); } catch (e) { body = null; }
            }
            // some code uses Request object
            if (!body && input && typeof input === 'object' && input.body) {
              try { body = JSON.parse(input.body); } catch (e) { body = null; }
            }
            const pos = tryExtractPos(body);
            if (pos) reportPos(pos);
          } catch (e) {}
          return origFetch.apply(this, arguments);
        };
      } catch (e) {}

      // Hook XHR send
      try {
        const XHR = window.XMLHttpRequest;
        if (XHR && XHR.prototype && !XHR.prototype.__mg_xhr_hooked) {
          const origSend = XHR.prototype.send;
          XHR.prototype.send = function(body) {
            try {
              let parsed = null;
              if (typeof body === 'string') {
                try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
              }
              const pos = tryExtractPos(parsed);
              if (pos) reportPos(pos);
            } catch (e) {}
            return origSend.apply(this, arguments);
          };
          XHR.prototype.__mg_xhr_hooked = true;
        }
      } catch (e) {}

      window.addEventListener('message', function(event) {
        if (!event.data || event.data.source !== 'mg-extension') return;
        var msg = event.data;

        switch (msg.action) {
          case 'setPlayerId':
            try {
              // normalize and store the player id for use in tryExtractPos
              __mg_player_id = String(msg.playerId || '').replace(/^\"|\"$/g, '') || null;
            } catch (e) { __mg_player_id = msg.playerId || null; }
            try { window.postMessage({ source: 'mg-extension-page', type: 'playerIdSet', playerId: __mg_player_id }, '*'); } catch (e) {}
            break;
          case 'triggerKey':
            dispatchKey(msg.code || ('Key' + (msg.key || '').toUpperCase()), 'keydown');
            setTimeout(function() { dispatchKey(msg.code || ('Key' + (msg.key || '').toUpperCase()), 'keyup'); }, 60);
            break;
          case 'getPlayerPosition':
            // reply with best-effort position
            try {
              var pos = null;
              // try heuristics first
              if (window.gameState && window.gameState.player && typeof window.gameState.player.x === 'number') {
                pos = { x: window.gameState.player.x, y: window.gameState.player.y, src: 'gameState.player', kind: 'player' };
              } else if (window.player && typeof window.player.x === 'number') {
                pos = { x: window.player.x, y: window.player.y, src: 'window.player', kind: 'player' };
              } else if (window.MagicGarden && window.MagicGarden.player && typeof window.MagicGarden.player.x === 'number') {
                pos = { x: window.MagicGarden.player.x, y: window.MagicGarden.player.y, src: 'MagicGarden.player', kind: 'player' };
              }
              // prefer explicit player pos; otherwise use best-known (player or other)
              if (!pos) pos = (typeof _getBestPlayerPos === 'function') ? _getBestPlayerPos() : null;
              // include kind if available
              window.postMessage({ source: 'mg-extension-page', type: 'playerPosition', pos: pos || null }, '*');
            } catch (e) {
              window.postMessage({ source: 'mg-extension-page', type: 'playerPosition', pos: null }, '*');
            }
            break;
          case 'move':
            var dir = msg.direction || msg.key;
            var count = Math.max(1, Math.floor(msg.distance || 1));
            var codeMap = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD' };
            for (var i = 0; i < count; i++) {
              (function(c, idx) {
                setTimeout(function() {
                  dispatchKey(c, 'keydown');
                  setTimeout(function() { dispatchKey(c, 'keyup'); }, 60);
                }, idx * 80);
              })(codeMap[(dir || '').toLowerCase()] || 'KeyW', i);
            }
            break;
          case 'testConnection':
            window.postMessage({ source: 'mg-extension-page', type: 'testResponse', ok: true, timestamp: Date.now() }, '*');
            break;
          case 'forceReconnectWS':
            try {
              if (window.__mg_ws_connection && window.__mg_ws_connection.readyState === WebSocket.OPEN) {
                try { console.log('[MG] Forcing WS reconnect'); } catch(e) {}
                try { window.__mg_ws_connection.close(1000, 'mg-force-resync'); } catch(e) {}
                // let the game reconnect naturally; the wrapper will capture the new connection
              } else {
                console.warn('[MG] No active WS to reconnect');
              }
            } catch (e) { console.error('[MG] forceReconnectWS error:', e); }
            break;
          case 'sendWebSocketMessage':
            // Find the active WebSocket connection and send the message
            try {
              // Look for WebSocket connections in the global scope
              let ws = null;
              if (window.__mg_ws_connection) {
                ws = window.__mg_ws_connection;
              } else {
                // Try to find WebSocket in common game objects
                const candidates = [
                  window.game?.ws,
                  window.game?.websocket,
                  window.MagicGarden?.ws,
                  window.MagicGarden?.websocket,
                  window.gameState?.ws,
                  window.gameState?.websocket
                ];
                ws = candidates.find(c => c && c.readyState === WebSocket.OPEN);
              }
              
              if (ws && ws.readyState === WebSocket.OPEN) {
                const message = msg.message || {};
                ws.send(JSON.stringify(message));
                console.log('[MG] Sent WebSocket message:', message);
              } else {
                console.warn('[MG] No active WebSocket connection found');
              }
            } catch (e) {
              console.error('[MG] Failed to send WebSocket message:', e);
            }
            break;
        }
      }, false);

      window.MagicGardenPageAPI = {
        triggerKey: function(code) { dispatchKey(code, 'keydown'); setTimeout(function() { dispatchKey(code, 'keyup'); }, 60); },
        move: function(dir, distance) {
          window.postMessage({ source: 'mg-extension', action: 'move', direction: dir, distance: distance }, '*');
        },
        getPlayerPosition: function() {
          // synchronous best-effort getter that prefers heuristics then last-known
          var pos = null;
          try {
            if (window.gameState && window.gameState.player && typeof window.gameState.player.x === 'number') {
              pos = { x: window.gameState.player.x, y: window.gameState.player.y, src: 'gameState.player', kind: 'player' };
            } else if (window.player && typeof window.player.x === 'number') {
              pos = { x: window.player.x, y: window.player.y, src: 'window.player', kind: 'player' };
            } else if (window.MagicGarden && window.MagicGarden.player && typeof window.MagicGarden.player.x === 'number') {
              pos = { x: window.MagicGarden.player.x, y: window.MagicGarden.player.y, src: 'MagicGarden.player', kind: 'player' };
            }
          } catch (e) {}
          if (!pos && typeof _getBestPlayerPos === 'function') pos = _getBestPlayerPos();
          return pos || null;
        }
      };
    };

    const target = frameId !== null ? { tabId: tabId, frameIds: [frameId] } : { tabId: tabId };
    console.log('background: injecting pageScript into', target);
    chrome.scripting.executeScript({
      target: target,
      func: pageScript,
      world: 'MAIN'
    }).then(() => {
      sendResponse({ success: true, injectedInto: target });
    }).catch(err => {
      console.error('background: inject failed', err);
      sendResponse({ success: false, error: String(err) });
    });

    return true; // will respond asynchronously
  }
  
  // Relay WS logs to terminal (devtools background console) and handle crop persistence via background to bypass CORS
  if (message && message.action === 'wsLog') {
    (async () => {
      try {
        try { console.log('[MG WS]', message.dir, message.msg); } catch(e) {}
        // Also persist to local Flask for later analysis
        try {
          await fetch('http://127.0.0.1:5000/api/wslog', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dir: message.dir, msg: message.msg }) });
        } catch (e) {}
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  // Allow content script to stream all ws packets to the server (mirrors page -> bg message bus)
  if (message && message.action === 'wsAllLog') {
    (async () => {
      try {
        try { console.log('[MG WS-ALL]', message.dir, message.msg); } catch(e) {}
        try {
          await fetch('http://127.0.0.1:5000/api/wslog', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dir: message.dir, msg: message.msg }) });
        } catch (e) {}
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (message && message.action === 'persistCrop') {
    (async () => {
      try {
        // Load current crops from local Flask
        const getRes = await fetch('http://127.0.0.1:5000/api/crops', { cache: 'no-store' });
        const arr = getRes.ok ? await getRes.json() : [];
        const key = (a) => a.x+','+a.y;
        const map = new Map(arr.map(a => [key(a), a]));
        const k = message.x+','+message.y;
        if (!message.crop) map.delete(k); else map.set(k, { x: message.x, y: message.y, crop: String(message.crop) });
        const next = Array.from(map.values()).sort((a,b)=>a.x-b.x||a.y-b.y);
        const postRes = await fetch('http://127.0.0.1:5000/api/crops', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(next) });
        if (!postRes.ok) {
          let err = 'HTTP ' + postRes.status;
          try { const j = await postRes.json(); if (j && j.error) err = j.error; } catch {}
          sendResponse({ success: false, error: err });
          return;
        }
        console.log('[MG bg] crops updated @', message.x, message.y, '=>', message.crop || '(removed)');
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true; // async
  }

  if (message && message.action === 'persistEgg') {
    (async () => {
      try {
        const getRes = await fetch('http://127.0.0.1:5000/api/eggs', { cache: 'no-store' });
        const arr = getRes.ok ? await getRes.json() : [];
        const key = (a) => a.x+','+a.y;
        const map = new Map(arr.map(a => [key(a), a]));
        const k = message.x+','+message.y;
        if (!message.egg) map.delete(k); else map.set(k, { x: message.x, y: message.y, egg: String(message.egg) });
        const next = Array.from(map.values()).sort((a,b)=>a.x-b.x||a.y-b.y);
        const postRes = await fetch('http://127.0.0.1:5000/api/eggs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(next) });
        if (!postRes.ok) {
          let err = 'HTTP ' + postRes.status;
          try { const j = await postRes.json(); if (j && j.error) err = j.error; } catch {}
          sendResponse({ success: false, error: err });
          return;
        }
        console.log('[MG bg] eggs updated @', message.x, message.y, '=>', message.egg || '(removed)');
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e) });
      }
    })();
    return true;
  }
});

// Handle tab updates to ensure content script is injected
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Inject content script if needed
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).catch(() => {
      // Ignore errors for restricted pages
    });
  }
});

