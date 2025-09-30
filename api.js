// Minimal, clean page-bridge API that exposes a stable surface for controlling the game.
// Keeps mg_modules attachments working by providing MagicGardenAPI + helpers.
(function initAPI() {
  if (window.MagicGardenAPI) return;

  const bus = {
    sendToPage(payload) {
      try { window.postMessage(Object.assign({ source: 'mg-extension' }, payload), '*'); } catch (e) {}
    }
  };

  const api = {
    // internal bridge for mg_modules
    sendToPage: bus.sendToPage,

    // Core controls
    move(direction, distance) {
      bus.sendToPage({ action: 'move', direction, distance });
    },
    triggerKey(code) {
      bus.sendToPage({ action: 'triggerKey', code });
    },
    setPlayerId(playerId) {
      bus.sendToPage({ action: 'setPlayerId', playerId });
    },
    getPlayerPositionSync() {
      try {
        if (typeof window.MagicGardenPageAPI?.getPlayerPosition === 'function') {
          return window.MagicGardenPageAPI.getPlayerPosition();
        }
      } catch (e) {}
      return null;
    },
    async getPlayerPosition() {
      return this.getPlayerPositionSync();
    },

    // WS helpers
    async sendWebSocketMessage(message) {
      try { bus.sendToPage({ action: 'sendWebSocketMessage', message }); return { success: true }; }
      catch (e) { return { success: false, error: String(e) }; }
    },

    // Game state fetch (from local Flask mirror)
    async getFullState() {
      try {
        const res = await fetch('http://127.0.0.1:5000/full_game_state.json', { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
      } catch (e) { return null; }
    },

    async getDiet(petId) {
      try {
        if (!petId) return [];
        const dres = await fetch('http://127.0.0.1:5000/api/pet_diet/' + encodeURIComponent(petId), { cache: 'no-store' });
        if (dres.ok) {
          const diet = await dres.json();
          return Array.isArray(diet) ? diet : [];
        }
      } catch (_) {}
      return [];
    },

    // Test function to debug diet fetching
    async testDiet(petId = 'd324000e-9143-45c3-9d27-1000833d4ade') {
      try {
        console.log('Testing diet for petId:', petId);
        const diet = await this.getDiet(petId);
        console.log('Diet result:', diet);
        return { success: true, petId, diet };
      } catch (e) {
        console.error('Test diet error:', e);
        return { success: false, error: String(e) };
      }
    },

    // Feed a pet by slot number using diets and inventory from local state
    async feedPet(slotNumber) {
      try {
        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        // Resolve the current user's slot: prefer an entry with type === 'user'; if multiple, pick the first
        const userSlot = (state.child.data.userSlots || []).find(s => s && s.type === 'user') || null;
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const petSlots = Array.isArray(userSlot.data.petSlots) ? userSlot.data.petSlots : [];
        const slotIdx = Number(slotNumber);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx >= petSlots.length) {
          return { success: false, error: 'invalid_slot' };
        }
        const petEntry = petSlots[slotIdx];
        const petId = petEntry && petEntry.id;
        if (!petId) {
          return { success: false, error: 'pet_not_found' };
        }

        // Get diet via helper
        let diet = await this.getDiet(petId);
        if (!Array.isArray(diet) || diet.length === 0) {
            console.log('diet_not_found', diet);
          return { success: false, error: 'diet_not_found', petId };
        }

        // Find produce in inventory matching diet order
        const inventoryItems = (userSlot.data && userSlot.data.inventory && Array.isArray(userSlot.data.inventory.items)) ? userSlot.data.inventory.items : [];
        function findProduceBySpecies(speciesName) {
          try {
            const wanted = String(speciesName || '').trim();
            if (!wanted) return null;
            for (let i = 0; i < inventoryItems.length; i++) {
              const it = inventoryItems[i];
              if (it && it.itemType === 'Produce' && String(it.species || '') === wanted) {
                return it;
              }
            }
          } catch (_) {}
          return null;
        }

        let foodItem = null;
        for (let i = 0; i < diet.length; i++) {
          const species = diet[i];
          const found = findProduceBySpecies(species);
          if (found) { foodItem = found; break; }
        }

        if (!foodItem || !foodItem.id) {
          return { success: false, error: 'no_food_in_inventory', petId, tried: diet };
        }

        // Send a feed request over WS. Message shape may vary by server; this is a best-effort default.
        const feedMsg = { scopePath: ["Room", "Quinoa"], type: 'FeedPet', petId: petId, inventoryItemId: foodItem.id };
        await this.sendWebSocketMessage(feedMsg);
        return { success: true, petId, foodId: foodItem.id, species: foodItem.species };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  };

  window.MagicGardenAPI = api;

  // Allow late attachment for mg_modules
  try {
    if (Array.isArray(window.__mg_attachers)) {
      window.__mg_attachers.forEach(fn => { try { fn(window.MagicGardenAPI); } catch(_){} });
      window.__mg_attachers.length = 0;
    }
  } catch (e) {}

  // On load, request the background to inject the pageScript into MAIN world
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'injectPageScript' }, function() {});
    }
  } catch (e) {}

  // Bridge: listen for page messages and forward to background if needed
  window.addEventListener('message', function(event) {
    const data = event && event.data;
    if (!data) return;
    // only accept messages from page bridge
    if (data.source === 'mg-extension-page') {
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          if (data.type === 'wsAll') {
            chrome.runtime.sendMessage({ action: 'wsAllLog', dir: data.dir, msg: data.msg });
          }
          if (data.type === 'farmEvent') {
            // optional: could forward too
            chrome.runtime.sendMessage({ action: 'wsLog', dir: data.dir, msg: data.msg });
          }
        }
      } catch (e) {}
    }
  });

  // Content-side message handler (from popup or other extension surfaces)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        if (!message || !message.action) return;
        switch (message.action) {
          case 'injectPageScript':
            try {
              chrome.runtime.sendMessage({ action: 'injectPageScript' }, resp => sendResponse(resp || { success: true }));
            } catch (e) { sendResponse({ success: false, error: String(e) }); }
            return true;
          case 'moveUp':
            bus.sendToPage({ action: 'move', direction: 'up', distance: 1 });
            sendResponse({ success: true });
            return; 
          case 'moveDown':
            bus.sendToPage({ action: 'move', direction: 'down', distance: 1 });
            sendResponse({ success: true });
            return;
          case 'moveLeft':
            bus.sendToPage({ action: 'move', direction: 'left', distance: 1 });
            sendResponse({ success: true });
            return;
          case 'moveRight':
            bus.sendToPage({ action: 'move', direction: 'right', distance: 1 });
            sendResponse({ success: true });
            return;
          case 'move':
            bus.sendToPage({ action: 'move', direction: message.direction, distance: message.distance });
            sendResponse({ success: true });
            return;
          case 'testConnection':
            sendResponse({ success: true });
            return;
          case 'setSpeed':
            // client-side only; movement cadence handled in popup
            sendResponse({ success: true });
            return;
          case 'getPlayerPosition': {
            const handler = function(ev) {
              const d = ev && ev.data;
              if (!d || d.source !== 'mg-extension-page' || d.type !== 'playerPosition') return;
              window.removeEventListener('message', handler);
              sendResponse({ success: true, pos: d.pos || null });
            };
            window.addEventListener('message', handler);
            bus.sendToPage({ action: 'getPlayerPosition' });
            return true; // async
          }
          case 'startMapping':
            // If you later re-add mapping in page script, forward here
            sendResponse({ success: false, error: 'mapping not implemented in api restart' });
            return;
          case 'stopMapping':
            sendResponse({ success: true });
            return;
        }
      } catch (e) {
        try { sendResponse({ success: false, error: String(e) }); } catch (_) {}
      }
    });
  }
})();


