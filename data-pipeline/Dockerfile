FROM python:3.11-slim

# Install uv for fast dependency resolution
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Install Python dependencies into the system interpreter (no venv needed in Docker).
# Copy only pyproject.toml first so this layer is cached unless deps change.
COPY pyproject.toml .
RUN uv pip install --system \
    "sentence-transformers>=2.7,<3.0" \
    "fastapi>=0.110" \
    "uvicorn[standard]>=0.29" \
    "python-dotenv>=1.0"

COPY embedding_server.py .

EXPOSE 8001

# Health check — uses stdlib urllib so curl is not required in the slim image.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/docs')"

CMD ["uvicorn", "embedding_server:app", "--host", "0.0.0.0", "--port", "8001"]
