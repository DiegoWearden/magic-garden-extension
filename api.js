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
    // dynamic player id cached from page/bkg
    _playerId: (function(){ try { return localStorage.getItem('mg_player_id') || null; } catch(_) { return null; } })(),
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
      try {
        const pid = String(playerId || '').replace(/^\"|\"$/g, '') || null;
        try { localStorage.setItem('mg_player_id', pid || ''); } catch(_) {}
        this._playerId = pid;
      } catch(_) {}
      bus.sendToPage({ action: 'setPlayerId', playerId });
    },
    // Resolve current user's slot dynamically
    _getCurrentUserSlotFromState(state) {
      try {
        const slots = state?.child?.data?.userSlots;
        if (!Array.isArray(slots)) return null;
        // Prefer explicit playerId if known
        const pid = this._playerId && String(this._playerId);
        if (pid) {
          const byId = slots.find(s => s && String(s.playerId || '') === pid);
          if (byId) return byId;
        }
        // Fallback heuristics: if exactly one slot, use it; otherwise prefer the one with inventory/garden
        if (slots.length === 1) return slots[0] || null;
        const rich = slots.find(s => s && s.data && (s.data.inventory || s.data.garden));
        return rich || (slots[0] || null);
      } catch(_) { return null; }
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

    // Extract mutations from a pet in the inventory by inventory slot number
    async extractPetMutations(slot) {
      try {
        const slotNum = Number(slot);
        if (!Number.isFinite(slotNum) || slotNum < 0) {
          return { success: false, error: 'invalid_slot' };
        }

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const inv = userSlot.data.inventory;
        const items = Array.isArray(inv) ? inv : (Array.isArray(inv?.items) ? inv.items : []);

        if (slotNum >= items.length) {
          return { success: false, error: 'slot_out_of_range' };
        }

        const item = items[slotNum];
        if (!item || item.itemType !== 'Pet') {
          return { success: false, error: 'not_a_pet' };
        }

        const mutations = Array.isArray(item.mutations) ? item.mutations.slice() : [];
        return { success: true, slot: slotNum, mutations };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // WS helpers
    async sendWebSocketMessage(message) {
      try { bus.sendToPage({ action: 'sendWebSocketMessage', message }); return { success: true }; }
      catch (e) { return { success: false, error: String(e) }; }
    },

    // Internal: compile a boolean expression over mutations into a predicate function
    // Supported identifiers (case-insensitive): wet, chilled, frozen, ambershine, dawnlit, dawncharged, ambercharged, gold, rainbow
    // Operators: &&, ||, !, parentheses
    _compileMutationExpr(expression) {
      try {
        const raw = String(expression || '').toLowerCase().trim();
        if (!raw) return () => false;
        const identifiers = ['wet','chilled','frozen','ambershine','dawnlit','dawncharged','ambercharged','gold','rainbow'];
        
        return function predicate(mutationsArray) {
          try {
            // Build mutation set
            const set = new Set();
            const arr = Array.isArray(mutationsArray) ? mutationsArray : [];
            for (let i = 0; i < arr.length; i++) {
              const m = arr[i];
              if (typeof m === 'string') {
                const s = m.toLowerCase().trim();
                if (s) set.add(s);
              } else if (m && typeof m === 'object') {
                for (const [k, v] of Object.entries(m)) {
                  const key = String(k || '').toLowerCase();
                  if (v === true || v === 'true' || v === 1) set.add(key);
                  else if (typeof v === 'string') {
                    const sv = v.toLowerCase().trim();
                    if (sv) set.add(sv);
                  }
                }
              }
            }
            
            // Simple expression evaluator without eval
            let expr = raw;
            // Replace identifiers with true/false based on set
            identifiers.forEach(id => {
              const re = new RegExp(`\\b${id}\\b`, 'g');
              expr = expr.replace(re, set.has(id) ? 'true' : 'false');
            });
            
            // Now expr should only have true, false, &&, ||, !, (, )
            // Safe to eval in a controlled way
            expr = expr.replace(/&&/g, '&').replace(/\|\|/g, '|');
            
            // Manual evaluation
            const evaluate = (s) => {
              s = s.trim();
              // Handle negation
              if (s.startsWith('!')) {
                return !evaluate(s.substring(1).trim());
              }
              // Handle parentheses
              while (s.includes('(')) {
                const start = s.lastIndexOf('(');
                const end = s.indexOf(')', start);
                if (end === -1) return false;
                const inner = s.substring(start + 1, end);
                const result = evaluate(inner);
                s = s.substring(0, start) + (result ? 'true' : 'false') + s.substring(end + 1);
              }
              // Handle OR
              if (s.includes('|')) {
                const parts = s.split('|').map(p => p.trim());
                return parts.some(p => evaluate(p));
              }
              // Handle AND
              if (s.includes('&')) {
                const parts = s.split('&').map(p => p.trim());
                return parts.every(p => evaluate(p));
              }
              // Base case
              return s === 'true';
            };
            
            return evaluate(expr);
          } catch (e) { return false; }
        };
      } catch (e) { return () => false; }
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

        // Find the current user's slot dynamically
        const userSlot = this._getCurrentUserSlotFromState(state);
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

          // Find the current user's slot dynamically
          const userSlot = this._getCurrentUserSlotFromState(state);
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

    // Plant a crop (seed) by species into a garden slot
    async plantCrop(cropID, slot) {
      try {
        const species = String(cropID || '').trim();
        const slotNum = Number(slot);
        if (!species) return { success: false, error: 'invalid_species' };
        if (!Number.isFinite(slotNum) || slotNum < 0) return { success: false, error: 'invalid_slot' };

        // Optionally could validate tile emptiness from state, but send directly for responsiveness
        const msg = { scopePath: ["Room", "Quinoa"], type: 'PlantSeed', slot: slotNum, species };
        const res = await this.sendWebSocketMessage(msg);
        if (res && res.success) return { success: true, slot: slotNum, species };
        return { success: false, error: (res && res.error) || 'send_failed' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Plant an egg in a garden slot
    async plantEgg(eggId, slot) {
      try {
        const eggName = String(eggId || '').trim();
        const slotNum = Number(slot);
        if (!eggName) return { success: false, error: 'invalid_egg_id' };
        if (!Number.isFinite(slotNum) || slotNum < 0) return { success: false, error: 'invalid_slot' };

        const msg = { scopePath: ["Room", "Quinoa"], type: 'PlantEgg', slot: slotNum, eggId: eggName };
        const res = await this.sendWebSocketMessage(msg);
        if (res && res.success) return { success: true, slot: slotNum, eggId: eggName };
        return { success: false, error: (res && res.error) || 'send_failed' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Hatch an egg in a garden slot
    async hatchEgg(slot) {
      try {
        const slotNum = Number(slot);
        if (!Number.isFinite(slotNum) || slotNum < 0) return { success: false, error: 'invalid_slot' };

        const msg = { scopePath: ["Room", "Quinoa"], type: 'HatchEgg', slot: slotNum };
        const res = await this.sendWebSocketMessage(msg);
        if (res && res.success) return { success: true, slot: slotNum };
        return { success: false, error: (res && res.error) || 'send_failed' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Sell a pet by its item ID
    async sellPet(petId) {
      try {
        const itemId = String(petId || '').trim();
        if (!itemId) return { success: false, error: 'invalid_pet_id' };

        const msg = { scopePath: ["Room", "Quinoa"], type: 'SellPet', itemId };
        const res = await this.sendWebSocketMessage(msg);
        if (res && res.success) return { success: true, itemId };
        return { success: false, error: (res && res.error) || 'send_failed' };
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

        // Find the current user's slot dynamically
        const userSlot = this._getCurrentUserSlotFromState(state);
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

    // Get the current hunger value for a pet slot
    async getPetHunger(slotNumber) {
      try {
        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        // Find the current user's slot dynamically
        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const petSlots = Array.isArray(userSlot.data.petSlots) ? userSlot.data.petSlots : [];
        const slotIdx = Number(slotNumber);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx >= petSlots.length) {
          return { success: false, error: 'invalid_slot' };
        }

        const petEntry = petSlots[slotIdx];
        if (!petEntry || !petEntry.id) {
          return { success: false, error: 'pet_not_found' };
        }

        const hunger = typeof petEntry.hunger === 'number' ? petEntry.hunger : null;
        if (hunger == null) {
          return { success: false, error: 'hunger_unavailable', petId: petEntry.id, slot: slotIdx };
        }

        return { success: true, hunger, petId: petEntry.id, slot: slotIdx };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Get petId of a currently active pet slot (valid 0..2)
    async getPetId(slotNumber) {
      try {
        const slotIdx = Number(slotNumber);
        if (!Number.isFinite(slotIdx) || slotIdx < 0 || slotIdx > 2) {
          return { success: false, error: 'invalid_slot', slot: slotNumber };
        }

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'no_state' };
        }

        // Resolve current user's slot dynamically
        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'no_user_slot' };
        }

        const petSlots = Array.isArray(userSlot.data.petSlots) ? userSlot.data.petSlots : [];
        if (slotIdx >= petSlots.length) {
          return { success: false, error: 'slot_out_of_range', slot: slotIdx };
        }

        const petEntry = petSlots[slotIdx];
        const petId = petEntry && petEntry.id ? petEntry.id : null;
        if (!petId) {
          return { success: false, error: 'pet_not_found', slot: slotIdx };
        }

        return { success: true, petId, slot: slotIdx };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // New: return all active pet IDs and details for the current user's slot
    async getAllActivePetIds() {
      try {
        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'no_state' };
        }

        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'no_user_slot' };
        }

        const petSlots = Array.isArray(userSlot.data.petSlots) ? userSlot.data.petSlots : [];
        const pets = petSlots.map((p, idx) => ({ slot: idx, id: p && p.id ? p.id : null, petSpecies: p && p.petSpecies ? p.petSpecies : null, name: p && p.name ? p.name : null, xp: p && typeof p.xp === 'number' ? p.xp : null, hunger: p && typeof p.hunger === 'number' ? p.hunger : null }));
        const petIds = pets.map(p => p.id).filter(Boolean);
        return { success: true, count: petIds.length, petIds, pets };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // New: copy active pet ids to clipboard (newline-separated)
    async copyActivePetIds() {
      try {
        const res = await this.getAllActivePetIds();
        if (!res || !res.success) return res;
        const text = (res.petIds || []).join('\n');
        if (!text) return { success: false, error: 'no_pet_ids' };
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return { success: true, copied: true, text };
          }
          // Fallback: attempt execCommand trick
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed'; ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand && document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) return { success: true, copied: true, text };
          return { success: false, error: 'clipboard_unavailable', text };
        } catch (e) {
          return { success: false, error: 'clipboard_error', reason: String(e), text };
        }
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Get the max hunger value for a pet slot
    async getPetMaxHunger(slotNumber) {
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
        if (!petEntry || !petEntry.id) {
          return { success: false, error: 'pet_not_found' };
        }

        // Prefer reading from combined diets file served by local Flask (includes maxHunger)
        try {
          const res = await fetch('http://127.0.0.1:5000/mg_pet_diets.json', { cache: 'no-store' });
          if (res && res.ok) {
            const combined = await res.json();
            const pets = combined && typeof combined === 'object' && combined.pets && typeof combined.pets === 'object'
              ? combined.pets
              : (combined && typeof combined === 'object' ? combined : null);
            const cfg = pets ? pets[String(petEntry.id)] : null;
            const mh = cfg && typeof cfg.maxHunger === 'number' ? cfg.maxHunger : (
              cfg && typeof cfg.maxHunger === 'string' && isFinite(parseInt(cfg.maxHunger, 10)) ? parseInt(cfg.maxHunger, 10) : null
            );
            if (typeof mh === 'number') {
              return { success: true, maxHunger: mh, petId: petEntry.id, slot: slotIdx };
            }
          }
        } catch (_) {}

        // Fallback: sometimes maxHunger is present on the pet entry in state
        const mhState = typeof petEntry.maxHunger === 'number' ? petEntry.maxHunger : null;
        if (mhState != null) {
          return { success: true, maxHunger: mhState, petId: petEntry.id, slot: slotIdx };
        }

        return { success: false, error: 'max_hunger_unavailable', petId: petEntry.id, slot: slotIdx };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Feed a pet repeatedly until hunger >= maxHunger - 10, or out of available food
    async feedPetUntilMax(slotNumber, options = {}) {
      try {
        const hungerPadding = Number.isFinite(options.hungerPadding) ? options.hungerPadding : 10;
        const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : 25;
        const maxStalls = Number.isFinite(options.maxStalls) ? options.maxStalls : 2;

        const slotIdx = Number(slotNumber);
        if (!Number.isFinite(slotIdx) || slotIdx < 0) return { success: false, error: 'invalid_slot' };

        const h0 = await this.getPetHunger(slotIdx);
        if (!h0 || !h0.success) return { success: false, error: 'hunger_unavailable' };
        let prevHunger = typeof h0.hunger === 'number' ? h0.hunger : 0;

        const mh = await this.getPetMaxHunger(slotIdx);
        const target = mh && mh.success && typeof mh.maxHunger === 'number' ? (mh.maxHunger - hungerPadding) : Infinity;

        let fedCount = 0;
        let stalls = 0;

        for (let step = 0; step < maxSteps; step++) {
          if (prevHunger >= target) {
            return { success: true, fed: fedCount, finalHunger: prevHunger, reason: 'maxed' };
          }

          const res = await this.feedPetWithHarvest(slotIdx);
          if (!res || !res.success) {
            // Out of food or other terminal condition
            const err = res && res.error ? String(res.error) : 'unknown_error';
            if (err === 'no_harvestable_crops_for_diet' || err === 'diet_not_found' || err === 'no_food_in_inventory') {
              return { success: true, fed: fedCount, finalHunger: prevHunger, reason: 'out_of_food' };
            }
            // Non-terminal error, stop to avoid loops
            return { success: false, fed: fedCount, finalHunger: prevHunger, error: err };
          }

          fedCount += 1;

          // Give state a moment to update, then re-read hunger
          await new Promise(r => setTimeout(r, 300));
          const hx = await this.getPetHunger(slotIdx);
          if (!hx || !hx.success || typeof hx.hunger !== 'number') {
            return { success: true, fed: fedCount, finalHunger: null, reason: 'hunger_unavailable' };
          }
          const curr = hx.hunger;
          if (curr <= prevHunger) {
            stalls += 1;
            if (stalls >= maxStalls) {
              return { success: true, fed: fedCount, finalHunger: curr, reason: 'stalled' };
            }
          } else {
            stalls = 0;
          }
          prevHunger = curr;

          // Quick break if we've essentially reached target
          if (prevHunger >= target) {
            return { success: true, fed: fedCount, finalHunger: prevHunger, reason: 'maxed' };
          }
        }

        return { success: true, fed: fedCount, finalHunger: prevHunger, reason: 'step_limit' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Start periodic auto-feeding: every 2 seconds, feed any pet with hunger < 500 until maxed/out of food
    startAutoFeeder(options = {}) {
      try {
        const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 2000;
        const hungerThreshold = Number.isFinite(options.hungerThreshold) ? options.hungerThreshold : 500;

        if (this._autoFeederInterval) {
          return { success: false, error: 'auto_feeder_already_running' };
        }

        this._autoFeederInterval = setInterval(async () => {
          try {
            const state = await this.getFullState();
            if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) return;
            const userSlot = this._getCurrentUserSlotFromState(state);
            if (!userSlot || !userSlot.data) return;
            const petSlots = Array.isArray(userSlot.data.petSlots) ? userSlot.data.petSlots : [];

            for (let i = 0; i < petSlots.length; i++) {
              try {
                const h = await this.getPetHunger(i);
                if (!h || !h.success || typeof h.hunger !== 'number') continue;
                if (h.hunger < hungerThreshold) {
                  await this.feedPetUntilMax(i).catch(() => {});
                }
              } catch (_) {}
            }
          } catch (_) {}
        }, intervalMs);

        // persist run state
        try { this._captureRunState(); } catch(_){}

        return { success: true, intervalMs, hungerThreshold };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Stop the auto-feeder if running
    stopAutoFeeder() {
      try {
        if (this._autoFeederInterval) {
          clearInterval(this._autoFeederInterval);
          this._autoFeederInterval = null;
          // persist run state
          try { this._captureRunState(); } catch(_){}
          return { success: true, stopped: true };
        }
        return { success: true, stopped: false };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Start Auto Hatcher: periodically hatch ready eggs and replant based on priority; then sell pets lacking desired mutations
    startAutoHatcher(options = {}) {
      try {
        const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 5000;
        let eggPriority = Array.isArray(options.eggPriority) && options.eggPriority.length > 0
          ? options.eggPriority.map(String)
          : [];
        let eggCatalogCache = null;
        const ensureEggPriority = async () => {
          try {
            if (eggPriority.length > 0) return eggPriority;
            if (!eggCatalogCache) {
              try {
                const resp = await fetch('http://127.0.0.1:5000/discovered_items.json', { cache: 'no-store' });
                if (resp && resp.ok) eggCatalogCache = await resp.json();
              } catch (_) {}
            }
            const eggs = Array.isArray(eggCatalogCache?.egg) ? eggCatalogCache.egg.map(String) : ['MythicalEgg','LegendaryEgg','RareEgg','UncommonEgg','CommonEgg'];
            eggPriority = eggs;
            return eggPriority;
          } catch (_) { return eggPriority; }
        };
        const keepExprRaw = typeof options.keepExpr === 'string' ? options.keepExpr : '';
        const evalKeep = (keepExprRaw && this._compileMutationExpr) ? this._compileMutationExpr(keepExprRaw) : null;
        const doSell = options.sell !== false; // default on

        if (this._autoHatcherInterval) {
          return { success: false, error: 'auto_hatcher_already_running' };
        }

        const tick = async () => {
          try {
            // Ensure egg priority from discovered catalog if not provided
            await ensureEggPriority();

            // Snapshot garden
            const gardenRes = await this.getCurrentGarden();
            if (!gardenRes || !gardenRes.success) return;
            const tileObjects = gardenRes.garden || {};
            const slots = Object.keys(tileObjects).sort((a,b) => (Number(a)||0) - (Number(b)||0));
            const usedSlots = new Set(Object.keys(tileObjects).map(String));
            const findFreeSlot = () => { for (let i = 0; i < 200; i++) { if (!usedSlots.has(String(i))) return i; } return null; };

            // Snapshot inventory for eggs
            const invRes = await this.getInventory();
            const items = (invRes && invRes.success && Array.isArray(invRes.items)) ? invRes.items : [];
            const eggCounts = {};
            for (let i = 0; i < items.length; i++) {
              const it = items[i];
              if (it && it.itemType === 'Egg' && it.eggId) {
                eggCounts[it.eggId] = (eggCounts[it.eggId] || 0) + (Number(it.quantity) || 0);
              }
            }

            const pickEggId = () => {
              for (const id of eggPriority) {
                if (eggCounts[id] > 0) return id;
              }
              const any = Object.keys(eggCounts).find(k => (eggCounts[k] || 0) > 0);
              return any || null;
            };

            const now = Date.now();
            for (let s = 0; s < slots.length; s++) {
              try {
                const slotStr = slots[s];
                const slotNum = Number(slotStr);
                const obj = tileObjects[slotStr];
                if (!obj || obj.objectType !== 'egg') continue;

                // Determine readiness using maturedAt fast path, fallback to API
                let ready = false;
                if (typeof obj.maturedAt === 'number') ready = now >= obj.maturedAt; else {
                  const chk = await this.isEggReady(slotNum);
                  ready = !!(chk && chk.success && chk.isReady);
                }
                if (!ready) continue;

                await this.hatchEgg(slotNum).catch(() => {});
                await new Promise(r => setTimeout(r, 150));

                // mark this slot as free now
                try { usedSlots.delete(String(slotStr)); } catch(_){ }

                const eggId = pickEggId();
                if (eggId) {
                  // find any open tile (0..199)
                  const freeSlot = findFreeSlot();
                  if (Number.isFinite(freeSlot)) {
                    await this.plantEgg(eggId, freeSlot).catch(() => {});
                    eggCounts[eggId] = Math.max(0, (eggCounts[eggId] || 0) - 1);
                    try { usedSlots.add(String(freeSlot)); } catch(_){ }
                    await new Promise(r => setTimeout(r, 150));
                  }
                }
              } catch (_) {}
            }

            // Selling pass: sell pets that do not match keepExpr (if provided)
            try {
              if (!doSell) return;
              // brief grace delay to allow newly hatched pets to appear in inventory
              await new Promise(r => setTimeout(r, 500));
              const invRes2 = await this.getInventory();
              const items2 = (invRes2 && invRes2.success && Array.isArray(invRes2.items)) ? invRes2.items : [];
              // Pre-collect pet IDs to sell based on current snapshot
              const sellIds = [];
              for (let j = 0; j < items2.length; j++) {
                try {
                  const it = items2[j];
                  if (!it || it.itemType !== 'Pet' || !it.id) continue;
                  const muts = Array.isArray(it.mutations) ? it.mutations : [];
                  let keep = false;
                  if (evalKeep) keep = !!evalKeep(muts);
                  if (!keep) sellIds.push(it.id);
                } catch (_) {}
              }
              // Debug: print pre-collected sell list and basic metadata before selling
              try {
                const preview = sellIds.map(id => {
                  try {
                    const it = items2.find(x => x && x.id === id);
                    return {
                      id,
                      petSpecies: it && it.petSpecies,
                      mutations: Array.isArray(it && it.mutations) ? it.mutations : []
                    };
                  } catch (_) { return { id }; }
                });
                console.log('[MG][AutoHatcher] Pre-collect sell list', { totalItems: items2.length, sellCount: sellIds.length, pets: preview });
              } catch (_) {}
              // Execute sells in sequence to avoid index-shift/state-change issues
              for (let k = 0; k < sellIds.length; k++) {
                try {
                  await this.sellPet(sellIds[k]).catch(() => {});
                  await new Promise(r => setTimeout(r, 350));
                } catch (_) {}
              }
            } catch (_) {}
          } catch (_) {}
        };
        // Run immediately once, then on interval
        try { tick(); } catch(_) {}
        this._autoHatcherInterval = setInterval(tick, intervalMs);

        // persist run state
        try { this._captureRunState(); } catch(_){}

        return { success: true, intervalMs, eggPriority, keepExpr: keepExprRaw, sell: doSell };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Stop the auto hatcher if running
    stopAutoHatcher() {
      try {
        if (this._autoHatcherInterval) {
          clearInterval(this._autoHatcherInterval);
          this._autoHatcherInterval = null;
          // persist run state
          try { this._captureRunState(); } catch(_){}
          return { success: true, stopped: true };
        }
        return { success: true, stopped: false };
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

        // Find the current user's slot dynamically
        const userSlot = this._getCurrentUserSlotFromState(state);
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

        // Find the current user's slot dynamically
        const userSlot = this._getCurrentUserSlotFromState(state);
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
    },

    // Check if an egg is ready to hatch
    async isEggReady(slot) {
      try {
        const slotNum = Number(slot);
        if (!Number.isFinite(slotNum) || slotNum < 0) {
          return { success: false, error: 'invalid_slot' };
        }

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        // Get garden data
        const gardenData = userSlot.data.garden || {};
        const tileObjects = gardenData.tileObjects || {};
        
        // Find the egg at the specified slot
        const egg = tileObjects[String(slotNum)];
        if (!egg) {
          return { success: false, error: 'egg_not_found' };
        }

        // Check if it's an egg and has maturedAt property
        if (egg.objectType !== 'egg' || typeof egg.maturedAt !== 'number') {
          return { success: false, error: 'egg_data_invalid' };
        }

        // Check if egg is ready (current time >= matured time)
        const currentTime = Date.now();
        const isReady = currentTime >= egg.maturedAt;

        return { 
          success: true, 
          isReady, 
          currentTime, 
          maturedAt: egg.maturedAt,
          timeRemaining: Math.max(0, egg.maturedAt - currentTime)
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Check if an item at an inventory slot is a pet
    async isPet(slot) {
      try {
        const slotNum = Number(slot);
        if (!Number.isFinite(slotNum) || slotNum < 0) {
          return { success: false, error: 'invalid_slot' };
        }

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        // Inventory may be { items: [...] } (current) or an array (legacy)
        const inv = userSlot.data.inventory;
        const items = Array.isArray(inv) ? inv : (Array.isArray(inv?.items) ? inv.items : []);

        if (slotNum >= items.length) {
          return { success: true, isPet: false, itemType: null };
        }

        const item = items[slotNum];
        if (!item) {
          return { success: true, isPet: false, itemType: null };
        }

        const isPet = item.itemType === 'Pet';
        return {
          success: true,
          isPet,
          itemType: item.itemType || null,
          petSpecies: isPet ? (item.petSpecies || null) : null,
          id: item.id || null
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Extract mutations for a specific garden slot and slotIndex
    async extractMutations(slot, slotIndex) {
      try {
        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        // Resolve current user's slot
        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const gardenData = userSlot.data.garden || {};
        const tileObjects = gardenData.tileObjects || {};
        const plant = tileObjects[String(slot)];
        if (!plant || !Array.isArray(plant.slots)) {
          return { success: false, error: 'plant_not_found' };
        }

        const idx = Number(slotIndex);
        if (!Number.isFinite(idx) || idx < 0 || idx >= plant.slots.length) {
          return { success: false, error: 'invalid_slot_index' };
        }

        const cropEntry = plant.slots[idx] || {};
        const mutations = Array.isArray(cropEntry.mutations) ? cropEntry.mutations.slice() : [];
        return { success: true, slot: Number(slot), slotIndex: idx, mutations };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Alias with common typo
    async extractMuations(slot, slotIndex) {
      return this.extractMutations(slot, slotIndex);
    },

    // Harvest all fruits in a garden slot that have mutations: Frozen AND (Dawnlit OR Ambershine)
    async harvestAllMax(slot, options = {}) {
      try {
      console.log('[MG] harvestAllMax', { slot, options });
        const slotNum = Number(slot);
        if (!Number.isFinite(slotNum) || slotNum < 0) {
          return { success: false, error: 'invalid_slot' };
        }

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }

        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const tileObjects = (userSlot.data.garden && userSlot.data.garden.tileObjects) || {};
        const plant = tileObjects[String(slotNum)];
        if (!plant || !Array.isArray(plant.slots)) {
          return { success: false, error: 'plant_not_found' };
        }

        // Resolve mutation expression from options or saved prefs
        const exprSaved = (function(){ try { return localStorage.getItem('mg_auto_harvest_expr') || ''; } catch(_) { return ''; } })();
        const expr = (options && typeof options.mutationExpr === 'string') ? options.mutationExpr : exprSaved;
        const effectiveExpr = (expr && expr.trim()) ? expr.trim() : 'frozen && (dawnlit || ambershine)';
        console.log('[EXPR] effectiveExpr=', effectiveExpr, 'has compiler?', typeof this._compileMutationExpr);
        const evalMut = typeof this._compileMutationExpr === 'function' ? this._compileMutationExpr(effectiveExpr) : (() => () => false)();
        console.log('[EXPR] evalMut type=', typeof evalMut);

        const wanted = [];
        const nowTs = Date.now();
        for (let i = 0; i < plant.slots.length; i++) {
          try {
            const entry = plant.slots[i] || {};
            const mutsArr = Array.isArray(entry.mutations) ? entry.mutations : [];
            const ready = typeof entry.endTime === 'number' ? (nowTs >= entry.endTime) : false;
            const matches = evalMut(mutsArr);
            console.log(`Slot ${i}: ready=${ready}, mutations=`, mutsArr, 'expr=', effectiveExpr, 'matches=', matches);
            if (ready && matches) {
              wanted.push(i);
            }
          } catch (_) {}
        }

        if (wanted.length === 0) {
          return { success: true, slot: slotNum, harvested: 0, harvestedIndices: [] };
        }

        const harvestedIndices = [];

        for (let j = 0; j < wanted.length; j++) {
          const idx = wanted[j];
          try {
            const result = await this.harvestCrop(slotNum, idx);
            if (result && result.success) {
              harvestedIndices.push(idx);
            }
            await new Promise(r => setTimeout(r, 60));
          } catch (_) {}
        }

        return { success: true, slot: slotNum, harvested: harvestedIndices.length, harvestedIndices };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Run a one-shot Auto Harvester: harvest all fruits meeting max mutation criteria
    // across the garden, optionally restricted to selected species, then replant
    // selected species in their tiles, and finally sell all crops.
    async autoSellOnce(options = {}) {
      try {
        const speciesFilter = new Set(
          (Array.isArray(options.speciesFilter) ? options.speciesFilter : [])
            .map(x => String(x || '').trim())
            .filter(Boolean)
        );
        const replantSet = new Set(
          (Array.isArray(options.replantSpecies) ? options.replantSpecies : [])
            .map(x => String(x || '').trim())
            .filter(Boolean)
        );
        const doSell = options.sell !== false;
        const mutationExpr = typeof options.mutationExpr === 'string' ? options.mutationExpr : (function(){ try { return localStorage.getItem('mg_auto_harvest_expr') || ''; } catch(_) { return ''; } })();

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !Array.isArray(state.child.data.userSlots)) {
          return { success: false, error: 'state_unavailable' };
        }
        const userSlot = this._getCurrentUserSlotFromState(state);
        if (!userSlot || !userSlot.data) {
          return { success: false, error: 'user_slot_not_found' };
        }

        const tileObjects = (userSlot.data.garden && userSlot.data.garden.tileObjects) || {};
        const entries = Object.entries(tileObjects);
        const harvestedByTile = {};
        const replanted = [];
        let totalHarvested = 0;


        for (const [slotStr, plant] of entries) {
          try {
            if (!plant || plant.objectType !== 'plant' || !Array.isArray(plant.slots)) continue;
            const slotNum = Number(slotStr);
            if (!Number.isFinite(slotNum) || slotNum < 0) continue;
            const plantSpecies = String(plant.species || '').trim();
            if (!plantSpecies) continue;
            if (speciesFilter.size > 0 && !speciesFilter.has(plantSpecies)) continue;

            // Use the existing harvestAllMax to harvest all eligible fruits in this tile
            try {
              const res = await this.harvestAllMax(slotNum, { mutationExpr });
              if (res && res.success && typeof res.harvested === 'number' && res.harvested > 0) {
                harvestedByTile[slotNum] = (harvestedByTile[slotNum] || 0) + res.harvested;
                totalHarvested += res.harvested;
              }
            } catch (_) {}

            if (replantSet.has(plantSpecies)) {
              try {
                const pr = await this.plantCrop(plantSpecies, slotNum);
                if (pr && pr.success) replanted.push({ slot: slotNum, species: plantSpecies });
                await new Promise(r => setTimeout(r, 80));
              } catch (_) {}
            }
          } catch (_) {}
        }

        let sold = null;
        if (doSell) {
          try { sold = await (this.sellAllCrops ? this.sellAllCrops() : null); } catch (_) {}
        }

        return {
          success: true,
          harvestedTotal: totalHarvested,
          harvestedByTile,
          replanted,
          soldAttempted: !!doSell,
          sold: sold && sold.success === true
        };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Start periodic Auto Harvester loop; runs autoSellOnce on a schedule.
    startAutoSeller(options = {}) {
      try {
        if (this._autoSellerInterval) {
          return { success: false, error: 'auto_seller_already_running' };
        }
        const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : (function(){ try { return parseInt(localStorage.getItem('mg_auto_seller_interval_ms')||'',10); } catch(_) { return NaN; } })();
        const ms = Number.isFinite(intervalMs) ? intervalMs : (60 * 60 * 1000);
        // Cache options; fall back to saved lists if not provided
        const speciesFilter = Array.isArray(options.speciesFilter) ? options.speciesFilter : (function(){ try { return JSON.parse(localStorage.getItem('mg_auto_seller_harvest_species')||'[]'); } catch(_) { return []; } })();
        const replantSpecies = Array.isArray(options.replantSpecies) ? options.replantSpecies : (function(){ try { return JSON.parse(localStorage.getItem('mg_auto_seller_replant_species')||'[]'); } catch(_) { return []; } })();
        const savedSell = (function(){ try { return localStorage.getItem('mg_auto_seller_sell') !== '0'; } catch(_) { return true; } })();
        const doSell = (typeof options.sell === 'undefined') ? savedSell : !!options.sell;
        this._autoSellerOptions = { speciesFilter, replantSpecies, sell: doSell };
        this._autoSellerBusy = false;

        this._autoSellerInterval = setInterval(async () => {
          if (this._autoSellerBusy) return;
          this._autoSellerBusy = true;
          try {
            await this.autoSellOnce(this._autoSellerOptions);
          } catch (_) {}
          this._autoSellerBusy = false;
        }, ms);

        // persist run state
        try { this._captureRunState(); } catch(_){}

        // Kick off an immediate run once
        (async () => {
          this._autoSellerBusy = true;
          try { await this.autoSellOnce(this._autoSellerOptions); } catch (_) {}
          this._autoSellerBusy = false;
        })();

        return { success: true, intervalMs: ms };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    stopAutoSeller() {
      try {
        if (this._autoSellerInterval) {
          clearInterval(this._autoSellerInterval);
          this._autoSellerInterval = null;
        }
        this._autoSellerOptions = null;
        this._autoSellerBusy = false;
        // persist run state
        try { this._captureRunState(); } catch(_){}
        return { success: true };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    // Get current stock of a shop item by its item string (species/toolId/eggId/decorId)
    async getShopStock(itemString) {
      try {
        const name = String(itemString || '').trim();
        if (!name) return { success: false, error: 'invalid_item' };

        const state = await this.getFullState();
        if (!state || !state.child || !state.child.data || !state.child.data.shops) {
          return { success: false, error: 'state_unavailable' };
        }

        const shops = state.child.data.shops || {};
        const kinds = ['seed','egg','tool','decor'];

        function computeStock(it) {
          try {
            const keys = ['remainingStock','currentStock','stock','available','qty','quantity'];
            for (const k of keys) {
              if (k in (it || {})) {
                const v = it[k];
                if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
                if (typeof v === 'string') {
                  const s = v.trim();
                  if (s && /^-?\d+(?:\.\d+)?$/.test(s)) return Math.max(0, Math.trunc(Number(s)));
                }
              }
            }
            if ('initialStock' in (it || {}) && 'sold' in (it || {})) {
              const initial = Number(it.initialStock || 0);
              const sold = Number(it.sold || 0);
              if (Number.isFinite(initial) && Number.isFinite(sold)) return Math.max(0, Math.trunc(initial - sold));
            }
            const initOnly = Number(it?.initialStock || 0);
            if (Number.isFinite(initOnly)) return Math.max(0, Math.trunc(initOnly));
          } catch (_) {}
          return 0;
        }

        function matchItem(kind, it) {
          try {
            if (!it) return false;
            if (kind === 'seed') return String(it.species || '') === name;
            if (kind === 'tool') return String(it.toolId || '') === name;
            if (kind === 'egg') return String(it.eggId || '') === name;
            if (kind === 'decor') return String(it.decorId || '') === name;
          } catch (_) {}
          return false;
        }

        for (const kind of kinds) {
          const shop = shops[kind];
          if (!shop || !Array.isArray(shop.inventory)) continue;
          for (const it of shop.inventory) {
            if (matchItem(kind, it)) {
              const stock = computeStock(it);
              return {
                success: true,
                item: name,
                kind,
                stock,
                secondsUntilRestock: Number(shop.secondsUntilRestock || 0)
              };
            }
          }
        }

        return { success: false, error: 'item_not_found', item: name };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Wait until a specific shop's countdown reaches 0; logs remaining seconds periodically
    async waitForShopRestock(shopName) {
      try {
        const normalize = (n) => {
          const s = String(n || '').trim().toLowerCase();
          if (!s) return null;
          if (['seed','seeds','seed shop','crop','crops','crop shop'].includes(s)) return 'seed';
          if (['egg','eggs','egg shop'].includes(s)) return 'egg';
          if (['tool','tools','tool shop'].includes(s)) return 'tool';
          if (['decor','decors','decoration','decorations','decor shop'].includes(s)) return 'decor';
          return ['seed','egg','tool','decor'].includes(s) ? s : null;
        };

        const kind = normalize(shopName);
        if (!kind) return { success: false, error: 'invalid_shop' };

        const readFromFullState = async () => {
          try {
            const res = await fetch('http://127.0.0.1:5000/full_game_state.json', { cache: 'no-store' });
            if (!res.ok) return null;
            const j = await res.json();
            const v = j?.child?.data?.shops?.[kind]?.secondsUntilRestock;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          } catch (_) { return null; }
        };

        const getVal = async () => {
          // Prefer authoritative value from local Flask mirror of full state
          const a = await readFromFullState();
          if (a != null) return a;
          // Fallback to in-page countdowns, if available
          try {
            if (typeof this.getShopCountdowns === 'function') {
              const cds = this.getShopCountdowns();
              const n = Number(cds && cds[kind]);
              return Number.isFinite(n) ? n : null;
            }
          } catch (_) {}
          return null;
        };

        // Get initial reading
        let prev = await getVal();
        if (prev != null) {
          try { console.log(`[MG][Shop] ${kind} restock in ${prev}s`); } catch (_) {}
        }

        // Poll until timer reset detected (current > previous)
        for (let i = 0; i < 36000; i++) { // hard cap ~5 hours @ 500ms
          await new Promise(r => setTimeout(r, 500));
          const current = await getVal();
          if (current != null) {
            if (prev != null && current > prev) {
              // Timer reset detected
              try { console.log(`[MG][Shop] ${kind} restock detected (${prev}s -> ${current}s)`); } catch (_) {}
              return { success: true, kind, seconds: current, reset: true };
            }
            if (current !== prev) {
              try { console.log(`[MG][Shop] ${kind} restock in ${current}s`); } catch (_) {}
            }
            prev = current;
          }
        }
        return { success: false, error: 'timeout' };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Wait using a single countdown read: fetch secondsUntilRestock once and sleep that long
    async waitForShopCountdown(shopName) {
      try {
        const normalize = (n) => {
          const s = String(n || '').trim().toLowerCase();
          if (!s) return null;
          if (['seed','seeds','seed shop','crop','crops','crop shop'].includes(s)) return 'seed';
          if (['egg','eggs','egg shop'].includes(s)) return 'egg';
          if (['tool','tools','tool shop'].includes(s)) return 'tool';
          if (['decor','decors','decoration','decorations','decor shop'].includes(s)) return 'decor';
          return ['seed','egg','tool','decor'].includes(s) ? s : null;
        };
        const kind = normalize(shopName);
        if (!kind) return { success: false, error: 'invalid_shop' };

        const sec = await (async () => {
          try {
            const res = await fetch('http://127.0.0.1:5000/full_game_state.json', { cache: 'no-store' });
            if (!res.ok) return null;
            const j = await res.json();
            const v = j?.child?.data?.shops?.[kind]?.secondsUntilRestock;
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(0, n) : null;
          } catch (_) { return null; }
        })();

        const seconds = (sec == null) ? 1 : sec; // fallback: 1s if unknown
        try { console.log(`[MG][Shop] ${kind} waiting ${seconds}s for next cycle`); } catch (_) {}
        const waitMs = Math.max(200, Math.round(seconds * 1000) + 200);
        await new Promise(r => setTimeout(r, waitMs));
        return { success: true, kind, seconds };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    // Internal: resolve shop matches for a list of item ids (species/toolId/eggId/decorId)
    async _resolveShopItems(itemIds) {
      try {
        const wanted = new Set((Array.isArray(itemIds) ? itemIds : []).map(x => String(x || '').trim()).filter(Boolean));
        if (wanted.size === 0) return [];
        // Prefer live shop snapshot from mg_modules/shops.js
        const snap = (typeof this.getShopSnapshot === 'function') ? this.getShopSnapshot() : null;
        const shops = snap?.shops || (await (async () => {
          const st = await this.getFullState();
          return st?.child?.data?.shops || {};
        })());
        const matches = [];
        const kinds = ['seed','egg','tool','decor'];
        function computeStock(it) {
          // If normalized snapshot present, prefer currentStock
          if (typeof it?.currentStock === 'number') return Math.max(0, Math.trunc(it.currentStock));
          try {
            const keys = ['remainingStock','currentStock','stock','available','qty','quantity'];
            for (const k of keys) {
              if (k in (it || {})) {
                const v = it[k];
                if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
                if (typeof v === 'string') {
                  const s = v.trim();
                  if (s && /^-?\d+(?:\.\d+)?$/.test(s)) return Math.max(0, Math.trunc(Number(s)));
                }
              }
            }
            if ('initialStock' in (it || {}) && 'sold' in (it || {})) {
              const initial = Number(it.initialStock || 0);
              const sold = Number(it.sold || 0);
              if (Number.isFinite(initial) && Number.isFinite(sold)) return Math.max(0, Math.trunc(initial - sold));
            }
            const initOnly = Number(it?.initialStock || 0);
            if (Number.isFinite(initOnly)) return Math.max(0, Math.trunc(initOnly));
          } catch (_) {}
          return 0;
        }
        function getIdForKind(kind, it) {
          if (!it) return null;
          // Normalized snapshot exposes an 'id' already
          if (typeof it.id === 'string' && it.id) return it.id;
          if (kind === 'seed') return it.species || null;
          if (kind === 'tool') return it.toolId || null;
          if (kind === 'egg') return it.eggId || null;
          if (kind === 'decor') return it.decorId || null;
          return null;
        }
        for (const kind of kinds) {
          const shop = shops?.[kind];
          const inv = Array.isArray(shop?.inventory) ? shop.inventory : [];
          for (const it of inv) {
            const id = String(getIdForKind(kind, it) || '');
            if (!id || !wanted.has(id)) continue;
            matches.push({ kind, id, stock: computeStock(it) });
          }
        }
        return matches;
      } catch (_) { return []; }
    },

    // Internal: load item catalog and map item id -> shop kind
    async _ensureItemCatalog() {
      try {
        if (this._itemIdToKind && typeof this._itemIdToKind === 'object') return this._itemIdToKind;
        const map = {};
        try {
          const resp = await fetch('http://127.0.0.1:5000/discovered_items.json', { cache: 'no-store' });
          if (resp && resp.ok) {
            const j = await resp.json();
            const add = (arr, kind) => { (Array.isArray(arr) ? arr : []).forEach(n => { if (n) map[String(n)] = kind; }); };
            add(j?.seed, 'seed'); add(j?.egg, 'egg'); add(j?.tool, 'tool'); add(j?.decor, 'decor');
          }
        } catch (_) {}
        this._itemIdToKind = map;
        return map;
      } catch (_) { this._itemIdToKind = this._itemIdToKind || {}; return this._itemIdToKind; }
    },

    async _kindForItemId(itemId) {
      try {
        const id = String(itemId || '').trim();
        if (!id) return null;
        const map = await this._ensureItemCatalog();
        if (map && map[id]) return map[id];
        // Fallback: try to infer from current shop inventories
        const snap = (typeof this.getShopSnapshot === 'function') ? this.getShopSnapshot() : null;
        const shops = snap?.shops || (await (async () => { const st = await this.getFullState(); return st?.child?.data?.shops || {}; })());
        if (shops?.seed?.inventory?.some?.(it => (it.id || it.species) === id)) return 'seed';
        if (shops?.egg?.inventory?.some?.(it => (it.id || it.eggId) === id)) return 'egg';
        if (shops?.tool?.inventory?.some?.(it => (it.id || it.toolId) === id)) return 'tool';
        if (shops?.decor?.inventory?.some?.(it => (it.id || it.decorId) === id)) return 'decor';
        return null;
      } catch (_) { return null; }
    },

    // Internal: read secondsUntilRestock once from full state (authoritative). Returns number or null.
    async _readShopCountdownSec(kind) {
      try {
        const res = await fetch('http://127.0.0.1:5000/full_game_state.json', { cache: 'no-store' });
        if (!res.ok) return null;
        const j = await res.json();
        const v = j?.child?.data?.shops?.[kind]?.secondsUntilRestock;
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, n) : null;
      } catch (_) { return null; }
    },

    // Internal: shop cycle lengths per kind (ms)
    _getShopPeriodMs(kind) {
      if (kind === 'seed') return 5 * 60 * 1000;   // 5 minutes
      if (kind === 'tool') return 10 * 60 * 1000;  // 10 minutes
      if (kind === 'egg') return 15 * 60 * 1000;   // 15 minutes
      if (kind === 'decor') return 60 * 60 * 1000; // 60 minutes
      return 5 * 60 * 1000;
    },

    // Internal: map selected targets to their shop kinds based on current inventory presence
    async _groupTargetsByKind(targetIds) {
      try {
        const out = { seed: new Set(), egg: new Set(), tool: new Set(), decor: new Set() };
        const ids = new Set((Array.isArray(targetIds) ? targetIds : []).map(x => String(x || '').trim()).filter(Boolean));
        if (ids.size === 0) return out;
        const snap = (typeof this.getShopSnapshot === 'function') ? this.getShopSnapshot() : null;
        const shops = snap?.shops || (await (async () => {
          const st = await this.getFullState();
          return st?.child?.data?.shops || {};
        })());
        const kinds = ['seed','egg','tool','decor'];
        function getId(kind, it) {
          if (!it) return null;
          if (typeof it.id === 'string' && it.id) return it.id;
          if (kind === 'seed') return it.species || null;
          if (kind === 'tool') return it.toolId || null;
          if (kind === 'egg') return it.eggId || null;
          if (kind === 'decor') return it.decorId || null;
          return null;
        }
        for (const k of kinds) {
          const inv = Array.isArray(shops?.[k]?.inventory) ? shops[k].inventory : [];
          for (const it of inv) {
            const id = String(getId(k, it) || '');
            if (id && ids.has(id)) out[k].add(id);
          }
        }
        return out;
      } catch (_) { return { seed: new Set(), egg: new Set(), tool: new Set(), decor: new Set() }; }
    },

    // Internal: wait for a specific shop kind to restock using countdown or restock event
    async _waitForShopRestock(kind) {
      try {
        const getVal = () => {
          try {
            const cds = this.getShopCountdowns ? this.getShopCountdowns() : null;
            const v = cds && cds[kind];
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          } catch(_) { return null; }
        };

        const waitEvent = new Promise((resolve) => {
          if (!this.onShopRestock) { resolve(null); return; }
          let unsub = null;
          try {
            unsub = this.onShopRestock((payload) => {
              try { if (payload && payload.kind === kind) { if (unsub) unsub(); resolve('event'); } } catch(_) {}
            });
          } catch(_) { resolve(null); }
        });

        const waitReset = (async () => {
          // Initialize with a first valid reading
          let prev = null;
          for (let i = 0; i < 120; i++) { // up to ~1 minute
            const v0 = getVal();
            if (v0 != null) { prev = v0; break; }
            await new Promise(r => setTimeout(r, 500));
          }
          // Poll until countdown increases compared to the previous reading → reset detected
          for (let i = 0; i < 3600; i++) { // up to ~30 minutes
            const v = getVal();
            if (v != null) {
              if (prev != null && v > prev) break; // reset
              prev = v;
              const sleep = Math.min(1000, Math.max(200, Math.round(((v > 0 ? v : 0) + 1) * 200)));
              await new Promise(r => setTimeout(r, sleep));
            } else {
              await new Promise(r => setTimeout(r, 500));
            }
          }
          await new Promise(r => setTimeout(r, 200));
          return 'reset';
        })();

        await Promise.race([waitEvent, waitReset]);
      } catch (_) { await new Promise(r => setTimeout(r, 1000)); }
    },

    // Internal worker: simple loop => buy all wanted for this kind, then wait for that shop restock, repeat
    async _autoBuyerWorker(kind) {
      try {
        const periodMs = this._getShopPeriodMs(kind);
        let nextTickAtMs = null;
        // eslint-disable-next-line no-constant-condition
        while (this._autoBuyerRunning) {
          if (nextTickAtMs == null) {
            // First pass: buy any currently in-stock targets before starting the countdown
            const allNow = this._autoBuyerTargets ? Array.from(this._autoBuyerTargets) : [];
            if (allNow.length) {
              const myTargetsInit = [];
              for (const id of allNow) {
                try { const k = await this._kindForItemId(id); if (k === kind) myTargetsInit.push(id); } catch(_) {}
              }
              if (myTargetsInit.length > 0) {
                try { await this.buyAllAvailable(myTargetsInit); } catch (_) {}
              }
            }
            // Align first scheduled tick to server countdown once
            const sec = await this._readShopCountdownSec(kind);
            const initialMs = (sec == null) ? periodMs : (sec * 1000);
            const ms = Math.max(0, initialMs);
            // If countdown is exactly zero, start a fresh period from now to stay in sync
            nextTickAtMs = Date.now() + (ms === 0 ? periodMs : ms);
          }

          // Sleep until scheduled tick time
          const nowA = Date.now();
          const delay = Math.max(0, nextTickAtMs - nowA);
          try { console.log(`[MG][AutoBuyer] ${kind} waiting started at ${new Date().toLocaleTimeString()} (${Math.round(delay/1000)}s)`); } catch (_) {}
          await new Promise(r => setTimeout(r, delay));
          if (!this._autoBuyerRunning) break;

          // Schedule the next tick immediately based on fixed period to avoid drift
          nextTickAtMs += periodMs;
          // If we missed the tick (tab suspended), catch up to the next future boundary
          while (nextTickAtMs <= Date.now() + 50) { nextTickAtMs += periodMs; }

          // Perform a single buy pass for this shop kind
          const allTargets = this._autoBuyerTargets ? Array.from(this._autoBuyerTargets) : [];
          if (allTargets.length) {
            const myTargets = [];
            for (const id of allTargets) {
              try { const k = await this._kindForItemId(id); if (k === kind) myTargets.push(id); } catch(_) {}
            }
            if (myTargets.length > 0) {
              try { await this.buyAllAvailable(myTargets); } catch (_) {}
            }
          }
        }
      } catch (_) { /* swallow worker errors */ }
    },

    // Internal: purchase one unit by kind
    async _purchaseOne(kind, id) {
      try {
        if (kind === 'seed') return await this.purchaseSeed(id);
        if (kind === 'egg') return await this.purchaseEgg(id);
        if (kind === 'tool') return await this.purchaseTool(id);
        if (kind === 'decor') return await this.purchaseDecor(id);
      } catch (e) { return { success: false, error: String(e) }; }
      return { success: false, error: 'unknown_kind' };
    },

    // Buy all available stock for the given item ids immediately
    async buyAllAvailable(items) {
      try {
        const list = Array.isArray(items) ? items : [items];
        const matches = await this._resolveShopItems(list);
        const results = [];
        // Order egg purchases (and thus planting) by Auto Hatcher priority
        let eggPriority = [];
        try {
          const s = (typeof localStorage !== 'undefined') ? (localStorage.getItem('mg_auto_hatcher_priority') || '') : '';
          eggPriority = s.split(',').map(x => String(x).trim()).filter(Boolean);
        } catch (_) {}
        if (eggPriority.length === 0) {
          try {
            const resp = await fetch('http://127.0.0.1:5000/discovered_items.json', { cache: 'no-store' });
            if (resp && resp.ok) {
              const j = await resp.json();
              eggPriority = Array.isArray(j?.egg) ? j.egg.map(String) : [];
            }
          } catch (_) {}
        }
        const prioIndex = (id) => {
          try {
            const idx = eggPriority.indexOf(String(id));
            return idx >= 0 ? idx : 1e9;
          } catch (_) { return 1e9; }
        };
        const seeds = matches.filter(m => m && m.kind === 'seed');
        const eggs = matches.filter(m => m && m.kind === 'egg').sort((a, b) => prioIndex(a && a.id) - prioIndex(b && b.id));
        const tools = matches.filter(m => m && m.kind === 'tool');
        const decor = matches.filter(m => m && m.kind === 'decor');
        const orderedMatches = seeds.concat(eggs, tools, decor);
        // Prepare garden snapshot to find free tiles for planting eggs
        let gardenSnap = null;
        try { gardenSnap = await this.getCurrentGarden(); } catch(_) {}
        const tileObjects = (gardenSnap && gardenSnap.success && gardenSnap.garden) ? gardenSnap.garden : {};
        const usedSlots = new Set(Object.keys(tileObjects).map(String));
        const findFreeSlot = () => { for (let i = 0; i < 200; i++) { if (!usedSlots.has(String(i))) return i; } return null; };
        for (const m of orderedMatches) {
          let bought = 0;
          const qty = Math.max(0, Number(m.stock || 0));
          for (let i = 0; i < qty; i++) {
            const r = await this._purchaseOne(m.kind, m.id);
            if (r && r.success) bought += 1; else break;
            await new Promise(r => setTimeout(r, 60));
            // If we bought an egg, try to plant immediately in any free slot
            if (m.kind === 'egg') {
              try {
                const free = findFreeSlot();
                if (Number.isFinite(free)) {
                  await this.plantEgg(m.id, free).catch(() => {});
                  usedSlots.add(String(free));
                  await new Promise(r => setTimeout(r, 120));
                }
              } catch(_) {}
            }
          }
          results.push({ item: m.id, kind: m.kind, attempted: qty, purchased: bought });
        }
        return { success: true, results };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    // Start auto buyer: per-shop loops that wait for that shop's restock and purchase selected items
    startAutoBuyer(options = {}) {
      try {
        const items = Array.isArray(options.items) ? options.items.filter(x => x && String(x).trim()).map(x => String(x).trim()) : [];
        if (this._autoBuyerRunning) return { success: false, error: 'auto_buyer_already_running' };
        if (!this.startShopMonitor || !this.getShopCountdowns) return { success: false, error: 'shop_monitor_unavailable' };
        if (items.length === 0) return { success: false, error: 'no_items' };

        this._autoBuyerRunning = true;
        this._autoBuyerTargets = new Set(items);
        this._autoBuyerWorkers = this._autoBuyerWorkers || {};

        // persist run state
        try { this._captureRunState(); } catch(_){}

        // Ensure shop monitor is started
        try { this.startShopMonitor({ logCountdown: false }); } catch (_) {}

        // Spawn one worker per shop kind
        for (const kind of ['seed','egg','tool','decor']) {
          try {
            const w = this._autoBuyerWorker(kind);
            this._autoBuyerWorkers[kind] = w; // store promise reference
          } catch (_) {}
        }

        return { success: true, items: Array.from(this._autoBuyerTargets) };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    },

    stopAutoBuyer() {
      try {
        this._autoBuyerRunning = false;
        this._autoBuyerTargets = null;
        this._autoBuyerWorkers = {};
        // persist run state
        try { this._captureRunState(); } catch(_){}
        return { success: true };
      } catch (e) { return { success: false, error: String(e) }; }
    },

    // Persist current run-state so background can restore after reload
    _captureRunState: function() {
      try {
        const keys = [
          'mg_player_id',
          'mg_auto_feeder_interval_ms', 'mg_auto_feeder_threshold',
          'mg_auto_hatcher_interval_ms','mg_auto_hatcher_priority','mg_auto_hatcher_keep_expr','mg_auto_hatcher_sell',
          'mg_auto_seller_interval_ms','mg_auto_seller_harvest_species','mg_auto_seller_replant_species','mg_auto_seller_sell','mg_auto_harvest_expr',
          'mg_auto_buyer_items','mg_auto_buyer_seen'
        ];
        const local = {};
        keys.forEach(k => { try { const v = localStorage.getItem(k); if (v !== null) local[k] = v; } catch(_) {} });
        const st = {
          timestamp: Date.now(),
          localStorage: local,
          autoFeeder: { running: !!this._autoFeederInterval, options: this._autoFeederInterval ? { intervalMs: Number(localStorage.getItem('mg_auto_feeder_interval_ms')||2000), hungerThreshold: Number(localStorage.getItem('mg_auto_feeder_threshold')||500) } : null },
          autoHatcher: { running: !!this._autoHatcherInterval, options: this._autoHatcherInterval ? { intervalMs: Number(localStorage.getItem('mg_auto_hatcher_interval_ms')||300000), eggPriority: (localStorage.getItem('mg_auto_hatcher_priority')||'').split(',').filter(Boolean), keepExpr: localStorage.getItem('mg_auto_hatcher_keep_expr')||'', sell: localStorage.getItem('mg_auto_hatcher_sell') !== '0' } : null },
          autoSeller: { running: !!this._autoSellerInterval, options: this._autoSellerInterval ? { intervalMs: Number(localStorage.getItem('mg_auto_seller_interval_ms')||3600000), speciesFilter: JSON.parse(localStorage.getItem('mg_auto_seller_harvest_species')||'[]'), replantSpecies: JSON.parse(localStorage.getItem('mg_auto_seller_replant_species')||'[]'), sell: localStorage.getItem('mg_auto_seller_sell') !== '0' } : null },
          autoBuyer: { running: !!this._autoBuyerRunning, options: this._autoBuyerRunning ? { items: Array.isArray(this._autoBuyerTargets) ? Array.from(this._autoBuyerTargets) : (this._autoBuyerTargets ? Array.from(this._autoBuyerTargets) : JSON.parse(localStorage.getItem('mg_auto_buyer_items')||'[]')) } : null }
        };
        try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) chrome.storage.local.set({ mg_run_state: st }); } catch (e) { try { chrome.runtime.sendMessage({ action: 'saveRunState', state: st }); } catch(_) {} }
        return st;
      } catch (e) { return null; }
    },

    // Show the Auto Feeder overlay UI
    openAutoFeederUI() {
      try { ensureAutoFeederUI(true); return { success: true }; }
      catch (e) { return { success: false, error: String(e) }; }
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
          if (data.type === 'playerIdSet' && data.playerId) {
            try { localStorage.setItem('mg_player_id', String(data.playerId)); } catch (e) {}
            try { if (window.MagicGardenAPI) window.MagicGardenAPI._playerId = String(data.playerId); } catch (e) {}
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
          case 'restoreRunState': {
            try {
              const state = message.state || {};
              // Restore arbitrary localStorage keys if provided
              if (state.localStorage && typeof state.localStorage === 'object') {
                try {
                  Object.keys(state.localStorage).forEach(k => {
                    try { localStorage.setItem(k, String(state.localStorage[k])); } catch(_) {}
                  });
                } catch(_) {}
              }

              // Restart core automated modules when requested
              try {
                if (state.autoFeeder && state.autoFeeder.running && typeof window.MagicGardenAPI?.startAutoFeeder === 'function') {
                  try { window.MagicGardenAPI.startAutoFeeder(state.autoFeeder.options || {}); } catch(_) {}
                }
                if (state.autoHatcher && state.autoHatcher.running && typeof window.MagicGardenAPI?.startAutoHatcher === 'function') {
                  try { window.MagicGardenAPI.startAutoHatcher(state.autoHatcher.options || {}); } catch(_) {}
                }
                if (state.autoSeller && state.autoSeller.running && typeof window.MagicGardenAPI?.startAutoSeller === 'function') {
                  try { window.MagicGardenAPI.startAutoSeller(state.autoSeller.options || {}); } catch(_) {}
                }
                if (state.autoBuyer && state.autoBuyer.running && typeof window.MagicGardenAPI?.startAutoBuyer === 'function') {
                  try { window.MagicGardenAPI.startAutoBuyer(state.autoBuyer.options || {}); } catch(_) {}
                }
              } catch(_) {}

              try { sendResponse({ success: true }); } catch(_) {}
            } catch (e) {
              try { sendResponse({ success: false, error: String(e) }); } catch(_) {}
            }
            return true;
          }

        }
      } catch (e) {
        try { sendResponse({ success: false, error: String(e) }); } catch (_) {}
      }
    });
  }

  // Simple overlay UI system (scalable): namespace 'MGUi', with Auto Feeder panel module
  const MGUi = (function(){
    const state = {
      inited: false,
      panel: null,
      toggleBtn: null,
      drag: { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 },
      pos: { left: null, top: null },
      visible: true
    };

    function loadPrefs(){
      try {
        const left = parseInt(localStorage.getItem('mg_ui_panel_left')||'',10);
        const top = parseInt(localStorage.getItem('mg_ui_panel_top')||'',10);
        const vis = localStorage.getItem('mg_ui_panel_visible');
        if (Number.isFinite(left)) state.pos.left = left;
        if (Number.isFinite(top)) state.pos.top = top;
        if (vis === '0') state.visible = false;
      } catch(_){}
    }
    function savePrefs(){
      try {
        if (Number.isFinite(state.pos.left)) localStorage.setItem('mg_ui_panel_left', String(state.pos.left));
        if (Number.isFinite(state.pos.top)) localStorage.setItem('mg_ui_panel_top', String(state.pos.top));
        localStorage.setItem('mg_ui_panel_visible', state.visible ? '1' : '0');
      } catch(_){}
    }

    function setVisible(v){
      state.visible = !!v;
      if (state.panel) state.panel.style.display = state.visible ? 'block' : 'none';
      if (state.toggleBtn) state.toggleBtn.style.display = state.visible ? 'none' : 'block';
      savePrefs();
    }

    function attachDrag(handleEl, panelEl){
      const onDown = (ev) => {
        try {
          state.drag.active = true;
          const rect = panelEl.getBoundingClientRect();
          state.drag.startLeft = rect.left;
          state.drag.startTop = rect.top;
          state.drag.startX = ev.clientX;
          state.drag.startY = ev.clientY;
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          ev.preventDefault();
        } catch(_){}
      };
      const onMove = (ev) => {
        if (!state.drag.active) return;
        try {
          const dx = ev.clientX - state.drag.startX;
          const dy = ev.clientY - state.drag.startY;
          const left = Math.max(0, state.drag.startLeft + dx);
          const top = Math.max(0, state.drag.startTop + dy);
          panelEl.style.left = left + 'px';
          panelEl.style.top = top + 'px';
          panelEl.style.right = 'auto';
          panelEl.style.bottom = 'auto';
          state.pos.left = left;
          state.pos.top = top;
        } catch(_){}
      };
      const onUp = () => {
        state.drag.active = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        savePrefs();
      };
      handleEl.addEventListener('mousedown', onDown);
    }

    function ensureAutoFeederUI(forceShow){
    try {
        if (!document || !document.body) return;
        if (state.inited) { if (forceShow) setVisible(true); return; }
        loadPrefs();

        const savedInterval = (function(){ try { return parseInt(localStorage.getItem('mg_auto_feeder_interval_ms')||'2000',10); } catch(_) { return 2000; } })();
        const savedThreshold = (function(){ try { return parseInt(localStorage.getItem('mg_auto_feeder_threshold')||'500',10); } catch(_) { return 500; } })();

        const panel = document.createElement('div');
        panel.id = 'mg-autofeeder-panel';
        panel.style.position = 'fixed';
        panel.style.right = '12px';
        panel.style.bottom = '12px';
        panel.style.zIndex = '2147483647';
        panel.style.background = 'rgba(20,20,20,0.92)';
        panel.style.color = '#fff';
        panel.style.padding = '10px 12px';
        panel.style.borderRadius = '8px';
        panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
        panel.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
        panel.style.minWidth = '220px';
        panel.style.maxHeight = '80vh';
        panel.style.overflowY = 'auto';
        if (Number.isFinite(state.pos.left) && Number.isFinite(state.pos.top)) {
          panel.style.left = state.pos.left + 'px';
          panel.style.top = state.pos.top + 'px';
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
        }

        const title = document.createElement('div');
        title.textContent = 'Auto Feeder';
        title.style.fontWeight = '600';
        title.style.marginBottom = '8px';
        title.style.display = 'flex';
        title.style.alignItems = 'center';
        title.style.justifyContent = 'space-between';
        title.style.cursor = 'move';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.title = 'Hide panel';
        closeBtn.style.background = 'transparent';
        closeBtn.style.color = '#fff';
        closeBtn.style.border = 'none';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '16px';
        closeBtn.style.lineHeight = '16px';
        closeBtn.style.padding = '0 4px';
        closeBtn.addEventListener('click', () => { setVisible(false); });
        title.appendChild(closeBtn);

        const row1 = document.createElement('div');
        row1.style.display = 'flex';
        row1.style.gap = '8px';
        row1.style.marginBottom = '8px';

        const intervalWrap = document.createElement('label');
        intervalWrap.style.display = 'flex';
        intervalWrap.style.flexDirection = 'column';
        intervalWrap.style.flex = '1';
        const intervalSpan = document.createElement('span');
        intervalSpan.textContent = 'Interval (ms)';
        intervalSpan.style.fontSize = '11px';
        intervalSpan.style.opacity = '0.9';
        const intervalInput = document.createElement('input');
        intervalInput.type = 'number';
        intervalInput.min = '100';
        intervalInput.step = '100';
        intervalInput.value = String(Number.isFinite(savedInterval) ? savedInterval : 2000);
        intervalInput.style.padding = '6px';
        intervalInput.style.borderRadius = '6px';
        intervalInput.style.border = '1px solid rgba(255,255,255,0.15)';
        intervalInput.style.background = 'rgba(0,0,0,0.2)';
        intervalInput.style.color = '#fff';
        intervalWrap.appendChild(intervalSpan);
        intervalWrap.appendChild(intervalInput);

        const threshWrap = document.createElement('label');
        threshWrap.style.display = 'flex';
        threshWrap.style.flexDirection = 'column';
        threshWrap.style.flex = '1';
        const threshSpan = document.createElement('span');
        threshSpan.textContent = 'Threshold';
        threshSpan.style.fontSize = '11px';
        threshSpan.style.opacity = '0.9';
        const threshInput = document.createElement('input');
        threshInput.type = 'number';
        threshInput.min = '0';
        threshInput.step = '10';
        threshInput.value = String(Number.isFinite(savedThreshold) ? savedThreshold : 500);
        threshInput.style.padding = '6px';
        threshInput.style.borderRadius = '6px';
        threshInput.style.border = '1px solid rgba(255,255,255,0.15)';
        threshInput.style.background = 'rgba(0,0,0,0.2)';
        threshInput.style.color = '#fff';
        threshWrap.appendChild(threshSpan);
        threshWrap.appendChild(threshInput);

        row1.appendChild(intervalWrap);
        row1.appendChild(threshWrap);

        const row2 = document.createElement('div');
        row2.style.display = 'flex';
        row2.style.gap = '8px';

        function mkBtn(text) {
          const b = document.createElement('button');
          b.textContent = text;
          b.style.flex = '1';
          b.style.padding = '8px 10px';
          b.style.background = '#2d7ef7';
          b.style.color = '#fff';
          b.style.border = 'none';
          b.style.borderRadius = '6px';
          b.style.cursor = 'pointer';
          b.onmouseenter = () => b.style.background = '#1f6de3';
          b.onmouseleave = () => b.style.background = '#2d7ef7';
          return b;
        }

        const startBtn = mkBtn('Start');
        const stopBtn = mkBtn('Stop');
        stopBtn.style.background = '#444';
        stopBtn.onmouseenter = () => stopBtn.style.background = '#383838';
        stopBtn.onmouseleave = () => stopBtn.style.background = '#444';

        const status = document.createElement('div');
        status.style.marginTop = '8px';
        status.style.fontSize = '12px';
        status.style.opacity = '0.9';
        status.textContent = 'Stopped';

        startBtn.addEventListener('click', async () => {
          try {
            const iv = Math.max(100, parseInt(intervalInput.value, 10) || 2000);
            const th = Math.max(0, parseInt(threshInput.value, 10) || 500);
            try { localStorage.setItem('mg_auto_feeder_interval_ms', String(iv)); } catch(_) {}
            try { localStorage.setItem('mg_auto_feeder_threshold', String(th)); } catch(_) {}
            const res = await window.MagicGardenAPI.startAutoFeeder({ intervalMs: iv, hungerThreshold: th });
            if (res && res.success) {
              status.textContent = `Running (interval=${iv}ms, threshold=${th})`;
            } else {
              status.textContent = `Error: ${(res && res.error) || 'unknown'}`;
            }
          } catch (e) {
            status.textContent = 'Error starting';
          }
        });

        stopBtn.addEventListener('click', async () => {
          try {
            const res = await window.MagicGardenAPI.stopAutoFeeder();
            if (res && res.success) {
              status.textContent = 'Stopped';
            } else {
              status.textContent = `Error: ${(res && res.error) || 'unknown'}`;
            }
          } catch (e) {
            status.textContent = 'Error stopping';
          }
        });

        row2.appendChild(startBtn);
        row2.appendChild(stopBtn);

        // Auto Buyer Section
        const buyerHeader = document.createElement('div');
        buyerHeader.textContent = 'Auto Buyer';
        buyerHeader.style.fontWeight = '600';
        buyerHeader.style.marginTop = '10px';
        buyerHeader.style.marginBottom = '6px';

        const buyerRow = document.createElement('div');
        buyerRow.style.display = 'flex';
        buyerRow.style.gap = '8px';
        buyerRow.style.alignItems = 'center';

        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.placeholder = 'Filter items';
        filterInput.style.flex = '1';
        filterInput.style.padding = '6px';
        filterInput.style.borderRadius = '6px';
        filterInput.style.border = '1px solid rgba(255,255,255,0.15)';
        filterInput.style.background = 'rgba(0,0,0,0.2)';
        filterInput.style.color = '#fff';

        const editorBtn = mkBtn('Hide Items');
        editorBtn.style.flex = '0 0 auto';

        const buyerEditor = document.createElement('div');
        buyerEditor.style.display = 'block';
        buyerEditor.style.marginTop = '6px';
        buyerEditor.style.maxHeight = '180px';
        buyerEditor.style.overflow = 'auto';
        buyerEditor.style.border = '1px solid rgba(255,255,255,0.15)';
        buyerEditor.style.borderRadius = '6px';
        buyerEditor.style.padding = '6px';
        buyerEditor.style.background = 'rgba(0,0,0,0.15)';

        const buyerControls = document.createElement('div');
        buyerControls.style.display = 'flex';
        buyerControls.style.gap = '8px';
        buyerControls.style.marginTop = '6px';

        const selectAllBtn = mkBtn('Select Visible');
        const clearBtn = mkBtn('Clear');
        selectAllBtn.style.background = '#555';
        clearBtn.style.background = '#555';
        selectAllBtn.onmouseenter = () => selectAllBtn.style.background = '#4a4a4a';
        selectAllBtn.onmouseleave = () => selectAllBtn.style.background = '#555';
        clearBtn.onmouseenter = () => clearBtn.style.background = '#4a4a4a';
        clearBtn.onmouseleave = () => clearBtn.style.background = '#555';

        buyerControls.appendChild(selectAllBtn);
        buyerControls.appendChild(clearBtn);

        const buyerActionRow = document.createElement('div');
        buyerActionRow.style.display = 'flex';
        buyerActionRow.style.gap = '8px';
        buyerActionRow.style.marginTop = '6px';

        const buyerStartBtn = mkBtn('Start Auto Buyer');
        const buyerStopBtn = mkBtn('Stop Auto Buyer');
        buyerStopBtn.style.background = '#444';
        buyerStopBtn.onmouseenter = () => buyerStopBtn.style.background = '#383838';
        buyerStopBtn.onmouseleave = () => buyerStopBtn.style.background = '#444';

        buyerActionRow.appendChild(buyerStartBtn);
        buyerActionRow.appendChild(buyerStopBtn);

        const buyerStatus = document.createElement('div');
        buyerStatus.style.marginTop = '6px';
        buyerStatus.style.fontSize = '12px';
        buyerStatus.style.opacity = '0.9';
        buyerStatus.textContent = 'Buyer stopped';

        buyerRow.appendChild(filterInput);
        buyerRow.appendChild(editorBtn);

        panel.appendChild(title);
        panel.appendChild(row1);
        panel.appendChild(row2);
        panel.appendChild(status);
        panel.appendChild(buyerHeader);
        panel.appendChild(buyerRow);
        panel.appendChild(buyerEditor);
        panel.appendChild(buyerControls);
        panel.appendChild(buyerActionRow);
        panel.appendChild(buyerStatus);

        // Auto Hatcher Section
        const hatcherHeader = document.createElement('div');
        hatcherHeader.textContent = 'Auto Hatcher';
        hatcherHeader.style.fontWeight = '600';
        hatcherHeader.style.marginTop = '12px';
        hatcherHeader.style.marginBottom = '6px';

        const hRow1 = document.createElement('div');
        hRow1.style.display = 'flex';
        hRow1.style.gap = '8px';
        hRow1.style.marginBottom = '6px';

        const hatchIntervalWrap = document.createElement('label');
        hatchIntervalWrap.style.display = 'flex';
        hatchIntervalWrap.style.flexDirection = 'column';
        hatchIntervalWrap.style.flex = '1';
        const hatchIntervalSpan = document.createElement('span');
        hatchIntervalSpan.textContent = 'Check Interval (minutes)';
        hatchIntervalSpan.style.fontSize = '11px';
        hatchIntervalSpan.style.opacity = '0.9';
        const savedHatchIvMs = (function(){ try { return parseInt(localStorage.getItem('mg_auto_hatcher_interval_ms')||'300000',10); } catch(_) { return 300000; } })();
        const hatchIntervalInput = document.createElement('input');
        hatchIntervalInput.type = 'number';
        hatchIntervalInput.min = '1';
        hatchIntervalInput.step = '1';
        hatchIntervalInput.value = String(Number.isFinite(savedHatchIvMs) ? Math.max(1, Math.round(savedHatchIvMs / 60000)) : 5);
        hatchIntervalInput.style.padding = '6px';
        hatchIntervalInput.style.borderRadius = '6px';
        hatchIntervalInput.style.border = '1px solid rgba(255,255,255,0.15)';
        hatchIntervalInput.style.background = 'rgba(0,0,0,0.2)';
        hatchIntervalInput.style.color = '#fff';
        hatchIntervalWrap.appendChild(hatchIntervalSpan);
        hatchIntervalWrap.appendChild(hatchIntervalInput);

        // Keep condition expression (token bank like Auto Harvester)
        const keepWrap = document.createElement('label');
        keepWrap.style.display = 'flex';
        keepWrap.style.flexDirection = 'column';
        keepWrap.style.flex = '1';
        const keepSpan = document.createElement('span');
        keepSpan.textContent = 'Keep condition (pet mutations)';
        keepSpan.style.fontSize = '11px';
        keepSpan.style.opacity = '0.9';
        const keepExprInput = document.createElement('input');
        keepExprInput.type = 'text';
        try { keepExprInput.value = localStorage.getItem('mg_auto_hatcher_keep_expr') || ''; } catch(_) { keepExprInput.value = ''; }
        keepExprInput.placeholder = 'e.g. rainbow || (frozen && gold)';
        keepExprInput.style.padding = '6px';
        keepExprInput.style.borderRadius = '6px';
        keepExprInput.style.border = '1px solid rgba(255,255,255,0.15)';
        keepExprInput.style.background = 'rgba(0,0,0,0.2)';
        keepExprInput.style.color = '#fff';
        keepExprInput.readOnly = true;
        // optional autocomplete using existing datalist from harvester
        keepExprInput.setAttribute('list', 'mg-mutation-options');
        keepWrap.appendChild(keepSpan);
        keepWrap.appendChild(keepExprInput);
        const keepTokenBank = document.createElement('div');
        keepTokenBank.style.display = 'flex';
        keepTokenBank.style.flexWrap = 'wrap';
        keepTokenBank.style.gap = '6px';
        keepTokenBank.style.marginTop = '6px';
        const keepTokens = ['wet','chilled','frozen','ambershine','dawnlit','dawncharged','ambercharged','gold','rainbow','&&','||','(',')'];
        function setKeepExpr(val){ keepExprInput.value = val; try { localStorage.setItem('mg_auto_hatcher_keep_expr', String(val)); } catch(_) {} }
        function appendKeepToken(tok){
          const cur = String(keepExprInput.value || '').trim();
          const spaced = (tok === '&&' || tok === '||') ? ` ${tok} ` : ` ${tok} `;
          setKeepExpr((cur + spaced).trim());
        }
        function backspaceKeepToken(){
          const parts = String(keepExprInput.value || '').trim().split(/\s+/).filter(Boolean);
          if (parts.length > 0) { parts.pop(); setKeepExpr(parts.join(' ')); }
        }
        const clearKeepBtn = mkBtn('Clear'); (function(b){ b.style.flex='0 0 auto'; b.style.padding='4px 8px'; b.style.fontSize='12px'; })(clearKeepBtn);
        const backKeepBtn = mkBtn('⌫'); (function(b){ b.style.flex='0 0 auto'; b.style.padding='4px 8px'; b.style.fontSize='12px'; })(backKeepBtn);
        clearKeepBtn.addEventListener('click', () => setKeepExpr(''));
        backKeepBtn.addEventListener('click', () => backspaceKeepToken());
        keepTokenBank.appendChild(clearKeepBtn);
        keepTokenBank.appendChild(backKeepBtn);
        keepTokens.forEach(t => { const b = mkBtn(t); (function(b2){ b2.style.flex='0 0 auto'; b2.style.padding='4px 8px'; b2.style.fontSize='12px'; })(b); b.addEventListener('click', () => appendKeepToken(t)); keepTokenBank.appendChild(b); });
        keepWrap.appendChild(keepTokenBank);

        hRow1.appendChild(hatchIntervalWrap);
        hRow1.appendChild(keepWrap);

        const hRow2 = document.createElement('div');
        hRow2.style.display = 'flex';
        hRow2.style.gap = '8px';

        const eggPrioWrap = document.createElement('label');
        eggPrioWrap.style.display = 'flex';
        eggPrioWrap.style.flexDirection = 'column';
        eggPrioWrap.style.flex = '1';
        const eggPrioSpan = document.createElement('span');
        eggPrioSpan.textContent = 'Egg Priority (drag to reorder)';
        eggPrioSpan.style.fontSize = '11px';
        eggPrioSpan.style.opacity = '0.9';
        const eggPrioList = document.createElement('div');
        eggPrioList.style.display = 'flex';
        eggPrioList.style.flexWrap = 'wrap';
        eggPrioList.style.gap = '6px';
        eggPrioList.style.padding = '6px';
        eggPrioList.style.border = '1px solid rgba(255,255,255,0.15)';
        eggPrioList.style.borderRadius = '6px';
        eggPrioList.style.background = 'rgba(0,0,0,0.15)';
        eggPrioWrap.appendChild(eggPrioSpan);
        eggPrioWrap.appendChild(eggPrioList);

        const defaultEggs = ['MythicalEgg','LegendaryEgg','RareEgg','UncommonEgg','CommonEgg'];
        const savedPrioCsv = (function(){ try { return localStorage.getItem('mg_auto_hatcher_priority') || ''; } catch(_) { return ''; } })();
        let eggOrder = savedPrioCsv.split(',').map(s => s.trim()).filter(Boolean);
        if (eggOrder.length === 0) eggOrder = defaultEggs.slice();
        // Ensure defaults present (append missing)
        defaultEggs.forEach(e => { if (!eggOrder.includes(e)) eggOrder.push(e); });

        function renderEggChips() {
          eggPrioList.innerHTML = '';
          eggOrder.forEach((id, idx) => {
            const chip = document.createElement('div');
            chip.textContent = id;
            chip.setAttribute('draggable', 'true');
            chip.dataset.id = id;
            chip.style.padding = '4px 8px';
            chip.style.background = '#2d7ef7';
            chip.style.color = '#fff';
            chip.style.borderRadius = '999px';
            chip.style.cursor = 'grab';
            chip.style.userSelect = 'none';
            chip.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', id); ev.dataTransfer.effectAllowed = 'move'; });
            eggPrioList.appendChild(chip);
          });
        }
        eggPrioList.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; });
        eggPrioList.addEventListener('drop', (ev) => {
          try {
            ev.preventDefault();
            const draggedId = ev.dataTransfer.getData('text/plain');
            if (!draggedId) return;
            const target = ev.target.closest('div');
            if (!target || !target.dataset || !target.dataset.id) return;
            const targetId = target.dataset.id;
            const from = eggOrder.indexOf(draggedId);
            const to = eggOrder.indexOf(targetId);
            if (from === -1 || to === -1 || from === to) return;
            const arr = eggOrder.slice();
            const [m] = arr.splice(from, 1);
            arr.splice(to, 0, m);
            eggOrder = arr;
            try { localStorage.setItem('mg_auto_hatcher_priority', eggOrder.join(',')); } catch(_) {}
            renderEggChips();
          } catch(_) {}
        });
        renderEggChips();

        const hActRow = document.createElement('div');
        hActRow.style.display = 'flex';
        hActRow.style.gap = '8px';
        hActRow.style.marginTop = '6px';
        const hatchStartBtn = mkBtn('Start Auto Hatcher');
        const hatchStopBtn = mkBtn('Stop Auto Hatcher');
        hatchStopBtn.style.background = '#444';
        hatchStopBtn.onmouseenter = () => hatchStopBtn.style.background = '#383838';
        hatchStopBtn.onmouseleave = () => hatchStopBtn.style.background = '#444';

        const hatchStatus = document.createElement('div');
        hatchStatus.style.marginTop = '6px';
        hatchStatus.style.fontSize = '12px';
        hatchStatus.style.opacity = '0.9';
        hatchStatus.textContent = 'Hatcher stopped';

        // Sell toggle
        const hatchSellWrap = document.createElement('label');
        hatchSellWrap.style.display = 'flex';
        hatchSellWrap.style.alignItems = 'center';
        hatchSellWrap.style.gap = '6px';
        hatchSellWrap.style.marginTop = '6px';
        const hatcherSellCb = document.createElement('input');
        hatcherSellCb.type = 'checkbox';
        hatcherSellCb.checked = (function(){ try { return localStorage.getItem('mg_auto_hatcher_sell') !== '0'; } catch(_) { return true; } })();
        const hatcherSellSpan = document.createElement('span');
        hatcherSellSpan.textContent = 'Sell pets not matching keep condition';
        hatchSellWrap.appendChild(hatcherSellCb);
        hatchSellWrap.appendChild(hatcherSellSpan);

        hatchStartBtn.addEventListener('click', async () => {
          try {
            const minutes = Math.max(1, parseInt(hatchIntervalInput.value, 10) || 5);
            const iv = minutes * 60 * 1000;
            const prio = eggOrder.slice();
            const keepExpr = String(keepExprInput.value || '').trim();
            const sell = !!hatcherSellCb.checked;
            try { localStorage.setItem('mg_auto_hatcher_interval_ms', String(iv)); } catch(_) {}
            try { localStorage.setItem('mg_auto_hatcher_priority', prio.join(',')); } catch(_) {}
            try { localStorage.setItem('mg_auto_hatcher_keep_expr', keepExpr); } catch(_) {}
            try { localStorage.setItem('mg_auto_hatcher_sell', sell ? '1' : '0'); } catch(_) {}
            const res = await window.MagicGardenAPI.startAutoHatcher({ intervalMs: iv, eggPriority: prio, keepExpr, sell });
            if (res && res.success) hatchStatus.textContent = `Hatcher running (interval=${minutes}m, sell=${sell ? 'on' : 'off'})`; else hatchStatus.textContent = `Error: ${(res && res.error) || 'unknown'}`;
          } catch (_) { hatchStatus.textContent = 'Error starting hatcher'; }
        });
        hatchStopBtn.addEventListener('click', async () => {
          try {
            const res = await window.MagicGardenAPI.stopAutoHatcher();
            if (res && res.success) hatchStatus.textContent = 'Hatcher stopped'; else hatchStatus.textContent = `Error: ${(res && res.error) || 'unknown'}`;
          } catch (_) { hatchStatus.textContent = 'Error stopping hatcher'; }
        });

        hRow2.appendChild(eggPrioWrap);
        hActRow.appendChild(hatchStartBtn);
        hActRow.appendChild(hatchStopBtn);

        panel.appendChild(hatcherHeader);
        panel.appendChild(hRow1);
        panel.appendChild(hRow2);
        panel.appendChild(hatchSellWrap);
        panel.appendChild(hActRow);
        panel.appendChild(hatchStatus);

        // Auto Harvester Section
        const sellerHeader = document.createElement('div');
        sellerHeader.textContent = 'Auto Harvester';
        sellerHeader.style.fontWeight = '600';
        sellerHeader.style.marginTop = '12px';
        sellerHeader.style.marginBottom = '6px';

        const sellerRow = document.createElement('div');
        sellerRow.style.display = 'flex';
        sellerRow.style.gap = '8px';
        sellerRow.style.alignItems = 'center';

        const sellerFilterInput = document.createElement('input');
        sellerFilterInput.type = 'text';
        sellerFilterInput.placeholder = 'Filter species';
        sellerFilterInput.style.flex = '1';
        sellerFilterInput.style.padding = '6px';
        sellerFilterInput.style.borderRadius = '6px';
        sellerFilterInput.style.border = '1px solid rgba(255,255,255,0.15)';
        sellerFilterInput.style.background = 'rgba(0,0,0,0.2)';
        sellerFilterInput.style.color = '#fff';

        const sellerEditorToggle = mkBtn('Hide Species');
        sellerEditorToggle.style.flex = '0 0 auto';

        const sellerEditorsWrap = document.createElement('div');
        sellerEditorsWrap.style.display = 'block';
        sellerEditorsWrap.style.marginTop = '6px';
        sellerEditorsWrap.style.border = '1px solid rgba(255,255,255,0.15)';
        sellerEditorsWrap.style.borderRadius = '6px';
        sellerEditorsWrap.style.padding = '6px';
        sellerEditorsWrap.style.background = 'rgba(0,0,0,0.15)';

        // Mutation expression input
        const exprWrap = document.createElement('label');
        exprWrap.style.display = 'flex';
        exprWrap.style.flexDirection = 'column';
        exprWrap.style.marginTop = '6px';
        const exprSpan = document.createElement('span');
        exprSpan.textContent = 'Harvest condition (mutations)';
        exprSpan.style.fontSize = '11px';
        exprSpan.style.opacity = '0.9';
        const exprInput = document.createElement('input');
        exprInput.type = 'text';
        exprInput.placeholder = 'e.g. frozen && (dawnlit || ambershine)';
        try { exprInput.value = localStorage.getItem('mg_auto_harvest_expr') || 'frozen && (dawnlit || ambershine)'; } catch (_) { exprInput.value = 'frozen && (dawnlit || ambershine)'; }
        exprInput.style.padding = '6px';
        exprInput.style.borderRadius = '6px';
        exprInput.style.border = '1px solid rgba(255,255,255,0.15)';
        exprInput.style.background = 'rgba(0,0,0,0.2)';
        exprInput.style.color = '#fff';
        exprInput.readOnly = true;
        // Autocomplete via datalist
        exprInput.setAttribute('list', 'mg-mutation-options');
        const dl = document.createElement('datalist');
        dl.id = 'mg-mutation-options';
        ;(['wet','chilled','frozen','ambershine','dawnlit','dawncharged','ambercharged','gold','rainbow']).forEach(name => {
          const opt = document.createElement('option');
          opt.value = name;
          dl.appendChild(opt);
        });
        exprWrap.appendChild(exprSpan);
        exprWrap.appendChild(exprInput);
        exprWrap.appendChild(dl);

        // Token bank for building expressions without typing
        const tokenBank = document.createElement('div');
        tokenBank.style.display = 'flex';
        tokenBank.style.flexWrap = 'wrap';
        tokenBank.style.gap = '6px';
        tokenBank.style.marginTop = '6px';
        const tokens = ['wet','chilled','frozen','ambershine','dawnlit','dawncharged','ambercharged','gold','rainbow','&&','||','(',')'];
        function setExpr(val){ exprInput.value = val; try { localStorage.setItem('mg_auto_harvest_expr', String(val)); } catch(_) {} }
        function appendToken(tok){
          const cur = String(exprInput.value || '').trim();
          const spaced = (tok === '&&' || tok === '||') ? ` ${tok} ` : ` ${tok} `;
          setExpr((cur + spaced).trim());
        }
        function backspaceToken(){
          const parts = String(exprInput.value || '').trim().split(/\s+/).filter(Boolean);
          if (parts.length > 0) { parts.pop(); setExpr(parts.join(' ')); }
        }
        const smallBtnStyle = (b) => { b.style.flex = '0 0 auto'; b.style.padding = '4px 8px'; b.style.fontSize = '12px'; };
        const clearExprBtn = mkBtn('Clear'); smallBtnStyle(clearExprBtn);
        const backBtn = mkBtn('⌫'); smallBtnStyle(backBtn);
        clearExprBtn.addEventListener('click', () => setExpr(''));
        backBtn.addEventListener('click', () => backspaceToken());
        tokenBank.appendChild(clearExprBtn);
        tokenBank.appendChild(backBtn);
        tokens.forEach(t => {
          const b = mkBtn(t); smallBtnStyle(b);
          b.addEventListener('click', () => appendToken(t));
          tokenBank.appendChild(b);
        });

        const sellerIntervalRow = document.createElement('div');
        sellerIntervalRow.style.display = 'flex';
        sellerIntervalRow.style.gap = '8px';
        sellerIntervalRow.style.marginTop = '6px';
        const sellerIntervalWrap = document.createElement('label');
        sellerIntervalWrap.style.display = 'flex';
        sellerIntervalWrap.style.flexDirection = 'column';
        sellerIntervalWrap.style.flex = '1';
        const sellerIntervalSpan = document.createElement('span');
        sellerIntervalSpan.textContent = 'Auto Harvester Interval (minutes)';
        sellerIntervalSpan.style.fontSize = '11px';
        sellerIntervalSpan.style.opacity = '0.9';
        const savedSellerInterval = (function(){ try { return parseInt(localStorage.getItem('mg_auto_seller_interval_ms')||'',10); } catch(_) { return NaN; } })();
        const sellerIntervalInput = document.createElement('input');
        sellerIntervalInput.type = 'number';
        sellerIntervalInput.min = '1';
        sellerIntervalInput.step = '1';
        sellerIntervalInput.value = String(Number.isFinite(savedSellerInterval) ? Math.max(1, Math.round(savedSellerInterval / 60000)) : 60);
        sellerIntervalInput.style.padding = '6px';
        sellerIntervalInput.style.borderRadius = '6px';
        sellerIntervalInput.style.border = '1px solid rgba(255,255,255,0.15)';
        sellerIntervalInput.style.background = 'rgba(0,0,0,0.2)';
        sellerIntervalInput.style.color = '#fff';
        sellerIntervalWrap.appendChild(sellerIntervalSpan);
        sellerIntervalWrap.appendChild(sellerIntervalInput);
        sellerIntervalRow.appendChild(sellerIntervalWrap);

        const harvestListLabel = document.createElement('div');
        harvestListLabel.textContent = 'Harvest Species';
        harvestListLabel.style.fontWeight = '600';
        harvestListLabel.style.margin = '4px 0';
        const harvestList = document.createElement('div');
        harvestList.style.maxHeight = '140px';
        harvestList.style.overflow = 'auto';
        harvestList.style.padding = '4px 2px';

        const replantListLabel = document.createElement('div');
        replantListLabel.textContent = 'Replant Species';
        replantListLabel.style.fontWeight = '600';
        replantListLabel.style.margin = '8px 0 4px';
        const replantList = document.createElement('div');
        replantList.style.maxHeight = '140px';
        replantList.style.overflow = 'auto';
        replantList.style.padding = '4px 2px';

        sellerEditorsWrap.appendChild(harvestListLabel);
        sellerEditorsWrap.appendChild(harvestList);
        sellerEditorsWrap.appendChild(replantListLabel);
        sellerEditorsWrap.appendChild(replantList);
        sellerEditorsWrap.appendChild(exprWrap);
        sellerEditorsWrap.appendChild(tokenBank);

        const sellerActionRow = document.createElement('div');
        sellerActionRow.style.display = 'flex';
        sellerActionRow.style.gap = '8px';
        sellerActionRow.style.marginTop = '6px';
        const runSellerBtn = mkBtn('Run Auto Harvester Once');
        const startSellerBtn = mkBtn('Start Auto Harvester');
        const stopSellerBtn = mkBtn('Stop Auto Harvester');
        stopSellerBtn.style.background = '#444';
        stopSellerBtn.onmouseenter = () => stopSellerBtn.style.background = '#383838';
        stopSellerBtn.onmouseleave = () => stopSellerBtn.style.background = '#444';
        const sellerSellWrap = document.createElement('label');
        sellerSellWrap.style.display = 'flex';
        sellerSellWrap.style.alignItems = 'center';
        sellerSellWrap.style.gap = '6px';
        sellerSellWrap.style.marginTop = '6px';
        const sellerSellCb = document.createElement('input');
        sellerSellCb.type = 'checkbox';
        sellerSellCb.checked = (function(){ try { return localStorage.getItem('mg_auto_seller_sell') !== '0'; } catch(_) { return true; } })();
        const sellerSellSpan = document.createElement('span');
        sellerSellSpan.textContent = 'Sell after harvest';
        sellerSellWrap.appendChild(sellerSellCb);
        sellerSellWrap.appendChild(sellerSellSpan);
        const sellerStatus = document.createElement('div');
        sellerStatus.style.marginTop = '6px';
        sellerStatus.style.fontSize = '12px';
        sellerStatus.style.opacity = '0.9';
        sellerStatus.textContent = 'Seller idle';
        sellerActionRow.appendChild(runSellerBtn);
        sellerActionRow.appendChild(startSellerBtn);
        sellerActionRow.appendChild(stopSellerBtn);

        sellerRow.appendChild(sellerFilterInput);
        sellerRow.appendChild(sellerEditorToggle);

        panel.appendChild(sellerHeader);
        panel.appendChild(sellerRow);
        panel.appendChild(sellerEditorsWrap);
        panel.appendChild(sellerIntervalRow);
        panel.appendChild(sellerSellWrap);
        panel.appendChild(sellerActionRow);
        panel.appendChild(sellerStatus);

        // Active Pets section: show current active pet ids and provide copy/refresh
        const petHeader = document.createElement('div');
        petHeader.textContent = 'Active Pets';
        petHeader.style.fontWeight = '600';
        petHeader.style.marginTop = '12px';

        const petRow = document.createElement('div');
        petRow.style.display = 'flex';
        petRow.style.gap = '8px';
        petRow.style.alignItems = 'center';

        const petRefreshBtn = mkBtn('Refresh Pets');
        petRefreshBtn.style.flex = '0 0 auto';
        const petCopyBtn = mkBtn('Copy IDs');
        petCopyBtn.style.flex = '0 0 auto';

        const petList = document.createElement('div');
        petList.style.fontFamily = 'monospace';
        petList.style.marginTop = '6px';
        petList.style.whiteSpace = 'pre-wrap';
        petList.style.maxHeight = '120px';
        petList.style.overflow = 'auto';
        petList.style.background = 'rgba(0,0,0,0.12)';
        petList.style.padding = '6px';
        petList.style.borderRadius = '6px';

        petRefreshBtn.addEventListener('click', updatePetList);
        petCopyBtn.addEventListener('click', async () => {
          try {
            let r = null;
            if (window.MagicGardenAPI && typeof window.MagicGardenAPI.copyActivePetIds === 'function') {
              r = await window.MagicGardenAPI.copyActivePetIds();
            } else if (typeof window.copyActivePetIds === 'function') {
              r = await window.copyActivePetIds();
            } else {
              alert('Copy API not available');
              return;
            }
            if (r && r.success) {
              petCopyBtn.textContent = 'Copied';
              setTimeout(() => petCopyBtn.textContent = 'Copy IDs', 1200);
            } else {
              alert('Copy failed: ' + (r && r.error ? r.error : 'unknown'));
            }
          } catch (e) {
            alert('Copy failed: ' + String(e));
          }
        });

        petRow.appendChild(petRefreshBtn);
        petRow.appendChild(petCopyBtn);
        panel.appendChild(petHeader);
        panel.appendChild(petRow);
        panel.appendChild(petList);

        async function updatePetList() {
          try {
            petList.textContent = 'Loading...';
            let res = null;
            if (window.MagicGardenAPI && typeof window.MagicGardenAPI.getAllActivePetIds === 'function') {
              res = await window.MagicGardenAPI.getAllActivePetIds();
            } else if (typeof window.getAllActivePetIds === 'function') {
              res = await window.getAllActivePetIds();
            } else {
              petList.textContent = 'API unavailable';
              return;
            }
            if (!res || !res.success) { petList.textContent = 'Error: ' + (res && res.error); return; }
            const pets = Array.isArray(res.pets) ? res.pets : [];
            if (pets.length === 0) { petList.textContent = 'No active pets'; return; }
            petList.innerHTML = '';
            pets.forEach(p => {
              const row = document.createElement('div');
              row.style.display = 'flex';
              row.style.justifyContent = 'space-between';
              row.style.alignItems = 'center';
              row.style.padding = '2px 0';

              const text = document.createElement('div');
              text.style.flex = '1';
              text.style.overflow = 'hidden';
              text.style.textOverflow = 'ellipsis';
              text.style.whiteSpace = 'nowrap';
              text.style.fontFamily = 'monospace';
              text.textContent = `slot ${p.slot}: ${p.id || '<empty>'} ${p.petSpecies ? '(' + p.petSpecies + ')' : ''}`;

              const copyBtn = document.createElement('button');
              copyBtn.textContent = '📋';
              copyBtn.title = 'Copy this pet id';
              copyBtn.style.marginLeft = '8px';
              copyBtn.style.flex = '0 0 auto';
              copyBtn.style.padding = '4px 6px';
              copyBtn.style.borderRadius = '4px';
              copyBtn.style.border = 'none';
              copyBtn.style.cursor = 'pointer';

              copyBtn.addEventListener('click', async (ev) => {
                try {
                  ev.stopPropagation();
                  const id = p.id || '';
                  if (!id) { alert('No pet id to copy'); return; }
                  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    await navigator.clipboard.writeText(id);
                  } else {
                    const ta = document.createElement('textarea');
                    ta.value = id;
                    ta.style.position = 'fixed'; ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand && document.execCommand('copy');
                    document.body.removeChild(ta);
                  }
                  // small visual feedback
                  const orig = copyBtn.textContent;
                  copyBtn.textContent = '✓';
                  setTimeout(() => copyBtn.textContent = orig, 900);
                } catch (e) {
                  alert('Copy failed: ' + String(e));
                }
              });

              row.appendChild(text);
              row.appendChild(copyBtn);
              petList.appendChild(row);
            });
          } catch (e) {
            petList.textContent = 'Error: ' + String(e);
          }
        }

        // Initial load
        try { updatePetList(); } catch(_) {}

        document.body.appendChild(panel);
        state.panel = panel;
        attachDrag(title, panel);

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'mg-autofeeder-toggle';
        toggleBtn.textContent = 'AF';
        toggleBtn.title = 'Auto Feeder';
        toggleBtn.style.position = 'fixed';
        toggleBtn.style.right = '12px';
        toggleBtn.style.bottom = '12px';
        toggleBtn.style.zIndex = '2147483647';
        toggleBtn.style.background = '#2d7ef7';
        toggleBtn.style.color = '#fff';
        toggleBtn.style.border = 'none';
        toggleBtn.style.borderRadius = '99px';
        toggleBtn.style.padding = '8px 10px';
        toggleBtn.style.cursor = 'pointer';
        toggleBtn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.35)';
        toggleBtn.style.display = 'none';
        toggleBtn.addEventListener('click', () => { setVisible(true); });
        document.body.appendChild(toggleBtn);
        state.toggleBtn = toggleBtn;

        // Initialize visibility
        setVisible(state.visible);

        // Shortcut: Ctrl+Shift+Z to toggle visibility
        window.addEventListener('keydown', (ev) => {
          try {
            if (ev && ev.ctrlKey && ev.shiftKey && (ev.key === 'Z' || ev.key === 'z')) {
              setVisible(!state.visible);
              ev.preventDefault();
              ev.stopPropagation();
            }
          } catch(_){}
        }, true);

        // Prevent game hotkeys while interacting with our panel
        const stopIfInsidePanel = (ev) => {
          try {
            if (!state.panel) return;
            const t = ev.target;
            if (!state.panel.contains(t)) return;

            // Always stop propagation so the game doesn't see the keystroke
            ev.stopPropagation();

            // Allow default behavior for editable controls so typing works
            const tag = (t.tagName || '').toUpperCase();
            const isEditable = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true);
            if (isEditable) return;

            // For non-editable elements inside the panel, prevent default for typical movement/interaction keys
            const k = ev.key;
            const keysToBlock = new Set([' ', 'Spacebar', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Tab', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D']);
            if (keysToBlock.has(k)) ev.preventDefault();
          } catch(_) {}
        };
        window.addEventListener('keydown', stopIfInsidePanel, true);
        window.addEventListener('keyup', stopIfInsidePanel, true);
        window.addEventListener('keypress', stopIfInsidePanel, true);

        // Build Auto Buyer items editor
        (async () => {
          const saved = (function(){ try { return JSON.parse(localStorage.getItem('mg_auto_buyer_items')||'[]'); } catch(_) { return []; } })();
          const firstRunSeen = (function(){ try { return localStorage.getItem('mg_auto_buyer_seen') === '1'; } catch(_) { return false; } })();
          const selected = new Set(Array.isArray(saved) ? saved.map(String) : []);
          if (!firstRunSeen) {
            try { localStorage.setItem('mg_auto_buyer_items', '[]'); localStorage.setItem('mg_auto_buyer_seen', '1'); } catch(_) {}
            selected.clear();
          }
          let catalog = null;
          try {
            const resp = await fetch('http://127.0.0.1:5000/discovered_items.json', { cache: 'no-store' });
            if (resp.ok) catalog = await resp.json();
          } catch (_) {}
          if (!catalog || typeof catalog !== 'object') catalog = {};
          const groups = [
            { key: 'seed', label: 'Seeds' },
            { key: 'egg', label: 'Eggs' },
            { key: 'tool', label: 'Tools' },
            { key: 'decor', label: 'Decor' }
          ];
          const allItems = [];
          groups.forEach(g => {
            const arr = Array.isArray(catalog[g.key]) ? catalog[g.key] : [];
            arr.forEach(name => allItems.push({ name: String(name), group: g.label }));
          });

          function renderList(filter) {
            buyerEditor.innerHTML = '';
            const f = String(filter || '').toLowerCase();
            const filtered = allItems.filter(it => !f || it.name.toLowerCase().includes(f));
            if (filtered.length === 0) {
              const none = document.createElement('div');
              none.textContent = 'No items';
              none.style.opacity = '0.8';
              buyerEditor.appendChild(none);
              return;
            }
            let currentGroup = null;
            filtered.forEach(it => {
              if (it.group !== currentGroup) {
                currentGroup = it.group;
                const gl = document.createElement('div');
                gl.textContent = currentGroup;
                gl.style.marginTop = '4px';
                gl.style.fontWeight = '600';
                buyerEditor.appendChild(gl);
              }
              const row = document.createElement('label');
              row.style.display = 'flex';
              row.style.alignItems = 'center';
              row.style.gap = '6px';
              row.style.padding = '2px 0';
              const cb = document.createElement('input');
              cb.type = 'checkbox';
              cb.checked = selected.has(it.name);
              cb.addEventListener('change', () => {
                if (cb.checked) selected.add(it.name); else selected.delete(it.name);
                try { localStorage.setItem('mg_auto_buyer_items', JSON.stringify(Array.from(selected))); } catch(_) {}
              });
              const span = document.createElement('span');
              span.textContent = it.name;
              row.appendChild(cb);
              row.appendChild(span);
              buyerEditor.appendChild(row);
            });
          }

          renderList('');
          filterInput.addEventListener('input', () => renderList(filterInput.value));
          editorBtn.addEventListener('click', () => {
            const hidden = buyerEditor.style.display === 'none';
            buyerEditor.style.display = hidden ? 'block' : 'none';
            editorBtn.textContent = hidden ? 'Hide Items' : 'Show Items';
          });
          selectAllBtn.addEventListener('click', () => {
            const f = String(filterInput.value || '').toLowerCase();
            allItems.forEach(it => { if (!f || it.name.toLowerCase().includes(f)) selected.add(it.name); });
            try { localStorage.setItem('mg_auto_buyer_items', JSON.stringify(Array.from(selected))); } catch(_) {}
            renderList(filterInput.value);
          });
          clearBtn.addEventListener('click', () => {
            const f = String(filterInput.value || '').toLowerCase();
            allItems.forEach(it => { if (!f || it.name.toLowerCase().includes(f)) selected.delete(it.name); });
            try { localStorage.setItem('mg_auto_buyer_items', JSON.stringify(Array.from(selected))); } catch(_) {}
            renderList(filterInput.value);
          });

          buyerStartBtn.addEventListener('click', async () => {
            const items = Array.from(selected);
            try { localStorage.setItem('mg_auto_buyer_items', JSON.stringify(items)); } catch(_) {}
            try {
              const res = await window.MagicGardenAPI.startAutoBuyer({ items });
              if (res && res.success) buyerStatus.textContent = `Buyer running (${items.length} items)`; else buyerStatus.textContent = `Error: ${(res && res.error) || 'unknown'}`;
            } catch (_) { buyerStatus.textContent = 'Error starting buyer'; }
          });
          buyerStopBtn.addEventListener('click', async () => {
            try {
              const res = await window.MagicGardenAPI.stopAutoBuyer();
              if (res && res.success) buyerStatus.textContent = 'Buyer stopped'; else buyerStatus.textContent = `Error: ${(res && res.error) || 'unknown'}`;
            } catch (_) { buyerStatus.textContent = 'Error stopping buyer'; }
          });
})();

        // Build Auto Harvester species editors
        (async () => {
          const loadSet = (key) => {
            try { return new Set(JSON.parse(localStorage.getItem(key) || '[]').map(String)); } catch (_) { return new Set(); }
          };
          const saveSet = (key, set) => { try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch (_) {} };

          const harvestSelected = loadSet('mg_auto_seller_harvest_species');
          const replantSelected = loadSet('mg_auto_seller_replant_species');
          let catalog = null;
          try {
            const resp = await fetch('http://127.0.0.1:5000/discovered_items.json', { cache: 'no-store' });
            if (resp.ok) catalog = await resp.json();
          } catch (_) {}
          const species = Array.isArray(catalog?.seed) ? catalog.seed.map(String) : [];

          function renderLists(filter) {
            const f = String(filter || '').toLowerCase();
            const list = species.filter(n => !f || n.toLowerCase().includes(f));
            const renderInto = (container, selectedSet) => {
              container.innerHTML = '';
              if (list.length === 0) {
                const none = document.createElement('div');
                none.textContent = 'No species';
                none.style.opacity = '0.8';
                container.appendChild(none);
                return;
              }
              list.forEach(name => {
                const row = document.createElement('label');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '6px';
                row.style.padding = '2px 0';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = selectedSet.has(name);
                cb.addEventListener('change', () => {
                  if (cb.checked) selectedSet.add(name); else selectedSet.delete(name);
                  saveSet(container === harvestList ? 'mg_auto_seller_harvest_species' : 'mg_auto_seller_replant_species', selectedSet);
                });
                const span = document.createElement('span');
                span.textContent = name;
                row.appendChild(cb);
                row.appendChild(span);
                container.appendChild(row);
              });
            };
            renderInto(harvestList, harvestSelected);
            renderInto(replantList, replantSelected);
          }

          renderLists('');
          sellerFilterInput.addEventListener('input', () => renderLists(sellerFilterInput.value));
          sellerEditorToggle.addEventListener('click', () => {
            const hidden = sellerEditorsWrap.style.display === 'none';
            sellerEditorsWrap.style.display = hidden ? 'block' : 'none';
            sellerEditorToggle.textContent = hidden ? 'Hide Species' : 'Show Species';
          });

          runSellerBtn.addEventListener('click', async () => {
            try {
              const speciesFilter = Array.from(harvestSelected);
              const replantSpecies = Array.from(replantSelected);
              const sell = !!sellerSellCb.checked;
              const mutationExpr = String(exprInput.value || '').trim();
              try { localStorage.setItem('mg_auto_harvest_expr', mutationExpr); } catch(_) {}
              try { localStorage.setItem('mg_auto_seller_sell', sell ? '1' : '0'); } catch(_) {}
              sellerStatus.textContent = 'Running...';
              const res = await window.MagicGardenAPI.autoSellOnce({ speciesFilter, replantSpecies, sell, mutationExpr });
              if (res && res.success) {
                sellerStatus.textContent = `Done: harvested ${res.harvestedTotal}, sold=${res.soldAttempted ? !!res.sold : 'skipped'}`;
              } else {
                sellerStatus.textContent = `Error: ${(res && res.error) || 'unknown'}`;
              }
            } catch (e) {
              sellerStatus.textContent = 'Error running seller';
            }
          });

          startSellerBtn.addEventListener('click', async () => {
            try {
              const minutes = Math.max(1, parseInt(sellerIntervalInput.value, 10) || 60);
              const iv = minutes * 60 * 1000;
              try { localStorage.setItem('mg_auto_seller_interval_ms', String(iv)); } catch(_) {}
              const speciesFilter = Array.from(harvestSelected);
              const replantSpecies = Array.from(replantSelected);
              const sell = !!sellerSellCb.checked;
              const mutationExpr = String(exprInput.value || '').trim();
              try { localStorage.setItem('mg_auto_harvest_expr', mutationExpr); } catch(_) {}
              try { localStorage.setItem('mg_auto_seller_sell', sell ? '1' : '0'); } catch(_) {}
              const res = await window.MagicGardenAPI.startAutoSeller({ intervalMs: iv, speciesFilter, replantSpecies, sell, mutationExpr });
              if (res && res.success) sellerStatus.textContent = `Auto Harvester running (interval=${minutes}m, sell=${sell ? 'on' : 'off'})`; else sellerStatus.textContent = `Error: ${(res && res.error) || 'unknown'}`;
            } catch (e) { sellerStatus.textContent = 'Error starting Auto Harvester'; }
          });

          stopSellerBtn.addEventListener('click', async () => {
            try {
              const res = await window.MagicGardenAPI.stopAutoSeller();
              if (res && res.success) sellerStatus.textContent = 'Seller stopped'; else sellerStatus.textContent = `Error: ${(res && res.error) || 'unknown'}`;
            } catch (e) { sellerStatus.textContent = 'Error stopping Auto Harvester'; }
          });
        })();

        state.inited = true;
      } catch (e) {}
    }

    return { ensureAutoFeederUI };
  })();

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => MGUi.ensureAutoFeederUI());
    } else {
      MGUi.ensureAutoFeederUI();
    }
  } catch (e) {}
})();

// ensure global convenience wrappers after API is attached
(function(){
  try {
    if (typeof window !== 'undefined') {
      if (!window.getAllActivePetIds) {
        window.getAllActivePetIds = async function() {
          try {
            if (window.MagicGardenAPI && typeof window.MagicGardenAPI.getAllActivePetIds === 'function') {
              return await window.MagicGardenAPI.getAllActivePetIds();
            }
            return { success: false, error: 'api_unavailable' };
          } catch (e) { return { success: false, error: String(e) }; }
        };
      }
      if (!window.copyActivePetIds) {
        window.copyActivePetIds = async function() {
          try {
            if (window.MagicGardenAPI && typeof window.MagicGardenAPI.copyActivePetIds === 'function') {
              return await window.MagicGardenAPI.copyActivePetIds();
            }
            return { success: false, error: 'api_unavailable' };
          } catch (e) { return { success: false, error: String(e) }; }
        };
      }
    }
  } catch (e) {}
})();


