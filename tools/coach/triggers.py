"""
Reference evaluator of observation-rule triggers (data/coach_model.json rules[].trigger).
The web UI implements the same semantics (docs/COACHING.md "Trigger conditions").

feats: dict note label -> raw feature dict {name: value} (or vector in common.FEATURES order).
Notes without a valid measurement (valid = 0) or absent from the take make a condition false.
"""
import math
import numpy as np
import common as C

OPS = {">": lambda a, b: a > b, "<": lambda a, b: a < b, ">=": lambda a, b: a >= b,
       "<=": lambda a, b: a <= b, "!=": lambda a, b: abs(a - b) > 1e-6, "==": lambda a, b: abs(a - b) <= 1e-6}
ROOM_OK = {"any": {"dry", "some", "too_reverberant", "uncertain"}, "dry_or_some": {"dry", "some", "uncertain"}, "dry": {"dry"}}


def _get(feats, ref):
    name, lbl = ref.split("@")
    f = feats.get(lbl)
    if f is None:
        return None
    if not isinstance(f, dict):
        f = dict(zip(C.FEATURES, f))
    if f.get("valid", 1) < 0.5:
        return None
    return float(f[name])


def _notes(feats, notes):
    if notes == "mf":
        return [t[0] for t in C.TEST_SET if t[2] == 0.5 and t[0] in feats]
    return [n for n in notes if n in feats]


def condition(feats, c):
    t = c["type"]
    if t == "value":
        x = _get(feats, c["x"])
    elif t == "diff":
        a, b = _get(feats, c["a"]), _get(feats, c["b"])
        x = None if a is None or b is None else a - b
    elif t in ("any_note", "mean", "max_abs"):
        vals = [_get(feats, f"{c['feature']}@{n}") for n in _notes(feats, c["notes"])]
        vals = [v for v in vals if v is not None]
        if not vals:
            return False
        if t == "any_note":
            return any(OPS[c["op"]](v, c["value"]) for v in vals)
        x = float(np.mean(vals)) if t == "mean" else max(abs(v) for v in vals)
    else:
        raise ValueError(t)
    return x is not None and OPS[c["op"]](x, c["value"])


def fired(rule, feats, room="uncertain"):
    trig = rule.get("trigger")
    if not trig:
        return False
    if room not in ROOM_OK.get(rule.get("room", "any"), ROOM_OK["any"]):
        return False
    if "all" in trig:
        return all(condition(feats, c) for c in trig["all"])
    return any(condition(feats, c) for c in trig.get("any", []))
