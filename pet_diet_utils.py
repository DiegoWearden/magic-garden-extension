#!/usr/bin/env python3
"""
Pet Diet Utilities - Helper functions for working with pet diets
"""

import json
import os
from typing import Dict, Optional

class PetDietUtils:
    def __init__(self, json_file: str = "mg_pet_diets.json"):
        self.json_file = json_file
        self.diets: Dict[str, str] = {}
        self.load_diets()
    
    def load_diets(self) -> bool:
        """Load diets from JSON file"""
        try:
            if os.path.exists(self.json_file):
                with open(self.json_file, 'r') as f:
                    data = json.load(f)
                # Support both combined and legacy formats
                diets = {}
                if isinstance(data, dict) and 'pets' in data and isinstance(data['pets'], dict):
                    for pid, cfg in data['pets'].items():
                        if isinstance(cfg, dict):
                            v = cfg.get('diets')
                            if isinstance(v, list): diets[pid] = ', '.join(map(str, v))
                            elif isinstance(v, str): diets[pid] = v
                elif isinstance(data, dict):
                    for pid, v in data.items():
                        if isinstance(v, list): diets[pid] = ', '.join(map(str, v))
                        elif isinstance(v, str): diets[pid] = v
                self.diets = diets
                return True
            return False
        except Exception as e:
            print(f"Error loading diets: {e}")
            return False
    
    def get_diet(self, pet_id: str) -> Optional[str]:
        """Get diet for a specific pet ID"""
        return self.diets.get(pet_id)
    
    def get_all_diets(self) -> Dict[str, str]:
        """Get all pet diets"""
        return self.diets.copy()
    
    def has_pet(self, pet_id: str) -> bool:
        """Check if pet ID exists in diets"""
        return pet_id in self.diets
    
    def add_diet(self, pet_id: str, diet: str) -> bool:
        """Add or update a pet diet"""
        try:
            self.diets[pet_id] = diet
            return True
        except Exception as e:
            print(f"Error adding diet: {e}")
            return False
    
    def save_diets(self) -> bool:
        """Save diets to JSON file"""
        try:
            with open(self.json_file, 'w') as f:
                json.dump(self.diets, f, indent=2)
            return True
        except Exception as e:
            print(f"Error saving diets: {e}")
            return False

# Example usage
if __name__ == "__main__":
    utils = PetDietUtils()
    
    # Example pet IDs (replace with real ones)
    example_pets = [
        "d324000e-9143-45c3-9d27-1000833d4ade",
        "7842870f-2265-4065-b872-adaf48017fbb", 
        "885c86d4-8e82-42ab-9b68-350e0cbced23"
    ]
    
    print("Pet Diet Lookup:")
    for pet_id in example_pets:
        diet = utils.get_diet(pet_id)
        if diet:
            print(f"  {pet_id[:8]}... -> {diet}")
        else:
            print(f"  {pet_id[:8]}... -> No diet set")
