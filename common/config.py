import os
from dotenv import load_dotenv

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(PROJECT_DIR, ".env"))

API_ID = int(os.environ["API_ID"])
API_HASH = os.environ["API_HASH"]
PHONE = os.environ.get("PHONE", "")
SESSION_NAME = os.path.join(PROJECT_DIR, os.environ.get("SESSION_NAME", "session"))

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
MUSIC_GROUP_KEYWORD = os.environ.get("MUSIC_GROUP_KEYWORD", "playlists cache")
MUSIC_TOPIC_NAME = os.environ.get("MUSIC_TOPIC_NAME", "")
WEBAPP_HOST = os.environ.get("WEBAPP_HOST", "0.0.0.0")
WEBAPP_PORT = int(os.environ.get("WEBAPP_PORT", "8080"))
WEBAPP_PUBLIC_URL = os.environ.get("WEBAPP_PUBLIC_URL", "")
MUSIC_CACHE_DIR = os.path.join(PROJECT_DIR, "music_cache")
