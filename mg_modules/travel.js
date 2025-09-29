// Attach travel helpers to MagicGardenAPI
(function attachTravelModule() {
  function attach(api) {
    if (!api || attach.__applied) return; attach.__applied = true;
    api.travelToGarden = async function() { return this.moveToWithPath(14, 14); };
    api.travelToCropShop = async function() { return this.moveToWithPath(35, 20); };
    api.travelToCropSeller = async function() { return this.moveToWithPath(44, 20); };
    api.travelToJournal = async function() { return this.moveToWithPath(48, 19); };
    api.travelToPetSeller = async function() { return this.moveToWithPath(44, 19); };
    api.travelToEggShop = async function() { return this.moveToWithPath(35, 19); };
    api.travelToToolShop = async function() { return this.moveToWithPath(31, 20); };
    api.travelToDecorShop = async function() { return this.moveToWithPath(31, 19); };
  }
  if (window.MagicGardenAPI) attach(window.MagicGardenAPI);
  else { (window.__mg_attachers = window.__mg_attachers || []).push(attach); }
})();


