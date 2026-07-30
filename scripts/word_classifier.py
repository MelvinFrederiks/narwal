#!/usr/bin/env python3
"""
word_classifier3.py — classify wordlist entries by part of speech.

For best results it make sense to first run scripts/wordsplit.py since this script only anlyses
the raw splitted words

Input is expected to be already normalised (see scripts/wordsplit3.py), so
every entry is looked up exactly as given — no fallback forms are tried.

Output categories
-----------------
    Noun  Verb  Adjective  Adverb  Pronoun  Article  Determiner  Preposition
    Conjunction  Modal  Auxiliary  Interjection  Name  Unknown

All of them appear in the output even at zero, so histograms from different
wordlists share an axis and stay comparable.

stdout is only ever the JSON histogram, ready for the Analysis results
scene. Everything else goes to stderr.

USAGE
-----
    python3 word_classifier3.py WORDLIST [-o OUT.json] [--verbose]
                                [--names fallback|always] [--name-rank N]
                                [--diagnose] [--dump DIR]

    --names fallback   (default) only consult the name database when the
                       word has no part of speech. Names overlap heavily
                       with ordinary words ("Rose", "Will", "May"), so
                       tagging every word that is also somebody's name
                       would swamp the histogram.
    --names always     tag names even when the word already has a POS.

    --name-rank N      only accept a name ranking in the top N for at least
                       one country (default 500; 0 disables the filter).
                       See "Name precision" below.

    --diagnose         split Unknown into per-reason buckets.
    --dump DIR         write DIR/<Category>.txt, one word per line, so each
                       bucket can be inspected.
    --verbose          print "word<TAB>categories" per line to stderr.

Name precision
--------------
names_dataset is broad enough that plain foreign words and technical terms
appear in it, so an unfiltered lookup tags "bonjour", "root" and "wifi" as
people. It also exposes a per-country rank, and measuring that on known
inputs shows a clean gap:

    common names      michael 1, garcia 1, smith 1, jessica 18, sofia 34
    uncommon names    kwame 8, priya 48, siobhan 51, bartosz 79,
                      ingeborg 155, oksana 179, olamide 184, tarquin 194
    ---- gap ----
    foreign words     hej 528, bonjour 611, gracias 748, ciao 763,
                      aloha 1000, hola 1695
    technical words   pass 2493, root 2773, danke 6017, admin 11864,
                      lol 12504, wifi 12845

Hence the default cutoff of 500: above every real name in the cluster, below
the lowest false positive. Rank is the *best* rank in any single country, not
an average, so region-specific names survive (yuki is 1st in Japan, kwame 8th
in Ghana) — averaging would discard exactly those.

The cost is genuinely rare names: eilidh (981) and thaddeus (2176) are real
and get rejected. The summary reports how many words the database knew but
the filter dropped, so the trade-off stays visible and you can re-tune against
your own data rather than these samples.
"""

import argparse
import json
import os
import sys
from collections import Counter
from functools import lru_cache

from nltk.corpus import wordnet as wn
from names_dataset import NameDataset

nd = NameDataset()

POS_MAP = {
    "n": "noun",
    "v": "verb",
    "a": "adjective",
    "s": "adjective",  # adjective satellite
    "r": "adverb",
}

# Internal fine-grained tag -> reporting category, and the emit order.
TAG_TO_CATEGORY = {
    "noun": "Noun",
    "verb": "Verb",
    "adjective": "Adjective",
    "adverb": "Adverb",
    "pronoun": "Pronoun",
    "article": "Article",
    "determiner": "Determiner",
    "preposition": "Preposition",
    "conjunction": "Conjunction",
    "modal": "Modal",
    "auxiliary": "Auxiliary",
    "interjection": "Interjection",
    "person_name": "Name",
}
CATEGORIES = (*TAG_TO_CATEGORY.values(), "Unknown")

# ── closed-class lexicon ───────────────────────────────────────────────────
# WordNet has none of these. They are finite sets, so enumerating them is
# exact rather than approximate. A word may carry several tags ("that" is a
# pronoun, a determiner and a conjunction) — multi-label output means that no
# longer has to be resolved to one answer.
CLOSED_CLASS: dict[str, set[str]] = {}


def _add(words: str, label: str) -> None:
    for w in words.split():
        CLOSED_CLASS.setdefault(w, set()).add(label)


