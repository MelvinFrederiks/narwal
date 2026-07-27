# Methodology

What Narwal actually measures, and where the methods come from.

## Reference corpora

| Dataset | Size | Year | Origin | Note |
|---|---|---|---|---|
| RockYou | 32.6M | 2009 | US gaming | the canonical baseline |
| LinkedIn | 60.6M | 2012 | global pro | stricter policy → harder |
| 000webhost | 15.3M | 2015 | US forum | policy-enforced, 2-class minimum |
| Mail.ru | 3.7M | 2014 | RU mail | Cyrillic-keyboard patterns |
| Taobao | 7.5M | 2012 | CN ecomm | digit-dominant |
| Gmail dump | 4.9M | 2014 | RU mail | mixed |
| Ashley Madison | 376k | 2015 | CA social | small, mostly unique |
| Libero | 668k | 2016 | IT mail | small, Italian |
| HIBP top10M | 10M | rolling | aggregator | for guess-list attacks |

All cleaned through demeuk with the standard pipeline (UTF-8 normalize, strip non-printable, dedupe, length filter ≥6) before any analysis. Dataset selection follows MAYA §4.1.

## What we measure

**Cumulative mask coverage** *(headline chart, van Heijningen 2013 figures O.2 / P.2).* For each mask we compute the percentage of the target dataset it covers, sort masks by `(coverage / keyspace)` ratio, and plot the cumulative percentage. A second axis shows the cumulative time to exhaust each mask on the configured cluster. The kink in the time curve is where adding more masks stops being worth it — that's the planner's natural budget line.

**Attack overlap (Jaccard).** For each attack pair `(A, B)` we compute `|cracked(A) ∩ cracked(B)| / |cracked(A) ∪ cracked(B)|`. Above 0.6 = redundant, drop the slower one. Below 0.3 = complementary, keep both. In between = judgment call shown to the user with the marginal-gain number.

**Per-position character frequency** *(van Heijningen 2013 figure 5 / appendix T).* For each position 1–8 we count character occurrence rates. The heatmap diagnoses dataset character at a glance: vowel concentration in early positions = natural-language passwords; digit dominance across all positions = PIN-style (Taobao); Cyrillic-keyboard remnants = RU origin.

**Dataset similarity (UMAP).** Each reference dataset becomes a feature vector: mask histogram, length distribution, character-class distribution, top-N MinHash. We UMAP-project to 2D for the cluster map. Conceptually similar to MAYA RQ6 but operationalised for a target-to-reference lookup ("which corpus does my target most resemble?"), not just an academic dataset-similarity question.

**Guess-number curves (headline figure).** Run async via PCFG and OMEN (both via the `pcfg_cracker` repo). For each reference dataset we generate guesses in probability order and record the cumulative cracking rate vs. log guess count. Marker radius on the curve encodes √(dataset cardinality). Conceptually the chart MAYA's figures 2-3 produce, but here it's interactive and conditional on the user's current pipeline.

## What we simulate vs. what we run

Simulation never touches the target hashes. We:
1. Run each candidate attack in hashcat `--stdout` mode against a representative reference dataset.
2. Set-intersect generated candidates with the plaintexts in that reference corpus.
3. Use that hit rate as a *prior* for the same attack against the user's target.

This is fast, GPU-free, and matches reality reasonably well *when the target distribution is close to the reference.* It's why the dataset-similarity cluster matters — if the target is far from all references, the priors are weak and we say so.

## Cluster speed defaults

Per hashcat published benchmarks for the RTX 5080. Scaled linearly by GPU count (we know this isn't perfectly accurate but the marginal-returns kink in van Heijningen's fig. 6 means it doesn't matter much for planning).

```
NTLM (mode 1000) :  ~105 GH/s per card  × 8  = 840 GH/s
MD5  (mode 0)    :  ~95  GH/s per card  × 8  = 760 GH/s
bcrypt $2b$05    :  ~11  GH/s per card  × 8  = 88  GH/s
```

User can override per-hash-type in the cluster spec panel.

## Why these two papers

**Van Heijningen 2013** — operational. The cumulative-mask cracking-time chart is how cracking actually thinks about budget; the per-position heatmap is the cleanest dataset diagnostic in the literature. The thesis is also pre-LLM, which keeps the methodology grounded.

**MAYA / Corrias 2026** — academic. Provides the dataset selection, the cleaning conventions, the cross-cultural insight (Taobao ≠ RockYou ≠ Mail.ru), and the framing that "dataset similarity" is a meaningful and measurable thing. We don't reproduce MAYA's deep-learning models — that's a separate research project — but we borrow their evaluation hygiene.

## Out of scope

- Targeted attacks (PII-conditioned). MAYA explicitly excludes these; we do too, for now.
- Hash cracking itself. Narwal plans; Hashtopolis executes.
- New ML models. The DL-based guessers in MAYA are interesting but heavy. We use PCFG and OMEN for the headline guess-number curves because they're fast, well-understood, and the marginal lift from FLA/PassGPT isn't worth the operational cost at the planner stage.
