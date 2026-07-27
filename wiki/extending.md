# Extending

Three things you might want to add: a new reference dataset, a new attack, a new hash type. All three are file-drop operations — no code surgery.

## Adding a reference dataset

1. Drop the raw file into `data/raw/<name>.txt` (one password per line, any encoding).
2. Add an entry to `backend/config/datasets.toml`:
   ```toml
   [my_corp_leak]
   path = "raw/my_corp_leak.txt"
   size = 100000
   year = 2024
   origin = "US"
   language = "en"
   service = "corp-vpn"
   policy = "none"
   min_length = 0
   notes = "Internal red-team corpus, leaked by us."
   ```
3. Restart the container. demeuk runs on first boot; the cleaned file lands in `data/clean/`.

The UMAP cluster map rebuilds automatically next time anyone hits `/profile`.

## Adding an attack

Attacks are just rows in `backend/config/attacks.toml`:

```toml
[[attack]]
id = "rockyou_pantagrule"
type = "wordlist+rules"
wordlist = "rockyou"
rules = "pantagrule.v1.popular"
label = "rockyou + pantagrule popular"

[[attack]]
id = "mask_lower_3d"
type = "mask"
mask = "?l?l?l?l?l?l?d?d?d"
label = "?l×6 ?d×3"
```

Restart, and they appear in the composer rail.

## Adding a hash type

Hashtopolis already supports it — Narwal just needs the throughput number. Add to `backend/config/hashrates.toml`:

```toml
[scrypt_N16384]
hashcat_mode = 8900
per_card_ghs = 0.002   # yes, that small
notes = "scrypt with cost params from Litecoin."
```

The cluster-spec panel will offer it in the dropdown and use it for runtime estimates.

## Adding a new visualization

Each viz is a single JS module under `web/scenes/`. The module exports a `render(data, mountEl)` function and a `name`. Drop it in, add an entry to `web/scenes/registry.js`, done. The data passed in is whatever `/profile` returns — extend the backend to add new fields if you need them.

## Hash-type defaults

If you don't know your cluster's actual throughput for a given hash, hashcat's published benchmarks are usually within 10–20%. We default to those scaled by GPU count, which is good enough for planning. The cluster-spec panel always lets you override.
