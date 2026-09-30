"""Narwal mergeability worker.

Runs in its own container so the API image can stay a plain slim-Python image
with no GPU runtime. Talks to the API only through the SQLite queue on the
shared NARWAL_RUNS_DIR volume — there is no network path between them, which
is what makes moving this to a dedicated GPU box a mount change rather than a
rewrite.
"""
