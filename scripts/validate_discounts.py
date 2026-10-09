#!/usr/bin/env python3
"""Validate data/discounts.json. Standard library only.

Errors (exit 1): structure that doesn't match data/discounts.schema.json,
duplicate ids, unknown brands, bad dates, non-https sources.
Warnings (exit 0): entries not verified for STALE_DAYS, expired entries still active.

Usage: python3 scripts/validate_discounts.py [path/to/discounts.json]
"""
import datetime
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STALE_DAYS = 90

REQUIRED = {"id", "brands", "name", "kind", "value", "conditions", "source", "lastVerified", "defaultOn", "active"}
OPTIONAL = {"group", "weekendValue", "days", "minSpendEur", "maxLitresPerFill", "validFrom", "validUntil"}
KINDS = {"instant", "balance", "mixed"}
VALUE_FIELDS = {
    "cpl": ({"cents"}, {"balanceCents"}),
    "percent": ({"pct"}, set()),
    "perMonthEur": ({"eur"}, set()),
    "perFillEur": ({"eur"}, set()),
}


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def parse_date(s):
    try:
        return datetime.date.fromisoformat(s) if isinstance(s, str) and len(s) == 10 else None
    except ValueError:
        return None


def check_value(v, where, err):
    if not isinstance(v, dict) or v.get("type") not in VALUE_FIELDS:
        err(f"{where}: must be an object with type one of {sorted(VALUE_FIELDS)}")
        return
    req, opt = VALUE_FIELDS[v["type"]]
    keys = set(v) - {"type"}
    for k in req - keys:
        err(f"{where}: missing '{k}'")
    for k in keys - req - opt:
        err(f"{where}: unexpected field '{k}'")
    for k in keys & (req | opt):
        if not is_num(v[k]) or v[k] < 0:
            err(f"{where}.{k}: must be a non-negative number")
    if v["type"] == "percent" and is_num(v.get("pct")) and v["pct"] > 100:
        err(f"{where}.pct: must be <= 100")


def known_brands(aliases):
    snap = ROOT / "data" / "snapshot.json"
    brands = set()
    for fuel in json.loads(snap.read_text(encoding="utf-8"))["fuels"].values():
        brands.update(aliases.get(b, b) for b in fuel["prices"])
    return brands


def validate(data, today):
    errors, warnings = [], []
    err, warn = errors.append, warnings.append

    if not isinstance(data, dict):
        return ["top level must be an object"], []
    for k in set(data) - {"$schema", "lastReviewed", "brandAliases", "discounts"}:
        err(f"unexpected top-level field '{k}'")
    if not parse_date(data.get("lastReviewed")):
        err("lastReviewed: must be a YYYY-MM-DD date")
    aliases = data.get("brandAliases", {})
    if not isinstance(aliases, dict) or not all(isinstance(v, str) for v in aliases.values()):
        err("brandAliases: must map strings to strings")
        aliases = {}
    discounts = data.get("discounts")
    if not isinstance(discounts, list):
        return errors + ["discounts: must be a list"], warnings

    brands = known_brands(aliases)
    seen = set()
    for i, d in enumerate(discounts):
        where = f"discounts[{i}]"
        if not isinstance(d, dict):
            err(f"{where}: must be an object")
            continue
        where = f"{where} ({d.get('id', '?')})"
        for k in REQUIRED - set(d):
            err(f"{where}: missing '{k}'")
        for k in set(d) - REQUIRED - OPTIONAL:
            err(f"{where}: unexpected field '{k}'")

        did = d.get("id")
        if not isinstance(did, str) or not did or did != did.lower() or " " in did:
            err(f"{where}: id must be lowercase-kebab-case")
        elif did in seen:
            err(f"{where}: duplicate id")
        seen.add(did)

        b = d.get("brands")
        if not isinstance(b, list) or not b:
            err(f"{where}: brands must be a non-empty list")
        else:
            for name in b:
                if name not in brands:
                    err(f"{where}: unknown brand '{name}' (use the DGEG name, uppercased; "
                        "add to brandAliases or refresh data/snapshot.json if it's new)")

        for k in ("name", "conditions"):
            if k in d and (not isinstance(d[k], str) or not d[k].strip()):
                err(f"{where}: {k} must be a non-empty string")
        if "group" in d and (not isinstance(d["group"], str) or not d["group"]):
            err(f"{where}: group must be a non-empty string")
        if d.get("kind") not in KINDS:
            err(f"{where}: kind must be one of {sorted(KINDS)}")
        if "value" in d:
            check_value(d["value"], f"{where}.value", err)
            has_bal = isinstance(d["value"], dict) and "balanceCents" in d["value"]
            if d.get("kind") == "mixed" and not has_bal:
                err(f"{where}: kind 'mixed' needs value.type 'cpl' with balanceCents")
            if d.get("kind") != "mixed" and has_bal:
                err(f"{where}: balanceCents is only allowed with kind 'mixed'")
        if "weekendValue" in d:
            check_value(d["weekendValue"], f"{where}.weekendValue", err)
        if "days" in d and d["days"] not in ("weekday", "weekend"):
            err(f"{where}: days must be 'weekday' or 'weekend'")
        for k in ("minSpendEur", "maxLitresPerFill"):
            if k in d and (not is_num(d[k]) or d[k] < 0):
                err(f"{where}: {k} must be a non-negative number")
        for k in ("defaultOn", "active"):
            if k in d and not isinstance(d[k], bool):
                err(f"{where}: {k} must be true/false")
        src = d.get("source")
        if not isinstance(src, str) or not src.startswith("https://"):
            err(f"{where}: source must be an https:// URL")

        dates = {}
        for k in ("lastVerified", "validFrom", "validUntil"):
            if k in d:
                dates[k] = parse_date(d[k])
                if not dates[k]:
                    err(f"{where}: {k} must be a valid YYYY-MM-DD date")
        if dates.get("validFrom") and dates.get("validUntil") and dates["validFrom"] > dates["validUntil"]:
            err(f"{where}: validFrom is after validUntil")
        lv = dates.get("lastVerified")
        if lv and lv > today:
            err(f"{where}: lastVerified is in the future")
        if lv and (today - lv).days > STALE_DAYS and d.get("active"):
            warn(f"{where}: not verified for {(today - lv).days} days")
        if dates.get("validUntil") and dates["validUntil"] < today and d.get("active"):
            warn(f"{where}: expired on {dates['validUntil']} (hidden in the app; set active=false when confirmed)")
    return errors, warnings


def main():
    path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "discounts.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: cannot read {path}: {e}")
        return 1
    errors, warnings = validate(data, datetime.date.today())
    for w in warnings:
        print(f"WARNING: {w}")
    for e in errors:
        print(f"ERROR: {e}")
    n = len(data.get("discounts", [])) if isinstance(data, dict) else 0
    print(f"{path.name}: {n} discounts, {len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
