"""On-demand loaders for licensed Bible translations.

Public-domain translations (KJV, ASV, WLC, etc.) ship in the SQLite
seed and never touch these loaders. Licensed translations (NIV,
NKJV…) are fetched from publisher / aggregator APIs and cached into
the same `translations` table when the user picks them from the
translation dropdown.

The boundary between "shipped" and "loaded" is the [`Registry`] in
`registry.py`: a translation with `source != "local"` triggers the
matching loader on a cache miss. Add a new translation = one row in
the registry + one env var (the API key).

License compliance — every loader writes the publisher's required
attribution string into `Translation.license`, and the chapter
endpoint surfaces a per-translation `attribution` field so the
frontend can render the footer line publishers require.
"""
