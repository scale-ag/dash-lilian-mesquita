#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera a dashboard estatica (index.html) do funil de DISTRIBUICAO DE CONTEUDO da
Lilian Mesquita a partir de DUAS planilhas distintas — nunca confundir as duas:

  PLANILHA 1 — "Extracao Dashboard" (SPREADSHEET_MEDIA), aba "Pagina1".
    Fonte UNICA de midia paga: Data, Campaign Name, Ad Set Name, Ad Name,
    Impressoes, Cliques no link, Amount Spent, Alcance. E' a unica fonte de
    gasto/impressoes/cliques/alcance e a unica com quebra por
    campanha/conjunto/anuncio.

  PLANILHA 2 — "Lilian Mesquita | Controle de trafego - 2026"
    (SPREADSHEET_CONTROLE), abas mensais em ABAS_CONTROLE.
    Fonte UNICA de SEGUIDORES por dia (bloco "META — Seguidores"). Nao tem
    quebra por anuncio: o seguidor so existe no nivel do dia.

Por que as fontes nao se misturam: em agosto o investimento lancado a mao na
Planilha 2 nao reconcilia com o Amount Spent do gerenciador (razao P2/P1 de
0,70 a 2,17 por dia, R$ 222 de diferenca no mes); em setembro as duas batem ao
centavo. Decisao do cliente: a Planilha 1 manda em gasto e derivados, a
Planilha 2 entra so com a contagem de seguidores. O investimento da Planilha 2
e' lido apenas para o log de conferencia — nunca alimenta CPM/CPC/CPS.

Leitura pelo endpoint gviz POR NOME de aba (nao por gid): estas planilhas nao
expoem o menu de abas no HTML, entao descobrir gid e' pouco confiavel; o nome
da aba e' estavel e visivel para o gestor. "headers=0" faz o gviz devolver
TODAS as linhas como dados — sem isso ele funde os cabecalhos de varias linhas
das abas mensais numa linha so.

Este script apenas LE as planilhas e emite os REGISTROS BRUTOS (media[], seg[])
dentro do HTML. Todos os filtros, agregacoes, KPIs, tabelas e graficos sao
calculados no navegador. Nunca escreve nada de volta.

Teste local: --media-file / --seg-file apontando para CSVs baixados.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

# --------------------------------------------------------------------------- #
# Fontes
# --------------------------------------------------------------------------- #
SPREADSHEET_MEDIA = "1vZgI8ju2OcQit2oEEGPbK-pm19gulnpiFH91TEh3ecI"
ABA_MEDIA = "Página1"

SPREADSHEET_CONTROLE = "1ESPchuMZHmXrDIyl5N8Kzy9i20Et0-9EkDVXe_DhSNs"
# So estas duas abas, conforme definido com o cliente. A planilha tambem tem uma
# aba "📈 Set" (residuo do template) que conflita com a "📈 Setembro": a "Set"
# tem investimento sem seguidores nos mesmos dias. A aba correta e' a "Setembro".
ABAS_CONTROLE = ["📈 Ago", "📈 Setembro"]

GVIZ_URL = ("https://docs.google.com/spreadsheets/d/{sid}/gviz/tq"
            "?tqx=out:csv&headers=0&sheet={aba}")

# Identificacao do cliente/conta (usada so em textos/relatorios).
CLIENT_NAME = "Lilian Mesquita"
MAIN_PRODUCT = "Distribuição de conteúdo"
# Prefixo comum a TODAS as campanhas da conta. A nomenclatura do cliente
# (aba "✏️ Nomenclaturas" da Planilha 2) e':
#   SIGLA | ETAPA | PUBLICO | OBJETIVO | BUDGET | DATA DE UPLOAD | DESCRICAO
# Ex.: "LM | E1-DIST |  | ENGJ | ABO | 2026-06-02 | Visitas no Perfil".
MAIN_PRODUCT_PREFIX = "LM"
# Sigla do funil (2o campo do Campaign Name). Hoje ha uma unica: E1-DIST
# (Etapa 1 - Distribuicao). Se surgir outra etapa na conta, acrescente aqui.
SIGLA_FUNIL = "E1-DIST"

