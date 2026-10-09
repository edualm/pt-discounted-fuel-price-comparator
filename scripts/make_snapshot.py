#!/usr/bin/env python3
"""Fetch current station prices from DGEG and write data/snapshot.json.

The snapshot is the app's offline fallback and the list of known brands used by
validate_discounts.py. Prices are stored per brand so the app computes stats the
same way it does with live data.

Usage: python3 scripts/make_snapshot.py
"""
import datetime
import json
import pathlib
import urllib.request

API = "https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb"
FUELS = {
    3201: "Gasolina simples 95",
    3205: "Gasolina especial 95",
    3400: "Gasolina 98",
    2101: "Gasóleo simples",
    2105: "Gasóleo especial",
    1120: "GPL Auto",
}
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "snapshot.json"


def fetch(fuel_id):
    url = f"{API}/PesquisarPostos?idsTiposComb={fuel_id}&qtdPorPagina=10000&pagina=1"
    with urllib.request.urlopen(url, timeout=120) as r:
        body = json.load(r)
    if not body.get("status"):
        raise RuntimeError(f"DGEG error for fuel {fuel_id}: {body.get('mensagem')}")
    return body["resultado"]


def parse_price(s):
    return float(s.replace("€", "").strip().replace(",", "."))


def main():
    fuels = {}
    for fuel_id, name in FUELS.items():
        prices, latest = {}, ""
        for st in fetch(fuel_id):
            brand = (st.get("Marca") or "").strip().upper()
            if not brand or not st.get("Preco"):
                continue
            prices.setdefault(brand, []).append(round(parse_price(st["Preco"]), 3))
            latest = max(latest, st.get("DataAtualizacao") or "")
        fuels[str(fuel_id)] = {"name": name, "latestUpdate": latest, "prices": prices}
        print(f"{name}: {sum(map(len, prices.values()))} stations, {len(prices)} brands")
    OUT.write_text(json.dumps({
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "source": API,
        "fuels": fuels,
    }, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
