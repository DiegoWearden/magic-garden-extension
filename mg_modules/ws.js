// Attach WebSocket helpers to MagicGardenAPI
(function attachWsModule() {
  function attach(api) {
    if (!api || attach.__applied) return; attach.__applied = true;

    api.sendWebSocketMessage = async function(message) {
      try { this.sendToPage({ action: 'sendWebSocketMessage', message }); return { success: true }; }
      catch (e) { return { success: false, error: String(e) }; }
    };

    api.purchaseSeed = async function(species) {
      return this.sendWebSocketMessage({ scopePath: ["Room", "Quinoa"], type: "PurchaseSeed", species });
    };

    api.purchaseEgg = async function(eggId) {
      return this.sendWebSocketMessage({ scopePath: ["Room", "Quinoa"], type: "PurchaseEgg", eggId });
    };

    api.purchaseTool = async function(toolId) {
      return this.sendWebSocketMessage({ scopePath: ["Room", "Quinoa"], type: "PurchaseTool", toolId });
    };

    api.purchaseDecor = async function(decorId) {
      return this.sendWebSocketMessage({ scopePath: ["Room", "Quinoa"], type: "PurchaseDecor", decorId });
    };

    api.sellAllCrops = async function() {
      return this.sendWebSocketMessage({ scopePath: ["Room", "Quinoa"], type: "SellAllCrops" });
    };

    api.forceResync = async function() {
      try { this.sendToPage({ action: 'forceReconnectWS' }); return { success: true }; }
      catch (e) { return { success: false, error: String(e) }; }
    };

    api.reselectQuinoa = async function() {
      try {
        await this.sendWebSocketMessage({ scopePath: ["Room"], type: "VoteForGame", gameName: "Quinoa" });
        await this.sendWebSocketMessage({ scopePath: ["Room"], type: "SetSelectedGame", gameName: "Quinoa" });
        return { success: true };
      } catch (e) { return { success: false, error: String(e) }; }
    };
  }
  if (window.MagicGardenAPI) attach(window.MagicGardenAPI);
  else { (window.__mg_attachers = window.__mg_attachers || []).push(attach); }
})();


