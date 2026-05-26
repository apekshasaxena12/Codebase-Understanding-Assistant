from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import ingest, query
from dotenv import load_dotenv
load_dotenv()
import logging
logging.basicConfig(level=logging.DEBUG)


from database import engine, Base         
import models.chunk                     
Base.metadata.create_all(bind=engine) 

app = FastAPI(title="Codebase Understanding Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest.router, prefix="/api")
app.include_router(query.router, prefix="/api")

@app.get("/health")
def health():
    return {"status": "ok"}
