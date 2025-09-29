# Magic Garden Chrome Extension

A comprehensive Chrome extension for automating gameplay in Magic Garden, featuring auto-feeding, virtual inventory management, and real-time game state monitoring.

## Features

### 🎮 Game Automation
- **Auto-feeder**: Automatically feeds pets until maximum hunger or no more items available
- **Crop harvesting**: Harvest crops by name, location, or mutation criteria
- **Movement automation**: Travel to specific game locations (garden, shops, etc.)
- **WebSocket integration**: Direct communication with game server

### 📊 Virtual Inventory Management
- **Real-time sync**: Keeps virtual inventory synchronized with game state
- **Flask backend**: Server-side inventory management with JSON storage
- **Item tracking**: Track crops, seeds, and other items across sessions

### 🐾 Pet Management
- **Diet configuration**: GUI for setting pet diets and max hunger values
- **Hunger monitoring**: Real-time pet hunger tracking
- **Auto-feeding**: Intelligent feeding system that harvests when needed

### 🌱 Garden Management
- **Crop monitoring**: Check crop growth status and readiness
- **Mutation tracking**: Extract and analyze crop mutations
- **Slot management**: Coordinate-based and slot-based garden navigation

## Installation

### Prerequisites
- Python 3.8+
- Chrome browser
- Flask and Flask-CORS

### Setup

1. **Install Python dependencies:**
   ```bash
   pip install flask flask-cors
   ```

2. **Load the Chrome extension:**
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select this directory

3. **Start the Flask server:**
   ```bash
   python app.py
   ```

4. **Configure pet diets:**
   - Open `http://127.0.0.1:5000/pet_diet_manager.html`
   - Set up pet diets and max hunger values

## Usage

### Basic Commands

```javascript
// Start auto-feeder
await window.MagicGardenAPI.startAutoFeeder();

// Feed a specific pet until max hunger
await window.MagicGardenAPI.feedUntilMax(0); // slot 0-2

// Harvest any crop by name
await window.MagicGardenAPI.harvestOneByCrop('Tomato');

// Check crop readiness
await window.MagicGardenAPI.isCropReady(22, 4, 1);

// Get inventory items
await window.MagicGardenAPI.getItemFromInventory('Tomato');
```

### Pet Management

```javascript
// Get pet information
const petInfo = window.MagicGardenAPI.getPetId(0);
console.log('Pet ID:', petInfo.petId);

// Get pet diet
const diet = window.MagicGardenAPI.getPetDietBySlot(0);
console.log('Pet diet:', diet.diet);
```

### Garden Operations

```javascript
// Get garden state
const garden = window.MagicGardenAPI.getGarden();

// Get mutations at specific location
const mutations = window.MagicGardenAPI.getMutationsAt(22, 4);

// Travel to specific locations
await window.MagicGardenAPI.travelToGarden();
await window.MagicGardenAPI.travelToCropShop();
```

## File Structure

```
magic-garden-extension/
├── manifest.json              # Chrome extension manifest
├── content.js                 # Main content script with game API
├── background.js              # Background script for WebSocket injection
├── popup.html/js              # Extension popup interface
├── app.py                     # Flask server for virtual inventory
├── pet_diet_manager.html      # Pet diet configuration GUI
├── discovered_items.json      # Available crops and items
├── mg_inventory.json          # Virtual inventory storage
├── mg_pet_diets.json          # Pet diet configurations
└── README.md                  # This file
```

## API Reference

### Core Functions

- `startAutoFeeder(options)` - Start automatic pet feeding
- `stopAutoFeeder()` - Stop auto-feeder
- `feedUntilMax(slotNumber)` - Feed pet until max hunger
- `harvestOneByCrop(cropName)` - Harvest one crop by name
- `harvestAnyCrop(x, y, slotIndex)` - Harvest any ready crop
- `isCropReady(x, y, slotIndex)` - Check if crop is ready

### Inventory Functions

- `getItemFromInventory(crop)` - Get items from virtual inventory
- `saveInventoryFromGameState()` - Sync inventory with game state
- `pushInventoryToServer()` - Force inventory update

### Pet Functions

- `getPetId(slotNumber)` - Get pet ID for slot
- `getPetDietBySlot(slotNumber)` - Get pet diet for slot
- `setPetDiet(petId, diet)` - Set pet diet

### Garden Functions

- `getGarden()` - Get entire garden state
- `getMutationsAt(x, y)` - Get mutations at coordinates
- `getCrop(slotNumber)` - Get crop at slot number
- `coordToSlot(x, y)` - Convert coordinates to slot number

## Configuration

### Pet Diets
Use the web interface at `http://127.0.0.1:5000/pet_diet_manager.html` to:
- Set pet diets (multiple crops per pet)
- Configure max hunger values
- Manage pet configurations

### Auto-feeder Options
```javascript
await window.MagicGardenAPI.startAutoFeeder({
  hungerThreshold: 500,        // Feed when hunger below this
  checkInterval: 5000,         // Check every 5 seconds
  maxHarvestLoops: 8          // Max harvest attempts per feed
});
```

## Troubleshooting

### Common Issues

1. **Extension not working**: Check that the Flask server is running
2. **Inventory not syncing**: Restart the extension and server
3. **Pets not feeding**: Verify pet diets are configured correctly
4. **Crops not harvesting**: Check crop readiness with `isCropReady()`

### Debug Mode

Enable debug logging:
```javascript
window.MagicGardenAPI.setDebugMode(true);
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

This project is for educational and personal use only. Please respect the game's terms of service.

## Changelog

### v1.0.0
- Initial release
- Auto-feeder functionality
- Virtual inventory management
- Pet diet configuration
- WebSocket integration
- Real-time game state monitoring