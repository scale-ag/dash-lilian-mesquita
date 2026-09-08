#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Reconhecimento READ-ONLY das planilhas do cliente (Fase 0) — v3.

O v2 confirmou que as duas planilhas sao publicas (link -> Leitor) e que o
endpoint gviz por NOME de aba funciona. Esta versao para de imprimir amostras
soltas e faz o que interessa: baixa TODAS as abas das duas planilhas e despeja
um unico JSON (gzip+base64) no log, para o agente reconstruir os CSVs offline
e montar/testar o build sem depender de acesso ao docs.google.com.

Somente leitura: apenas GETs nos endpoints publicos de export. Nunca escreve.
"""
from __future__ import annotations

import base64
import gzip
import json
import re
import urllib.error
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}

PLANILHAS = [
    ("p1_extracao",  "1vZgI8ju2OcQit2oEEGPbK-pm19gulnpiFH91TEh3ecI"),
    ("p2_controle",  "1ESPchuMZHmXrDIyl5N8Kzy9i20Et0-9EkDVXe_DhSNs"),
]


def get(url: str, timeout: int = 120):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.geturl(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, url, e.read()[:2000]
    except Exception as e:                                  # noqa: BLE001
        return 0, url, f"ERRO {type(e).__name__}: {e}".encode()


def abas(sid: str) -> list[tuple[str, str]]:
    """[(nome, gid), ...] a partir do menu de abas do htmlview / bootstrap do /edit."""
    achados: dict[str, str] = {}
    for caminho in ("htmlview", "edit"):
        _, _, corpo = get(f"https://docs.google.com/spreadsheets/d/{sid}/{caminho}")
        html = corpo.decode("utf-8", "replace")
        for gid, rot in re.findall(
            r'id="sheet-button-(\d+)"[^>]*>(?:<a[^>]*>)?(.*?)</(?:a|li)>', html, re.S
        ):
            nome = re.sub(r"<[^>]+>", "", rot).strip()
            if nome:
                achados.setdefault(nome, gid)
        for nome, gid in re.findall(r'"name":"((?:[^"\\]|\\.)*)","index":\d+,"sheetId":(\d+)', html):
            try:
                achados.setdefault(json.loads(f'"{nome}"'), gid)
            except ValueError:
                achados.setdefault(nome, gid)
        if achados:
            break
    return list(achados.items())


def main() -> int:
    pacote: dict = {}
    for chave, sid in PLANILHAS:
        lista = abas(sid)
        print(f"\n=== {chave} ({sid}) — {len(lista)} aba(s) ===")
        pacote[chave] = {"sid": sid, "abas": {}}
        for nome, gid in lista:
            # export por gid preserva a estrutura crua de linhas (inclusive
            # cabecalhos em varias linhas), ao contrario do gviz que as funde.
            st, _, raw = get(f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv&gid={gid}")
            ok = st == 200 and b"accounts.google.com" not in raw[:4000]
            print(f"  - {nome!r} gid={gid} -> HTTP {st} | {len(raw)} bytes | ok={ok}")
            pacote[chave]["abas"][nome] = {
                "gid": gid,
                "http": st,
                "csv": raw.decode("utf-8", "replace") if ok else "",
            }

    blob = json.dumps(pacote, ensure_ascii=False).encode("utf-8")
    comp = gzip.compress(blob, 9)
    b64 = base64.b64encode(comp).decode()
    print(f"\nPACOTE_JSON_GZ_B64 ({len(blob)} bytes crus -> {len(comp)} comprimidos -> {len(b64)} base64)")
    print("PACOTE_INICIO")
    for k in range(0, len(b64), 480):
        print(b64[k:k + 480])
    print("PACOTE_FIM")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
