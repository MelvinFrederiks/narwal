FROM python:3.11-slim

# hashcat-data, not hashcat: the rule files only, no binary and no OpenCL
# stack. The API needs them because it both lists the available rules for the
# Mergeability job builder and validates a submitted job's rule paths before
# queueing it — and it has to agree with the worker about where those files
# live (/usr/share/hashcat/rules). Without this the rules dropdown is empty
# and any job using one is rejected at enqueue.
RUN apt-get update \
 && apt-get install -y --no-install-recommends hashcat-data \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir fastapi "uvicorn[standard]"

# The experimental python-hashtopolis client is not on PyPI, so it comes from a
# local checkout passed in as the `hashtopolis-src` build context (compose sets
# it from NARWAL_HASHTOPOLIS_SRC). Unset, that context is an empty directory and
# the install is skipped: the app runs without the Hashtopolis attack picker.
# The client reads hashtopolis-test.yaml from its CWD (/app) — compose mounts it.
COPY --from=hashtopolis-src . /tmp/hashtopolis
RUN if [ -f /tmp/hashtopolis/pyproject.toml ] || [ -f /tmp/hashtopolis/setup.py ]; then \
      pip install --no-cache-dir /tmp/hashtopolis; \
    fi \
 && rm -rf /tmp/hashtopolis

COPY backend ./backend
COPY web ./web

EXPOSE 7070

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7070"]
