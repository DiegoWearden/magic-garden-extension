// Magic Garden Game Control API Chrome Extension (updated)
// This content script injects a small page-context script that actually creates
// and dispatches keyboard events from the page context, and then forwards
// commands to that page script using window.postMessage.

// Prevent double injection which causes redeclaration SyntaxError
if (window.__mg_content_injected) {
  console.log('content.js: already injected, skipping');
} else {
  window.__mg_content_injected = true;

  // Persistent wall set for current room and simple persistence helpers
  // stored under chrome.storage.local (fallback to localStorage)
  let __mg_walls = new Set();

  async function loadWallsForRoom() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const key = 'mg_walls';
          chrome.storage.local.get([key], function(result) {
            try {
              const arr = result && result[key] ? result[key] : [];
              __mg_walls = new Set((arr || []).map(p => (p.x + ',' + p.y)));
            } catch (e) {
              __mg_walls = new Set();
            }
            resolve();
          });
          return;
        }
      } catch (e) {
        // fallthrough to localStorage
      }
      try {
        const raw = localStorage.getItem('mg_walls');
        const arr = raw ? JSON.parse(raw) : [];
        __mg_walls = new Set((arr || []).map(p => (p.x + ',' + p.y)));
      } catch (e) {
        __mg_walls = new Set();
      }
      resolve();
    });
  }

  async function saveWallsForRoom(walls) {
    return new Promise((resolve) => {
      // Prepare the array of wall positions to persist
      let arr;
      try {
        arr = (walls || Array.from(__mg_walls).map(s => { const p = s.split(','); return { x: Number(p[0]), y: Number(p[1]) }; }));
      } catch (e) {
        arr = [];
      }

      // Log each position being saved for debugging/tracing
      try {
        if (Array.isArray(arr)) {
          arr.forEach((pos, idx) => {
            try {
              console.log('saveWallsForRoom: saving wall[' + idx + ']:', pos);
            } catch (e) {
              // ignore logging errors
            }
          });
        }
      } catch (e) {
        // ignore
      }

      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ 'mg_walls': arr }, function() { 
            try { console.log('saveWallsForRoom: persisted', arr.length, 'walls to chrome.storage.local'); } catch (e) {}
            resolve(); 
          });
          return;
        }
      } catch (e) {}

      try {
        localStorage.setItem('mg_walls', JSON.stringify(arr));
        try { console.log('saveWallsForRoom: persisted', arr.length, 'walls to localStorage'); } catch (e) {}
      } catch (e) {
        try { console.error('saveWallsForRoom: failed to persist walls', e); } catch (ee) {}
      }
      resolve();
    });
  }

  // Request background to inject the page script into the main world to avoid CSP issues
  (function requestPageInjection() {
    try {
      chrome.runtime.sendMessage({ action: 'injectPageScript' }, function(response) {
        console.log('content.js: injectPageScript response from background', response);
        if (!response || !response.success) {
          console.warn('content.js: page script injection failed or not acknowledged', response);
        }
      });
    } catch (e) {
      // Some pages prevent chrome runtime messaging; ignore and continue
      console.warn('Could not request page script injection', e);
    }


    // Retry once after a short delay in case the background wasn't ready
    setTimeout(function() {
      try {
        chrome.runtime.sendMessage({ action: 'injectPageScript' }, function(response) {
          console.log('content.js: second injectPageScript response', response);
        });
      } catch (e) {}
    }, 500);

    // Check after 1s and 2s whether the page API exists
    setTimeout(function() {
      console.log('content.js: check page API after 1s:', !!window.MagicGardenPageAPI, window.MagicGardenPageAPI);
    }, 1000);
    setTimeout(function() {
      console.log('content.js: check page API after 2s:', !!window.MagicGardenPageAPI, window.MagicGardenPageAPI);
      if (!window.MagicGardenPageAPI) {
        console.warn('content.js: MagicGardenPageAPI still undefined — page injection likely failed or blocked by CSP/iframe');
      }
    }, 2000);
  })();

  // Content-script-side API that forwards commands to the injected page script
  class MagicGardenAPI {
    constructor() {
      this.speed = 10;
      this.isInitialized = false;
      // Grid bounds defaults; can be overridden if needed
      this.minX = 0; this.maxX = 200;
      this.minY = 0; this.maxY = 200;
      // Cache mapping from server slot index -> last known coordinate when user acted
      this._slotToCoord = new Map();
      // Latest known tileObjects by slot index for mutation lookup
      this._tileObjects = Object.create(null);
      // Last known fullState (from Welcome), optionally updated by PartialState patches
      this._fullState = null;
      // Live pet data cache for real-time monitoring
      this._petData = {
        petSlots: {},
        petSlotInfos: {}
      };
      // Timestamp of last garden update applied to _tileObjects
      this._lastGardenUpdateTs = 0;
      // Live mirror of inventory and last update timestamp
      this._inventoryItems = [];
      this._lastInventoryUpdateTs = 0;
      this._inventoryListeners = [];
      // Removed granular push timers; we now update virtual inventory only via explicit API calls at action points
      // One-time guard for initial inventory write
      this._initialInventorySaved = false;
      // Local app server base (Flask app.py). Change port if needed.
      this._inventoryServerBase = 'http://127.0.0.1:5000';
      // Pet diet/Diet API shares same base
      this._dietServerBase = this._inventoryServerBase;
      // Enable egg tracking
      this._eggsEnabled = true;
      this.init();
    }

    init() {
      // expose a small handle in the content script scope
      window.MagicGardenAPI = this;
      console.log('Magic Garden API (content script) initialized');
      this.isInitialized = true;
      // Seed virtual inventory JSON shortly after startup in case we missed Welcome
      try {
        setTimeout(() => { try { this.seedVirtualInventory({ retries: 12, intervalMs: 500 }); } catch (e) {} }, 600);
      } catch (e) {}

      // As soon as full game inventory becomes available, write it to the server JSON once
      try {
        const onStartupWs = async (ev) => {
          try {
            if (this._initialInventorySaved) return;
            const d = ev && ev.data;
            if (!d || d.source !== 'mg-extension-page' || d.type !== 'wsAll' || d.dir !== 'in') return;
            const msg = d.msg;
            if (!msg) return;

            let hasInventory = false;
            if (msg.type === 'Welcome') {
              console.log('[MG] Welcome message received, checking for inventory...');
              const us0 = msg.fullState && msg.fullState.data && msg.fullState.data.child && msg.fullState.data.child.data && Array.isArray(msg.fullState.data.child.data.userSlots)
                ? msg.fullState.data.child.data.userSlots[0] : null;
              const items = us0 && us0.data && us0.data.inventory && Array.isArray(us0.data.inventory.items) ? us0.data.inventory.items : null;
              hasInventory = Array.isArray(items) && items.length > 0;
              console.log('[MG] Welcome inventory check:', { hasInventory, itemCount: items ? items.length : 0 });
            } else if (msg.type === 'PartialState' && Array.isArray(msg.patches)) {
              for (const p of msg.patches) {
                const path = String(p.path || '');
                if (/\/child\/data\/userSlots\/\d+\/data\/inventory\//.test(path)) { 
                  hasInventory = true; 
                  console.log('[MG] Inventory patch detected:', path);
                  break; 
                }
              }
            }

            if (hasInventory) {
              console.log('[MG] Saving initial inventory to server...');
              try { 
                const result = await this.saveInventoryFromGameState({ compact: true }); 
                console.log('[MG] Initial inventory save result:', result);
              } catch (e) {
                console.error('[MG] Initial inventory save failed:', e);
              }
              this._initialInventorySaved = true;
              try { window.removeEventListener('message', onStartupWs); } catch (e) {}
            }
          } catch (e) {
            console.error('[MG] Startup WS handler error:', e);
          }
        };
        window.addEventListener('message', onStartupWs);
        
        // More aggressive fallback polling
        const pollForInventory = async () => {
          if (this._initialInventorySaved) return;
          try {
            const gs = this.getGameState();
            const us0 = gs && gs.child && gs.child.data && gs.child.data.userSlots && Array.isArray(gs.child.data.userSlots) ? gs.child.data.userSlots[0] : null;
            const items = us0 && us0.data && us0.data.inventory && Array.isArray(us0.data.inventory.items) ? us0.data.inventory.items : null;
            if (Array.isArray(items) && items.length > 0) {
              console.log('[MG] Fallback: Found inventory, saving...', { itemCount: items.length });
              try { 
                const result = await this.saveInventoryFromGameState({ compact: true }); 
                console.log('[MG] Fallback inventory save result:', result);
              } catch (e) {
                console.error('[MG] Fallback inventory save failed:', e);
              }
              this._initialInventorySaved = true;
              try { window.removeEventListener('message', onStartupWs); } catch (e) {}
            }
          } catch (e) {
            console.error('[MG] Fallback poll error:', e);
          }
        };
        
        // Try multiple times with increasing delays
        setTimeout(pollForInventory, 1000);
        setTimeout(pollForInventory, 3000);
        setTimeout(pollForInventory, 5000);
        setTimeout(pollForInventory, 10000);
      } catch (e) {
        console.error('[MG] Startup inventory saver setup failed:', e);
      }
    }

    // Convert a coordinate (x,y) to a slot index (0..199). Returns null if outside the garden or x==14
    coordToSlot(x, y) {
      try {
        const xi = Math.round(Number(x));
        const yi = Math.round(Number(y));
        if (!Number.isFinite(xi) || !Number.isFinite(yi)) return null;
        if (yi < 4 || yi > 13) return null;
        let col;
        if (xi >= 4 && xi <= 13) {
          col = xi - 4; // 0..9
        } else if (xi >= 15 && xi <= 24) {
          col = 10 + (xi - 15); // 10..19
        } else {
          return null; // includes xi === 14, or outside bounds
        }
        const row = yi - 4; // 0..9
        return row * 20 + col; // 0..199
      } catch (e) {
        return null;
      }
    }

    // Convert a slot index (0..199) to coordinate { x, y }
    slotToCoord(slotIndex) {
      try {
        const s = Number(slotIndex);
        if (!Number.isFinite(s) || s < 0 || s > 199) return null;
        const row = Math.floor(s / 20); // 0..9
        const col = s % 20; // 0..19
        const y = 4 + row;
        const x = col < 10 ? (4 + col) : (15 + (col - 10));
        return { x, y };
      } catch (e) {
        return null;
      }
    }

    // Get the tile object by coordinate
    getTileByCoord(x, y) {
      const slot = this.coordToSlot(x, y);
      if (slot == null) return null;
      return this.extractMutationsBySlot(slot);
    }

    // Subscribe to farm events from the page (via injected WS hook) and persist crops
    startFarmSync(slotToCoordMapper) {
      if (this._farmSyncStarted) return;
      this._farmSyncStarted = true;
      // Disable mapper-based guessing to avoid stray updates
      this._slotToCoordMapper = null;
      window.addEventListener('message', async (ev) => {
        const d = ev.data;
        if (!d || d.source !== 'mg-extension-page') return;
        try {
          // Forward ALL packets (both in/out) to background for logging and also parse server-side PartialState to keep crops in sync
          if (d.type === 'wsAll') {
            try { chrome.runtime.sendMessage({ action: 'wsAllLog', dir: d.dir, msg: d.msg }); } catch (e) {}
            // Capture fullState tileObjects on Welcome
            if (d.dir === 'in' && d.msg && d.msg.type === 'Welcome') {
              try {
                this._fullState = d.msg.fullState ? JSON.parse(JSON.stringify(d.msg.fullState)) : null;
                // Seed live garden mirror from userSlots[0].data.garden.tileObjects (correct path)
                try {
                  const us0 = d.msg && d.msg.fullState && d.msg.fullState.data && d.msg.fullState.data.child && d.msg.fullState.data.child.data && d.msg.fullState.data.child.data.userSlots && d.msg.fullState.data.child.data.userSlots[0];
                  const to = us0 && us0.data && us0.data.garden && us0.data.garden.tileObjects;
                  if (to && typeof to === 'object') {
                    this._tileObjects = Object.create(null);
                    Object.keys(to).forEach(k => { this._tileObjects[Number(k)] = to[k]; });
                    this._lastGardenUpdateTs = Date.now();
                  }
                } catch (e) {}
                // Seed live inventory mirror from Welcome
                try {
                  const us0b = d.msg && d.msg.fullState && d.msg.fullState.data && d.msg.fullState.data.child && d.msg.fullState.data.child.data && d.msg.fullState.data.child.data.userSlots && d.msg.fullState.data.child.data.userSlots[0];
                  const inv = us0b && us0b.data && us0b.data.inventory && Array.isArray(us0b.data.inventory.items) ? us0b.data.inventory.items : [];
                  this._inventoryItems = JSON.parse(JSON.stringify(inv));
                  this._lastInventoryUpdateTs = Date.now();
                  // Initialize virtual inventory on the Flask server (only if non-empty)
                  try { this._postInventoryToServer(this._inventoryItems); } catch (e) {}
                } catch (e) {}
                // Seed live pet cache from Welcome
                try {
                  const us0 = d.msg && d.msg.fullState && d.msg.fullState.data && d.msg.fullState.data.child && d.msg.fullState.data.child.data && d.msg.fullState.data.child.data.userSlots && d.msg.fullState.data.child.data.userSlots[0];
                  if (us0) {
                    const ps = (us0.data && us0.data.petSlots) ? us0.data.petSlots : {};
                    const psi = us0.petSlotInfos ? us0.petSlotInfos : {};
                    this._petData = {
                      petSlots: JSON.parse(JSON.stringify(ps)),
                      petSlotInfos: JSON.parse(JSON.stringify(psi))
                    };
                  }
                } catch (e) {}
              } catch (e) {}
            }
            // Refresh local mirror if server sends consolidated garden updates
            if (d.dir === 'in' && d.msg && (d.msg.type === 'GardenStateUpdated' || d.msg.type === 'GardenObjectPlaced' || d.msg.type === 'GardenObjectRemoved')) {
              try {
                const g = (d.msg.garden) || (d.msg.data && d.msg.data.garden) || null;
                if (g && g.tileObjects && typeof g.tileObjects === 'object') {
                  this._tileObjects = Object.create(null);
                  Object.keys(g.tileObjects).forEach(k => { this._tileObjects[Number(k)] = g.tileObjects[k]; });
                  this._lastGardenUpdateTs = Date.now();
                }
              } catch (e) {}
            }
            // Parse incoming PartialState patches for tile add/remove
            if (d.dir === 'in' && d.msg && d.msg.type === 'PartialState' && Array.isArray(d.msg.patches)) {
              for (const p of d.msg.patches) {
                try {
                  const path = String(p.path || '');
                  
                  // Handle pet data updates (hunger, xp, position)
                  if (path.includes('/petSlots/') || path.includes('/petSlotInfos/')) {
                    try {
                      // Update live pet data cache
                      const segs = String(p.path || '').split('/').filter(Boolean);
                      // Find root within _petData (either petSlots or petSlotInfos)
                      let target = this._petData;
                      const petRootIdx = segs.findIndex(s => s === 'petSlots' || s === 'petSlotInfos');
                      if (petRootIdx >= 0) {
                        const rootKey = segs[petRootIdx];
                        if (!target[rootKey]) target[rootKey] = {};
                        target = target[rootKey];
                        // Trim segs to start from rootKey
                        const trimmed = segs.slice(petRootIdx + 1);
                        // Navigate to the target object under that root
                        for (let i = 0; i < trimmed.length - 1; i++) {
                          const key = trimmed[i];
                          const idx = Number(key);
                          if (Array.isArray(target) && Number.isFinite(idx)) {
                            target = target[idx];
                          } else {
                            // Create missing container objects for both add and replace ops
                            if (!target[key] && (p.op === 'add' || p.op === 'replace')) target[key] = {};
                            target = target[key];
                          }
                          if (!target) break;
                        }
                        const last = trimmed[trimmed.length - 1];
                        if (target) {
                          if (p.op === 'add' || p.op === 'replace') {
                            const idx = Number(last);
                            if (Array.isArray(target) && Number.isFinite(idx)) target[idx] = p.value; 
                            else target[last] = p.value;
                          } else if (p.op === 'remove') {
                            const idx = Number(last);
                            if (Array.isArray(target) && Number.isFinite(idx)) target.splice(idx, 1); 
                            else delete target[last];
                          }
                        }
                      }
                      
                      // Navigate to the target object
                      for (let i = 0; i < segs.length - 1; i++) {
                        const key = segs[i];
                        const idx = Number(key);
                        if (Array.isArray(target) && Number.isFinite(idx)) {
                          target = target[idx];
                        } else {
                          if (!target[key] && p.op === 'add') target[key] = {};
                          target = target[key];
                        }
                        if (!target) break;
                      }
                      
                      const last = segs[segs.length - 1];
                      if (target) {
                        if (p.op === 'add' || p.op === 'replace') {
                          const idx = Number(last);
                          if (Array.isArray(target) && Number.isFinite(idx)) target[idx] = p.value; 
                          else target[last] = p.value;
                        } else if (p.op === 'remove') {
                          const idx = Number(last);
                          if (Array.isArray(target) && Number.isFinite(idx)) target.splice(idx, 1); 
                          else delete target[last];
                        }
                      }
                      
                      // Also update fullState for consistency
                      if (this._fullState && this._fullState.data && this._fullState.data.child && this._fullState.data.child.data) {
                        const base = this._fullState.data.child.data;
                        let parent = base;
                        for (let i = 0; i < segs.length - 1; i++) {
                          const key = segs[i];
                          const idx = Number(key);
                          if (Array.isArray(parent) && Number.isFinite(idx)) {
                            parent = parent[idx];
                          } else {
                            // Create missing container objects for both add and replace ops
                            if (!parent[key] && (p.op === 'add' || p.op === 'replace')) parent[key] = {};
                            parent = parent[key];
                          }
                          if (!parent) break;
                        }
                        const last = segs[segs.length - 1];
                        if (parent) {
                          if (p.op === 'add' || p.op === 'replace') {
                            const idx = Number(last);
                            if (Array.isArray(parent) && Number.isFinite(idx)) parent[idx] = p.value; 
                            else parent[last] = p.value;
                          } else if (p.op === 'remove') {
                            const idx = Number(last);
                            if (Array.isArray(parent) && Number.isFinite(idx)) parent.splice(idx, 1); 
                            else delete parent[last];
                          }
                        }
                      }
                    } catch (e) { /* ignore pet patch errors */ }
                    continue; // Skip garden processing for pet patches
                  }

                  // Handle inventory updates (user inventory only)
                  if (/\/child\/data\/userSlots\/\d+\/data\/inventory\//.test(path)) {
                    try {
                      // Apply patch to _fullState
                      const segs = String(p.path || '').split('/').filter(Boolean);
                      const childData = this._fullState && this._fullState.data && this._fullState.data.child && this._fullState.data.child.data ? this._fullState.data.child.data : null;
                      if (childData) {
                        const iUserSlots = segs.indexOf('userSlots');
                        const startIdx = iUserSlots >= 0 ? iUserSlots : 0;
                        const trimmed = segs.slice(startIdx);
                        let parent = childData;
                        for (let i = 0; i < trimmed.length - 1; i++) {
                          const key = trimmed[i];
                          const nextKey = trimmed[i + 1];
                          const keyNum = Number(key);
                          if (Array.isArray(parent) && Number.isFinite(keyNum)) {
                            if (parent[keyNum] === undefined && (p.op === 'add' || p.op === 'replace')) parent[keyNum] = {};
                            parent = parent[keyNum];
                          } else {
                            if (!parent[key]) parent[key] = (key === 'items') ? [] : {};
                            parent = parent[key];
                            const nextNum = Number(nextKey);
                            if (Array.isArray(parent) && Number.isFinite(nextNum) && parent[nextNum] === undefined && (p.op === 'add' || p.op === 'replace')) parent[nextNum] = {};
                          }
                          if (!parent) break;
                        }
                        const last = trimmed[trimmed.length - 1];
                        const idxNum = Number(last);
                        if (parent) {
                          if (p.op === 'add' || p.op === 'replace') {
                            if (Array.isArray(parent) && Number.isFinite(idxNum)) parent[idxNum] = p.value; else parent[last] = p.value;
                          } else if (p.op === 'remove') {
                            if (Array.isArray(parent) && Number.isFinite(idxNum)) parent.splice(idxNum, 1); else delete parent[last];
                          }
                        }
                      }
                      // Update live mirror directly for immediacy
                      try {
                        if (!Array.isArray(this._inventoryItems)) this._inventoryItems = [];
                        let itemsChanged = false;
                        const mIdx = path.match(/\/inventory\/items\/(\d+)/);
                        if (mIdx) {
                          const i = Number(mIdx[1]);
                          if (p.op === 'add') {
                            this._inventoryItems[i] = p.value;
                            itemsChanged = true;
                          } else if (p.op === 'remove') {
                            if (Number.isFinite(i)) this._inventoryItems.splice(i, 1);
                            itemsChanged = true;
                          } else if (p.op === 'replace') {
                            this._inventoryItems[i] = p.value;
                            itemsChanged = true;
                          }
                        }
                        // Whole-array operations: accept 'replace' as authoritative reorder
                        if (/\/inventory\/items$/.test(path) && (p.op === 'replace' || p.op === 'add')) {
                          this._inventoryItems = Array.isArray(p.value) ? JSON.parse(JSON.stringify(p.value)) : [];
                          itemsChanged = true;
                          // For whole-array changes, push full snapshot
                          try { this._postInventoryToServer(this._inventoryItems); } catch (e) {}
                        }
                        // No per-patch server writes; virtual inventory is now driven by explicit API calls on actions
                      } catch (e) {}
                      this._lastInventoryUpdateTs = Date.now();
                      // Notify listeners
                      try { (this._inventoryListeners || []).forEach(fn => { try { fn({ op: p.op, path, value: p.value }); } catch (e) {} }); } catch (e) {}
                    } catch (e) {}
                    continue; // Skip garden processing for inventory patches
                  }
                  
                  // Support both short and long garden paths
                  const m = path.match(/\/(?:garden|child\/data\/userSlots\/\d+\/data\/garden)\/tileObjects\/(\d+)(?:\/(.*))?$/);
                  if (!m) continue;
                  const slotIdx = Number(m[1]);
                  const subPath = m[2] || null; // e.g., "slots/1/startTime" or "slots/1/mutations/0"
                  
                  // Debug: Log garden patches
                  console.log('[MG] Garden patch:', { op: p.op, path, slotIdx, subPath, value: p.value });
                  let pos = this._slotToCoord.has(slotIdx) ? this._slotToCoord.get(slotIdx) : null;
                  // Maintain local mirror of tileObjects for mutation extraction
                  if (p.op === 'add') {
                    // Add entire tile object or specific mutation entry
                    const mmMutAdd = path.match(/\/(?:garden|child\/data\/userSlots\/\d+\/data\/garden)\/tileObjects\/(\d+)\/slots\/(\d+)\/mutations\/(\d+)$/);
                  if (mmMutAdd) {
                      const sIdx = Number(mmMutAdd[1]);
                      const slotIx = Number(mmMutAdd[2]);
                      const mutIx = Number(mmMutAdd[3]);
                      if (this._tileObjects[sIdx]) {
                        if (!Array.isArray(this._tileObjects[sIdx].slots)) this._tileObjects[sIdx].slots = [];
                        if (!this._tileObjects[sIdx].slots[slotIx]) this._tileObjects[sIdx].slots[slotIx] = {};
                        if (!Array.isArray(this._tileObjects[sIdx].slots[slotIx].mutations)) this._tileObjects[sIdx].slots[slotIx].mutations = [];
                        this._tileObjects[sIdx].slots[slotIx].mutations.splice(mutIx, 0, p.value);
                      }
                    this._lastGardenUpdateTs = Date.now();
                  } else if (!subPath) {
                      this._tileObjects[slotIdx] = p.value;
                    this._lastGardenUpdateTs = Date.now();
                    } else {
                      // Generic nested add under tile object (e.g., slots/1/startTime)
                      try {
                        const segs = subPath.split('/');
                        let parent = (this._tileObjects[slotIdx] ||= {});
                        for (let i = 0; i < segs.length - 1; i++) {
                          const key = segs[i];
                          const nextKey = segs[i + 1];
                          const idx = Number(key);
                          if (Array.isArray(parent) && Number.isFinite(idx)) {
                            if (parent[idx] === undefined) parent[idx] = {};
                            parent = parent[idx];
                          } else {
                            // Ensure array containers for known arrays
                            if (key === 'slots' || key === 'mutations') {
                              if (!Array.isArray(parent[key])) parent[key] = [];
                            } else if (!parent[key]) {
                              parent[key] = {};
                            }
                            parent = parent[key];
                            // If next step is a numeric index into an array, ensure element exists
                            const nextIdx = Number(nextKey);
                            if (Array.isArray(parent) && Number.isFinite(nextIdx) && parent[nextIdx] === undefined) {
                              parent[nextIdx] = {};
                            }
                          }
                          if (!parent) break;
                        }
                        if (parent) {
                          const last = segs[segs.length - 1];
                          const idx = Number(last);
                          if (Array.isArray(parent) && Number.isFinite(idx)) parent[idx] = p.value; else parent[last] = p.value;
                        }
                        this._lastGardenUpdateTs = Date.now();
                      } catch (e) {}
                    }
                  } else if (p.op === 'remove') {
                    // Remove entire tile or a specific mutation entry
                    const mmMutRem = path.match(/\/(?:garden|child\/data\/userSlots\/\d+\/data\/garden)\/tileObjects\/(\d+)\/slots\/(\d+)\/mutations\/(\d+)$/);
                    if (mmMutRem) {
                      const sIdx = Number(mmMutRem[1]);
                      const slotIx = Number(mmMutRem[2]);
                      const mutIx = Number(mmMutRem[3]);
                      if (this._tileObjects[sIdx] && this._tileObjects[sIdx].slots && this._tileObjects[sIdx].slots[slotIx] && Array.isArray(this._tileObjects[sIdx].slots[slotIx].mutations)) {
                        this._tileObjects[sIdx].slots[slotIx].mutations.splice(mutIx, 1);
                      }
                      this._lastGardenUpdateTs = Date.now();
                    } else if (!subPath) {
                      delete this._tileObjects[slotIdx];
                      this._lastGardenUpdateTs = Date.now();
                    } else {
                      // Generic nested remove under tile object
                      try {
                        const segs = subPath.split('/');
                        let parent = this._tileObjects[slotIdx];
                        for (let i = 0; i < segs.length - 1; i++) {
                          const key = segs[i];
                          const idx = Number(key);
                          if (Array.isArray(parent) && Number.isFinite(idx)) parent = parent[idx]; else parent = parent && parent[key];
                          if (!parent) break;
                        }
                        if (parent) {
                          const last = segs[segs.length - 1];
                          const idx = Number(last);
                          if (Array.isArray(parent) && Number.isFinite(idx)) parent.splice(idx, 1); else delete parent[last];
                        }
                        this._lastGardenUpdateTs = Date.now();
                      } catch (e) {}
                    }
                  } else if (p.op === 'replace') {
                    // Replace entire tile object
                    if (!subPath) {
                      if (p.value == null) {
                        delete this._tileObjects[slotIdx];
                      } else {
                        this._tileObjects[slotIdx] = p.value;
                      }
                      this._lastGardenUpdateTs = Date.now();
                    } else {
                      // Replace nested path under tile object (covers slots/N, slots/N/mutations, slots/N/startTime, etc.)
                      try {
                        // First, ensure we have the complete tile object from full state
                        if (!this._tileObjects[slotIdx]) {
                          const gameState = this.getGameState();
                          if (gameState?.child?.data?.userSlots?.[0]?.data?.garden?.tileObjects?.[slotIdx]) {
                            this._tileObjects[slotIdx] = JSON.parse(JSON.stringify(gameState.child.data.userSlots[0].data.garden.tileObjects[slotIdx]));
                          }
                        }
                        
                        const segs = subPath.split('/');
                        let parent = (this._tileObjects[slotIdx] ||= {});
                        for (let i = 0; i < segs.length - 1; i++) {
                          const key = segs[i];
                          const nextKey = segs[i + 1];
                          const idx = Number(key);
                          if (Array.isArray(parent) && Number.isFinite(idx)) {
                            if (parent[idx] === undefined) parent[idx] = {};
                            parent = parent[idx];
                          } else {
                            if (key === 'slots' || key === 'mutations') {
                              if (!Array.isArray(parent[key])) parent[key] = [];
                            } else if (!parent[key]) {
                              parent[key] = {};
                            }
                            parent = parent[key];
                            const nextIdx = Number(nextKey);
                            if (Array.isArray(parent) && Number.isFinite(nextIdx) && parent[nextIdx] === undefined) {
                              parent[nextIdx] = {};
                            }
                          }
                          if (!parent) break;
                        }
                        if (parent) {
                          const last = segs[segs.length - 1];
                          const idx = Number(last);
                          if (Array.isArray(parent) && Number.isFinite(idx)) parent[idx] = p.value; else parent[last] = p.value;
                        }
                        this._lastGardenUpdateTs = Date.now();
                      } catch (e) {}
                    }
                  }
                  // Also try to apply patch to cached fullState child.data (best-effort)
                  try {
                    if (this._fullState && this._fullState.data && this._fullState.data.child && this._fullState.data.child.data) {
                      const base = this._fullState.data.child.data;
                      const segs = String(p.path || '').split('/').filter(Boolean); // drop leading ''
                      if (segs[0] === 'garden') {
                        // navigate to parent of target
                        let parent = base;
                        for (let i = 0; i < segs.length - 1; i++) {
                          const key = segs[i];
                          const idx = Number(key);
                          if (Array.isArray(parent) && Number.isFinite(idx)) {
                            parent = parent[idx];
                          } else {
                            if (!parent[key] && p.op === 'add') parent[key] = {};
                            parent = parent[key];
                          }
                          if (!parent) break;
                        }
                        const last = segs[segs.length - 1];
                        if (parent) {
                          if (p.op === 'add' || p.op === 'replace') {
                            const idx = Number(last);
                            if (Array.isArray(parent) && Number.isFinite(idx)) parent[idx] = p.value; else parent[last] = p.value;
                          } else if (p.op === 'remove') {
                            const idx = Number(last);
                            if (Array.isArray(parent) && Number.isFinite(idx)) parent.splice(idx, 1); else delete parent[last];
                          }
                        }
                      }
                    }
                  } catch (e) {}
                  // Do NOT guess: only use explicit cache
                  // If we add a plant/egg object, persist accordingly
                  if (p.op === 'add' && p.value && typeof p.value === 'object') {
                    const v = p.value;
                    const species = v.species || (v.objectType === 'plant' && v.species) || null;
                    const eggName = v.objectType === 'egg' ? (v.egg || v.species || null) : null;
                    if (species && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) await this.addCrop(pos.x, pos.y, String(species));
                    if (eggName && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) await this.addEgg(pos.x, pos.y, String(eggName));
                  }
                  // If tile object is removed, clear crop/egg
                  if (p.op === 'remove') {
                    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
                      // Use removeCrop and removeEgg which automatically set Dirt
                      await this.removeCrop(pos.x, pos.y);
                      await this.removeEgg(pos.x, pos.y);
                    }
                    // clear cache mapping so it can be repopulated next plant
                    this._slotToCoord.delete(slotIdx);
                  }
                } catch (e) { /* ignore malformed patch */ }
              }
            }
            return;
          }
          if (d.type !== 'farmEvent') return;
          const msg = d.msg || {};
          if (Array.isArray(msg.scopePath) && msg.scopePath[1] === 'Quinoa') {
            // Get position once for all operations
            let pos = null;
            try {
              const cur = await this.getCurrentPosition();
              if (cur && cur.pos) {
                pos = { x: Math.round(Number(cur.pos.x)), y: Math.round(Number(cur.pos.y)) };
              }
            } catch (e) {}
            
            // Fallback ONLY to explicit slot mapping if no current position
            if (!pos && Number.isFinite(msg.slot) && this._slotToCoord.has(msg.slot)) {
              pos = this._slotToCoord.get(msg.slot);
            }

            // Define what should happen for each message type
            const shouldAddCrop = msg.type === 'PlantSeed' || msg.type === 'PlantGardenPlant';
            const shouldRemoveCrop = msg.type === 'RemoveGardenObject' || msg.type === 'HarvestCrop' || msg.type === 'PotPlant';
            const shouldAddEgg = msg.type === 'PlantEgg' || msg.type === 'HatchEgg';
            const shouldRemoveEgg = msg.type === 'RemoveGardenObject' || msg.type === 'HatchEgg';

            // Execute actions based on identifiers
            if (shouldAddCrop && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
              const species = msg.species || 'UnknownPlant'; // fallback for PlantGardenPlant
              // When planting a crop, clear any existing egg
              await this._persistEgg(pos.x, pos.y, null);
              await this.addCrop(pos.x, pos.y, species);
            }

            if (shouldRemoveCrop && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
              await this.removeCrop(pos.x, pos.y);
            }

            if (shouldAddEgg && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
              const eggName = msg.egg || msg.species || msg.eggType || msg.eggId;
              if (eggName) {
                // When planting an egg, clear any existing crop (including Dirt)
                await this._persistCrop(pos.x, pos.y, null);
                await this.addEgg(pos.x, pos.y, String(eggName));
              }
            }

            if (shouldRemoveEgg && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
              await this.removeEgg(pos.x, pos.y);
            }

            // Cache slot mapping for all types that have slots
            if (Number.isFinite(msg.slot) && pos) {
              this._slotToCoord.set(msg.slot, pos);
            }
            
            // Clean up slot mapping for removal types
            if (shouldRemoveCrop || shouldRemoveEgg) {
              if (Number.isFinite(msg.slot)) this._slotToCoord.delete(msg.slot);
            }
            try { chrome.runtime.sendMessage({ action: 'wsLog', dir: d.dir, msg }); } catch (e) {}
          }
        } catch (e) {
          console.warn('farm sync error:', e);
        }
      });
    }

    async _persistCrop(x, y, speciesOrNull) {
      try {
        chrome.runtime.sendMessage({ action: 'persistCrop', x, y, crop: speciesOrNull ? String(speciesOrNull) : null }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('persistCrop bg error:', chrome.runtime.lastError.message);
            return;
          }
          if (resp && resp.success) {
            console.log('[MG] crops updated @', x, y, '=>', speciesOrNull || '(removed)');
          } else {
            console.warn('persist crop failed:', resp && resp.error);
          }
        });
      } catch (e) { console.warn('persist crop failed:', e); }
    }

    async _persistEgg(x, y, eggOrNull) {
      try {
        if (!this._eggsEnabled) return;
        chrome.runtime.sendMessage({ action: 'persistEgg', x, y, egg: eggOrNull ? String(eggOrNull) : null }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('persistEgg bg error:', chrome.runtime.lastError.message);
            return;
          }
          if (resp && resp.success) {
            console.log('[MG] eggs updated @', x, y, '=>', eggOrNull || '(removed)');
          } else {
            console.warn('persist egg failed:', resp && resp.error);
          }
        });
      } catch (e) { console.warn('persist egg failed:', e); }
    }

    // Convenience wrappers
    async addCrop(x, y, species) { return this._persistCrop(x, y, species); }
    async removeCrop(x, y) { 
      // When removing a crop, set Dirt instead of null
      return this._persistCrop(x, y, 'Dirt'); 
    }
    async addEgg(x, y, egg) { return this._persistEgg(x, y, egg); }
    async removeEgg(x, y) { 
      // When removing an egg, also set Dirt
      await this._persistCrop(x, y, 'Dirt');
      return this._persistEgg(x, y, null); 
    }

    // Load walls JSON bundled with the extension (default: mg_walls.json)
    async loadWallsFromExtension(filename = 'mg_walls.json') {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
          return { success: false, error: 'chrome.runtime.getURL unavailable in this context' };
        }
        const url = chrome.runtime.getURL(filename);
        const res = await fetch(url);
        const json = await res.json();
        this.setWallsFromJson(json);
        return { success: true, count: Array.isArray(json) ? json.length : 0 };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Load walls from arbitrary URL returning JSON array of {x,y}
    async loadWallsFromUrl(url) {
      try {
        const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
        const json = await res.json();
        this.setWallsFromJson(json);
        return { success: true, count: Array.isArray(json) ? json.length : 0 };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    sendToPage(payload) {
      try {
        window.postMessage(Object.assign({ source: 'mg-extension' }, payload), '*');
      } catch (e) {
        console.error('Failed to postMessage to page script', e);
      }
    }

    moveUp(distance = 1) {
      if (distance > 1) {
        this.move('up', distance);
      } else {
        this.sendToPage({ action: 'triggerKey', key: 'w', code: 'KeyW' });
      }
    }

    moveDown(distance = 1) {
      if (distance > 1) {
        this.move('down', distance);
      } else {
        this.sendToPage({ action: 'triggerKey', key: 's', code: 'KeyS' });
      }
    }

    moveLeft(distance = 1) {
      if (distance > 1) {
        this.move('left', distance);
      } else {
        this.sendToPage({ action: 'triggerKey', key: 'a', code: 'KeyA' });
      }
    }

    moveRight(distance = 1) {
      if (distance > 1) {
        this.move('right', distance);
      } else {
        this.sendToPage({ action: 'triggerKey', key: 'd', code: 'KeyD' });
      }
    }

    // Manually press 'C' N times (default 1) with a small delay for testing
    async pressC(times = 1, delayMs = 100) {
      const n = Math.max(1, Math.floor(Number(times) || 1));
      const delay = Math.max(20, Math.floor(Number(delayMs) || 100));
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      for (let i = 0; i < n; i++) {
        this.sendToPage({ action: 'triggerKey', key: 'c', code: 'KeyC' });
        await sleep(delay);
      }
      return { success: true, pressed: n };
    }

    // Manually press 'X' N times (default 1) with a small delay for testing
    async pressX(times = 1, delayMs = 100) {
      const n = Math.max(1, Math.floor(Number(times) || 1));
      const delay = Math.max(20, Math.floor(Number(delayMs) || 100));
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      for (let i = 0; i < n; i++) {
        this.sendToPage({ action: 'triggerKey', key: 'x', code: 'KeyX' });
        await sleep(delay);
      }
      return { success: true, pressed: n };
    }

    move(direction, distance = 1) {
      // Return a Promise that resolves when the requested steps have been issued.
      const map = {
        up: { key: 'w', code: 'KeyW' },
        down: { key: 's', code: 'KeyS' },
        left: { key: 'a', code: 'KeyA' },
        right: { key: 'd', code: 'KeyD' }
      };

      const entry = map[direction] || map.up;

      // compute a small delay in ms between key events. Respect speed setting.
      // Higher speed -> smaller delay. Clamp to a safe minimum.
      const base = 120; // ms
      const delayMs = Math.max(20, Math.round(base - (this.speed || 10) * 2));

      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

      // If single step, issue one event and resolve immediately
      if (!distance || distance <= 1) {
        this.sendToPage({ action: 'triggerKey', key: entry.key, code: entry.code });
        return Promise.resolve();
      }

      // For multi-step, send steps sequentially with delay
      return (async () => {
        for (let i = 0; i < distance; i++) {
          this.sendToPage({ action: 'triggerKey', key: entry.key, code: entry.code });
          await sleep(delayMs);
        }
      })();
    }

    // Returns true if the coordinate is not a wall and inside bounds
    _isWalkable(x, y) {
      if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false;
      const key = x + ',' + y;
      return !__mg_walls.has(key);
    }

    // Build shortest path using BFS from start to goal, avoiding walls
    // Returns array of points [{x,y}, ...] including start and goal, or null if unreachable
    _bfsShortestPath(start, goal) {
      const startKey = start.x + ',' + start.y;
      const goalKey = goal.x + ',' + goal.y;
      if (startKey === goalKey) return [start];

      const queue = [];
      const visited = new Set();
      const parent = new Map(); // key -> parentKey

      const push = (p) => { queue.push(p); visited.add(p.x + ',' + p.y); };
      if (!this._isWalkable(start.x, start.y)) return null;
      if (!this._isWalkable(goal.x, goal.y)) return null;
      push(start);

      const dirs = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 }
      ];

      while (queue.length) {
        const cur = queue.shift();
        const ckey = cur.x + ',' + cur.y;
        if (ckey === goalKey) {
          // reconstruct path
          const path = [];
          let k = ckey;
          while (k) {
            const parts = k.split(',');
            path.push({ x: Number(parts[0]), y: Number(parts[1]) });
            k = parent.get(k) || null;
          }
          path.reverse();
          return path;
        }
        for (const d of dirs) {
          const nx = cur.x + d.dx;
          const ny = cur.y + d.dy;
          const nkey = nx + ',' + ny;
          if (!visited.has(nkey) && this._isWalkable(nx, ny)) {
            parent.set(nkey, ckey);
            push({ x: nx, y: ny });
          }
        }
      }
      return null;
    }

    // helper: compute delay between steps based on speed
    _getStepDelay() {
      const base = 120;
      return Math.max(30, Math.round(base - (this.speed || 10) * 2));
    }

    // helper: send one step in dir and verify axis changed by expectedDelta (1 or -1)
    async _stepAndVerify(dir, axis, expectedDelta, prevValue, retries = 2, pauseMs = null) {
      const map = { up: { key: 'w', code: 'KeyW' }, down: { key: 's', code: 'KeyS' }, left: { key: 'a', code: 'KeyA' }, right: { key: 'd', code: 'KeyD' } };
      const entry = map[dir] || map.right;
      pauseMs = pauseMs || this._getStepDelay();

      for (let attempt = 0; attempt <= retries; attempt++) {
        // send the key
        this.sendToPage({ action: 'triggerKey', key: entry.key, code: entry.code });
        // wait for server/game to update
        await new Promise(r => setTimeout(r, pauseMs));
        // read current position
        try {
          const resp = await this.getCurrentPosition();
          const pos = resp && resp.pos;
          if (pos && typeof pos[axis] === 'number') {
            const rounded = Math.round(Number(pos[axis]));
            if (rounded === Math.round(Number(prevValue)) + expectedDelta) {
              return { success: true, pos: pos };
            }
          }
        } catch (e) {}
        // if not matched, retry (loop)
      }
      return { success: false, error: 'verify-failed' };
    }

    // Move the player to a specific grid coordinate using shortest path (BFS) that avoids walls.
    // Accepts optional options: { wallsJson: [{x,y},...], bounds: {minX,maxX,minY,maxY} }
    // Returns { success, pos, path } or { success:false, error }
    async moveTo(targetX, targetY, options) {
      options = options || {};
      // Optionally accept a walls JSON list to override current walls
      if (Array.isArray(options.wallsJson)) {
        try { this.setWallsFromJson(options.wallsJson); } catch (e) {}
      }
      // Optionally override grid bounds
      if (options.bounds) {
        const b = options.bounds;
        if (typeof b.minX === 'number') this.minX = b.minX;
        if (typeof b.maxX === 'number') this.maxX = b.maxX;
        if (typeof b.minY === 'number') this.minY = b.minY;
        if (typeof b.maxY === 'number') this.maxY = b.maxY;
      }

      // clamp target to bounds
      targetX = Math.max(this.minX, Math.min(this.maxX, Math.round(Number(targetX))));
      targetY = Math.max(this.minY, Math.min(this.maxY, Math.round(Number(targetY))));

      // get current position
      const curResp = await this.getCurrentPosition();
      if (!curResp || !curResp.success || !curResp.pos) {
        return { success: false, error: 'current-position-unavailable', pos: curResp && curResp.pos ? curResp.pos : null };
      }
      const cur = { x: Math.round(Number(curResp.pos.x)), y: Math.round(Number(curResp.pos.y)) };
      const goal = { x: targetX, y: targetY };

      // Build path with BFS avoiding walls
      const path = this._bfsShortestPath(cur, goal);
      if (!path || path.length === 0) {
        return { success: false, error: 'unreachable-target' };
      }

      // Follow the path step-by-step, verifying movement
      // Path includes current position as first node; skip index 0
      for (let i = 1; i < path.length; i++) {
        const prev = path[i - 1];
        const next = path[i];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        let dir, axis, delta, prevAxisVal;
        if (dx === 1 && dy === 0) { dir = 'right'; axis = 'x'; delta = 1; prevAxisVal = prev.x; }
        else if (dx === -1 && dy === 0) { dir = 'left'; axis = 'x'; delta = -1; prevAxisVal = prev.x; }
        else if (dx === 0 && dy === 1) { dir = 'down'; axis = 'y'; delta = 1; prevAxisVal = prev.y; }
        else if (dx === 0 && dy === -1) { dir = 'up'; axis = 'y'; delta = -1; prevAxisVal = prev.y; }
        else {
          return { success: false, error: 'invalid-path-step', stepIndex: i, prev: prev, next: next };
        }
        const res = await this._stepAndVerify(dir, axis, delta, prevAxisVal, 2, null);
        if (!res || !res.success) {
          return { success: false, error: 'step-failed', stepIndex: i, attemptedDir: dir };
        }
      }

      const final = await this.getCurrentPosition();
      return { success: true, pos: final && final.pos ? final.pos : goal, path };
    }

    // Move horizontally by delta steps: positive => right, negative => left
    async moveX(delta) {
      const n = Math.round(Number(delta) || 0);
      if (n === 0) return { success: true, pos: await this.getCurrentPosition().then(r => r.pos || null) };
      const dir = n > 0 ? 'right' : 'left';

      // get current pos
      const curResp = await this.getCurrentPosition();
      if (!curResp || !curResp.success || !curResp.pos) return { success: false, error: 'current-position-unavailable' };
      let curX = curResp.pos.x;
      const sign = n > 0 ? 1 : -1;
      for (let i = 0; i < Math.abs(n); i++) {
        const res = await this._stepAndVerify(dir, 'x', sign, curX, 2, null);
        if (!res || !res.success) return { success: false, error: 'moveX-stuck', stepIndex: i, pos: res && res.pos ? res.pos : { x: curX } };
        curX = res.pos.x;
      }
      const final = await this.getCurrentPosition();
      return { success: true, pos: final && final.pos ? final.pos : null };
    }

    // Move vertically by delta steps: positive => down, negative => up
    async moveY(delta) {
      const n = Math.round(Number(delta) || 0);
      if (n === 0) return { success: true, pos: await this.getCurrentPosition().then(r => r.pos || null) };
      const dir = n > 0 ? 'down' : 'up';

      const curResp = await this.getCurrentPosition();
      if (!curResp || !curResp.success || !curResp.pos) return { success: false, error: 'current-position-unavailable' };
      let curY = curResp.pos.y;
      const sign = n > 0 ? 1 : -1;
      for (let i = 0; i < Math.abs(n); i++) {
        const res = await this._stepAndVerify(dir, 'y', sign, curY, 2, null);
        if (!res || !res.success) return { success: false, error: 'moveY-stuck', stepIndex: i, pos: res && res.pos ? res.pos : { y: curY } };
        curY = res.pos.y;
      }
      const final = await this.getCurrentPosition();
      return { success: true, pos: final && final.pos ? final.pos : null };
    }

    setSpeed(speed) { this.speed = Math.max(1, Math.min(50, speed)); }
    getSpeed() { return this.speed; }

    testConnection() {
      // Ask the page script to reply; the page script will post a page->window message
      return new Promise((resolve) => {
        const respHandler = (ev) => {
          if (ev.data && ev.data.source === 'mg-extension-page' && ev.data.type === 'testResponse') {
            window.removeEventListener('message', respHandler);
            resolve({ success: true, debug: ev.data });
          }
        };
        window.addEventListener('message', respHandler);
        this.sendToPage({ action: 'testConnection' });
        // timeout
        setTimeout(() => { window.removeEventListener('message', respHandler); resolve({ success: false, error: 'timeout' }); }, 1500);
      });
    }

    getPlayerPosition() {
      // Best-effort async request to the page script which will try to discover x/y
      return new Promise((resolve) => {
        const handler = (ev) => {
          if (ev.data && ev.data.source === 'mg-extension-page' && ev.data.type === 'playerPosition') {
            window.removeEventListener('message', handler);
            resolve({ success: true, pos: ev.data.pos });
          }
        };
        window.addEventListener('message', handler);
        this.sendToPage({ action: 'getPlayerPosition' });
        // fallback timeout
        setTimeout(() => { window.removeEventListener('message', handler); resolve({ success: false, error: 'timeout' }); }, 1200);
      });
    }

    // Friendly alias: attempts a synchronous read via the injected page API if present,
    // otherwise falls back to the async postMessage-based getPlayerPosition().
    getCurrentPosition() {
      try {
        if (window.MagicGardenPageAPI && typeof window.MagicGardenPageAPI.getPlayerPosition === 'function') {
          const pos = window.MagicGardenPageAPI.getPlayerPosition();
          return Promise.resolve({ success: true, pos: pos });
        }
      } catch (e) {
        // ignore and fall through to async method
      }
      return this.getPlayerPosition();
    }

    test() {
      console.log('Testing Magic Garden API (content script)...');
      return 'API test invoked';
    }

    // Return last known game state (Welcome.fullState mirrored + subsequent PartialState applied best-effort)
    getGameState() {
      try {
        return this._fullState ? JSON.parse(JSON.stringify(this._fullState)) : null;
      } catch (e) {
        return null;
      }
    }

    // Return the entire garden tileObjects plane (all 200 slots)
    getGarden() {
      try {
        const gameState = this.getGameState();
        if (!gameState) return null;
        return gameState.child.data.userSlots[0].data.garden.tileObjects;
      } catch (e) {
        console.error('[MG] getGarden error:', e);
        return null;
      }
    }

    // Return the raw crop/tile object at a given slot number (0..199)
    // Uses full state directly for consistency
    getCrop(slotNumber) {
      try {
        const slot = Number(slotNumber);
        if (!Number.isFinite(slot) || slot < 0 || slot > 199) return null;

        // Use full state directly for consistency
        const gameState = this.getGameState();
        if (!gameState || !gameState.child || !gameState.child.data || !gameState.child.data.userSlots || !gameState.child.data.userSlots[0]) {
          return null;
        }
        
        const tileObjects = gameState.child.data.userSlots[0].data.garden.tileObjects;
        if (!tileObjects || typeof tileObjects !== 'object') return null;
        
        const t = tileObjects[String(slot)] || tileObjects[slot];
        if (t) return JSON.parse(JSON.stringify(t));
        return null;
      } catch (e) {
        return null;
      }
    }

    // Return all slot numbers that contain the given crop species (case-insensitive)
    getSlotOf(cropName) {
      try {
        const name = String(cropName || '').trim();
        if (!name) return { success: false, error: 'Crop name cannot be empty' };
        const target = name.toLowerCase();

        const garden = this.getGarden();
        if (!garden || typeof garden !== 'object') {
          return { success: false, error: 'No garden data available' };
        }

        const result = [];
        const keys = Object.keys(garden);
        for (const k of keys) {
          const slotNumber = Number(k);
          if (!Number.isFinite(slotNumber)) continue;
          const tile = garden[k];
          if (!tile) continue;

          let found = false;
          // Tile-level species
          if (tile.species && String(tile.species).toLowerCase() === target) {
            found = true;
          }
          // Slot-level species
          if (!found && Array.isArray(tile.slots)) {
            for (const s of tile.slots) {
              if (s && s.species && String(s.species).toLowerCase() === target) {
                found = true; break;
              }
            }
          }
          if (found) result.push(slotNumber);
        }

        return { success: true, crop: name, slots: result, count: result.length };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Helper: get garden object from fullState
    _getGarden() {
      try {
        const fs = this._fullState;
        if (!fs) return null;
        // The garden data is in userSlots[0].data.garden, not child.data.garden
        const userSlots = fs && fs.data && fs.data.child && fs.data.child.data && fs.data.child.data.userSlots;
        if (Array.isArray(userSlots) && userSlots[0] && userSlots[0].data && userSlots[0].data.garden) {
          return userSlots[0].data.garden;
        }
        return null;
      } catch (e) {
        return null;
      }
    }

    // Prefer live mirror of tileObjects kept fresh via WS patches; fallback to fullState
    _getLiveTileObjects() {
      try {
        if (this._tileObjects && Object.keys(this._tileObjects).length > 0) return this._tileObjects;
        const garden = this._getGarden();
        if (garden && garden.tileObjects && typeof garden.tileObjects === 'object') return garden.tileObjects;
        const fs = this.getGameState();
        const us0 = fs && fs.child && fs.child.data && fs.child.data.userSlots && Array.isArray(fs.child.data.userSlots)
          ? fs.child.data.userSlots[0] : null;
        const to = us0 && us0.data && us0.data.garden && us0.data.garden.tileObjects;
        return to || {};
      } catch (e) {
        return {};
      }
    }

    // Extract mutations for a crop at coordinate (x,y) using slot mapping:
    // - Slots cover rectangle x:[4..13] and [15..24] (skip x==14), y:[4..13]
    // - Row-major; slot 0 => (4,4); slot 9 => (13,4); slot 10 => (15,4); slot 199 => (24,13)
    extractMutations(x, y) {
      // For backward-compatibility with the earlier name, return the tile object for (x,y)
      return this.getTileByCoord(x, y);
    }

    // Extract mutations by slot number (0-199) - simple and direct
    extractMutationsBySlot(n) {
      try {
        const slot = Number(n);
        if (!Number.isFinite(slot)) return null;
        const live = this._getLiveTileObjects();
        const fromLive = live && (live[String(slot)] || live[slot]);
        if (fromLive) return fromLive;
        const gameState = this.getGameState();
        if (!gameState) return null;
        const us0 = gameState.child && gameState.child.data && gameState.child.data.userSlots && gameState.child.data.userSlots[0];
        const tobj = us0 && us0.data && us0.data.garden && us0.data.garden.tileObjects && (us0.data.garden.tileObjects[String(slot)] || us0.data.garden.tileObjects[slot]);
        return tobj || null;
      } catch (e) {
        console.error('[MG] extractMutationsBySlot error:', e);
        return null;
      }
    }

    // Aggregate mutations across all slots for a given slot index
    getMutationsBySlot(slotNumber) {
      try {
        const tile = this.extractMutationsBySlot(slotNumber);
        if (!tile || !Array.isArray(tile.slots)) return [];
        const out = [];
        for (let i = 0; i < tile.slots.length; i++) {
          const s = tile.slots[i] || {};
          if (Array.isArray(s.mutations) && s.mutations.length) out.push(...s.mutations.map(String));
        }
        return out;
      } catch (e) {
        console.error('[MG] getMutationsBySlot error:', e);
        return [];
      }
    }

    // Aggregate mutations by coordinate (x,y)
    getMutationsAt(x, y) {
      const slot = this.coordToSlot(x, y);
      if (slot == null) return [];
      return this.getMutationsBySlot(slot);
    }

    // Detailed: list each tile-entry's mutations with its index and context (by slot number)
    getMutationEntriesBySlot(slotNumber) {
      try {
        const tile = this.extractMutationsBySlot(slotNumber);
        if (!tile || !Array.isArray(tile.slots)) return [];
        const details = [];
        for (let i = 0; i < tile.slots.length; i++) {
          const s = tile.slots[i] || {};
          details.push({
            slotIndex: i,
            mutations: Array.isArray(s.mutations) ? s.mutations.map(String) : [],
            species: s.species || tile.species || null,
            startTime: s.startTime || null,
            endTime: s.endTime || null,
            targetScale: s.targetScale || null
          });
        }
        return details;
      } catch (e) {
        console.error('[MG] getMutationEntriesBySlot error:', e);
        return [];
      }
    }

    // Detailed: list each tile-entry's mutations with its index and context (by coordinate)
    getMutationEntriesAt(x, y) {
      const slot = this.coordToSlot(x, y);
      if (slot == null) return [];
      return this.getMutationEntriesBySlot(slot);
    }

    // Wait for the next garden update (PartialState patch touching tileObjects or Garden* event)
    async waitForGardenUpdate(options = {}) {
      const { slotIndex = null, timeoutMs = 800 } = options;
      return new Promise((resolve) => {
        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          try { window.removeEventListener('message', onMsg); } catch (e) {}
          try { clearTimeout(timer); } catch (e) {}
        };
        const onMsg = (ev) => {
          try {
            const d = ev && ev.data;
            if (!d || d.source !== 'mg-extension-page') return;
            if (d.type !== 'wsAll' || d.dir !== 'in') return;
            const msg = d.msg;
            if (!msg) return;
            if (msg.type === 'GardenStateUpdated' || msg.type === 'GardenObjectPlaced' || msg.type === 'GardenObjectRemoved') {
              cleanup();
              resolve(true);
              return;
            }
            if (msg.type === 'PartialState' && Array.isArray(msg.patches)) {
              for (const p of msg.patches) {
                const path = String(p.path || '');
                const m = path.match(/\/(?:garden|child\/data\/userSlots\/\d+\/data\/garden)\/tileObjects\/(\d+)/);
                if (m) {
                  const sIdx = Number(m[1]);
                  if (slotIndex == null || sIdx === Number(slotIndex)) {
                    cleanup();
                    resolve(true);
                    return;
                  }
                }
              }
            }
          } catch (e) {}
        };
        window.addEventListener('message', onMsg);
        const timer = setTimeout(() => { cleanup(); resolve(false); }, Math.max(100, Number(timeoutMs) || 800));
      });
    }
    // Fresh variants that wait for a garden update affecting the target slot
    async getMutationEntriesAtFresh(x, y, options = {}) {
      const slot = this.coordToSlot(x, y);
      if (slot == null) return [];
      await this.waitForGardenUpdate({ slotIndex: slot, timeoutMs: options.timeoutMs || 800 });
      
      // Debug: Log what we're getting from live mirror vs full state
      console.log('[MG] getMutationEntriesAtFresh debug:', {
        slot,
        liveMirror: this._tileObjects[slot],
        fullState: this.getGameState()?.child?.data?.userSlots?.[0]?.data?.garden?.tileObjects?.[slot]
      });
      
      return this.getMutationEntriesBySlot(slot);
    }

    // Harvest a crop at coordinate (x,y), selecting the specific tile entry index by pressing 'c' N times, then 'space'
    // tileEntryIndex: 0-based index within the tile's slots array
    // options: { delayMs?: number } delay between key presses (default ~100ms)
    async harvestCropAt(x, y, tileEntryIndex = 0, options) {
      try {
        // Convert coordinates to slot number
        const slotNumber = this.coordToSlot(x, y);
        if (slotNumber === null) {
          return { success: false, error: 'Invalid coordinates', x, y, tileEntryIndex };
        }
        
        // Send HarvestCrop WebSocket message directly
        const message = {
          scopePath: ["Room", "Quinoa"],
          type: "HarvestCrop",
          slot: slotNumber,
          slotsIndex: tileEntryIndex
        };
        
        await this.sendWebSocketMessage(message);
        try { fetch(this._inventoryServerBase + '/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'HarvestCropSent', slot: slotNumber, slotsIndex: tileEntryIndex }) }); } catch (e) {}
        // Proactively push current mirror to server shortly after harvest; inventory add patches will update mirror
        try {
          setTimeout(() => { try { this._postInventoryToServer(this._inventoryItems); } catch (e) {} }, 400);
        } catch (e) {}
        return { success: true, x: Math.round(Number(x)), y: Math.round(Number(y)), slotNumber, slotsIndex: tileEntryIndex, message };
      } catch (e) {
        return { success: false, error: String(e), x, y, tileEntryIndex };
      }
    }

    // Convenience: harvest by garden slot index (0..199) and tile entry index
    async harvestCropBySlot(slotIndex, tileEntryIndex = 0, options) {
      const coord = this.slotToCoord(slotIndex);
      if (!coord) return { success: false, error: 'invalid-slot' };
      return this.harvestCropAt(coord.x, coord.y, tileEntryIndex, options);
    }

    // Travel functions to various locations
    async travelToGarden() {
      return this.moveToWithPath(14, 14);
    }

    async travelToCropShop() {
      return this.moveToWithPath(35, 20);
    }

    async travelToCropSeller() {
      return this.moveToWithPath(44, 20);
    }

    async travelToJournal() {
      return this.moveToWithPath(48, 19);
    }

    async travelToPetSeller() {
      return this.moveToWithPath(44, 19);
    }

    async travelToEggShop() {
      return this.moveToWithPath(35, 19);
    }

    async travelToToolShop() {
      return this.moveToWithPath(31, 20);
    }

    async travelToDecorShop() {
      return this.moveToWithPath(31, 19);
    }

    // Send a WebSocket message directly to the game server
    async sendWebSocketMessage(message) {
      try {
        // Send to the page script which will forward to WebSocket
        this.sendToPage({ 
          action: 'sendWebSocketMessage', 
          message: message 
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Convenience function to purchase seeds
    async purchaseSeed(species) {
      const message = {
        scopePath: ["Room", "Quinoa"],
        type: "PurchaseSeed",
        species: species
      };
      return this.sendWebSocketMessage(message);
    }

    // Convenience function to purchase eggs
    async purchaseEgg(eggId) {
      const message = {
        scopePath: ["Room", "Quinoa"],
        type: "PurchaseEgg",
        eggId: eggId
      };
      return this.sendWebSocketMessage(message);
    }

    // Convenience function to sell all crops
    async sellAllCrops() {
      const message = {
        scopePath: ["Room", "Quinoa"],
        type: "SellAllCrops"
      };
      return this.sendWebSocketMessage(message);
    }

    // Force resync by closing the active WebSocket so the game reconnects and sends a fresh Welcome
    async forceResync() {
      try {
        this.sendToPage({ action: 'forceReconnectWS' });
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Reselect Quinoa to trigger a state refresh
    async reselectQuinoa() {
      try {
        await this.sendWebSocketMessage({ scopePath: ["Room"], type: "VoteForGame", gameName: "Quinoa" });
        await this.sendWebSocketMessage({ scopePath: ["Room"], type: "SetSelectedGame", gameName: "Quinoa" });
        return { success: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Pet monitoring system
    startPetMonitoring(options = {}) {
      const { logInterval = 10000, lowHungerThreshold = 1000 } = options; // 10 second intervals, 1000 hunger threshold
      
      if (this._petMonitorInterval) {
        clearInterval(this._petMonitorInterval);
      }
      
      this._petMonitorInterval = setInterval(() => {
        try {
          // Use live pet data cache instead of full state
          const petSlots = this._petData.petSlots || {};
          const petSlotInfos = this._petData.petSlotInfos || {};
          
          // If no live data, fallback to full state
          if (Object.keys(petSlots).length === 0) {
            const gameState = this.getGameState();
            if (gameState && gameState.child && gameState.child.data && gameState.child.data.userSlots && gameState.child.data.userSlots[0]) {
              const fallbackPetSlots = gameState.child.data.userSlots[0].data.petSlots || {};
              const fallbackPetSlotInfos = gameState.child.data.userSlots[0].petSlotInfos || {};
              
              console.log('[MG] Pet Hunger Status (from full state):');
              Object.keys(fallbackPetSlots).forEach(slotIndex => {
                const pet = fallbackPetSlots[slotIndex];
                const petInfo = fallbackPetSlotInfos[pet.id] || {};
                const hunger = pet.hunger || 0;
                const xp = pet.xp || 0;
                const position = petInfo.position || { x: 0, y: 0 };
                
                const status = hunger < lowHungerThreshold ? '🔴 LOW' : '🟢 OK';
                const petIdShort = pet && pet.id ? String(pet.id).slice(0, 8) : 'unknown';
                console.log(`  Pet ${slotIndex} (${petIdShort}...): Hunger ${hunger.toFixed(1)} ${status} | XP ${xp} | Pos (${position.x}, ${position.y})`);
              });
              return;
            }
          }
          
          console.log('[MG] Pet Hunger Status (live data):');
          Object.keys(petSlots).forEach(slotIndex => {
            const pet = petSlots[slotIndex];
            const petInfo = petSlotInfos[pet.id] || {};
            const hunger = pet.hunger || 0;
            const xp = pet.xp || 0;
            const position = petInfo.position || { x: 0, y: 0 };
            
            const status = hunger < lowHungerThreshold ? '🔴 LOW' : '🟢 OK';
            const petIdShort = pet && pet.id ? String(pet.id).slice(0, 8) : 'unknown';
            console.log(`  Pet ${slotIndex} (${petIdShort}...): Hunger ${hunger.toFixed(1)} ${status} | XP ${xp} | Pos (${position.x}, ${position.y})`);
          });
        } catch (e) {
          console.error('[MG] Pet monitoring error:', e);
        }
      }, logInterval);
      
      console.log(`[MG] Pet monitoring started (${logInterval}ms intervals, low hunger threshold: ${lowHungerThreshold})`);
      return { success: true, interval: logInterval, threshold: lowHungerThreshold };
    }

    stopPetMonitoring() {
      if (this._petMonitorInterval) {
        clearInterval(this._petMonitorInterval);
        this._petMonitorInterval = null;
        console.log('[MG] Pet monitoring stopped');
        return { success: true };
      }
      return { success: false, message: 'No monitoring active' };
    }

    getPetStatus() {
      try {
        // Try live pet data first
        const petSlots = this._petData.petSlots || {};
        const petSlotInfos = this._petData.petSlotInfos || {};
        
        // If no live data, fallback to full state
        if (Object.keys(petSlots).length === 0) {
          const gameState = this.getGameState();
          if (!gameState || !gameState.child || !gameState.child.data || !gameState.child.data.userSlots || !gameState.child.data.userSlots[0]) {
            return { success: false, error: 'No game state available' };
          }
          
          const fallbackPetSlots = gameState.child.data.userSlots[0].data.petSlots || {};
          const fallbackPetSlotInfos = gameState.child.data.userSlots[0].petSlotInfos || {};
          
          const pets = [];
          Object.keys(fallbackPetSlots).forEach(slotIndex => {
            const pet = fallbackPetSlots[slotIndex];
            const petInfo = fallbackPetSlotInfos[pet.id] || {};
            pets.push({
              slot: Number(slotIndex),
              id: pet.id,
              hunger: pet.hunger || 0,
              xp: pet.xp || 0,
              position: petInfo.position || { x: 0, y: 0 }
            });
          });
          
          return { success: true, pets, count: pets.length, source: 'fullState' };
        }
        
        const pets = [];
        Object.keys(petSlots).forEach(slotIndex => {
          const pet = petSlots[slotIndex];
          const petInfo = petSlotInfos[pet.id] || {};
          pets.push({
            slot: Number(slotIndex),
            id: pet.id,
            hunger: pet.hunger || 0,
            xp: pet.xp || 0,
            position: petInfo.position || { x: 0, y: 0 }
          });
        });
        
        return { success: true, pets, count: pets.length, source: 'liveData' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Get pet ID from pet slot number (0-2)
    getPetId(slotNumber) {
      try {
        const slot = Number(slotNumber);
        if (!Number.isFinite(slot) || slot < 0 || slot > 2) {
          return { success: false, error: 'Invalid slot number. Must be 0, 1, or 2' };
        }

        // Try live pet data first
        const petSlots = this._petData.petSlots || {};
        if (petSlots[slot] && petSlots[slot].id) {
          return { success: true, petId: petSlots[slot].id, slot, source: 'liveData' };
        }

        // Fallback to full state
        const gameState = this.getGameState();
        if (!gameState || !gameState.child || !gameState.child.data || !gameState.child.data.userSlots || !gameState.child.data.userSlots[0]) {
          return { success: false, error: 'No game state available' };
        }

        const petSlotsFromState = gameState.child.data.userSlots[0].data.petSlots || {};
        if (petSlotsFromState[slot] && petSlotsFromState[slot].id) {
          return { success: true, petId: petSlotsFromState[slot].id, slot, source: 'fullState' };
        }

        return { success: false, error: 'No pet found in slot ' + slot };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Pet diet management functions
    loadPetDiets() {
      try {
        const stored = localStorage.getItem('mg_pet_diets');
        return stored ? JSON.parse(stored) : {};
      } catch (e) {
        console.error('[MG] Failed to load pet diets:', e);
        return {};
      }
    }

    savePetDiets(diets) {
      try {
        localStorage.setItem('mg_pet_diets', JSON.stringify(diets));
        return { success: true };
      } catch (e) {
        console.error('[MG] Failed to save pet diets:', e);
        return { success: false, error: String(e) };
      }
    }

    getPetDiet(petId) {
      try {
        const diets = this.loadPetDiets();
        return diets[petId] || null;
      } catch (e) {
        console.error('[MG] Failed to get pet diet:', e);
        return null;
      }
    }

    // Get pet diet as array (for multiple crops)
    getPetDietArray(petId) {
      try {
        const diets = this.loadPetDiets();
        const diet = diets[petId];
        if (Array.isArray(diet)) {
          return diet;
        } else if (typeof diet === 'string') {
          // Handle legacy single diet format
          return [diet];
        }
        return [];
      } catch (e) {
        console.error('[MG] Failed to get pet diet array:', e);
        return [];
      }
    }

    setPetDiet(petId, diet) {
      try {
        const diets = this.loadPetDiets();
        // Handle both single diet and array of diets
        if (Array.isArray(diet)) {
          diets[petId] = diet;
        } else {
          diets[petId] = [diet];
        }
        return this.savePetDiets(diets);
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Add multiple diets to a pet
    addPetDiets(petId, newDiets) {
      try {
        const diets = this.loadPetDiets();
        const existingDiets = diets[petId] || [];
        const combinedDiets = [...new Set([...existingDiets, ...newDiets])]; // Remove duplicates
        diets[petId] = combinedDiets;
        return this.savePetDiets(diets);
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Remove specific diets from a pet
    removePetDiets(petId, dietsToRemove) {
      try {
        const diets = this.loadPetDiets();
        const existingDiets = diets[petId] || [];
        const filteredDiets = existingDiets.filter(diet => !dietsToRemove.includes(diet));
        diets[petId] = filteredDiets;
        return this.savePetDiets(diets);
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Get diet for a pet by slot number
    getPetDietBySlot(slotNumber) {
      try {
        const petResult = this.getPetId(slotNumber);
        if (!petResult.success) {
          return { success: false, error: petResult.error };
        }
        
        const dietArray = this.getPetDietArray(petResult.petId);
        return { 
          success: true, 
          petId: petResult.petId, 
          diet: dietArray, 
          dietString: dietArray.join(', '),
          slot: slotNumber 
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Get all pets with their diets
    getAllPetDiets() {
      try {
        const petStatus = this.getPetStatus();
        if (!petStatus.success) {
          return { success: false, error: petStatus.error };
        }

        const diets = this.loadPetDiets();
        const petsWithDiets = petStatus.pets.map(pet => {
          const dietArray = this.getPetDietArray(pet.id);
          return {
            slot: pet.slot,
            petId: pet.id,
            diet: dietArray,
            dietString: dietArray.join(', '),
            hunger: pet.hunger,
            xp: pet.xp,
            position: pet.position
          };
        });

        return { success: true, pets: petsWithDiets };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Search inventory for items matching a crop name
    getItemFromInventory(crop) {
      try {
        const cropName = String(crop).trim();
        if (!cropName) {
          return { success: false, error: 'Crop name cannot be empty' };
        }

        // Prefer reading from the virtual inventory JSON managed by app.py
        // Fallback to live in-memory mirror if the server is unavailable
        const readFromServer = async () => {
          try {
            const resp = await fetch(this._inventoryServerBase + '/api/inventory', { cache: 'no-cache' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const items = await resp.json();
            return Array.isArray(items) ? items : [];
          } catch (e) {
            return null;
          }
        };

        const buildMatches = (items) => {
          const matchingItems = [];
          items.forEach((item, index) => {
          if (!item || typeof item !== 'object') return;

          // Check different item types for species/crop name
          let itemSpecies = null;
          let itemType = item.itemType || 'Unknown';

          if (item.species) {
            // Seeds, Plants, Produce use 'species'
            itemSpecies = item.species;
          } else if (item.toolId) {
            // Tools use 'toolId'
            itemSpecies = item.toolId;
          } else if (item.decorId) {
            // Decorations use 'decorId'
            itemSpecies = item.decorId;
          } else if (item.eggId) {
            // Eggs use 'eggId'
            itemSpecies = item.eggId;
          } else if (item.petSpecies) {
            // Pets use 'petSpecies'
            itemSpecies = item.petSpecies;
          }

          // Check if the species matches (case-insensitive)
          if (itemSpecies && String(itemSpecies).toLowerCase() === cropName.toLowerCase()) {
            matchingItems.push({
              index: index,
              item: item,
              species: itemSpecies,
              type: itemType,
              quantity: item.quantity || 1,
              id: item.id || null,
              mutations: item.mutations || null,
              scale: item.scale || null,
              plantedAt: item.plantedAt || null,
              slots: item.slots || null
            });
          }
        });
          return matchingItems;
        };

        const run = async () => {
          const serverItems = await readFromServer();
          const itemsToUse = serverItems || this._inventoryItems || [];
          const matchingItems = buildMatches(itemsToUse);
          return {
            success: true,
            crop: cropName,
            matches: matchingItems,
            totalFound: matchingItems.length,
            inventorySize: itemsToUse.length,
            source: serverItems ? 'server' : 'liveMirror'
          };
        };

        return run();
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Helper: read server inventory (returns array or null on failure)
    async _readServerInventory() {
      try {
        const resp = await fetch(this._inventoryServerBase + '/api/inventory', { cache: 'no-cache' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return Array.isArray(data) ? data : [];
      } catch (e) { return null; }
    }

    // Helper: compact a possibly sparse items array into a dense list of valid item objects
    _compactItems(items) {
      try {
        if (!Array.isArray(items)) return [];
        const out = [];
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          // Treat as valid if it looks like any known inventory object
          if (it.id || it.species || it.itemType || it.toolId || it.decorId || it.eggId || it.petSpecies) {
            out.push(it);
          }
        }
        return out;
      } catch (e) { return []; }
    }

    // Helper: post full items list to server (skips empty lists)
    async _postInventoryToServer(items) {
      try {
        const compact = this._compactItems(items);
        if (compact.length === 0) return false;
        await fetch(this._inventoryServerBase + '/api/inventory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: compact })
        });
        return true;
      } catch (e) { return false; }
    }

    // Removed granular per-index server ops; we now update on action boundaries only

    // Public helper to force-write current in-memory inventory to server (if non-empty)
    async pushInventoryToServer() {
      try {
        const items = Array.isArray(this._inventoryItems) ? this._inventoryItems : [];
        const ok = await this._postInventoryToServer(items);
        return { success: ok };
      } catch (e) { return { success: false, error: String(e) }; }
    }

    // Directly write the current game state's inventory.items to the server JSON
    // options: { compact?: boolean } when true, filters out nulls/invalid entries
    // Always completely overwrites mg_inventory.json regardless of current contents
    async saveInventoryFromGameState(options = {}) {
      try {
        const compact = !!options.compact;
        const gs = this.getGameState();
        const us0 = gs && gs.child && gs.child.data && gs.child.data.userSlots && Array.isArray(gs.child.data.userSlots)
          ? gs.child.data.userSlots[0] : null;
        const itemsRaw = us0 && us0.data && us0.data.inventory && Array.isArray(us0.data.inventory.items)
          ? us0.data.inventory.items : [];
        const items = compact ? this._compactItems(itemsRaw) : itemsRaw;
        
        console.log('[MG] saveInventoryFromGameState:', { 
          hasGameState: !!gs, 
          hasUserSlot: !!us0, 
          rawItemCount: itemsRaw.length, 
          compactItemCount: items.length,
          compact: compact
        });
        
        // Always overwrite the file completely, even if items is empty
        const response = await fetch(this._inventoryServerBase + '/api/inventory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items })
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // Update in-memory mirror to match
        this._inventoryItems = Array.isArray(items) ? JSON.parse(JSON.stringify(items)) : [];
        this._lastInventoryUpdateTs = Date.now();
        return { success: true, count: Array.isArray(items) ? items.length : 0 };
      } catch (e) {
        console.error('[MG] saveInventoryFromGameState failed:', e);
        return { success: false, error: String(e) };
      }
    }

    // Manual function to force save inventory (for debugging)
    async forceSaveInventory() {
      console.log('[MG] Force saving inventory...');
      this._initialInventorySaved = false; // Reset the flag
      return await this.saveInventoryFromGameState({ compact: true });
    }

    // Ensure the virtual inventory JSON is seeded even if Welcome was missed
    async seedVirtualInventory(options = {}) {
      const retries = Number(options.retries || 8);
      const interval = Number(options.intervalMs || 500);
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < retries; i++) {
        // If server already has items, stop
        const serverItems = await this._readServerInventory();
        if (serverItems && serverItems.length > 0) return { success: true, seeded: false, reason: 'already_present' };
        // Collect items from live mirror or full state
        let items = [];
        try {
          if (Array.isArray(this._inventoryItems) && this._inventoryItems.length > 0) {
            items = this._compactItems(this._inventoryItems);
          } else {
            const gs = this.getGameState();
            const us0 = gs && gs.child && gs.child.data && gs.child.data.userSlots && Array.isArray(gs.child.data.userSlots) ? gs.child.data.userSlots[0] : null;
            const inv = us0 && us0.data && us0.data.inventory && Array.isArray(us0.data.inventory.items) ? us0.data.inventory.items : [];
            items = this._compactItems(Array.isArray(inv) ? inv : []);
            if (items.length > 0) this._inventoryItems = JSON.parse(JSON.stringify(items));
          }
        } catch (e) { items = []; }
        // Post to server; if successful and non-empty, stop
        try {
          await this._postInventoryToServer(items);
          if (items.length > 0) return { success: true, seeded: true, count: items.length };
        } catch (e) {}
        await sleep(interval);
      }
      return { success: true, seeded: false };
    }

    // Subscribe to live inventory updates
    onInventoryChange(handler) {
      try {
        if (typeof handler !== 'function') return { success: false, error: 'Handler must be a function' };
        if (!Array.isArray(this._inventoryListeners)) this._inventoryListeners = [];
        this._inventoryListeners.push(handler);
        return { success: true };
      } catch (e) { return { success: false, error: String(e) }; }
    }

    // Wait until the next inventory update arrives
    async waitForInventoryUpdate(options = {}) {
      const timeout = Number(options.timeoutMs || 1000);
      const start = Date.now();
      const initial = this._lastInventoryUpdateTs || 0;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      while (Date.now() - start < timeout) {
        if ((this._lastInventoryUpdateTs || 0) > initial) return true;
        await sleep(30);
      }
      return false;
    }

    // Fresh variant that waits for a live update before reading
    async getItemFromInventoryFresh(crop, options = {}) {
      await this.waitForInventoryUpdate({ timeoutMs: options.timeoutMs || 1000 });
      return this.getItemFromInventory(crop);
    }

    // Fetch diet array for a given pet id; prefer combined JSON file, then API, then localStorage
    async _getDietForPetId(petId) {
      const pid = String(petId);
      // 1) Combined file (mg_pet_diets.json written by the GUI server)
      try {
        const combined = await this._readCombinedDietsFile();
        const pets = combined && combined.pets && typeof combined.pets === 'object' ? combined.pets : null;
        const cfg = pets ? pets[pid] : null;
        if (cfg && Array.isArray(cfg.diets)) return cfg.diets.map(String);
      } catch (e) {}
      // 2) Legacy API on Flask app.py
      try {
        const resp = await fetch(this._dietServerBase + '/api/pet_diet/' + encodeURIComponent(pid), { cache: 'no-cache' });
        if (resp.ok) {
          const arr = await resp.json();
          if (Array.isArray(arr)) return arr.map(String);
        }
      } catch (e) {}
      // 3) Fallback to extension-managed localStorage
      try {
        const diets = this.loadPetDiets();
        const raw = diets && diets[pid];
        if (Array.isArray(raw)) return raw.map(String);
        if (typeof raw === 'string') return [raw];
      } catch (e) {}
      return [];
    }

    // Read combined diets file (written by pet_diet_server_flask) via main Flask static server
    async _readCombinedDietsFile() {
      try {
        const resp = await fetch(this._inventoryServerBase + '/mg_pet_diets.json', { cache: 'no-cache' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return (data && typeof data === 'object') ? data : null;
      } catch (e) { return null; }
    }

    // Get max hunger for a petId from combined JSON; fallback to live/fullstate
    async _getMaxHungerForPetId(petId) {
      try {
        const combined = await this._readCombinedDietsFile();
        const pets = combined && combined.pets && typeof combined.pets === 'object' ? combined.pets : null;
        const cfg = pets ? pets[String(petId)] : null;
        if (cfg && typeof cfg.maxHunger === 'number') return cfg.maxHunger;
      } catch (e) {}
      // Fallbacks
      try {
        // live cache
        const slots = this._petData && this._petData.petSlots ? this._petData.petSlots : null;
        for (const k in (slots || {})) {
          const s = slots[k];
          if (s && s.id === petId && typeof s.maxHunger === 'number') return s.maxHunger;
        }
      } catch (e) {}
      try {
        const gs = this.getGameState();
        const ps = gs?.child?.data?.userSlots?.[0]?.data?.petSlots || {};
        for (const k in ps) {
          const s = ps[k];
          if (s && s.id === petId && typeof s.maxHunger === 'number') return s.maxHunger;
        }
      } catch (e) {}
      return null;
    }

    // Get pet id for a given slot (uses live cache/fullstate)
    getPetId(slotNumber) {
      try {
        const slot = Number(slotNumber);
        if (!Number.isFinite(slot) || slot < 0 || slot > 2) {
          return { success: false, error: 'Invalid slot number. Must be 0, 1, or 2' };
        }
        const petSlots = this._petData.petSlots || {};
        if (petSlots[slot] && petSlots[slot].id) {
          return { success: true, petId: petSlots[slot].id, slot, source: 'liveData' };
        }
        const gameState = this.getGameState();
        if (!gameState || !gameState.child || !gameState.child.data || !gameState.child.data.userSlots || !gameState.child.data.userSlots[0]) {
          return { success: false, error: 'No game state available' };
        }
        const petSlotsFromState = gameState.child.data.userSlots[0].data.petSlots || {};
        if (petSlotsFromState[slot] && petSlotsFromState[slot].id) {
          return { success: true, petId: petSlotsFromState[slot].id, slot, source: 'fullState' };
        }
        return { success: false, error: 'No pet found in slot ' + slot };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Feed a pet in slot (0-2) using its diet and current inventory
    async feedPet(slotNumber, options = {}) {
      try {
        const slot = Number(slotNumber);
        if (!Number.isFinite(slot) || slot < 0 || slot > 2) {
          return { success: false, error: 'Invalid slot number. Must be 0, 1, or 2' };
        }

        // Resolve pet id
        const petIdResp = this.getPetId(slot);
        if (!petIdResp.success) return petIdResp;
        const petId = petIdResp.petId;

        // Get pet diet array from server/local
        const diet = await this._getDietForPetId(petId);
        if (!Array.isArray(diet) || diet.length === 0) {
          return { success: false, error: 'No diet found for pet ' + petId };
        }

        // Load inventory from server (virtual inventory JSON) first
        const serverItems = await this._readServerInventory();
        const items = serverItems || (this._inventoryItems || []);
        if (!Array.isArray(items) || items.length === 0) {
          return { success: false, error: 'No inventory items available' };
        }

        // Find the first PRODUCE inventory item whose species matches any diet entry (case-insensitive)
        const dietSet = new Set(diet.map(d => String(d).toLowerCase()));
        let chosenItem = null;
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          const species = it && it.species ? String(it.species).toLowerCase() : null;
          const itemType = it && it.itemType ? String(it.itemType) : '';
          if (itemType === 'Produce' && species && dietSet.has(species)) { chosenItem = it; break; }
        }
        if (!chosenItem) {
          return { success: false, error: 'No matching crop in inventory for diet', diet };
        }

        // petItemId is the pet id; cropItemId is the inventory item id
        const cropItemId = chosenItem.id || null;
        if (!cropItemId) return { success: false, error: 'Chosen inventory item has no id' };

        // Send FeedPet via websocket
        const msg = { scopePath: ['Room', 'Quinoa'], type: 'FeedPet', petItemId: petId, cropItemId };
        await this.sendWebSocketMessage(msg);
        try { fetch(this._inventoryServerBase + '/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'FeedPetSent', petId, cropItemId }) }); } catch (e) {}
        // Proactively update virtual inventory by item id (server-mirroring by id)
        try {
          await fetch(this._inventoryServerBase + '/api/inventory/remove_id', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cropItemId })
          });
        } catch (e) {}

        return { success: true, slot, petId, fedCrop: chosenItem.species, cropItemId };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Feed a pet repeatedly from inventory until hunger is maxed (within 10 of max) or no more items are available.
    // This function does NOT harvest.
    async feedUntilMax(slotNumber, options = {}) {
      try {
        const slot = Number(slotNumber);
        if (!Number.isFinite(slot) || slot < 0 || slot > 2) {
          return { success: false, error: 'Invalid slot number. Must be 0, 1, or 2' };
        }

        const maxSteps = Number.isFinite(options.maxSteps) ? Number(options.maxSteps) : 50;
        const waitHungerMs = Number.isFinite(options.waitHungerMs) ? Number(options.waitHungerMs) : 1500;
        const maxStalls = Number.isFinite(options.maxStalls) ? Number(options.maxStalls) : 2;

        const petHunger = (s) => {
          const ps = this._petData?.petSlots?.[s];
          if (ps && typeof ps.hunger === 'number') return ps.hunger;
          try {
            const gs = this.getGameState();
            return gs?.child?.data?.userSlots?.[0]?.data?.petSlots?.[s]?.hunger ?? null;
          } catch (_) { return null; }
        };
        const petMaxHunger = async (s) => {
          // Resolve pet id, read max from combined JSON; fallback to live/fullstate
          const pet = this.getPetId(s);
          if (pet && pet.success) {
            const mh = await this._getMaxHungerForPetId(pet.petId);
            if (typeof mh === 'number') return mh;
          }
          const ps = this._petData?.petSlots?.[s];
          if (ps && typeof ps.maxHunger === 'number') return ps.maxHunger;
          try {
            const gs = this.getGameState();
            return gs?.child?.data?.userSlots?.[0]?.data?.petSlots?.[s]?.maxHunger ?? null;
          } catch (_) { return null; }
        };

        let fedCount = 0;
        let stalls = 0;
        let prev = petHunger(slot);
        if (prev == null) return { success: false, error: 'pet-hunger-unavailable' };

        const maxH = await petMaxHunger(slot);

        console.log('[MG] feedUntilMax: pet already maxed', { slot, prev, maxH });
        if (typeof maxH === 'number' && prev >= (maxH - 10)) {
          return { success: true, fed: 0, finalHunger: prev, reason: 'already-max' };
        }

        for (let i = 0; i < maxSteps; i++) {
          let res = await this.feedPet(slot).catch(() => null);
          if (!res || !res.success) {
            // No inventory: attempt to harvest repeatedly until feed succeeds or no more garden items
            const pet = this.getPetId(slot);
            if (!pet || !pet.success) {
              const reason = res && res.error ? 'feed-failed' : 'no-items';
              return { success: true, fed: fedCount, finalHunger: petHunger(slot), reason, error: res && res.error };
            }
            const diet = await this._getDietForPetId(pet.petId);
            if (!Array.isArray(diet) || diet.length === 0) {
              return { success: true, fed: fedCount, finalHunger: petHunger(slot), reason: 'no-diet' };
            }
            let everHarvested = false;
            const maxHarvestLoops = Number.isFinite(options.maxHarvestLoops) ? Number(options.maxHarvestLoops) : 8;
            for (let hl = 0; hl < maxHarvestLoops; hl++) {
              let harvested = false;
              for (const cropName of diet) {
                const h = await this.harvestOneByCrop(String(cropName)).catch(() => null);
                if (h && h.success && h.harvested === 1) { harvested = true; everHarvested = true; break; }
              }
              if (!harvested) break; // nothing harvestable right now
              try { await this.waitForInventoryUpdate({ timeoutMs: 1200 }); } catch (_) {}
              res = await this.feedPet(slot).catch(() => null);
              if (res && res.success) break; // fed successfully after harvest
            }
            if (!res || !res.success) {
              return { success: true, fed: fedCount, finalHunger: petHunger(slot), reason: everHarvested ? 'feed-failed' : 'no-items-in-garden', error: res && res.error };
            }
          }
          fedCount++;

          await this.waitForPetUpdate({ slotNumber: slot, timeoutMs: waitHungerMs }).catch(() => {});
          const curr = petHunger(slot);
          if (curr == null) return { success: true, fed: fedCount, finalHunger: null, reason: 'hunger-unavailable' };
          if (typeof maxH === 'number' && curr >= (maxH - 10)) return { success: true, fed: fedCount, finalHunger: curr, reason: 'maxed' };

          if (curr <= prev) {
            stalls++;
            if (stalls >= maxStalls) return { success: true, fed: fedCount, finalHunger: curr, reason: 'stalled' };
          } else {
            stalls = 0;
          }
          prev = curr;
        }

        return { success: true, fed: fedCount, finalHunger: petHunger(slot), reason: 'max-steps' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Harvest any harvestable crop at the given location (no mutation requirements)
    // If slotIndex is provided, harvest that specific slot; otherwise find first ready crop
    async harvestAnyCrop(x, y, slotIndex = null, options = {}) {
      try {
        // Get all crops at this location
        const entries = this.getMutationEntriesAt(x, y) || [];
        if (!Array.isArray(entries) || entries.length === 0) {
          return { success: true, harvested: 0, message: 'No crops found at this location' };
        }

        let harvestSlotIndex = -1;

        // If specific slot index provided, check that slot
        if (slotIndex !== null && slotIndex !== undefined) {
          const slot = Number(slotIndex);
          if (!Number.isFinite(slot) || slot < 0 || slot >= entries.length) {
            return { success: false, error: 'Invalid slot index. Must be between 0 and ' + (entries.length - 1) };
          }
          
          const readyResult = await this.isCropReady(x, y, slot, options);
          if (readyResult.success && readyResult.isReady) {
            harvestSlotIndex = slot;
          } else {
            return { success: true, harvested: 0, message: 'Crop in slot ' + slot + ' is not ready for harvest' };
          }
        } else {
          // Find the first harvestable crop using isCropReady
          for (let i = 0; i < entries.length; i++) {
            const readyResult = await this.isCropReady(x, y, i, options);
            if (readyResult.success && readyResult.isReady) {
              harvestSlotIndex = i;
              break;
            }
          }

          if (harvestSlotIndex === -1) {
            return { success: true, harvested: 0, message: 'No harvestable crops found at this location' };
          }
        }

        // Harvest the specified or found ready crop
        try {
          const result = await this.harvestCropAt(x, y, harvestSlotIndex, options);
          if (result.success) {
            return { success: true, harvested: 1, slotIndex: harvestSlotIndex, x: Math.round(Number(x)), y: Math.round(Number(y)) };
          } else {
            return { success: false, error: result.error || 'Harvest failed' };
          }
        } catch (e) {
          return { success: false, error: String(e) };
        }
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Harvest one item by crop name using getSlotOf() to filter candidate tiles
    async harvestOneByCrop(cropName, options = {}) {
      try {
        const name = String(cropName || '').trim();
        if (!name) return { success: false, error: 'Crop name cannot be empty' };
        const nameLower = name.toLowerCase();

        // Use getSlotOf to narrow to only tiles that contain this crop
        const slotsResp = this.getSlotOf(name);
        if (!slotsResp || !slotsResp.success) {
          return { success: false, harvested: 0, message: 'Could not resolve slots for ' + name };
        }
        const slots = Array.isArray(slotsResp.slots) ? slotsResp.slots : [];
        if (slots.length === 0) {
          return { success: false, harvested: 0, message: 'No tiles contain crop ' + name };
        }

        // Iterate only those slot numbers; within each, find matching species entries and check readiness
        for (const slotNumber of slots) {
          const crop = this.getCrop(slotNumber);
          const entries = crop && Array.isArray(crop.slots) ? crop.slots : [];
          if (!Array.isArray(entries) || entries.length === 0) continue;

          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i] || {};
            const species = entry && entry.species ? String(entry.species).toLowerCase() : null;
            if (!species || species !== nameLower) continue;

            const coord = this.slotToCoord(Number(slotNumber));
            if (!coord) continue;

            // Use isCropReady for freshness; then harvest via harvestAnyCrop targeting this slot
            const ready = await this.isCropReady(coord.x, coord.y, i, options);
            if (ready && ready.success && ready.isReady) {
              const res = await this.harvestAnyCrop(coord.x, coord.y, i, options);
              if (res && res.success && res.harvested === 1) {
                return {
                  success: true,
                  harvested: 1,
                  species: entry.species || name,
                  x: coord.x,
                  y: coord.y,
                  slotNumber: Number(slotNumber),
                  slotIndex: i
                };
              }
            }
          }
        }

        return { success: false, harvested: 0, message: 'No ready crops found for ' + name };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Boolean wrapper: true if one was harvested, false otherwise
    async harvestOneByCropSimple(cropName, options = {}) {
      try {
        const res = await this.harvestOneByCrop(cropName, options);
        return !!(res && res.success && res.harvested === 1);
      } catch (e) {
        return false;
      }
    }

    // Check if a crop has finished growing (waits for fresh data)
    async isCropReady(x, y, slotIndex = 0, options = {}) {
      try {
        const fresh = await this.getMutationEntriesAtFresh(x, y);
        const entries = Array.isArray(fresh) ? fresh : (this.getMutationEntriesAt(x, y) || []);
        if (!Array.isArray(entries) || entries.length === 0) {
          return { success: false, error: 'No crops found at this location' };
        }
        
        if (slotIndex >= entries.length) {
          return { success: false, error: 'Invalid slot index' };
        }
        
        const entry = entries[slotIndex];
        const startTime = entry.startTime || 0;
        const endTime = entry.endTime || 0;
        const currentTime = Date.now();
        
        const isReady = currentTime >= endTime;
        const timeRemaining = Math.max(0, endTime - currentTime);
        const timeElapsed = currentTime - startTime;
        const totalGrowthTime = endTime - startTime;
        const progressPercent = totalGrowthTime > 0 ? Math.min(100, (timeElapsed / totalGrowthTime) * 100) : 0;
        
        return {
          success: true,
          isReady,
          timeRemaining: Math.round(timeRemaining / 1000), // seconds
          timeElapsed: Math.round(timeElapsed / 1000), // seconds
          totalGrowthTime: Math.round(totalGrowthTime / 1000), // seconds
          progressPercent: Math.round(progressPercent * 100) / 100,
          startTime,
          endTime,
          currentTime
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Check all crops at a location and return their growth status (waits briefly for latest updates)
    async getAllCropsStatus(x, y, options = {}) {
      try {
        const fresh = await this.getMutationEntriesAtFresh(x, y, { timeoutMs: options.timeoutMs || 800 });
        const entries = Array.isArray(fresh) ? fresh : (this.getMutationEntriesAt(x, y) || []);
        if (!Array.isArray(entries) || entries.length === 0) {
          return { success: false, error: 'No crops found at this location' };
        }
        
        const crops = [];
        const currentTime = Date.now();
        
        entries.forEach((entry, index) => {
          const startTime = entry.startTime || 0;
          const endTime = entry.endTime || 0;
          const isReady = currentTime >= endTime;
          const timeRemaining = Math.max(0, endTime - currentTime);
          const timeElapsed = currentTime - startTime;
          const totalGrowthTime = endTime - startTime;
          const progressPercent = totalGrowthTime > 0 ? Math.min(100, (timeElapsed / totalGrowthTime) * 100) : 0;
          
          crops.push({
            slotIndex: index,
            isReady,
            timeRemaining: Math.round(timeRemaining / 1000), // seconds
            timeElapsed: Math.round(timeElapsed / 1000), // seconds
            totalGrowthTime: Math.round(totalGrowthTime / 1000), // seconds
            progressPercent: Math.round(progressPercent * 100) / 100,
            mutations: entry.mutations || [],
            startTime,
            endTime
          });
        });
        
        const readyCount = crops.filter(c => c.isReady).length;
        
        return {
          success: true,
          crops,
          totalCrops: crops.length,
          readyCrops: readyCount,
          allReady: readyCount === crops.length
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

    // Send a ping to trigger server response and potentially get updated state
    async pingServer() {
      const message = {
        scopePath: ["Room", "Quinoa"],
        type: "Ping",
        id: Date.now()
      };
      return this.sendWebSocketMessage(message);
    }

    // Harvest all entries at (x,y) that satisfy: Frozen && (Ambershine || Dawnlit)
    // Implements a single-pass linked-list style traversal; for each node:
    // - if false => press 'c' to advance; if true => press Space to harvest (also advances), then remove node
    // options: { delayMs?: number }
    async harvestAllMax(x, y, options = {}) {
      try {
        const delay = (options && Number(options.delayMs) >= 20) ? Number(options.delayMs) : 100;
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

        // Get entries
        const entries = this.getMutationEntriesAt(x, y) || [];
        if (!Array.isArray(entries) || entries.length === 0) {
          return { success: true, harvested: 0, message: 'No crops found' };
        }

        // Find all slots that match the criteria: Frozen && (Ambershine || Dawnlit)
        const harvestSlots = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i] || {};
          const mutations = Array.isArray(entry.mutations) ? entry.mutations : [];
          const hasFrozen = mutations.includes('Frozen');
          const hasAmbershine = mutations.includes('Ambershine');
          const hasDawnlit = mutations.includes('Dawnlit');
          
          if (hasFrozen && (hasAmbershine || hasDawnlit)) {
            harvestSlots.push(i);
          }
        }

        if (harvestSlots.length === 0) {
          return { success: true, harvested: 0, message: 'No crops match harvest criteria' };
        }

        // Send HarvestCrop WebSocket messages for each qualifying slot
        let harvested = 0;
        for (const slotIndex of harvestSlots) {
          try {
            await this.harvestCropAt(x, y, slotIndex, options);
            harvested++;
            // Small delay between harvests to avoid overwhelming the server
            await sleep(delay);
          } catch (e) {
            console.warn(`[MG] Failed to harvest slot ${slotIndex}:`, e);
          }
        }

        return { 
          success: true, 
          harvested, 
          totalSlots: entries.length,
          harvestSlots: harvestSlots.length,
          slots: harvestSlots
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

  // Wait for next pet hunger/xp update (PartialState) with optional timeout
  async waitForPetUpdate(options = {}) {
    const { timeoutMs = 1500, slotNumber = null } = options;
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        try { window.removeEventListener('message', onMsg); } catch (e) {}
        try { clearTimeout(timer); } catch (e) {}
      };
      const onMsg = (ev) => {
        try {
          const d = ev && ev.data;
          if (!d || d.source !== 'mg-extension-page') return;
          if (d.type !== 'wsAll' || d.dir !== 'in') return;
          const msg = d.msg;
          if (!msg) return;
          if (msg.type === 'PartialState' && Array.isArray(msg.patches)) {
            for (const p of msg.patches) {
              const path = String(p.path || '');
              // Match hunger/xp changes under petSlots
              const m = path.match(/\/child\/data\/userSlots\/0\/data\/petSlots\/(\d+)\/(hunger|xp)$/);
              if (m) {
                const sIdx = Number(m[1]);
                if (slotNumber == null || sIdx === Number(slotNumber)) {
                  cleanup();
                  resolve(true);
                  return;
                }
              }
            }
          }
        } catch (e) {}
      };
      window.addEventListener('message', onMsg);
      const timer = setTimeout(() => { cleanup(); resolve(false); }, Math.max(100, Number(timeoutMs) || 1500));
    });
  }

    // Feed a specific pet slot until hunger stops increasing or an optional target is reached
    async _feedPetToMax(slot, options = {}) {
      try {
        const hungerTarget = Number.isFinite(options.hungerTarget) ? Number(options.hungerTarget) : Infinity;
        const maxSteps = Number.isFinite(options.maxSteps) ? Number(options.maxSteps) : 25;
        const maxStalls = Number.isFinite(options.maxStalls) ? Number(options.maxStalls) : 2;
        const waitHungerMs = Number.isFinite(options.waitHungerMs) ? Number(options.waitHungerMs) : 1500;

        const petHunger = (s) => {
          const ps = this._petData?.petSlots?.[s];
          if (ps && typeof ps.hunger === 'number') return ps.hunger;
          try {
            const gs = this.getGameState();
            return gs?.child?.data?.userSlots?.[0]?.data?.petSlots?.[s]?.hunger ?? null;
          } catch (_) { return null; }
        };

        let prev = petHunger(slot);
        if (prev == null) return { success: false, error: 'pet-hunger-unavailable' };

        let steps = 0;
        let stalls = 0;
        while ((petHunger(slot) ?? 0) < hungerTarget && steps < maxSteps) {
          steps++;

          // Try feed from inventory
          let fed = await this.feedPet(slot).catch(() => null);
          if (!fed || !fed.success) {
            // Harvest one item matching diet, then try again
            const pet = this.getPetId(slot);
            if (!pet || !pet.success) break;
            const diet = await this._getDietForPetId(pet.petId);
            if (!diet || diet.length === 0) break;

            let harvested = false;
            for (const cropName of diet) {
              const h = await this.harvestOneByCrop(String(cropName)).catch(() => null);
              if (h && h.success && h.harvested === 1) { harvested = true; break; }
            }
            if (!harvested) break;

            try { await this.pushInventoryToServer?.(); } catch (_) {}
            await this.waitForInventoryUpdate({ timeoutMs: 1200 }).catch(() => {});

            fed = await this.feedPet(slot).catch(() => null);
            if (!fed || !fed.success) break;
          }

          await this.waitForPetUpdate({ slotNumber: slot, timeoutMs: waitHungerMs }).catch(() => {});
          const curr = petHunger(slot);
          if (curr == null) break;
          if (curr <= prev) {
            stalls++;
            if (stalls >= maxStalls) break;
          } else {
            stalls = 0;
          }
          prev = curr;
        }

        return { success: true, steps, stalls, finalHunger: petHunger(slot) };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }

  // Start automatic pet feeder loop
    // Options: { intervalMs?: number, hungerThreshold?: number, maxAttemptsPerTick?: number, feedToMax?: boolean }
    startAutoFeeder(options = {}) {
      const { intervalMs = 8000, hungerThreshold = 500, maxAttemptsPerTick = 2, feedToMax = true } = options;
    if (this._autoFeederInterval) clearInterval(this._autoFeederInterval);
    this._autoFeederInterval = setInterval(async () => {
      try {
        // Prefer live cache; fallback to full state
        const petSlots = this._petData?.petSlots || {};
        const petHunger = (slot) => {
          const ps = petSlots && petSlots[slot];
          if (ps && typeof ps.hunger === 'number') return ps.hunger;
          try {
            const gs = this.getGameState();
            return gs?.child?.data?.userSlots?.[0]?.data?.petSlots?.[slot]?.hunger ?? null;
          } catch (_) { return null; }
        };

        for (let slot = 0; slot <= 2; slot++) {
          let hunger = petHunger(slot);
          if (hunger == null) continue;
          if (hunger >= hungerThreshold) continue;

          if (feedToMax) {
            await this._feedPetToMax(slot, {
              hungerTarget: Infinity,
              maxSteps: options.maxSteps ?? 25,
              maxStalls: options.maxStalls ?? 2,
              waitHungerMs: options.waitHungerMs ?? 1500
            });
            break; // fully feed this pet before checking others
          } else {
            let attempts = 0;
            while (hunger < hungerThreshold && attempts < maxAttemptsPerTick) {
              attempts++;

              const feedRes = await this.feedPet(slot).catch(() => null);
              if (!feedRes || !feedRes.success) {
                const pet = this.getPetId(slot);
                if (!pet || !pet.success) break;
                const diet = await this._getDietForPetId(pet.petId);
                if (!diet || diet.length === 0) break;

                let harvested = false;
                for (const cropName of diet) {
                  const h = await this.harvestOneByCrop(String(cropName)).catch(() => null);
                  if (h && h.success && h.harvested === 1) { harvested = true; break; }
                }
                if (!harvested) break;

                try { await this.pushInventoryToServer?.(); } catch (_) {}
                await this.waitForInventoryUpdate({ timeoutMs: 1200 }).catch(() => {});

                const feedRes2 = await this.feedPet(slot).catch(() => null);
                if (!feedRes2 || !feedRes2.success) break;
              }

              await this.waitForPetUpdate({ slotNumber: slot, timeoutMs: 1500 }).catch(() => {});
              hunger = petHunger(slot) ?? hunger;
            }
          }
        }
      } catch (_) {}
    }, Math.max(2000, Number(intervalMs) || 8000));

      return { success: true, running: true, intervalMs, hungerThreshold };
    }

    stopAutoFeeder() {
    if (this._autoFeederInterval) {
      clearInterval(this._autoFeederInterval);
      this._autoFeederInterval = null;
    }
      return { success: true, running: false };
    }
  }

// Add map exploration method to MagicGardenAPI prototype
MagicGardenAPI.prototype.exploreAndMap = async function(options) {
    options = options || {};
    const maxCells = options.maxCells || 10000;
    const saveEvery = options.saveEvery || 50; // save walls every N discoveries

    // load existing walls
    await loadWallsForRoom();

    __mg_mappingActive = true; __mg_mappingAbort.aborted = false;

    // helper
    const keyOf = (p) => p.x + ',' + p.y;
    const directions = [
      { name: 'right', dx: 1, dy: 0, axis: 'x', delta: 1, opposite: 'left' },
      { name: 'left', dx: -1, dy: 0, axis: 'x', delta: -1, opposite: 'right' },
      { name: 'down', dx: 0, dy: 1, axis: 'y', delta: 1, opposite: 'up' },
      { name: 'up', dx: 0, dy: -1, axis: 'y', delta: -1, opposite: 'down' }
    ];

    // get start
    const curResp = await this.getCurrentPosition();
    if (!curResp || !curResp.success || !curResp.pos) return { success: false, error: 'current-position-unavailable' };
    const start = { x: Math.round(curResp.pos.x), y: Math.round(curResp.pos.y) };

    const visited = new Set();
    const queue = [ start ];
    visited.add(keyOf(start));
    let discovered = 0;

    // Ensure we're physically at start before exploring
    try { await this.moveToWithPath(start.x, start.y); } catch (e) { /* ignore */ }

    while (queue.length && !__mg_mappingAbort.aborted && visited.size < maxCells) {
      const pos = queue.shift();
      // attempt to move to pos
      try { await this.moveToWithPath(pos.x, pos.y); } catch (e) { /* ignore */ }
      const hereResp = await this.getCurrentPosition();
      if (!hereResp || !hereResp.success || !hereResp.pos) continue;
      const here = { x: Math.round(hereResp.pos.x), y: Math.round(hereResp.pos.y) };

      for (const d of directions) {
        if (__mg_mappingAbort.aborted) break;
        const nx = here.x + d.dx, ny = here.y + d.dy;
        const nkey = nx + ',' + ny;
        if (visited.has(nkey) || __mg_walls.has(nkey)) continue;

        // attempt a single step into neighbor
        const axisPrev = (d.axis === 'x') ? here.x : here.y;
        const stepResp = await this._stepAndVerify(d.name, d.axis, d.delta, axisPrev, 1, null);
        if (stepResp && stepResp.success) {
          // moved into neighbor
          const arrived = stepResp.pos ? { x: Math.round(stepResp.pos.x), y: Math.round(stepResp.pos.y) } : { x: nx, y: ny };
          const arrivedKey = keyOf(arrived);
          if (!visited.has(arrivedKey)) {
            visited.add(arrivedKey);
            queue.push(arrived);
            discovered++;
          }
          // move back to continue BFS from original 'here'
          await this._stepAndVerify(d.opposite, d.axis, -d.delta, (d.axis === 'x') ? arrived.x : arrived.y, 1, null).catch(() => {});
        } else {
          // mark neighbor as wall
          __mg_walls.add(nkey);
          discovered++;
        }

        // periodically persist walls
        if (discovered % saveEvery === 0) {
          try { await saveWallsForRoom(Array.from(__mg_walls).map(s => { const p = s.split(','); return { x: Number(p[0]), y: Number(p[1]) }; })); } catch (e) {}
          // publish progress message
          try { chrome.runtime.sendMessage({ action: 'mappingProgress', visited: visited.size, walls: __mg_walls.size }); } catch (e) {}
        }
      }
    }

    // final save
    try { await saveWallsForRoom(Array.from(__mg_walls).map(s => { const p = s.split(','); return { x: Number(p[0]), y: Number(p[1]) }; })); } catch (e) {}
    __mg_mappingActive = false; __mg_mappingAbort.aborted = false;
    return { success: true, visited: visited.size, walls: __mg_walls.size };
  };

  // Walls management helpers so you can feed JSON and query/clear
  MagicGardenAPI.prototype.setWallsFromJson = function(wallsJson) {
    try {
      if (!Array.isArray(wallsJson)) return false;
      const next = new Set();
      for (const w of wallsJson) {
        if (!w) continue;
        const x = Number(w.x), y = Number(w.y);
        if (Number.isFinite(x) && Number.isFinite(y)) next.add(x + ',' + y);
      }
      __mg_walls = next;
      try { saveWallsForRoom(Array.from(__mg_walls).map(s => { const p = s.split(','); return { x: Number(p[0]), y: Number(p[1]) }; })); } catch (e) {}
      return true;
    } catch (e) { return false; }
  };

  MagicGardenAPI.prototype.getWalls = function() {
    try {
      return Array.from(__mg_walls).map(s => { const p = s.split(','); return { x: Number(p[0]), y: Number(p[1]) }; });
    } catch (e) {
      return [];
    }
  };

  MagicGardenAPI.prototype.clearWalls = function() {
    __mg_walls = new Set();
    try { saveWallsForRoom([]); } catch (e) {}
    return true;
  };

  // Implement a simple moveToWithPath wrapper so mapping can navigate between cells.
  // It prefers the existing moveTo() method; falls back to sequential moveX/moveY.
  MagicGardenAPI.prototype.moveToWithPath = async function(targetX, targetY) {
    try {
      if (typeof this.moveTo === 'function') {
        // use existing moveTo implementation
        return await this.moveTo(targetX, targetY);
      }
    } catch (e) {
      // ignore and try fallback
    }

    // fallback: try simple direct moves (x then y)
    try {
      const curResp = await this.getCurrentPosition();
      if (!curResp || !curResp.success || !curResp.pos) return { success: false, error: 'current-position-unavailable' };
      const cur = curResp.pos;
      const dx = Math.round(Number(targetX)) - Math.round(Number(cur.x));
      const dy = Math.round(Number(targetY)) - Math.round(Number(cur.y));
      if (dx !== 0) {
        const rx = await this.moveX(dx);
        if (!rx || !rx.success) return { success: false, error: 'moveX-failed' };
      }
      if (dy !== 0) {
        const ry = await this.moveY(dy);
        if (!ry || !ry.success) return { success: false, error: 'moveY-failed' };
      }
      const final = await this.getCurrentPosition();
      return { success: true, pos: final && final.pos ? final.pos : null };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  };

  // Mapping control state
  let __mg_mappingActive = false;
  let __mg_mappingAbort = { aborted: false };

  // Initialize API instance
  if (!window.MagicGardenAPI) {
    new MagicGardenAPI();
    
    // Auto-load walls JSON on startup
    setTimeout(async () => {
      try {
        const result = await window.MagicGardenAPI.loadWallsFromExtension('mg_walls.json');
        if (result.success) {
          console.log('✅ Auto-loaded', result.count, 'walls from mg_walls.json');
        } else {
          console.warn('⚠️ Failed to auto-load walls:', result.error);
        }
      } catch (e) {
        console.warn('⚠️ Auto-load walls failed:', e);
      }
    }, 1000); // Wait 1 second for everything to initialize
    
    // Start farm sync once the page-side WS hook is in place; provide a simple slot->coord mapping hook.
    // You can replace this mapping with your own if you know the slot layout.
    const naiveSlotToCoord = (slot) => {
      // Fallback: try a simple 9x? row-major guess; adjust as needed
      const width = 9; // change if your garden width differs
      const x = slot % width;
      const y = Math.floor(slot / width);
      return { x, y };
    };
    try { window.MagicGardenAPI.startFarmSync(naiveSlotToCoord); } catch (e) { console.warn('startFarmSync failed:', e); }
  }

  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('content.js: received message from popup/background', request && request.action, request);

    if (!window.MagicGardenAPI) {
      sendResponse({ success: false, error: 'Magic Garden API not initialized' });
      return true;
    }

    (async () => {
      switch (request.action) {
        case 'moveUp':
          window.MagicGardenAPI.moveUp();
          sendResponse({ success: true });
          break;
        case 'getPlayerPosition':
          // Ask the page script to discover the player position and return it
          try {
            const posResp = await window.MagicGardenAPI.getPlayerPosition();
            sendResponse(posResp);
          } catch (e) {
            sendResponse({ success: false, error: String(e) });
          }
          break;
        case 'moveDown':
          window.MagicGardenAPI.moveDown();
          sendResponse({ success: true });
          break;
        case 'moveLeft':
          window.MagicGardenAPI.moveLeft();
          sendResponse({ success: true });
          break;
        case 'moveRight':
          window.MagicGardenAPI.moveRight();
          sendResponse({ success: true });
          break;
        case 'setSpeed':
          window.MagicGardenAPI.setSpeed(request.speed);
          sendResponse({ success: true });
          break;
        case 'testConnection':
          const resp = await window.MagicGardenAPI.testConnection();
          sendResponse(resp);
          break;
        case 'moveX':
          try {
            const moveXResp = await window.MagicGardenAPI.moveX(request.delta);
            sendResponse(moveXResp);
          } catch (e) {
            sendResponse({ success: false, error: String(e) });
          }
          break;
        case 'moveY':
          try {
            const moveYResp = await window.MagicGardenAPI.moveY(request.delta);
            sendResponse(moveYResp);
          } catch (e) {
            sendResponse({ success: false, error: String(e) });
          }
          break;
        case 'moveToWithPath':
          try {
            const resp = await window.MagicGardenAPI.moveToWithPath(request.x, request.y);
            sendResponse(resp);
          } catch (e) { sendResponse({ success: false, error: String(e) }); }
          break;
        case 'startMapping':
          // options: { maxCells, saveEvery }
          if (!window.MagicGardenAPI || typeof window.MagicGardenAPI.exploreAndMap !== 'function') {
            sendResponse({ success: false, error: 'mapping-not-available' });
            break;
          }
          if (__mg_mappingActive) { sendResponse({ success: false, error: 'already-mapping' }); break; }
          // keep channel open
          (async () => {
            try {
              const result = await window.MagicGardenAPI.exploreAndMap(request.options || {});
              sendResponse(result);
            } catch (e) { sendResponse({ success: false, error: String(e) }); }
          })();
          return true; // async
          break;
        case 'stopMapping':
          __mg_mappingAbort.aborted = true; __mg_mappingActive = false;
          sendResponse({ success: true });
          break;
        case 'getMappingStatus':
          sendResponse({ active: __mg_mappingActive, aborted: __mg_mappingAbort.aborted });
          break;
        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    })();

    return true; // keep message channel open for async
  });
  }
