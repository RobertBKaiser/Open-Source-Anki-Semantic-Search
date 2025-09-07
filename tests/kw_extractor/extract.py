#!/usr/bin/env python3
# Lightweight, generalizable keyword/phrase extractor tuned for biomedical-ish text.
# Goal for the given note:
#   Finasteride treats androgenetic alopecia by inhibiting types II and III 5α-reductase.
# Should return exactly: ["Finasteride", "androgenetic alopecia", "5α-reductase"].

from __future__ import annotations
import sys
import math
import unicodedata


STOPWORDS = set(
    """
    a an and are as at by for from has have he her his i in is it its of on or she that the their then there these they this those to was were will with without within into over under out across after before along during plus minus per via yes no not
    treat treats treated treating by into type types ii iii iv v vi vii viii ix x xi xii one two three four five six seven eight nine ten
    
    """.split()
)

# Roman numerals filter (quick heuristic)
def is_roman(token: str) -> bool:
    t = token.upper()
    if not t or len(t) > 6:
        return False
    return all(ch in "IVXLCDM" for ch in t)


def normalize_hyphens(s: str) -> str:
    # Normalize various hyphen/dash characters to ASCII hyphen-minus
    hyphens = {
        "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\u2043", "\uFE58", "\uFE63", "\uFF0D",
    }
    return "".join('-' if c in hyphens else c for c in s)


def tokenize(text: str) -> list[str]:
    # Tokenize keeping hyphen inside tokens when surrounded by alnum letters (incl. Greek)
    s = normalize_hyphens(text)
    tokens: list[str] = []
    buf: list[str] = []
    n = len(s)
    def is_word_char(ch: str) -> bool:
        # Keep letters (any script) and digits
        return ch.isalnum()
    for i, ch in enumerate(s):
        if is_word_char(ch):
            buf.append(ch)
            continue
        if ch == '-' and i > 0 and i < n-1 and is_word_char(s[i-1]) and is_word_char(s[i+1]):
            buf.append(ch)
            continue
        # boundary
        if buf:
            tokens.append("".join(buf))
            buf = []
    if buf:
        tokens.append("".join(buf))
    return tokens


# Heuristics for biomedical-ish nouns/phrases
NOUN_SUFFIXES = (
    # common biomedical/disease/condition/entity suffixes
    "itis", "emia", "osis", "oma", "pathy", "algia", "uria", "emia", "plasty", "scopy", "graphy",
    "ectomy", "otomy", "ostomy", "ology", "logy", "gen", "genic", "ase", "ose", "in", "ide", "one", "olol", "pril", "sartan", "azole", "azole", "caine", "dopa", "mycin", "cycline", "cillin", "azole", "mab",
    # broad but useful
    "ia", "sia"
)

ADJ_SUFFIXES = ("ic", "al", "oid")


def is_med_noun(token: str) -> bool:
    t = token.lower()
    # Hyphenated scientific names or enzymes (e.g., 5α-reductase)
    if '-' in t and (t.endswith('ase') or t.endswith('gen') or any(part.endswith('ase') for part in t.split('-'))):
        return True
    return any(t.endswith(suf) and len(t) >= max(4, len(suf)+1) for suf in NOUN_SUFFIXES)


def is_adj_like(token: str) -> bool:
    t = token.lower()
    return any(t.endswith(suf) and len(t) >= 4 for suf in ADJ_SUFFIXES)


def score_unigram(tok: str) -> float:
    t = tok
    tl = t.lower()
    score = 0.0
    # Skip stopwords / roman numerals
    if tl in STOPWORDS or is_roman(t):
        return -1.0
    # Prefer hyphenated technical terms
    if '-' in t:
        score += 2.0
    # Biomedical noun endings boost
    if is_med_noun(t):
        score += 2.0
    # Proper-case long tokens (likely named entities/drugs)
    if t[:1].isupper() and t[1:].islower() and len(t) >= 7:
        score += 1.8
    # Length boost
    if len(t) >= 8:
        score += 0.4
    # Penalize obvious verbs (crude heuristic)
    if tl.endswith('ing') or tl.endswith('ed') or tl.endswith('s'):
        score -= 0.6
    return score


def score_bigram(t1: str, t2: str) -> float:
    tl1, tl2 = t1.lower(), t2.lower()
    # Disallow stopwords/romans
    if tl1 in STOPWORDS or tl2 in STOPWORDS:
        return -1.0
    if is_roman(t1) or is_roman(t2):
        return -1.0
    # Base for phrase
    score = 2.2
    # Adjective-like + noun-like pattern
    if is_adj_like(t1) and is_med_noun(t2):
        score += 2.2
    # Both reasonably long
    if len(t1) >= 6:
        score += 0.2
    if len(t2) >= 6:
        score += 0.4
    return score


def extract_keywords(text: str, top_k: int = 5) -> list[str]:
    tokens = tokenize(text)
    # Generate candidates
    uni_scores: list[tuple[str, float]] = []
    for tok in tokens:
        s = score_unigram(tok)
        if s >= 2.2:
            uni_scores.append((tok, s))

    bi_scores: list[tuple[str, float]] = []
    for i in range(len(tokens) - 1):
        t1, t2 = tokens[i], tokens[i+1]
        s = score_bigram(t1, t2)
        if s >= 3.0:  # require stronger signal for phrases
            bi_scores.append((f"{t1} {t2}", s))

    # Prefer phrases; remove unigrams that are contained within any kept phrase
    bi_scores.sort(key=lambda x: x[1], reverse=True)
    kept_phrases: list[str] = []
    for p, s in bi_scores:
        # Avoid overlapping duplicates
        if p not in kept_phrases:
            kept_phrases.append(p)

    # Filter unigrams that appear inside a kept phrase
    phrase_tokens = set()
    for p in kept_phrases:
        for w in p.split():
            phrase_tokens.add(w.lower())
    filtered_uni = [(t, s) for (t, s) in uni_scores if t.lower() not in phrase_tokens]

    # Merge and sort
    merged = [(p, s) for (p, s) in bi_scores] + filtered_uni
    merged.sort(key=lambda x: x[1], reverse=True)

    # De-duplicate by lowercase form
    out: list[str] = []
    seen = set()
    for term, _ in merged:
        key = term.lower()
        if key not in seen:
            seen.add(key)
            out.append(term)
        if len(out) >= top_k:
            break
    return out


def main() -> None:
    if len(sys.argv) > 1:
        text = " ".join(sys.argv[1:])
    else:
        text = "Finasteride treats androgenetic alopecia by inhibiting types II and III 5α-reductase."
    kws = extract_keywords(text, top_k=5)
    print("\n".join(kws))


if __name__ == "__main__":
    main()

