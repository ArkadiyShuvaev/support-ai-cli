"""
Lightweight embedding server.

Exposes a single POST /embed endpoint that returns a 512-dimensional
vector for a given text string, using the same model as the indexer.

Usage:
    uv run uvicorn embedding_server:app --port 8001 --reload
"""

import os

from dotenv import find_dotenv, load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

load_dotenv(find_dotenv())

EMBEDDING_MODEL_NAME: str = os.environ.get(
    "EMBEDDING_MODEL_NAME", "distiluse-base-multilingual-cased-v1"
)

app = FastAPI(title="Embedding Server")
model = SentenceTransformer(EMBEDDING_MODEL_NAME)


class EmbedRequest(BaseModel):
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    vector = model.encode(req.text, normalize_embeddings=True)
    return EmbedResponse(embedding=vector.tolist())