# English has exactly three articles. That is the whole category.
_add("a an the", "article")

_add("i me you he him she her it we us they them one", "pronoun")
_add("my your his her its our their mine yours hers ours theirs", "pronoun")
_add("myself yourself himself herself itself oneself ourselves yourselves themselves", "pronoun")
_add("this that these those", "pronoun")
_add("who whom whose which what whatever whoever whichever", "pronoun")
_add("anyone anybody anything everyone everybody everything someone somebody something "
     "nobody nothing none neither either another other others", "pronoun")
_add("thou thee thy thine ye", "pronoun")  # archaic, common in wordlists

# Determiners minus the three articles, which are broken out above.
_add("this that these those each every either neither some any no all both half "
     "many much more most few little less least several such what which whose enough",
     "determiner")

_add("about above across after against along amid among around as at before behind below "
     "beneath beside besides between beyond by despite down during except for from in "
     "inside into like near of off on onto out outside over past per since through "
     "throughout till to toward towards under underneath until up upon via with within "
     "without", "preposition")

_add("and but or nor for yet so although because since unless until while whereas though "
     "if than whether once where when after before as that", "conjunction")

_add("can could may might must shall should will would ought need dare", "modal")
_add("am is are was were be been being have has had do does did", "auxiliary")

_add("oh ah aha hey hi hello bye wow ouch oops yes no okay ok yeah yep nope hmm huh alas "
     "bravo hooray ugh eh yay damn hush", "interjection")


# ── lookup ─────────────────────────────────────────────────────────────────
@lru_cache(maxsize=None)
def pos_tags(word: str) -> frozenset:
    """Open-class tags from WordNet plus closed-class tags from the lexicon."""
    # The lexicon is keyed lowercase; NLTK lowercases internally and runs
    # morphy, so inflections such as "running" or "dogs" resolve here too.
    tags = set(CLOSED_CLASS.get(word.lower(), ()))
    tags |= {POS_MAP[s.pos()] for s in wn.synsets(word)}
    return frozenset(tags)


def _best_rank(entry) -> int | None:
    """Lowest (most common) rank this name reaches in any single country."""
    if not entry:
        return None
    ranks = [r for r in (entry.get("rank") or {}).values() if isinstance(r, int) and r > 0]
    return min(ranks) if ranks else None


@lru_cache(maxsize=None)
def name_rank(word: str) -> int | None:
    """
    Best rank across countries as either a first or last name, or None if the
    database does not know it at all. Lower is more common.
    """
    hit = nd.search(word)
    ranks = [r for r in (_best_rank(hit["first_name"]), _best_rank(hit["last_name"])) if r]
    return min(ranks) if ranks else None


# Sits in the measured gap between real names and false positives — see the
# module docstring for the calibration data behind it.
DEFAULT_NAME_RANK = 500


def is_person_name(word: str, max_rank: int | None) -> bool:
    rank = name_rank(word)
    if rank is None:
        return False
    return not max_rank or rank <= max_rank  # 0 / None disables the filter


def categorise(word: str, names_mode: str, max_rank: int | None) -> set:
    """
    Return the reporting categories for `word`; empty when nothing matched.

    Several fine-grained tags can share a category, so the result is a set and
    each category counts at most once per word.
    """
    tags = set(pos_tags(word))
    if (names_mode == "always" or not tags) and is_person_name(word, max_rank):
        tags.add("person_name")
    return {TAG_TO_CATEGORY[t] for t in tags}


# ── why a word failed ──────────────────────────────────────────────────────
def unknown_reason(word: str) -> str:
    if not any(c.isalpha() for c in word):
        return "unknown_no_letters"
    if not word.isascii():
        return "unknown_non_ascii"
    if len(word) < 3:
        return "unknown_too_short"
    if any(c.isdigit() for c in word):
        return "unknown_has_digits"
    if len(word) > 12:
        # Very likely two or more words run together — scripts/wordsplit3.py
        # segments these, and re-running this classifier on its output
        # recovers most of them.
        return "unknown_long_maybe_compound"
    return "unknown_alpha"


