# Narwal mergeability worker — hashcat plus the queue loop.
#
# Separate from the API image on purpose: this one carries hashcat and an
# OpenCL stack, while the API stays a plain slim-Python image. The two share
# nothing but the NARWAL_RUNS_DIR volume.
#
# No pip install: the worker imports only backend/config.py, backend/jobs/*
# and the stdlib. FastAPI lives in backend/routes/, which is never imported
# here — that is what keeps this image free of the web dependencies.

FROM python:3.11-slim

# pocl-opencl-icd is the CPU fallback, so the stack runs end-to-end on a host
# with no GPU. On a GPU host the NVIDIA container runtime injects its own ICD
# into /etc/OpenCL/vendors and hashcat picks that up instead — see
# docker-compose.gpu.yml.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      hashcat \
      ocl-icd-libopencl1 \
      pocl-opencl-icd \
 && rm -rf /var/lib/apt/lists/* \
 # Mode 99999 ("Plaintext") is the assumption this entire feature rests on.
 # Fail the build here rather than one failed job per user, later.
 && hashcat -m 99999 --example-hashes > /dev/null

WORKDIR /app

COPY backend ./backend
COPY worker ./worker

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    NARWAL_RUNS_DIR=/runs

CMD ["python", "-m", "worker.main"]
