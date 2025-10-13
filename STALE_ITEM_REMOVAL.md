# Automatic Stale Item Removal Feature

## Overview
The Chrome extension now automatically detects and removes stale crop items from `full_game_state.json` when they fail to feed pets multiple times.

## Problem Solved
Previously, if an item existed in the JSON file but not in the actual game:
- The extension would repeatedly try to feed it to pets
- It would fail indefinitely 
- Manual intervention was required to fix the state

## New Behavior

### Smart Retry Logic
When `feedPet()` is called, it now:

1. **Attempts to feed** the pet with the first available crop from the diet
2. **Verifies success** by checking if the item still exists in inventory after feeding
3. **If item still exists** (feeding failed):
   - Increments failure counter for that specific item ID
   - After **3 consecutive failures** for the same item, marks it as stale
4. **Removes stale items** from `full_game_state.json` via Flask API
5. **Retries with next available crop** from the diet
6. **Continues up to 10 total attempts**, trying different crops as stale ones are removed

### Key Features

- ✅ **Automatic detection**: No manual intervention needed
- ✅ **Smart filtering**: Skips already-identified stale items in subsequent attempts  
- ✅ **Persistent tracking**: Tracks failure counts across calls via `_feedFailureTracker`
- ✅ **Detailed logging**: Console logs show which items are being removed
- ✅ **Backward compatible**: Existing code continues to work

## Code Changes

### New Helper Function
```javascript
async removeStaleInventoryItem(itemId)
```
Calls Flask API endpoint `/api/inventory/remove_id` to delete an item by ID.

### Modified Function
```javascript
async feedPet(slotNumber, options = {})
```

**New Parameters:**
- `options.maxRetries` (default: 10) - Maximum total feeding attempts
- `options.retryDelay` (default: 200ms) - Delay between attempts

**New Return Values:**
- `attempts` - Number of attempts made
- `removedStaleItems` - Array of item IDs that were removed as stale

## Example Usage

### Basic Usage (unchanged)
```javascript
// Works exactly as before
const result = await MagicGardenAPI.feedPet(0);
```

### Advanced Usage
```javascript
// Custom retry settings
const result = await MagicGardenAPI.feedPet(0, {
  maxRetries: 15,    // Try up to 15 times
  retryDelay: 300    // Wait 300ms between attempts
});

// Check what happened
if (result.success) {
  console.log('Fed successfully after', result.attempts, 'attempts');
  if (result.removedStaleItems.length > 0) {
    console.log('Removed stale items:', result.removedStaleItems);
  }
} else {
  console.log('Failed after', result.attempts, 'attempts');
  console.log('Removed stale items:', result.removedStaleItems);
}
```

## How It Works

### Detection Process
```
Attempt 1: Try feeding with Carrot (ID: abc123)
  → Item still in inventory → Failure count: 1

Attempt 2: Try feeding with Carrot (ID: abc123) again  
  → Item still in inventory → Failure count: 2

Attempt 3: Try feeding with Carrot (ID: abc123) again
  → Item still in inventory → Failure count: 3
  → Remove from state as STALE

Attempt 4: Try feeding with Tomato (ID: def456)
  → Item removed from inventory → SUCCESS!
```

### Verification Logic
After sending the feed command, the code:
1. Waits for server response (200ms default)
2. Re-fetches the full game state
3. Checks if the item ID still exists in inventory
4. If exists → feeding failed (stale item)
5. If gone → feeding succeeded (real item)

## Console Logs

You'll see helpful console messages:

```javascript
// Success
[MG feedPet] Successfully fed pet with Carrot id: abc123

// Failure detection  
[MG feedPet] Feed attempt 1 failed for item abc123 (Carrot)
[MG feedPet] Feed attempt 2 failed for item abc123 (Carrot)
[MG feedPet] Feed attempt 3 failed for item abc123 (Carrot)

// Stale removal
[MG feedPet] Item abc123 failed 3 times, removing from state as stale
[MG] Removed stale item from inventory: abc123 {removed: true}

// Completion
[MG feedPet] no_food_in_inventory after 10 attempts, tried: ["abc123", "def456"]
```

## Impact on Other Functions

### `feedPetWithHarvest()`
Automatically benefits from stale removal since it calls `feedPet()` internally.

### `feedPetUntilMax()`  
Automatically benefits from stale removal since it calls `feedPetWithHarvest()` internally.

### Auto Feeder
Will automatically clean up stale items as it runs, improving reliability over time.

## Configuration

### Adjust Failure Threshold
Currently set to 3 failures before removal. To change, edit this line in `api.js`:

```javascript
if (this._feedFailureTracker[foodItem.id] >= 3) {  // Change 3 to desired threshold
```

### Adjust Max Retries
Change the default in the function signature:

```javascript
const maxRetries = options.maxRetries || 10;  // Change 10 to desired max
```

## Testing

### Test Stale Removal Manually
1. Add a fake item to `full_game_state.json` inventory with a bogus ID
2. Call `await MagicGardenAPI.feedPet(0)`
3. Watch console - should see it detected and removed after 3 attempts
4. Should then try next item in diet

### Monitor Auto Feeder
1. Start auto feeder
2. Watch browser console for removal messages
3. Over time, stale items will be cleaned up automatically

## Troubleshooting

### "Too aggressive - removing real items"
Increase the failure threshold from 3 to 5 or more:
```javascript
if (this._feedFailureTracker[foodItem.id] >= 5) {
```

### "Not detecting stale items"
Increase the retry delay to ensure state updates:
```javascript
await MagicGardenAPI.feedPet(0, { retryDelay: 500 });
```

### "Max retries hit too quickly"  
Increase max retries:
```javascript
await MagicGardenAPI.feedPet(0, { maxRetries: 20 });
```

## API Endpoint Used

The feature requires this Flask endpoint (already implemented in `app.py`):

```
POST /api/inventory/remove_id
Body: { "id": "<item-uuid>" }
Response: { "ok": true, "removed": true/false, "count": <remaining_items> }
```

This endpoint removes the first item matching the given ID from the inventory array.
