"""Mergeability job queue — schema, spec validation, and metrics.

Split out of backend/routes/ because the worker container imports these
modules too: the API enqueues and reads, the worker claims and writes, and
both need the same schema and the same idea of what a valid attack spec is.
"""
