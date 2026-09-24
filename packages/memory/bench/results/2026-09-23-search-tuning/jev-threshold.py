#!/usr/bin/env python3
"""Jev injection-threshold tables, from jev-threshold-scores.json (tuning sets only).

Production scores a memory as Jev's probability x 100 and applyRerank keeps
scores >= threshold (packages/core/src/memory-rerank/types.ts), so for
threshold t the packed top 5 are the reranked top 5 with p * 100 >= t.

  LongMemEval S q1-60: evidence turns kept in the gated top 5, and memories
    packed per answerable / abstention question.
  memory-suite: relevant top-5 hits kept, positive queries losing one, and
    negative queries (nothing relevant exists) that still inject a memory.

Usage: python3 jev-threshold.py [path/to/jev-threshold-scores.json]
"""
import json
import os
import sys

THRESHOLDS = [0, 5, 10, 20, 30, 40, 50, 60]
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "jev-threshold-scores.json")
data = json.load(open(path))


def kept(p, t):
    return p * 100 >= t


lme = data["longmemeval"]["questions"]
answerable = [q for q in lme if not q["abstention"] and q["evidenceIds"]]
abstain = [q for q in lme if q["abstention"]]
ev_total = sum(len(q["evidenceIds"]) for q in answerable)


def gated_top5(q, t):
    return [r for r in q["top"][:5] if kept(r["score"], t)]


print(f"LongMemEval tuning: {len(answerable)} answerable ({ev_total} evidence turns), {len(abstain)} abstention")
print("| threshold | evidence@5 kept | memories packed per answerable q | per abstention q |")
print("|---:|---:|---:|---:|")
for t in THRESHOLDS:
    ev = sum(sum(1 for r in gated_top5(q, t) if r["id"] in q["evidenceIds"]) for q in answerable)
    packed = sum(len(gated_top5(q, t)) for q in answerable) / len(answerable)
    packed_abs = sum(len(gated_top5(q, t)) for q in abstain) / max(1, len(abstain))
    print(f"| {t} | {ev}/{ev_total} ({100 * ev / ev_total:.1f}%) | {packed:.2f} | {packed_abs:.2f} |")

queries = data["memorySuite"]["queries"]
pos = [v for v in queries.values() if v["slice"] != "negative"]
neg = [v for v in queries.values() if v["slice"] == "negative"]
pos_hits = sum(sum(1 for r in v["ranks"] if r <= 5) for v in pos)
print(f"\nmemory-suite: {len(pos)} positive queries ({pos_hits} relevant hits in the top 5 ungated), {len(neg)} negative queries")
print("| threshold | relevant top-5 hits kept | positive queries losing a top-5 hit | negative queries still injecting a memory |")
print("|---:|---:|---:|---:|")
for t in THRESHOLDS:
    hits = 0
    losing = 0
    for v in pos:
        top5 = [r for r in v["ranks"] if r <= 5]
        hits += sum(1 for r in top5 if kept(v["scores5"][r - 1], t))
        losing += any(not kept(v["scores5"][r - 1], t) for r in top5)
    injecting = sum(1 for v in neg if v["scores5"] and kept(v["scores5"][0], t))
    print(f"| {t} | {hits}/{pos_hits} ({100 * hits / max(1, pos_hits):.1f}%) | {losing} | {injecting}/{len(neg)} |")
