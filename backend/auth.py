import os
from fastapi import Header, HTTPException
from dotenv import load_dotenv

load_dotenv()

_API_KEY = os.getenv("API_KEY", "").strip()


async def require_api_key(x_api_key: str = Header(default="")):
    """Optional API key guard. Enforced only when API_KEY env var is set."""
    if _API_KEY and x_api_key != _API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key header")
