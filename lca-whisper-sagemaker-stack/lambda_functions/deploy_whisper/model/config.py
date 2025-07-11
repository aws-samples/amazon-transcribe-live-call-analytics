import os
import sys

"""
This file is used as a fallback if the environment variable approach doesn't work.
It imports the WHISPER_MODEL from the root config.py file.
"""

# Add the parent directory to the path so we can import from the root config
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

try:
    # Try to import from the root config
    from config import WHISPER_MODEL
except ImportError:
    # If that fails, use a default value
    print("Failed to import from config.py, using default value.")
    WHISPER_MODEL = "base.en"
