FROM python:3.11-slim

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir fastapi "uvicorn[standard]"

COPY backend ./backend
COPY web ./web

EXPOSE 7070

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7070"]
