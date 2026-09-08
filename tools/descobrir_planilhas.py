#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Reconhecimento READ-ONLY das planilhas do cliente (Fase 0) — v2, com diagnostico
de acesso publico.

Roda no runner do GitHub Actions (o sandbox do agente nao alcanca docs.google.com).
NUNCA escreve nada de volta: so faz GET nos endpoints publicos de export.

O runner NAO tem credencial Google. Se a planilha nao estiver com
"qualquer pessoa com o link -> Leitor", todo GET volta a pagina de login em vez
do dado — e o build de producao falharia do mesmo jeito. Este script mostra
exatamente qual e' o caso.
"""
from __future__ import annotations

import base64
import csv
import gzip
import io
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"}

PLANILHAS = [
    ("PLANILHA 1 - Extracao Dashboard (Meta Ads)", "1vZgI8ju2OcQit2oEEGPbK-pm19gulnpiFH91TEh3ecI"),
    ("PLANILHA 2 - Controle de trafego 2026",      "1ESPchuMZHmXrDIyl5N8Kzy9i20Et0-9EkDVXe_DhSNs"),
]
# Abas nomeadas que o cliente mandou ler na Planilha 2 (via gviz, por NOME).
ABAS_POR_NOME = ["\U0001F4C8 Ago", "\U0001F4C8 Setembro", "Ago", "Setembro"]

MAX_B64_BYTES = 250_000
SAMPLE_ROWS = 10


def get(url: str, timeout: int = 90):
    """Devolve (status, url_final, corpo_bytes)."""
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.geturl(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, url, e.read()[:3000]
    except Exception as e:                                  # noqa: BLE001
        print(f"      !! erro de rede: {type(e).__name__}: {e}")
        return 0, url, b""


def eh_login(url_final: str, corpo: bytes) -> bool:
    if "accounts.google.com" in url_final or "/ServiceLogin" in url_final:
        return True
    amostra = corpo[:60000].decode("utf-8", "replace")
    return ("accounts.google.com/ServiceLogin" in amostra
            or "Faça login" in amostra
            or "To continue, sign in" in amostra
            or "Sign in - Google Accounts" in amostra)


def diagnostico_acesso(sid: str) -> bool:
    """Testa se a planilha responde a export CSV sem credencial. True = publica."""
    url = f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv&gid=0"
    st, fin, corpo = get(url)
    login = eh_login(fin, corpo)
    print(f"      export?gid=0 -> HTTP {st} | {len(corpo)} bytes | login={login}")
    print(f"      url final    : {fin[:150]}")
    ct = corpo[:200].decode("utf-8", "replace").replace("\n", "\\n")
    print(f"      inicio corpo : {ct!r}")
    return st == 200 and not login


def descobrir_abas(sid: str) -> list[tuple[str, str]]:
    """[(nome, gid), ...] via htmlview (menu de abas) e via /edit (bootstrap)."""
    achados: dict[str, str] = {}
    for caminho in ("htmlview", "edit"):
        st, fin, corpo = get(f"https://docs.google.com/spreadsheets/d/{sid}/{caminho}")
        html = corpo.decode("utf-8", "replace")
        print(f"      /{caminho} -> HTTP {st} | {len(corpo)} bytes | login={eh_login(fin, corpo)}")
        for gid, rot in re.findall(r'id="sheet-button-(\d+)"[^>]*>(?:<a[^>]*>)?(.*?)</(?:a|li)>', html, re.S):
            nome = re.sub(r"<[^>]+>", "", rot).strip()
            if nome:
                achados.setdefault(nome, gid)
        for nome, gid in re.findall(r'"name":"((?:[^"\\]|\\.)*)","index":\d+,"sheetId":(\d+)', html):
            try:
                achados.setdefault(json.loads(f'"{nome}"'), gid)
            except ValueError:
                achados.setdefault(nome, gid)
        # ultimo recurso: qualquer "#gid=NNN" citado na pagina
        for gid in set(re.findall(r"[#&]gid=(\d+)", html)):
            achados.setdefault(f"(gid {gid} — nome desconhecido)", gid)
        if achados:
            break
    return list(achados.items())


def mostrar_tabela(rotulo: str, raw: bytes, despejar: bool, tag: str) -> None:
    texto = raw.decode("utf-8", "replace")
    linhas = list(csv.reader(io.StringIO(texto)))
    print(f"      linhas totais (inclui cabecalho): {len(linhas)}")
    if not linhas:
        return
    idx = 0
    for i, ln in enumerate(linhas[:20]):
        if sum(1 for c in ln if (c or "").strip()) >= 2:
            idx = i
            break
    print(f"      linha de cabecalho detectada: indice {idx}")
    print(f"      COLUNAS ({len(linhas[idx])}):")
    for i, c in enumerate(linhas[idx]):
        print(f"        [{i:02d}] {c!r}")
    print(f"      AMOSTRA ({SAMPLE_ROWS} linhas apos o cabecalho):")
    for ln in linhas[idx + 1: idx + 1 + SAMPLE_ROWS]:
        print(f"        {ln}")
    cab = [(c or "").strip().lower() for c in linhas[idx]]
    for alvo in ("campaign name", "campanha", "nome da campanha"):
        if alvo in cab:
            j = cab.index(alvo)
            dist = sorted({(l[j] or "").strip() for l in linhas[idx + 1:]
                           if j < len(l) and (l[j] or "").strip()})
            print(f"      CAMPAIGN NAME distintos ({len(dist)}):")
            for d in dist:
                print(f"        * {d}")
            break
    if despejar:
        comp = gzip.compress(raw, 9)
        if len(comp) <= MAX_B64_BYTES:
            b64 = base64.b64encode(comp).decode()
            print(f"      CSV_GZ_B64_INICIO {tag} ({len(comp)} bytes comprimidos)")
            for k in range(0, len(b64), 200):
                print("      B64 " + b64[k:k + 200])
            print(f"      CSV_GZ_B64_FIM {tag}")
        else:
            print(f"      (CSV grande demais p/ o log: {len(comp)} bytes > {MAX_B64_BYTES})")


def main() -> int:
    despejar = "--dump-csv" in sys.argv
    for titulo, sid in PLANILHAS:
        print("\n" + "=" * 78)
        print(f"{titulo}\nid: {sid}")
        print("=" * 78)

        print("\n  [1] Acesso publico (o runner nao tem login Google):")
        publica = diagnostico_acesso(sid)
        print(f"      => {'PUBLICA (link -> Leitor)' if publica else 'NAO PUBLICA — precisa liberar o compartilhamento'}")

        print("\n  [2] Abas e gids:")
        abas = descobrir_abas(sid)
        if abas:
            for nome, gid in abas:
                print(f"      - {nome!r} -> gid={gid}")
        else:
            print("      (nenhuma aba descoberta)")

        print("\n  [3] Leitura por gid:")
        for nome, gid in abas:
            print(f"\n    --- ABA {nome!r} gid={gid} ---")
            st, fin, raw = get(f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv&gid={gid}")
            print(f"      export csv -> HTTP {st} | {len(raw)} bytes | login={eh_login(fin, raw)}")
            if st == 200 and raw and not eh_login(fin, raw):
                mostrar_tabela(nome, raw, despejar, f"sid={sid[:8]} gid={gid}")

        print("\n  [4] Leitura por NOME de aba (gviz) — util quando o gid nao aparece:")
        for nome in ABAS_POR_NOME:
            url = (f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq"
                   f"?tqx=out:csv&sheet={urllib.parse.quote(nome)}")
            st, fin, raw = get(url)
            login = eh_login(fin, raw)
            print(f"\n    --- gviz sheet={nome!r} -> HTTP {st} | {len(raw)} bytes | login={login} ---")
            if st == 200 and raw and not login:
                mostrar_tabela(nome, raw, despejar, f"sid={sid[:8]} sheet={nome}")
            elif raw:
                print(f"      inicio corpo: {raw[:200].decode('utf-8', 'replace')!r}")

    print("\n== reconhecimento concluido ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
