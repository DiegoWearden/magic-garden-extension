// Popup script for Character Movement API Chrome Extension

document.addEventListener('DOMContentLoaded', function() {
  const speedSlider = document.getElementById('speed');
  const speedDisplay = document.getElementById('speedDisplay');
  const moveUpBtn = document.getElementById('moveUp');
  const moveDownBtn = document.getElementById('moveDown');
  const moveLeftBtn = document.getElementById('moveLeft');
  const moveRightBtn = document.getElementById('moveRight');
  const testBtn = document.getElementById('testConnection');
  const mapWallsBtn = document.getElementById('mapWalls');
  const stopMappingBtn = document.getElementById('stopMapping');
  const mappingStatusText = document.getElementById('mappingStatusText');

  // --- Grid viewer setup (81 x 40) ---
  // Columns: 0..80 (81 columns)  — corresponds to GRID_W
  // Rows:    0..39 (40 rows)    — corresponds to GRID_H
  const GRID_W = 81, GRID_H = 40;
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  // Use Math.ceil so cells cover the full canvas and no rows/columns are omitted
  const CELL_W = canvas ? Math.ceil(canvas.width / GRID_W) : 8;
  const CELL_H = canvas ? Math.ceil(canvas.height / GRID_H) : 8;

  // Colors
  const COLOR_UNKNOWN = '#d0d7e0';
  const COLOR_VISITED = '#6fe36f';
  const COLOR_WALL = '#000000';
  const COLOR_GRID_LINE = 'rgba(255,255,255,0.03)';

  // State sets (strings "x,y")
  const visitedSet = new Set();
  const wallSet = new Set();

  function clearMapState() {
    visitedSet.clear();
    wallSet.clear();
  }

  function drawMap() {
    if (!ctx || !canvas) return;
    // clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // draw unknown background
    ctx.fillStyle = COLOR_UNKNOWN;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // draw walls
    wallSet.forEach(k => {
      const parts = k.split(',');
      if (parts.length !== 2) return;
      const x = Number(parts[0]), y = Number(parts[1]);
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      ctx.fillStyle = COLOR_WALL;
      ctx.fillRect(x * CELL_W, y * CELL_H, CELL_W, CELL_H);
    });

    // draw visited
    visitedSet.forEach(k => {
      if (wallSet.has(k)) return; // wall beats visited
      const parts = k.split(',');
      const x = Number(parts[0]), y = Number(parts[1]);
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      ctx.fillStyle = COLOR_VISITED;
      ctx.fillRect(x * CELL_W, y * CELL_H, CELL_W, CELL_H);
    });

    // light grid lines for readability
    ctx.strokeStyle = COLOR_GRID_LINE;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= GRID_W; i++) {
      const px = i * CELL_W + 0.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, canvas.height); ctx.stroke();
    }
    for (let j = 0; j <= GRID_H; j++) {
      const py = j * CELL_H + 0.5;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(canvas.width, py); ctx.stroke();
    }
  }

  function markVisited(x, y) {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const key = x + ',' + y;
    if (wallSet.has(key)) return; // don't mark walls as visited
    if (!visitedSet.has(key)) {
      visitedSet.add(key);
      drawMap();
    }
  }

  function markWall(x, y) {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const key = x + ',' + y;
    if (!wallSet.has(key)) {
      wallSet.add(key);
      // remove from visited if present
      if (visitedSet.has(key)) visitedSet.delete(key);
      drawMap();
      persistWalls();
    }
  }

  // Allow removing a wall
  function unmarkWall(x, y) {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const key = x + ',' + y;
    if (wallSet.has(key)) {
      wallSet.delete(key);
      drawMap();
      persistWalls();
    }
  }

  // Persist current wallSet to storage (chrome.storage.local preferred, fallback to localStorage)
  function persistWalls() {
    try {
      const arr = Array.from(wallSet).map(k => {
        const parts = k.split(',');
        return { x: Number(parts[0]), y: Number(parts[1]) };
      });
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ mg_walls: arr }, function() { /* noop */ });
        return;
      }
    } catch (e) {
      // ignore
    }
    try {
      const arr = Array.from(wallSet).map(k => {
        const parts = k.split(',');
        return { x: Number(parts[0]), y: Number(parts[1]) };
      });
      localStorage.setItem('mg_walls', JSON.stringify(arr));
    } catch (e) { /* ignore */ }
  }

  // Make the map canvas editable: click/drag to paint or erase walls
  (function setupCanvasEditing() {
    if (!canvas) return;
    canvas.style.cursor = 'crosshair';

    let isDrawing = false;
    let paintMode = 'paint'; // 'paint' to add walls, 'erase' to remove

    function coordFromEvent(evtClientX, evtClientY) {
      const rect = canvas.getBoundingClientRect();
      const cx = Math.floor((evtClientX - rect.left) / CELL_W);
      const cy = Math.floor((evtClientY - rect.top) / CELL_H);
      return { x: cx, y: cy };
    }

    canvas.addEventListener('mousedown', function(e) {
      e.preventDefault();
      const p = coordFromEvent(e.clientX, e.clientY);
      const key = p.x + ',' + p.y;
      paintMode = wallSet.has(key) ? 'erase' : 'paint';
      if (paintMode === 'paint') markWall(p.x, p.y); else unmarkWall(p.x, p.y);
      isDrawing = true;
    });

    window.addEventListener('mouseup', function() { isDrawing = false; });

    canvas.addEventListener('mousemove', function(e) {
      if (!isDrawing) return;
      const p = coordFromEvent(e.clientX, e.clientY);
      if (paintMode === 'paint') markWall(p.x, p.y); else unmarkWall(p.x, p.y);
    });

    // Touch support
    canvas.addEventListener('touchstart', function(e) {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      const p = coordFromEvent(t.clientX, t.clientY);
      const key = p.x + ',' + p.y;
      paintMode = wallSet.has(key) ? 'erase' : 'paint';
      if (paintMode === 'paint') markWall(p.x, p.y); else unmarkWall(p.x, p.y);
      isDrawing = true;
    }, { passive: false });

    canvas.addEventListener('touchmove', function(e) {
      e.preventDefault();
      if (!isDrawing) return;
      const t = e.touches[0];
      if (!t) return;
      const p = coordFromEvent(t.clientX, t.clientY);
      if (paintMode === 'paint') markWall(p.x, p.y); else unmarkWall(p.x, p.y);
    }, { passive: false });

    canvas.addEventListener('touchend', function() { isDrawing = false; });

    // Prevent the default context menu on the canvas (helps when right-clicking)
    canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });
  })();

  // Try to load persisted walls from chrome.storage.local (fallback to localStorage)
  function loadPersistedWalls() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['mg_walls'], function(result) {
          try {
            const arr = (result && result.mg_walls) ? result.mg_walls : [];
            arr.forEach(p => { if (p && typeof p.x === 'number' && typeof p.y === 'number') markWall(Math.round(p.x), Math.round(p.y)); });
            drawMap();
          } catch (e) { /* ignore */ }
        });
        return;
      }
    } catch (e) {}

    // fallback localStorage
    try {
      const raw = localStorage.getItem('mg_walls');
      const arr = raw ? JSON.parse(raw) : [];
      (arr || []).forEach(p => { if (p && typeof p.x === 'number' && typeof p.y === 'number') markWall(Math.round(p.x), Math.round(p.y)); });
      drawMap();
    } catch (e) { /* ignore */ }
  }

  // Watch for storage changes so mapping can update the popup map in real-time
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area !== 'local') return;
      if (changes.mg_walls && changes.mg_walls.newValue) {
        try {
          const arr = changes.mg_walls.newValue || [];
          arr.forEach(p => { if (p && typeof p.x === 'number' && typeof p.y === 'number') markWall(Math.round(p.x), Math.round(p.y)); });
        } catch (e) {}
        drawMap();
      }
    });
  }

  // Polling for player position while popup open
  let pollIntervalId = null;
  function startPositionPolling(intervalMs = 400) {
    if (pollIntervalId) return;
    pollIntervalId = setInterval(requestCurrentPositionAndMark, intervalMs);
    // immediate first tick
    requestCurrentPositionAndMark();
  }
  function stopPositionPolling() { if (pollIntervalId) { clearInterval(pollIntervalId); pollIntervalId = null; } }

  function requestCurrentPositionAndMark() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: 'getPlayerPosition' }, function(resp) {
        if (chrome.runtime.lastError) return; // content script not available
        if (!resp || !resp.success || !resp.pos) return;
        try {
          const pos = resp.pos;
          const x = Math.round(Number(pos.x));
          const y = Math.round(Number(pos.y));
          if (!Number.isNaN(x) && !Number.isNaN(y)) markVisited(x, y);
        } catch (e) { /* ignore */ }
      });
    });
  }

  // Ensure map loads persisted walls on popup open and start polling
  loadPersistedWalls();
  drawMap();
  startPositionPolling(450);

  // Stop polling when popup unloads
  window.addEventListener('unload', function() { stopPositionPolling(); });

  // Update map when mapping progress messages are received (visited/walls counts only)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function(msg) {
      try {
        if (msg && msg.action === 'mappingProgress') {
          mappingStatusText.textContent = 'visited: ' + (msg.visited || 0) + ' — walls: ' + (msg.walls || 0);
          // load persisted walls (they may be updated periodically)
          loadPersistedWalls();
        }
      } catch (e) { /* ignore */ }
    });
  }

  // Focus the popup container so it receives keyboard events
  const popupContainer = document.getElementById('popupContainer');
  if (popupContainer) {
    popupContainer.focus();
  }

  // Continuous movement state
  const activeKeys = {}; // key -> intervalId
  function getIntervalMs() {
    const speed = parseInt(speedSlider.value, 10) || 10;
    // Map speed (1-50) to interval ms (500ms down to ~20ms)
    return Math.max(20, Math.floor(600 / speed));
  }

  function startContinuousMove(key) {
    const normalized = key.toLowerCase();
    if (activeKeys[normalized]) return; // already moving

    // Send one immediate movement command
    triggerMoveForKey(normalized);

    // Then start interval
    const id = setInterval(() => triggerMoveForKey(normalized), getIntervalMs());
    activeKeys[normalized] = id;
  }

  function stopContinuousMove(key) {
    const normalized = key.toLowerCase();
    const id = activeKeys[normalized];
    if (id) {
      clearInterval(id);
      delete activeKeys[normalized];
    }
  }

  function triggerMoveForKey(k) {
    switch(k) {
      case 'w': executeMovement('moveUp'); break;
      case 's': executeMovement('moveDown'); break;
      case 'a': executeMovement('moveLeft'); break;
      case 'd': executeMovement('moveRight'); break;
    }
  }

  // Listen on the container so popup must be focused (we auto-focus above)
  if (popupContainer) {
    popupContainer.addEventListener('keydown', function(e) {
      const key = e.key.toLowerCase();
      if (['w','a','s','d'].includes(key)) {
        e.preventDefault();
        startContinuousMove(key);
      }
    });

    popupContainer.addEventListener('keyup', function(e) {
      const key = e.key.toLowerCase();
      if (['w','a','s','d'].includes(key)) {
        e.preventDefault();
        stopContinuousMove(key);
      }
    });

    // If the popup loses focus (e.g., user clicks outside), stop all movements
    popupContainer.addEventListener('blur', function() {
      Object.keys(activeKeys).forEach(k => stopContinuousMove(k));
    });
  }

  // Safe storage wrapper: prefer chrome.storage.sync, fallback to localStorage
  const storage = (function() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        return {
          get: function(keys, cb) { chrome.storage.sync.get(keys, cb); },
          set: function(obj, cb) { chrome.storage.sync.set(obj, cb || function(){}); }
        };
      }
    } catch (e) {
      // ignore
    }
    // fallback
    return {
      get: function(keys, cb) {
        const result = {};
        (keys || []).forEach(function(k) {
          try {
            result[k] = JSON.parse(localStorage.getItem(k));
          } catch (e) {
            result[k] = localStorage.getItem(k);
          }
        });
        console.warn('popup: using localStorage fallback for keys', keys);
        cb(result);
      },
      set: function(obj, cb) {
        Object.keys(obj || {}).forEach(function(k) {
          try { localStorage.setItem(k, JSON.stringify(obj[k])); } catch (e) { localStorage.setItem(k, String(obj[k])); }
        });
        if (cb) cb();
      }
    };
  })();

  // Load saved settings
  storage.get(['speed'], function(result) {
    const speed = (result && result.speed) || 10;
    if (speedSlider) speedSlider.value = speed;
    if (speedDisplay) speedDisplay.textContent = speed;
  });

  // Speed slider event listener
  speedSlider.addEventListener('input', function() {
    const speed = parseInt(this.value);
    speedDisplay.textContent = speed;
    
    // Save speed setting
    storage.set({ speed: speed });
    
    // Update speed in content script
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'setSpeed',
        speed: speed
      });
    });
  });

  // Movement button event listeners
  moveUpBtn.addEventListener('click', function() {
    console.log('popup: moveUp button clicked');
    executeMovement('moveUp');
    // request immediate position update
    setTimeout(requestCurrentPositionAndMark, 120);
  });

  moveDownBtn.addEventListener('click', function() {
    console.log('popup: moveDown button clicked');
    executeMovement('moveDown');
    setTimeout(requestCurrentPositionAndMark, 120);
  });

  moveLeftBtn.addEventListener('click', function() {
    console.log('popup: moveLeft button clicked');
    executeMovement('moveLeft');
    setTimeout(requestCurrentPositionAndMark, 120);
  });

  moveRightBtn.addEventListener('click', function() {
    console.log('popup: moveRight button clicked');
    executeMovement('moveRight');
    setTimeout(requestCurrentPositionAndMark, 120);
  });

  testBtn.addEventListener('click', function() {
    console.log('popup: testConnection button clicked');
    testGameConnection();
  });

  // Function to execute movement commands
  function executeMovement(action) {
    console.log('popup: sending action to tab', action);
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: action
        }, function(response) {
          if (chrome.runtime.lastError) {
            console.log('popup: sendMessage error', chrome.runtime.lastError.message);
            // Try to inject content script if it's not loaded
            chrome.scripting.executeScript({
              target: { tabId: tabs[0].id },
              files: ['content.js']
            });
          } else {
            console.log('popup: received response from content script', response);
          }
        });
      } else {
        console.log('popup: no active tab found');
      }
    });
  }

  // Function to test game connection
  function testGameConnection() {
    console.log('popup: testing game connection');
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'testConnection'
        }, function(response) {
          if (chrome.runtime.lastError) {
            console.log('popup: testConnection error', chrome.runtime.lastError.message);
            alert('Game connection failed. Make sure you are on the Magic Garden game page.');
          } else {
            console.log('popup: testConnection response', response);
            alert('Game connection successful! You can now control your character.');
          }
        });
      } else {
        console.log('popup: no active tab for testConnection');
      }
    });
  }

  // Add keyboard shortcuts for popup
  document.addEventListener('keydown', function(e) {
    switch(e.key.toLowerCase()) {
      case 'w':
        moveUpBtn.click();
        break;
      case 's':
        moveDownBtn.click();
        break;
      case 'a':
        moveLeftBtn.click();
        break;
      case 'd':
        moveRightBtn.click();
        break;
    }
  });

  function setMappingUI(active) {
    if (active) {
      mapWallsBtn.style.display = 'none';
      stopMappingBtn.style.display = '';
      mappingStatusText.textContent = 'mapping...';
    } else {
      mapWallsBtn.style.display = '';
      stopMappingBtn.style.display = 'none';
      mappingStatusText.textContent = 'idle';
    }
  }

  // Listen for runtime messages (mapping progress) sent from content script
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function(msg, sender) {
      try {
        if (msg && msg.action === 'mappingProgress') {
          mappingStatusText.textContent = 'visited: ' + (msg.visited || 0) + ' — walls: ' + (msg.walls || 0);
        }
      } catch (e) { /* ignore */ }
    });
  }

  // Start mapping button
  if (mapWallsBtn) {
    mapWallsBtn.addEventListener('click', function() {
      setMappingUI(true);
      mappingStatusText.textContent = 'starting...';
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (!tabs[0]) { alert('No active tab'); setMappingUI(false); return; }
        chrome.tabs.sendMessage(tabs[0].id, { action: 'startMapping', options: { maxCells: 2000, saveEvery: 50 } }, function(response) {
          if (chrome.runtime.lastError) {
            console.error('popup: startMapping error', chrome.runtime.lastError.message);
            alert('Failed to start mapping. Make sure the extension is allowed on this page.');
            setMappingUI(false);
            return;
          }
          // mapping finished (response from content script)
          if (response && response.success) {
            mappingStatusText.textContent = 'finished — visited: ' + (response.visited || 0) + ' walls: ' + (response.walls || 0);
          } else {
            mappingStatusText.textContent = 'error: ' + (response && response.error ? response.error : 'unknown');
          }
          setMappingUI(false);
        });
      });
    });
  }

  // Stop mapping button
  if (stopMappingBtn) {
    stopMappingBtn.addEventListener('click', function() {
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (!tabs[0]) { alert('No active tab'); return; }
        chrome.tabs.sendMessage(tabs[0].id, { action: 'stopMapping' }, function(resp) {
          if (chrome.runtime.lastError) {
            console.error('popup: stopMapping error', chrome.runtime.lastError.message);
            alert('Failed to send stop request');
            return;
          }
          mappingStatusText.textContent = 'stopping...';
        });
      });
    });
  }
});
