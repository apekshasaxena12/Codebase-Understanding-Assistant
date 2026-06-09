import os
from groq import AsyncGroq
from dotenv import load_dotenv

load_dotenv()

JINA_API_URL = "https://api.jina.ai/v1/embeddings"

groq_client = AsyncGroq(api_key=os.getenv("GROQ_API_KEY"))
