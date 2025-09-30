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

        // Find the current user's slot by player ID
        const userSlot = (state.child.data.userSlots || []).find(s => s && s.playerId === "p_U3VHpnGsKTYd686j") || null;
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
        const feedMsg = { scopePath: ["Room", "Quinoa"], type: 'FeedPet', petItemId: petId, cropItemId: foodItem.id };
        await this.sendWebSocketMessage(feedMsg);
        return { success: true, petId, foodId: foodItem.id, species: foodItem.species };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Harvest a crop either by species name (string) or by specific slot/index (numbers)
    async harvestCrop(slotOrSpecies, slotIndex) {
      try {
        // Species-mode: find and harvest the first ready crop of the given species
        if (typeof slotOrSpecies === 'string') {
          const itemString = String(slotOrSpecies || '').trim();
          if (!itemString) {
            return { success: false, error: 'invalid_species' };
          }

          const state = await this.getFullState();
          if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
            return { success: false, error: 'state_unavailable' };
          }

          // Find the current user's slot by player ID
          const userSlot = (state.child.data.userSlots || []).find(s => s && s.playerId === "p_U3VHpnGsKTYd686j") || null;
          if (!userSlot || !userSlot.data) {
            return { success: false, error: 'user_slot_not_found' };
          }

          // Garden data
          const tileObjects = (userSlot.data.garden && userSlot.data.garden.tileObjects) || {};
          const currentTime = Date.now();

          // Search through all garden slots for plants of the specified species
          for (const [slotStr, plant] of Object.entries(tileObjects)) {
            if (!plant || plant.objectType !== 'plant' || !plant.slots || !Array.isArray(plant.slots)) {
              continue;
            }
            if (plant.species !== itemString) {
              continue;
            }

            // Check each crop slot in this plant
            for (let i = 0; i < plant.slots.length; i++) {
              const cropEntry = plant.slots[i];
              if (!cropEntry || typeof cropEntry.endTime !== 'number') {
                continue;
              }
              if (currentTime >= cropEntry.endTime) {
                // Found a ready crop! Harvest it
                const slotNum = Number(slotStr);
                const harvestMsg = { 
                  scopePath: ["Room", "Quinoa"], 
                  type: 'HarvestCrop', 
                  slot: slotNum, 
                  slotsIndex: i 
                };
                await this.sendWebSocketMessage(harvestMsg);
                return { 
                  success: true, 
                  species: itemString,
                  slot: slotNum, 
                  slotIndex: i,
                  harvested: true
                };
              }
            }
          }

          // No ready crops of this species found
          return { 
            success: true, 
            species: itemString,
            harvested: false,
            message: 'No ready crops of this species found'
          };
        }

        // Numeric mode: harvest a specific slot/index
        const slotNum = Number(slotOrSpecies);
        const slotsIdx = Number(slotIndex);
        
        if (!Number.isFinite(slotNum) || slotNum < 0) {
          return { success: false, error: 'invalid_slot' };
        }
        
        if (!Number.isFinite(slotsIdx) || slotsIdx < 0) {
          return { success: false, error: 'invalid_slot_index' };
        }

        // Send harvest request over WS
        const harvestMsg = { 
          scopePath: ["Room", "Quinoa"], 
          type: 'HarvestCrop', 
          slot: slotNum, 
          slotsIndex: slotsIdx 
        };
        
        await this.sendWebSocketMessage(harvestMsg);
        return { success: true, slot: slotNum, slotsIndex: slotsIdx };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Feed pet; if no food in inventory, try harvesting per diet then feed
    async feedPetWithHarvest(petSlotNumber) {
      try {
        const normalFeedResult = await this.feedPet(petSlotNumber);
        if (normalFeedResult && normalFeedResult.success) {
          return Object.assign({ method: 'inventory', harvested: false }, normalFeedResult);
        }
        if (!normalFeedResult || normalFeedResult.error !== 'no_food_in_inventory') {
          return normalFeedResult || { success: false, error: 'unknown_error' };
        }

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        // Find the current user's slot by player ID
        const userSlot = (state.child.data.userSlots || []).find(s => s && s.playerId === "p_U3VHpnGsKTYd686j") || null;
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const petSlots = Array.isArray(userSlot.data.petSlots) ? userSlot.data.petSlots : [];
        const slotIdx = Number(petSlotNumber);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx >= petSlots.length) {
          return { success: false, error: 'invalid_slot' };
        }
        const petEntry = petSlots[slotIdx];
        const petId = petEntry && petEntry.id;
        if (!petId) {
          return { success: false, error: 'pet_not_found' };
        }

        const diet = await this.getDiet(petId);
        if (!Array.isArray(diet) || diet.length === 0) {
          return { success: false, error: 'diet_not_found', petId, method: 'harvest_attempted' };
        }

        for (let i = 0; i < diet.length; i++) {
          const species = diet[i];
          const harvestResult = await this.harvestCrop(species);
          if (harvestResult && harvestResult.success && harvestResult.harvested) {
            for (let attempt = 0; attempt < 3; attempt++) {
              const retryFeedResult = await this.feedPet(petSlotNumber);
              if (retryFeedResult && retryFeedResult.success) {
                return Object.assign({
                  method: 'harvest_and_feed',
                  harvested: true,
                  harvestedSpecies: species,
                  harvestSlot: harvestResult.slot,
                  harvestSlotIndex: harvestResult.slotIndex != null ? harvestResult.slotIndex : harvestResult.slotsIndex
                }, retryFeedResult);
              }
              await new Promise(r => setTimeout(r, 250));
            }
            return {
              success: false,
              error: 'harvest_succeeded_but_feed_failed',
              petId,
              method: 'harvest_and_feed',
              harvested: true,
              harvestedSpecies: species,
              harvestSlot: harvestResult.slot,
              harvestSlotIndex: harvestResult.slotIndex != null ? harvestResult.slotIndex : harvestResult.slotsIndex
            };
          }
        }

        return {
          success: false,
          error: 'no_harvestable_crops_for_diet',
          petId,
          method: 'harvest_attempted',
          diet: diet
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Get current inventory items
    async getInventory() {
      try {
        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        // Find the current user's slot by player ID
        const userSlot = (state.child.data.userSlots || []).find(s => s && s.playerId === "p_U3VHpnGsKTYd686j") || null;
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const inventoryItems = (userSlot.data && userSlot.data.inventory && Array.isArray(userSlot.data.inventory.items)) 
          ? userSlot.data.inventory.items 
          : [];

        return { success: true, items: inventoryItems };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Get current garden state
    async getCurrentGarden() {
      try {
        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        // Find the current user's slot by player ID
        const userSlot = (state.child.data.userSlots || []).find(s => s && s.playerId === "p_U3VHpnGsKTYd686j") || null;
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        // Garden data is in the user's slot
        const gardenData = userSlot.data.garden || {};

        return { success: true, garden: gardenData.tileObjects };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Check if a crop is ready for harvesting
    async isCropReady(slot, slotIndex) {
      try {
        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        // Find the current user's slot by player ID
        const userSlot = (state.child.data.userSlots || []).find(s => s && s.playerId === "p_U3VHpnGsKTYd686j") || null;
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        // Get garden data
        const gardenData = userSlot.data.garden || {};
        const tileObjects = gardenData.tileObjects || {};
        
        // Find the plant at the specified slot
        const plant = tileObjects[String(slot)];
        if (!plant || !plant.slots || !Array.isArray(plant.slots)) {
          return { success: false, error: 'plant_not_found' };
        }

        // Check if slotIndex is valid
        const slotIdx = Number(slotIndex);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx >= plant.slots.length) {
          return { success: false, error: 'invalid_slot_index' };
        }

        // Get the crop entry
        const cropEntry = plant.slots[slotIdx];
        if (!cropEntry || typeof cropEntry.endTime !== 'number') {
          return { success: false, error: 'crop_data_invalid' };
        }

        // Check if crop is ready (current time >= end time)
        const currentTime = Date.now();
        const isReady = currentTime >= cropEntry.endTime;

        return { 
          success: true, 
          isReady, 
          currentTime, 
          endTime: cropEntry.endTime,
          timeRemaining: Math.max(0, cropEntry.endTime - currentTime)
        };
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


