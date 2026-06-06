# syntax=docker/dockerfile:1.6
#
# Bible IU — single-image deploy.
#   stage 1: build the frontend (Vite → static assets in /app/dist).
#   stage 2: install the backend, copy in the built assets, and have
#            FastAPI serve them so we ship one process behind one port.
#
# Designed for Fly.io (persistent volume mounted at /data for the
# SQLite + Y.Docs store) but portable to any Docker host.
# ---------------------------------------------------------------------------

# ---------- stage 1: frontend build ----------
FROM node:20-slim AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Production build: tsc verifies types, vite emits hashed assets to /app/dist.
RUN npm run build

# ---------- stage 2: backend runtime ----------
FROM python:3.12-slim AS runtime
WORKDIR /app

# Build tooling needed for argon2-cffi + pycrdt wheels; removed
# after install so the runtime image stays slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Backend source + built frontend assets.
COPY backend/ ./backend/
COPY --from=frontend /app/dist /app/frontend_dist

# Bible IU expects backend/data/ to exist; Fly mounts the persistent
# volume here so SQLite, Y.Docs ystore, and seeded scripture survive
# deploys.
RUN mkdir -p /data
ENV BIBLE_IU_DATABASE_URL=sqlite:////data/bible-iu.sqlite \
    BIBLE_IU_YSTORE_PATH=/data/ystore \
    BIBLE_IU_STATIC_DIR=/app/frontend_dist \
    PYTHONUNBUFFERED=1 \
    PORT=8080

EXPOSE 8080

# Strip dev-only build packages to shrink the runtime image.
RUN apt-get purge -y --auto-remove build-essential

CMD ["sh", "-c", "uvicorn backend.api.main:app --host 0.0.0.0 --port ${PORT}"]
