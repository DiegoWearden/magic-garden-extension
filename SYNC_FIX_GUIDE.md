# Inventory Sync Fix Guide

## Problem
The Chrome extension tries to feed pets with crops that don't exist in the actual game inventory, even though they appear in `full_game_state.json`. This happens because the JSON file becomes out of sync with the real game state.

## Root Cause
When you feed a pet, the game server sends WebSocket PartialState patches to remove the consumed item from inventory. If these patches:
- Arrive slowly (network latency)
- Aren't processed correctly by Flask
- Are missed during rapid operations

Then `full_game_state.json` becomes stale.

## Fixes Applied

### 1. Increased Wait Times in api.js
- **feedPet()**: Now waits 200ms after feeding to allow server patches to arrive
- **feedPetUntilMax()**: Increased delay from 300ms to 500ms between feeding attempts

### 2. How It Works
```javascript
// Before
await this.sendWebSocketMessage(feedMsg);
return { success: true, ... };

// After  
await this.sendWebSocketMessage(feedMsg);
await new Promise(r => setTimeout(r, 200)); // Wait for patches
return { success: true, ... };
```

## Testing the Fix

1. **Reload the Chrome Extension**
   - Go to `chrome://extensions/`
   - Click reload on "Magic Garden Game Controller"

2. **Test Manual Feeding**
   ```javascript
   // In browser console:
   await MagicGardenAPI.feedPet(0)
   ```
   
3. **Check the JSON file**
   - After feeding, check that the item was removed from `full_game_state.json`
   - Path: `.child.data.userSlots[].data.inventory.items[]`

4. **Test Auto Feeder**
   - Start the auto feeder with the UI
   - Watch for any errors in console
   - Verify it doesn't try to feed non-existent items

## Additional Debugging

If issues persist, you can:

### Check WebSocket Messages
```javascript
// In browser console, monitor WebSocket traffic:
// Look for PartialState messages with inventory patches
```

### Force a Full Resync
```javascript
// Force the game to send a fresh Welcome message with full state:
await MagicGardenAPI.forceResync()
```

### Check Flask Server Logs
The Flask server logs should show:
- `logged`: Number of WebSocket frames received
- `applied`: Number of patches successfully applied
- `skipped`: Number of patches that failed

If `skipped` is high, there's a patching problem.

## If Problems Continue

### Option 1: Increase Delays Further
Edit `api.js` and increase the delays:
- Change 200ms to 500ms in `feedPet()`
- Change 500ms to 1000ms in `feedPetUntilMax()`

### Option 2: Force Full State Refresh
Add to the start of `feedPet()`:
```javascript
// Force a fresh state read
await this.forceResync();
await new Promise(r => setTimeout(r, 1000));
```

### Option 3: Verify WebSocket Patch Processing
Check `app.py` line 647-665 - the patch application logic.
If patches are being skipped, the JSON pointer path might be wrong.

## Technical Details

### WebSocket Message Flow
1. Page → WebSocket intercept (background.js pageScript)
2. Page → Content Script via postMessage
3. Content Script → Background Script (`wsAllLog`)
4. Background Script → Flask Server (`/api/wslog`)
5. Flask → Parse PartialState patches
6. Flask → Apply patches to `full_game_state.json`

### Key Files
- `api.js`: Client-side API (feeding logic)
- `background.js`: WebSocket interception (lines 554-585)
- `app.py`: Server-side patch processing (lines 525-680)

## Emergency Workaround

If feeding breaks completely, you can manually reset the state:
1. Open the game and let it load completely
2. The next Welcome message will reset `full_game_state.json` with fresh data
3. Or restart Flask server to clear state (requires new Welcome)
