FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        hashcat \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.5.4 /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml .python-version ./
RUN uv sync --no-dev --frozen 2>/dev/null || uv pip install --system -e .

COPY backend ./backend
COPY web ./web
COPY data ./data

EXPOSE 8080

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]
