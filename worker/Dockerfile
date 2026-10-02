# Narwal worker — the queue loop and an OpenCL stack. No hashcat.
#
# Separate from the API image on purpose: this one carries the OpenCL runtime,
# while the API stays a plain slim-Python image. The two share nothing but the
# NARWAL_RUNS_DIR volume.
#
# hashcat is NOT installed here. It is bind-mounted from the host at
# /opt/hashcat (see docker-compose.yml and .env.example) so you run *your own*
# build — which is the point: a distribution hashcat is pinned to whatever
# version that distribution shipped, and attack modes, hash modes and backends
# added since then simply are not there. Shipping one in the image would also
# mean NARWAL_HASHCAT_BIN's default silently resolves to it, so a
# misconfigured mount would look like it worked while quietly running the wrong
# binary. The worker refuses to start instead, naming what to set.
#
# That means `docker compose up` needs NARWAL_HASHCAT_DIR pointed at a hashcat
# install before the worker will run. Any hashcat tree works: a release
# tarball, or a `git clone && make` build directory.
#
# No pip install: the worker imports only backend/config.py, backend/jobs/*
# and the stdlib.

FROM python:3.11-slim

# The ICD loader plus the PoCL CPU runtime, so the stack works end-to-end on a
# host with no GPU. On a GPU host the NVIDIA container runtime injects its own
# ICD into /etc/OpenCL/vendors and hashcat picks that up instead — see
# docker-compose.gpu.yml. hashcat links neither: it dlopen()s libOpenCL.so.1 at
# runtime, which is why a hashcat built on a different distribution still runs
# against the ICD loader installed here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ocl-icd-libopencl1 \
      pocl-opencl-icd \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend ./backend
COPY worker ./worker

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    NARWAL_RUNS_DIR=/runs \
    NARWAL_HASHCAT_BIN=/opt/hashcat/hashcat

CMD ["python", "-m", "worker.main"]
