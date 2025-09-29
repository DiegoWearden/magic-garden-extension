// Attach coordinate and garden helpers to MagicGardenAPI without polluting global scope
(function attachCoordsModule() {
  function attach(api) {
    if (!api || attach.__applied) return; attach.__applied = true;

    api.coordToSlot = function(x, y) {
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
      } catch (e) { return null; }
    };

    api.slotToCoord = function(slotIndex) {
      try {
        const s = Number(slotIndex);
        if (!Number.isFinite(s) || s < 0 || s > 199) return null;
        const row = Math.floor(s / 20); // 0..9
        const col = s % 20; // 0..19
        const y = 4 + row;
        const x = col < 10 ? (4 + col) : (15 + (col - 10));
        return { x, y };
      } catch (e) { return null; }
    };

    api.getTileByCoord = function(x, y) {
      const slot = api.coordToSlot(x, y);
      if (slot == null) return null;
      return api.extractMutationsBySlot(slot);
    };

    api.getGarden = function() {
      try {
        const gs = api.getGameState();
        return gs?.child?.data?.userSlots?.[0]?.data?.garden?.tileObjects || {};
      } catch (_) { return {}; }
    };
  }

  if (window.MagicGardenAPI) attach(window.MagicGardenAPI);
  else { (window.__mg_attachers = window.__mg_attachers || []).push(attach); }
})();


