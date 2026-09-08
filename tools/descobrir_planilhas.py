#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Reconhecimento READ-ONLY das planilhas do cliente (Fase 0).

Roda no runner do GitHub Actions (o sandbox do agente nao alcanca docs.google.com).
NUNCA escreve nada de volta: so faz GET nos endpoints publicos de export/visualizacao.

Imprime no log do job:
  - nome + gid de TODAS as abas das 2 planilhas;
  - cabecalho completo (todas as colunas) de cada aba;
  - N linhas de amostra por aba;
  - valores distintos de Campaign Name (p/ deduzir a Sigla do Funil);
  - o CSV inteiro em gzip+base64 quando couber (p/ testar o build offline).

Este arquivo e temporario e sai do repo assim que a Fase 0 terminar.
"""
from __future__ import annotations

import base64
import csv
import gzip
import io
import re
import sys
import urllib.error
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (compatible; dash-discovery/1.0)"}

PLANILHAS = [
    ("PLANILHA 1 - Extracao Dashboard (Meta Ads)", "1vZgI8ju2OcQit2oEEGPbK-pm19gulnpiFH91TEh3ecI"),
    ("PLANILHA 2 - Controle de trafego 2026",      "1ESPchuMZHmXrDIyl5N8Kzy9i20Et0-9EkDVXe_DhSNs"),
]

MAX_B64_BYTES = 250_000   # acima disso, so amostra (nao despeja o CSV inteiro no log)
SAMPLE_ROWS = 8


def get(url: str, timeout: int = 90) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:2000]
    except Exception as e:                                  # noqa: BLE001
        print(f"    !! erro de rede: {type(e).__name__}: {e}")
        return 0, b""


def descobrir_abas(sid: str) -> list[tuple[str, str]]:
    """Devolve [(nome_da_aba, gid), ...]. Tenta htmlview e depois a pagina /edit."""
    achados: dict[str, str] = {}

    st, body = get(f"https://docs.google.com/spreadsheets/d/{sid}/htmlview")
    print(f"    htmlview -> HTTP {st} ({len(body)} bytes)")
    if st == 200:
        html = body.decode("utf-8", "replace")
        # <li id="sheet-button-123456"...><a ...>Nome da aba</a>
        for gid, rotulo in re.findall(
            r'id="sheet-button-(\d+)"[^>]*>(?:<a[^>]*>)?(.*?)</(?:a|li)>', html, re.S
        ):
            nome = re.sub(r"<[^>]+>", "", rotulo).strip()
            if nome:
                achados.setdefault(nome, gid)

    if not achados:
        st, body = get(f"https://docs.google.com/spreadsheets/d/{sid}/edit")
        print(f"    /edit -> HTTP {st} ({len(body)} bytes)")
        if st == 200:
            html = body.decode("utf-8", "replace")
            # bootstrapData traz pares {"...","<nome>",<gid>,...}
            for nome, gid in re.findall(r'\{"name":"(.*?)","index":\d+,"sheetId":(\d+)', html):
                achados.setdefault(nome.encode().decode("unicode_escape"), gid)
            if not achados:
                for gid, nome in re.findall(r'\[null,(\d+),"(.*?)"', html)[:60]:
                    achados.setdefault(nome.encode().decode("unicode_escape"), gid)
            if not achados:
                print("    (nenhuma aba extraida do /edit — amostra do HTML p/ diagnostico:)")
                print("    " + html[:1200].replace("\n", " ")[:1200])

    return list(achados.items())


def baixar_csv(sid: str, gid: str) -> tuple[int, bytes]:
    return get(f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv&gid={gid}")


def dump_aba(titulo: str, sid: str, nome: str, gid: str, despejar_csv: bool) -> None:
    print(f"\n  --- ABA: {nome!r}   gid={gid} ---")
    st, raw = baixar_csv(sid, gid)
    print(f"    export csv -> HTTP {st} ({len(raw)} bytes)")
    if st != 200 or not raw:
        print("    !! nao foi possivel exportar esta aba (permissao? aba oculta?)")
        return

    texto = raw.decode("utf-8", "replace")
    linhas = list(csv.reader(io.StringIO(texto)))
    print(f"    linhas totais (inclui cabecalho): {len(linhas)}")
    if not linhas:
        return

    # Cabecalho: a 1a linha com >=2 celulas nao vazias (abas de controle costumam
    # ter titulo/merge nas primeiras linhas).
    idx_cab = 0
    for i, ln in enumerate(linhas[:15]):
        if sum(1 for c in ln if (c or "").strip()) >= 2:
            idx_cab = i
            break
    print(f"    linha de cabecalho detectada: indice {idx_cab}")
    print(f"    COLUNAS ({len(linhas[idx_cab])}):")
    for i, c in enumerate(linhas[idx_cab]):
        print(f"      [{i:02d}] {c!r}")

    print(f"    AMOSTRA ({SAMPLE_ROWS} linhas apos o cabecalho):")
    for ln in linhas[idx_cab + 1: idx_cab + 1 + SAMPLE_ROWS]:
        print(f"      {ln}")

    # Campaign Name distintos (p/ deduzir a Sigla do Funil)
    cab_norm = [(c or "").strip().lower() for c in linhas[idx_cab]]
    for alvo in ("campaign name", "campanha", "nome da campanha"):
        if alvo in cab_norm:
            j = cab_norm.index(alvo)
            distintos = sorted({(l[j] or "").strip() for l in linhas[idx_cab + 1:]
                                if j < len(l) and (l[j] or "").strip()})
            print(f"    CAMPAIGN NAME distintos ({len(distintos)}):")
            for d in distintos:
                print(f"      * {d}")
            break

    if despejar_csv:
        comp = gzip.compress(raw, 9)
        if len(comp) <= MAX_B64_BYTES:
            b64 = base64.b64encode(comp).decode()
            print(f"    CSV_GZ_B64_INICIO gid={gid} ({len(comp)} bytes comprimidos)")
            for k in range(0, len(b64), 200):
                print("    B64 " + b64[k:k + 200])
            print(f"    CSV_GZ_B64_FIM gid={gid}")
        else:
            print(f"    (CSV grande demais p/ o log: {len(comp)} bytes comprimidos > {MAX_B64_BYTES})")


def main() -> int:
    despejar = "--dump-csv" in sys.argv
    for titulo, sid in PLANILHAS:
        print("\n" + "=" * 78)
        print(f"{titulo}")
        print(f"id: {sid}")
        print("=" * 78)
        abas = descobrir_abas(sid)
        if not abas:
            print("  !! NENHUMA ABA DESCOBERTA — a planilha provavelmente nao esta")
            print("     acessivel por link publico. O build no Actions tambem falharia.")
            continue
        print(f"\n  ABAS ENCONTRADAS ({len(abas)}):")
        for nome, gid in abas:
            print(f"    - {nome!r}  ->  gid={gid}")
        for nome, gid in abas:
            dump_aba(titulo, sid, nome, gid, despejar)
    print("\n== reconhecimento concluido ==")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
