#!/usr/bin/env python3
"""
wordbreak.py — segment concatenated strings (e.g. lines in a wordlist,
domain names, usernames) into their most likely constituent words.

This uses the same class of approach described in Wang, Thrasher & Hsu,
"Web Scale NLP: A Case Study on URL Word Breaking" (WWW 2011): dynamic
programming over all possible splits of a string, scored by how probable
each candidate word is, picking the split with the highest overall
probability (equivalently, lowest total -log-probability "cost").
This particular implementation follows the classic approach popularized
by Peter Norvig (which the paper also discusses and builds on).

USAGE
-----
    python3 wordbreak.py INPUT_FILE [-d DICTIONARY_FILE] [-o OUTPUT_FILE]
                          [--min-len N] [--sep " "]

    INPUT_FILE
        A text file, one string per line (e.g. a wordlist / password list).
        Lines are lowercased and non-alphanumeric characters are treated
        as already-present separators (kept as-is, not re-split).

    -d / --dictionary DICTIONARY_FILE   (required)
        A word-frequency reference file to score candidate splits against.
        Accepted formats (auto-detected):
          * "word<TAB or space>count"  per line   (best — real frequencies)
          * "word" per line, ordered most→least common (rank used as proxy)

    -o / --output OUTPUT_FILE           (optional, default: stdout)
        Where to write "original_string<TAB>segmented version" per line.

    --min-len N                         (default: 1)
        Skip segmentation for strings shorter than N characters (they're
        passed through unchanged).

    --sep " "                           (default: single space)
        Separator to insert between recovered words in the output.

EXAMPLE
-------
    $ printf "expertsexchange\\nletmein123\\nqwertypassword\\n" > sample.txt
    $ python3 wordbreak.py sample.txt
    expertsexchange        experts exchange
    letmein123      let me in 123
    qwertypassword  qwerty password
"""

import argparse
import math
import re
import sys
from functools import lru_cache


def load_dictionary(path):
    """
    Load a dictionary/frequency file. Returns dict: word -> frequency (float).
    Handles either "word count" per line or "word" per line (rank-based).
    """
    freqs = {}
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        lines = [ln.strip() for ln in f if ln.strip()]

    # Detect "word<sep>count" format by checking a sample of lines.
    has_counts = False
    for ln in lines[:50]:
        parts = re.split(r"[\t ]+", ln)
        if len(parts) >= 2 and re.fullmatch(r"\d+(\.\d+)?", parts[-1]):
            has_counts = True
            break

    if has_counts:
        for ln in lines:
            parts = re.split(r"[\t ]+", ln)
            if len(parts) < 2:
                continue
            word = parts[0].lower()
            try:
                count = float(parts[-1])
            except ValueError:
                continue
            freqs[word] = freqs.get(word, 0.0) + count
    else:
        # Rank-based: line order = frequency order.
        for i, word in enumerate(lines):
            word = word.strip().lower()
            if word:
                freqs[word] = 1.0 / (i + 1)

    return freqs


class Segmenter:
    """
    DP word segmenter. For a string of length n, cost(i) = min over all
    valid last words w ending at i of cost(i - len(w)) + word_cost(w).
    word_cost(w) = -log(P(w)); unknown words get a length-penalized
    estimate so segmentation still degrades gracefully instead of
    just refusing to split.
    """

    def __init__(self, freqs, max_word_len=24):
        self.freqs = freqs
        self.total = sum(freqs.values()) or 1.0
        self.max_word_len = max_word_len

    def word_cost(self, word):
        if word in self.freqs:
            return -math.log(self.freqs[word] / self.total)
        # Unknown-word penalty: longer unknown chunks cost more,
        # so the DP still prefers real dictionary words when available.
        return -math.log(1e-12) + len(word) * math.log(26)

    def segment(self, text):
        """Return the best-scoring list of word pieces for `text`."""
        n = len(text)
        if n == 0:
            return []

        # best_cost[i] = lowest total cost to segment text[:i]
        best_cost = [0.0] + [math.inf] * n
        back = [None] * (n + 1)

        for i in range(1, n + 1):
            start = max(0, i - self.max_word_len)
            for j in range(start, i):
                piece = text[j:i]
                cost = best_cost[j] + self.word_cost(piece)
                if cost < best_cost[i]:
                    best_cost[i] = cost
                    back[i] = j

        # Reconstruct.
        words = []
        i = n
        while i > 0:
            j = back[i]
            words.append(text[j:i])
            i = j
        words.reverse()
        return words


def segment_line_pieces(line, segmenter, min_len):
    """
    Segment a raw wordlist line and return the list of individual pieces
    (recovered words plus any leftover non-alphabetic chunks, e.g. digits
    or symbols like '#1'). Order is preserved but each piece is separate,
    which is what --flat mode needs.
    """
    line = line.rstrip("\n")
    if len(line) < min_len:
        return [line] if line else []

    pieces = []
    for chunk in re.split(r"([^a-zA-Z]+)", line):
        if chunk == "":
            continue
        if re.fullmatch(r"[a-zA-Z]+", chunk) and len(chunk) >= min_len:
            pieces.extend(segmenter.segment(chunk.lower()))
        else:
            pieces.append(chunk)
    return pieces


def segment_line(line, segmenter, min_len, sep):
    """Segment a line and return it as a single 'word sep word sep ...' string."""
    return sep.join(segment_line_pieces(line, segmenter, min_len))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="wordlist file, one entry per line")
    ap.add_argument("-d", "--dictionary", required=True,
                     help="word-frequency reference file (required)")
    ap.add_argument("-o", "--output", help="output file (default: stdout)")
    ap.add_argument("--min-len", type=int, default=1,
                     help="minimum run length to attempt segmentation on")
    ap.add_argument("--sep", default=" ", help="separator between recovered words")
    ap.add_argument("-f", "--flat", action="store_true",
                     help="write every recovered word as its own line, instead of "
                          "'original<TAB>segmented' pairs")
    ap.add_argument("--min-word-len", type=int, default=2,
                     help="with --flat, drop output words shorter than this many "
                          "characters (default: 2)")
    args = ap.parse_args()

    freqs = load_dictionary(args.dictionary)
    if not freqs:
        print(f"Error: dictionary file '{args.dictionary}' produced no usable "
              "entries.", file=sys.stderr)
        sys.exit(1)

    segmenter = Segmenter(freqs)

    out_f = open(args.output, "w", encoding="utf-8") if args.output else sys.stdout
    try:
        with open(args.input, "r", encoding="utf-8", errors="ignore") as f:
            for raw_line in f:
                original = raw_line.rstrip("\n")
                if not original:
                    continue

                if args.flat:
                    pieces = segment_line_pieces(original, segmenter, args.min_len)
                    for word in pieces:
                        if not word.isalpha():
                            continue
                        if len(word) < args.min_word_len:
                            continue
                        out_f.write(word + "\n")
                else:
                    segmented = segment_line(original, segmenter, args.min_len, args.sep)
                    out_f.write(f"{original}\t{segmented}\n")
    finally:
        if args.output:
            out_f.close()


if __name__ == "__main__":
    main()