BRT = timezone(timedelta(hours=-3))   # horario de Brasilia (exibicao)
# Imposto/taxa da conta de midia: 13,85%. O toggle "Imposto Meta" nasce ativo.
TAX_FACTOR = 1.1385

# --------------------------------------------------------------------------- #
# Regras da aba Relatorio (Top/Piores anuncios)
# --------------------------------------------------------------------------- #
# Amostra minima para julgar um anuncio. Abaixo disso ele entra como
# "Em observacao" (dado insuficiente). Como o funil de distribuicao nao tem
# conversao por anuncio, a amostra profunda e' medida em CLIQUES.
SAMPLE_MIN_SPEND = 30.0    # gasto minimo (R$) para amostra relevante
SAMPLE_MIN_CLICKS = 30     # cliques minimos para julgar qualidade
TOP_ADS_N = 10             # n de linhas em Top / Piores anuncios

# Metas & parametros da conta (DEFAULTS do painel editavel da aba Relatorio).
# None = "meta nao definida" (a metrica aparece sem cor ate o gestor preencher).
META_CPC = None            # meta de custo por clique (R$)
META_CPS = None            # meta de custo por seguidor (R$)
VOLUME_MIN_AMOSTRAL = SAMPLE_MIN_CLICKS
N_DIAS_CORTE = 5           # dias consecutivos acima do teto p/ considerar corte