class Dumper:
    """Lazily-opened one-file-per-category writer, so nothing is held in RAM."""

    def __init__(self, directory):
        self.dir = directory
        self.handles = {}
        if directory:
            os.makedirs(directory, exist_ok=True)

    def write(self, category, word):
        if not self.dir:
            return
        fh = self.handles.get(category)
        if fh is None:
            fh = self.handles[category] = open(
                os.path.join(self.dir, f"{category}.txt"), "w", encoding="utf-8"
            )
        fh.write(word + "\n")

    def close(self):
        for fh in self.handles.values():
            fh.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="Classify words by part of speech (multi-label).")
    ap.add_argument("wordlist", help="Path to the wordlist")
    ap.add_argument("-o", "--output", help="Write JSON here instead of stdout")
    ap.add_argument("--names", choices=("fallback", "always"), default="fallback",
                    help="when to consult the person-name database (default: fallback)")
    ap.add_argument("--name-rank", type=int, default=DEFAULT_NAME_RANK, metavar="N",
                    help=f"only accept names ranking in the top N of some country "
                         f"(default {DEFAULT_NAME_RANK}; 0 disables)")
    ap.add_argument("--diagnose", action="store_true",
                    help="split Unknown into per-reason buckets")
    ap.add_argument("--dump", metavar="DIR",
                    help="write DIR/<Category>.txt, one word per line")
    ap.add_argument("--verbose", action="store_true",
                    help="print each word and its categories to stderr")
    args = ap.parse_args()

    # Seed every category at zero so runs over different wordlists share an
    # axis in the Analysis results scene.
    counts: Counter = Counter({c: 0 for c in CATEGORIES})
    reasons: Counter = Counter()
    dumper = Dumper(args.dump)
    words = 0
    tagged = 0
    no_pos = 0        # words WordNet and the lexicon both had nothing for
    rescued = 0       # ...of which the name database recognised
    too_rare = 0      # ...and which it knew, but ranked below the cutoff

    try:
        with open(args.wordlist, encoding="utf-8", errors="replace") as f:
            for line in f:
                word = line.strip()
                if not word:
                    continue
                words += 1

                had_pos = bool(pos_tags(word))
                cats = categorise(word, args.names, args.name_rank)

                if not had_pos:
                    no_pos += 1
                    if "Name" in cats:
                        rescued += 1
                    elif name_rank(word) is not None:
                        # Known to the database, but too rare to trust.
                        too_rare += 1

                if cats:
                    tagged += 1
                    for cat in cats:
                        counts[cat] += 1  # multi-label: every category counts
                        dumper.write(cat, word)
                else:
                    reason = unknown_reason(word)
                    reasons[reason] += 1
                    counts[reason if args.diagnose else "Unknown"] += 1
                    dumper.write("Unknown", word)

                if args.verbose:
                    print(f"{word}\t{'+'.join(sorted(cats)) or 'unknown'}", file=sys.stderr)
    finally:
        dumper.close()

    # Declared order first, then anything --diagnose added.
    ordered = {c: counts[c] for c in CATEGORIES}
    ordered.update({k: v for k, v in sorted(counts.items()) if k not in ordered})

    result = {
        "name": args.wordlist,
        "type": "histogram",
        "values": ordered,
    }
    text = json.dumps(result, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as out:
            out.write(text + "\n")
    else:
        print(text)

    # Summary — stderr, so stdout stays valid JSON even when redirected.
    pct = (tagged / words * 100) if words else 0.0
    print(f"\n{words:,} words · {tagged:,} matched ({pct:.1f}%) · "
          f"{sum(ordered.values()):,} category tags assigned", file=sys.stderr)

    if no_pos:
        share = rescued / no_pos * 100
        limit = f"top {args.name_rank:,}" if args.name_rank else "any rank"
        print(f"\n{no_pos:,} words had no part of speech; {rescued:,} of them ({share:.1f}%) "
              f"were accepted as names ({limit}).", file=sys.stderr)
        if too_rare:
            print(f"  {too_rare:,} more were in the name database but ranked below the "
                  f"cutoff — raise --name-rank to include them.", file=sys.stderr)

    if reasons:
        print(f"\n{sum(reasons.values()):,} still unmatched, by reason:", file=sys.stderr)
        for reason, n in reasons.most_common():
            print(f"  {n:>9,}  {reason[len('unknown_'):]}", file=sys.stderr)

    if args.dump:
        print(f"\nper-category words written to {args.dump}/", file=sys.stderr)


if __name__ == "__main__":
    main()
