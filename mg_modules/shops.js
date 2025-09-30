// Shop monitoring module: tracks countdowns and detects new items on restock
(function attachShopsModule() {
  function attach(api) {
    if (!api || attach.__applied) return; attach.__applied = true;

    // Internal state
    api._shopState = null;                // normalized snapshot
    api._restockTimers = {};              // kind -> { secs, t0, period }
    api._shopListeners = [];              // callbacks(snapshot)
    api._restockListeners = [];           // callbacks({ kind, newItems, snapshot })
    api._shopCountdownInterval = null;    // logging interval id

    function nowMono() { return performance && performance.now ? performance.now() / 1000 : Date.now() / 1000; }

    function _displayName(item) {
      return (
        item?.displayName || item?.name || item?.species || item?.toolId || item?.eggId || item?.decorId || item?.id || 'unknown'
      );
    }

    function _currentStock(item) {
      const keys = ['remainingStock','currentStock','stock','available','qty','quantity'];
      for (const k of keys) {
        if (k in (item || {})) {
          const v = item[k];
          if (typeof v === 'number') return Math.trunc(v);
          if (typeof v === 'string') {
            const s = v.trim();
            if (!s) continue;
            if (/^-?\d+(?:\.\d+)?$/.test(s)) return Math.trunc(Number(s));
          }
        }
      }
      if ('initialStock' in (item || {}) && 'sold' in (item || {})) {
        try { return Math.max(Number(item.initialStock || 0) - Number(item.sold || 0), 0); } catch (_) {}
      }
      try { return Math.trunc(Number(item.initialStock || 0)); } catch (_) { return 0; }
    }

    function _normalizeShops(fullState) {
      try {
        const child = fullState && fullState.data && fullState.data.child && fullState.data.child.data;
        const shops = child && child.shops;
        if (!shops) return null;
        const out = { captured_at: Date.now(), currentTime: child?.currentTime, shops: {} };
        for (const kind of ['seed','egg','tool','decor']) {
          const s = shops[kind];
          if (!s) continue;
          const inv = Array.isArray(s.inventory) ? s.inventory : [];
          out.shops[kind] = {
            secondsUntilRestock: s.secondsUntilRestock,
            inventory: inv.map((it) => ({
              id: it.species || it.toolId || it.eggId || it.decorId || it.id,
              name: _displayName(it),
              itemType: it.itemType || kind,
              initialStock: Number(it.initialStock || 0),
              currentStock: _currentStock(it)
            }))
          };
        }
        return out;
      } catch (_) { return null; }
    }

    function _snapshotFromState() {
      const fs = api._fullState || api.getGameState?.();
      return _normalizeShops(fs);
    }

    function _emitSnapshot(snap) {
      try { for (const fn of api._shopListeners) { try { fn(snap); } catch (_) {} } } catch (_) {}
    }

    function _emitRestock(payload) {
      try { for (const fn of api._restockListeners) { try { fn(payload); } catch (_) {} } } catch (_) {}
    }

    function _diffNewItems(prevKind, curKind) {
      const before = (prevKind?.inventory || []).reduce((m, it) => { m[it.id || it.name] = Number(it.currentStock || 0); return m; }, {});
      const added = [];
      for (const it of (curKind?.inventory || [])) {
        const key = it.id || it.name;
        const prev = before[key];
        const cur = Number(it.currentStock || 0);
        if ((prev == null || prev <= 0) && cur > 0) {
          added.push({ id: it.id, name: it.name, currentStock: cur, itemType: it.itemType });
        }
      }
      return added;
    }

    function _refreshTimersFromSnapshot(snap) {
      const t0 = nowMono();
      for (const kind of ['seed','egg','tool','decor']) {
        const s = snap?.shops?.[kind];
        if (!s) continue;
        const secs = Number(s.secondsUntilRestock || 0);
        const prev = api._restockTimers[kind];
        // if server raised the timer significantly, treat as a reset to new period
        if (!prev || secs > (prev.secs + 3)) {
          api._restockTimers[kind] = { secs, t0, period: secs || (prev?.period || 0) };
        } else {
          api._restockTimers[kind] = { secs, t0, period: prev.period || secs };
        }
      }
    }

    function _handleWelcome(msg) {
      try {
        api._shopState = _normalizeShops(msg.fullState);
        if (api._shopState) {
          _refreshTimersFromSnapshot(api._shopState);
          _emitSnapshot(api._shopState);
        }
      } catch (_) {}
    }

    function _applyJsonPatchPath(root, ptr, op, value) {
      try {
        if (!root || typeof ptr !== 'string') return;
        const parts = ptr.split('/').filter(Boolean);
        let cur = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          const idx = Number(seg);
          if (Array.isArray(cur) && Number.isFinite(idx)) {
            if (cur[idx] === undefined && (op === 'add' || op === 'replace')) cur[idx] = {};
            cur = cur[idx];
          } else {
            if (!cur[seg] && (op === 'add' || op === 'replace')) cur[seg] = {};
            cur = cur[seg];
          }
          if (!cur) return;
        }
        const last = parts[parts.length - 1];
        const lastIdx = Number(last);
        if (op === 'remove') {
          if (Array.isArray(cur) && Number.isFinite(lastIdx)) cur.splice(lastIdx, 1);
          else if (cur) delete cur[last];
        } else {
          if (Array.isArray(cur) && Number.isFinite(lastIdx)) cur[lastIdx] = value; else cur[last] = value;
        }
      } catch (_) {}
    }

    function _handlePartialState(patches) {
      let sawShopChange = false;
      for (const p of (patches || [])) {
        const path = String(p.path || '');
        if (path.startsWith('/child/data/shops/')) {
          sawShopChange = true;
          try { _applyJsonPatchPath(api._fullState, path, p.op, p.value); } catch (_) {}
        }
      }
      if (!sawShopChange) return;

      const prev = api._shopState;
      const cur = _snapshotFromState();
      if (!cur) return;
      api._shopState = cur;
      _refreshTimersFromSnapshot(cur);
      _emitSnapshot(cur);

      // Detect new items now in stock
      for (const kind of ['seed','egg','tool','decor']) {
        const added = _diffNewItems(prev?.shops?.[kind], cur?.shops?.[kind]);
        if (added && added.length) {
          try { console.log('[MG][Shop] Restock detected for', kind, '→', added.map(a => a.name).join(', ')); } catch (_) {}
          _emitRestock({ kind, newItems: added, snapshot: cur });
        }
      }
    }

    // Public API
    api.onShopSnapshot = function(cb) {
      if (typeof cb === 'function') api._shopListeners.push(cb);
      return () => { const i = api._shopListeners.indexOf(cb); if (i >= 0) api._shopListeners.splice(i,1); };
    };

    api.onShopRestock = function(cb) {
      if (typeof cb === 'function') api._restockListeners.push(cb);
      return () => { const i = api._restockListeners.indexOf(cb); if (i >= 0) api._restockListeners.splice(i,1); };
    };

    api.getShopSnapshot = function() {
      try { return api._shopState ? JSON.parse(JSON.stringify(api._shopState)) : null; } catch (_) { return null; }
    };

    api.getShopCountdowns = function() {
      const out = {}; const t = nowMono();
      for (const k of ['seed','egg','tool','decor']) {
        const rt = api._restockTimers[k];
        if (!rt) { out[k] = null; continue; }
        const remain = Number(rt.secs) - (t - Number(rt.t0));
        out[k] = Math.max(0, Math.round(remain));
      }
      return out;
    };

    api.startShopMonitor = function(options) {
      options = options || {};
      const logCountdown = options.logCountdown !== false; // default true
      const countdownEvery = Math.max(1, Number(options.countdownEvery) || 5);

      // Attach WS listener if not already
      if (!api._shopWsListenerAttached) {
        window.addEventListener('message', function onMsg(ev) {
          try {
            const d = ev && ev.data;
            if (!d || d.source !== 'mg-extension-page') return;
            if (d.type !== 'wsAll' || d.dir !== 'in') return;
            const msg = d.msg; if (!msg) return;
            if (msg.type === 'Welcome') _handleWelcome(msg);
            else if (msg.type === 'PartialState' && Array.isArray(msg.patches)) _handlePartialState(msg.patches);
          } catch (_) {}
        });
        api._shopWsListenerAttached = true;
      }

      // Seed from current full state if available
      try { const snap = _snapshotFromState(); if (snap) { api._shopState = snap; _refreshTimersFromSnapshot(snap); _emitSnapshot(snap); } } catch (_) {}

      // Optionally log countdowns
      if (logCountdown) {
        if (api._shopCountdownInterval) clearInterval(api._shopCountdownInterval);
        api._shopCountdownInterval = setInterval(() => {
          try {
            const cds = api.getShopCountdowns();
            console.log('[MG][Shop] countdowns', cds);
          } catch (_) {}
        }, countdownEvery * 1000);
      }
      return { success: true };
    };

    api.stopShopMonitor = function() {
      try { if (api._shopCountdownInterval) clearInterval(api._shopCountdownInterval); } catch (_) {}
      api._shopCountdownInterval = null;
      return { success: true };
    };
  }

  if (window.MagicGardenAPI) attach(window.MagicGardenAPI);
  else { (window.__mg_attachers = window.__mg_attachers || []).push(attach); }
})();