# --------------------------------------------------------------------------- #
# Leitura
# --------------------------------------------------------------------------- #
def fetch_csv(url: str) -> list[list[str]]:
    req = urllib.request.Request(url, headers={"User-Agent": "dash-lilian-mesquita/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return list(csv.reader(io.StringIO(raw)))


def read_csv_file(path: str) -> list[list[str]]:
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as f:
        return list(csv.reader(f))


def aba_url(sid: str, aba: str) -> str:
    return GVIZ_URL.format(sid=sid, aba=urllib.parse.quote(aba))


def load_rows(url: str, local: str | None) -> list[list[str]]:
    return read_csv_file(local) if local else fetch_csv(url)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s: str | None) -> str:
    return strip_accents((s or "").strip().lower())


def to_float(v) -> float:
    """Numero em pt-BR ou en-US, tolerante a "R$", espacos e milhar."""
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[^\d,.\-]", "", str(v).strip())
    if not s:
        return 0.0
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_date(v: str) -> str | None:
    if not v:
        return None
    s = str(v).strip()
    if not s:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    for fmt in ("%d/%m/%Y", "%d/%m/%y", "%m/%d/%Y", "%b %d, %Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def cell(row, i):
    if i is None or i < 0 or i >= len(row):
        return ""
    return (row[i] or "").strip()


def sigla_funil(campanha: str) -> str:
    """2o campo do Campaign Name na nomenclatura do cliente."""
    partes = [p.strip() for p in (campanha or "").split("|")]
    return partes[1] if len(partes) > 1 and partes[1] else "—"


def objetivo_campanha(campanha: str) -> str:
    """Ultimo campo do Campaign Name: a descricao/objetivo da campanha
    ("Visitas no Perfil", "Impulsionar"). E' a dimensao mais util para o gestor
    agrupar as campanhas deste funil."""
    partes = [p.strip() for p in (campanha or "").split("|")]
    return partes[-1] if partes and partes[-1] else "(sem objetivo)"


def publico_conjunto(adset: str) -> str:
    """Ultimo campo do Ad Set Name: a descricao do publico.
    Nomenclatura: POSICIONAMENTO | GENERO | IDADE | LOCALIZACAO | DESCRICAO."""
    partes = [p.strip() for p in (adset or "").split("|") if p.strip()]
    return partes[-1] if partes else "(sem público)"


def plataforma_conjunto(adset: str) -> str:
    """1o campo do Ad Set Name: o posicionamento (IG/FB). Alguns conjuntos vem
    numerados ("1 - IG", "03 - IG"), entao o numero de ordem e' descartado."""
    p = [x.strip() for x in (adset or "").split("|")]
    if not p or not p[0]:
        return "—"
    return re.sub(r"^\d+\s*-\s*", "", p[0]).strip() or "—"


# --------------------------------------------------------------------------- #
# Indexacao das colunas
# --------------------------------------------------------------------------- #
def header_index(header, wanted, fallback):
    idx = {}
    hn = [norm(h) for h in header]
    for key, aliases in wanted.items():
        found = None
        for a in aliases:
            a = norm(a)
            for i, h in enumerate(hn):
                if h == a or (a and a in h):
                    found = i
                    break
            if found is not None:
                break
        idx[key] = found if found is not None else fallback.get(key)
    return idx


# --------------------------------------------------------------------------- #
# PLANILHA 1 — midia paga
# --------------------------------------------------------------------------- #
def process_media(rows):
    """Le a aba de midia e devolve os registros brutos, um por linha.

    O cabecalho da planilha so rotula Campaign Name / Ad Set Name / Ad Name; as
    colunas numericas estao SEM rotulo. Os indices de fallback abaixo vem da
    conferencia feita no reconhecimento: a coluna 8 e' exatamente
    gasto/impressoes*1000 em todas as linhas (logo, 4=impressoes, 6=gasto,
    8=CPM) e a 7 nunca excede a 4 (logo e' o alcance, nao os cliques).
    O CPM da planilha nao e' importado: e' recalculado no navegador, ja com o
    fator de imposto aplicado."""
    header = rows[0] if rows else []
    idx = header_index(
        header,
        {"day": ["day", "data"], "campaign": ["campaign name", "campanha"],
         "adset": ["ad set name", "conjunto"], "ad": ["ad name", "anuncio"],
         "impr": ["impressions", "impress"], "clicks": ["link clicks", "cliques"],
         "spent": ["amount spent", "valor gasto", "gasto"], "reach": ["reach", "alcance"]},
        {"day": 0, "campaign": 1, "adset": 2, "ad": 3,
         "impr": 4, "clicks": 5, "spent": 6, "reach": 7},
    )

    media = []
    for row in rows[1:]:
        if not any((c or "").strip() for c in row):
            continue
        d = parse_date(cell(row, idx["day"]))
        if not d:
            continue                      # linha de cabecalho/rodape, nao de dado
        camp = cell(row, idx["campaign"]) or "(sem campanha)"
        adset = cell(row, idx["adset"]) or "(sem conjunto)"
        ad = cell(row, idx["ad"]) or "(sem anúncio)"
        media.append({
            "d": d,
            "camp": camp,
            "adset": adset,
            "ad": ad,
            "obj": objetivo_campanha(camp),
            "sig": sigla_funil(camp),
            "pub": publico_conjunto(adset),
            "plat": plataforma_conjunto(adset),
            "sp": round(to_float(cell(row, idx["spent"])), 4),
            "im": to_float(cell(row, idx["impr"])),
            "cl": to_float(cell(row, idx["clicks"])),
            "rc": to_float(cell(row, idx["reach"])),
        })
    return media


# --------------------------------------------------------------------------- #
# PLANILHA 2 — seguidores por dia
# --------------------------------------------------------------------------- #
# Posicao das colunas nas abas mensais. O cabecalho ocupa varias linhas mescladas
# e nao sobrevive ao export, entao a leitura e' POSICIONAL. Layout conferido no
# reconhecimento (bloco "META — Seguidores"):
#   [01] Data · [12] Invest. (R$) · [13] Seguid. · [14] CPS
COL_CTRL_DATA = 1
COL_CTRL_INVEST = 12
COL_CTRL_SEGUIDORES = 13


def process_controle(abas_rows):
    """Le as abas mensais e devolve [{d, seg, inv_ctrl}, ...], um registro por dia.

    "inv_ctrl" e' o investimento lancado a mao pelo gestor. NAO alimenta nenhum
    calculo da dashboard — fica so no payload para o log de conferencia contra o
    gasto real do gerenciador (Planilha 1). Dias sem seguidor E sem investimento
    sao descartados (a aba ja vem com o mes inteiro pre-preenchido de zeros)."""
    por_dia: dict[str, dict] = {}
    for aba, rows in abas_rows:
        for row in rows:
            d = parse_date(cell(row, COL_CTRL_DATA))
            if not d:
                continue
            seg = to_float(cell(row, COL_CTRL_SEGUIDORES))
            inv = to_float(cell(row, COL_CTRL_INVEST))
            if not seg and not inv:
                continue
            # Se o mesmo dia aparecer em duas abas, vence o registro com seguidor
            # (a aba residual "Set" traz investimento sem seguidor nos mesmos dias).
            ant = por_dia.get(d)
            if ant and ant["seg"] and not seg:
                continue
            por_dia[d] = {"d": d, "seg": seg, "inv_ctrl": round(inv, 2), "aba": aba}
    return [por_dia[d] for d in sorted(por_dia)]


def log_conferencia(media, seg):
    """Confere, dia a dia, o gasto do gerenciador (Planilha 1) contra o
    investimento lancado no controle (Planilha 2). Nao altera a saida: serve
    para o gestor enxergar onde as duas fontes divergem."""
    gasto_dia: dict[str, float] = {}
    for m in media:
        gasto_dia[m["d"]] = gasto_dia.get(m["d"], 0.0) + m["sp"]

    linhas = [(s["d"], gasto_dia.get(s["d"], 0.0), s["inv_ctrl"]) for s in seg if s["inv_ctrl"]]
    if not linhas:
        return
    tot_p1 = sum(l[1] for l in linhas)
    tot_p2 = sum(l[2] for l in linhas)
    divergentes = [l for l in linhas if abs(l[1] - l[2]) > 0.5]
    print(f"  conferencia P1 x P2 : {len(linhas)} dia(s) comparados | "
          f"gerenciador R$ {tot_p1:,.2f} x controle R$ {tot_p2:,.2f} "
          f"(dif R$ {tot_p2 - tot_p1:,.2f})", file=sys.stderr)
    if divergentes:
        print(f"  {len(divergentes)} dia(s) divergem acima de R$ 0,50 "
              f"(a dashboard usa SEMPRE o gerenciador):", file=sys.stderr)
        for d, a, b in divergentes:
            print(f"    - {d}  gerenciador R$ {a:8.2f}  controle R$ {b:8.2f}  "
                  f"({b / a:.2f}x)" if a else
                  f"    - {d}  gerenciador R$ {a:8.2f}  controle R$ {b:8.2f}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# Montagem do payload
# --------------------------------------------------------------------------- #
def process(media_rows, controle_abas):
    media = process_media(media_rows)
    seg = process_controle(controle_abas)
    log_conferencia(media, seg)

    dates = sorted({d for d in ([m["d"] for m in media] + [s["d"] for s in seg]) if d})
    now_brt = datetime.now(BRT)
    return {
        "build": {
            "generated_at_brt": now_brt.strftime("%d/%m/%Y %H:%M"),
            "build_id": datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
            "today": now_brt.strftime("%Y-%m-%d"),
            "date_min": dates[0] if dates else None,
            "date_max": dates[-1] if dates else None,
            "tax_factor": TAX_FACTOR,
            "client_name": CLIENT_NAME,
            "main_product": MAIN_PRODUCT,
            "sigla_funil": SIGLA_FUNIL,
            # config da aba Relatorio (lida pelo front)
            "sample_min_spend": SAMPLE_MIN_SPEND,
            "sample_min_clicks": SAMPLE_MIN_CLICKS,
            "top_ads_n": TOP_ADS_N,
            # metas & parametros (defaults do painel editavel; None = nao definida)
            "meta_cpc": META_CPC,
            "meta_cps": META_CPS,
            "volume_min_amostral": VOLUME_MIN_AMOSTRAL,
            "n_dias_corte": N_DIAS_CORTE,
            # dia a partir do qual ha contagem de seguidores (antes disso a
            # planilha de controle nao existia) — o front usa para nao exibir
            # "0 seguidores" onde o certo e' "sem dado".
            "seg_date_min": seg[0]["d"] if seg else None,
            "seg_date_max": seg[-1]["d"] if seg else None,
        },
        "media": media,
        "seg": seg,
        # Insights de Trafego (texto pre-escrito, lido de relatorios.json).
        "briefings": {},
    }


# --------------------------------------------------------------------------- #
# Insights de Trafego (aba Relatorio)
# --------------------------------------------------------------------------- #
def load_briefings(path: str) -> dict:
    """Le build/relatorios.json. A geracao NAO acontece aqui — este build so le o
    texto ja pronto, sem chamar nenhuma API."""
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else {}
    except (ValueError, OSError):
        return {}


# --------------------------------------------------------------------------- #
# Render
# --------------------------------------------------------------------------- #
def render(data, template_path):
    """Costura template.html + identidade-visual.css + estilos.css + app.js e
    injeta os dados. Nao altera nenhum deles."""
    base = os.path.dirname(os.path.abspath(template_path))

    def readf(name):
        with open(os.path.join(base, name), "r", encoding="utf-8") as f:
            return f.read()

    with open(template_path, "r", encoding="utf-8") as f:
        tpl = f.read()
    styles = readf("identidade-visual.css") + "\n" + readf("estilos.css")
    tpl = tpl.replace("__STYLES__", styles)
    tpl = tpl.replace("__APP_JS__", readf("app.js"))
    tpl = tpl.replace("__DATA_JSON__", json.dumps(data, ensure_ascii=False))
    tpl = tpl.replace("__BUILD_ID__", data["build"]["build_id"])
    tpl = tpl.replace("__GENERATED_BRT__", data["build"]["generated_at_brt"])
    return tpl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-file", help="CSV local da Planilha 1 (midia paga)")
    ap.add_argument("--seg-file", action="append", default=None,
                    help="CSV local de uma aba mensal da Planilha 2 (repetivel)")
    ap.add_argument("--template", default="build/template.html")
    ap.add_argument("--out", default="dist/index.html")
    args = ap.parse_args()

    media_rows = load_rows(aba_url(SPREADSHEET_MEDIA, ABA_MEDIA), args.media_file)

    controle_abas = []
    if args.seg_file:
        for i, caminho in enumerate(args.seg_file):
            controle_abas.append((os.path.basename(caminho), read_csv_file(caminho)))
    else:
        for aba in ABAS_CONTROLE:
            controle_abas.append((aba, fetch_csv(aba_url(SPREADSHEET_CONTROLE, aba))))

    data = process(media_rows, controle_abas)

    briefings_path = os.path.join(os.path.dirname(os.path.abspath(args.template)), "relatorios.json")
    data["briefings"] = load_briefings(briefings_path)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(render(data, args.template))

    b = data["build"]
    sp = sum(m["sp"] for m in data["media"])
    im = sum(m["im"] for m in data["media"])
    cl = sum(m["cl"] for m in data["media"])
    sg = sum(s["seg"] for s in data["seg"])
    print("== build ok ==", file=sys.stderr)
    print(f"  periodo     : {b['date_min']} -> {b['date_max']}", file=sys.stderr)
    print(f"  midia       : {len(data['media'])} linhas | R$ {sp:,.2f} | "
          f"{im:,.0f} impressoes | {cl:,.0f} cliques", file=sys.stderr)
    print(f"  seguidores  : {sg:,.0f} em {len(data['seg'])} dia(s) "
          f"({b['seg_date_min']} -> {b['seg_date_max']})", file=sys.stderr)
    print(f"  CPS medio   : R$ {(sp * TAX_FACTOR / sg):,.2f}" if sg else
          "  CPS medio   : -", file=sys.stderr)
    print(f"  out         : {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
