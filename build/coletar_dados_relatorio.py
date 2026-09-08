#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera build/relatorios_dados.json: SÓ NÚMEROS (nenhuma interpretação/texto),
agregados por período/campanha/conjunto/anúncio a partir dos mesmos dados que
alimentam o dashboard (mídia paga x Leads). É o insumo lido pela Routine do
Claude (ver GUIA-RELATORIOS.md) para escrever build/relatorios.json — garante
que os números do texto batem 1:1 com o site sem depender do Claude "fazer
conta". Não chama nenhuma API de IA/LLM.

Uso:
    python build/coletar_dados_relatorio.py --out build/relatorios_dados.json
    python build/coletar_dados_relatorio.py --media-file midia.csv --seg-file ago.csv \
        --seg-file setembro.csv --out build/relatorios_dados.json

Sem --media-file/--seg-file, busca os CSVs públicos das planilhas (mesma URL de
build.py) — precisa de acesso a docs.google.com (o runner do GitHub Actions tem;
o sandbox do agente normalmente não).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build as bp  # reaproveita fetch/parse/process/constantes de build.py
from relatorio_lib import (
    BRT, d, build_periods, in_range, agg, derived, shift_back,
    previous_period, compare, funnel_health, money, pct, num,
)


def daily_series(media: list[dict], seg: list[dict], start, end, camp=None, adset=None, ad=None) -> list[dict]:
    """Uma linha por dia — dá ao Claude a base pra enxergar tendência (ex.: CPM
    subindo ou custo por seguidor piorando N dias seguidos)."""
    out = []
    cur = start
    while cur <= end:
        a = derived(agg(media, seg, cur, cur, camp=camp, adset=adset, ad=ad))
        if a["spend"] or a.get("visitas") or a.get("seguidores"):
            out.append({
                "d": cur.strftime("%Y-%m-%d"),
                "spend": round(a["spend"], 2), "impr": a["impr"], "clicks": a["clicks"],
                "reach": a["reach"], "visitas": a["visitas"], "seguidores": a["seguidores"],
                "cpm": _r(a["cpm"]), "ctr": _r(a["ctr"], 4), "cpc": _r(a["cpc"]),
                "freq": _r(a["freq"]), "cpv": _r(a["cpv"]), "txvis": _r(a["txvis"], 4),
                "cps": _r(a["cps"]), "txseg": _r(a["txseg"], 4),
            })
        cur += timedelta(days=1)
    return out


def _r(v, nd=2):
    return None if v is None else round(v, nd)


def totais_dict(a: dict) -> dict:
    return {
        "spend": round(a["spend"], 2), "impr": a["impr"], "clicks": a["clicks"],
        "reach": a["reach"], "visitas": a["visitas"], "seguidores": a["seguidores"],
        "cpm": _r(a["cpm"]), "ctr": _r(a["ctr"], 4), "cpc": _r(a["cpc"]),
        "freq": _r(a["freq"]), "cpv": _r(a["cpv"]), "txvis": _r(a["txvis"], 4),
        "cps": _r(a["cps"]), "txseg": _r(a["txseg"], 4),
    }


def breakdown(media: list[dict], seg: list[dict], start, end, dim: str, camp_filter=None) -> list[dict]:
    """Agrega por campanha/conjunto/anúncio dentro do período (só métricas
    agregadas — SEM série diária por estrutura, que inchava o arquivo). A série
    diária existe apenas AGREGADA no nível do período (ver periodo_payload)."""
    def key_of(r):
        if dim == "camp":
            return r["camp"]
        if dim == "adset":
            return (r["camp"], r["adset"])
        return (r["camp"], r["adset"], r["ad"])

    # Só a mídia define as estruturas: visitas e seguidores não têm dimensão.
    keys = set()
    for r in media:
        if in_range(r["d"], start, end) and (camp_filter is None or r["camp"] == camp_filter):
            keys.add(key_of(r))

    out = []
    for k in sorted(keys, key=lambda x: str(x)):
        if dim == "camp":
            camp, adset, ad = k, None, None
        elif dim == "adset":
            camp, adset, ad = k[0], k[1], None
        else:
            camp, adset, ad = k

        a = derived(agg(media, seg, start, end, camp=camp, adset=adset, ad=ad))
        if not a["spend"] and not a["clicks"]:
            continue
        row = totais_dict(a)
        if dim == "camp":
            row["campanha"] = camp
        elif dim == "adset":
            row["campanha"], row["conjunto"] = camp, adset
        else:
            row["campanha"], row["conjunto"], row["anuncio"] = camp, adset, ad
        out.append(row)
    out.sort(key=lambda r: -r["spend"])
    return out


def consolidado_criativos(por_anuncio: list[dict]) -> list[dict]:
    """Agrupa as ocorrências (campanha+conjunto+anúncio) de `por_anuncio` pelo
    NOME do anúncio — visão consolidada do criativo (regra §11-A do briefing:
    o mesmo criativo pode rodar em várias estruturas com resultados diferentes)."""
    by_ad: dict[str, list[dict]] = {}
    for row in por_anuncio:
        by_ad.setdefault(row["anuncio"], []).append(row)

    out = []
    for ad, occs in by_ad.items():
        spend = sum(o["spend"] for o in occs)
        clicks = sum(o["clicks"] for o in occs)
        impr = sum(o["impr"] for o in occs)
        reach = sum(o["reach"] for o in occs)
        # Clique é o resultado mais profundo que existe POR CRIATIVO neste
        # funil: visitas e seguidores só são contados por dia, sem quebra por
        # anúncio, então a comparação entre estruturas é feita pelo CPC.
        occs_com_clique = [o for o in occs if o["clicks"]]
        melhor = min(occs_com_clique, key=lambda o: o["cpc"]) if occs_com_clique else None
        pior = max(occs_com_clique, key=lambda o: o["cpc"]) if occs_com_clique else None
        out.append({
            "anuncio": ad,
            "n_estruturas": len(occs),
            "estruturas": [{"campanha": o["campanha"], "conjunto": o["conjunto"]} for o in occs],
            "spend": round(spend, 2), "impr": impr, "clicks": clicks, "reach": reach,
            "cpm": round(spend / impr * 1000, 2) if impr else None,
            "ctr": round(clicks / impr, 4) if impr else None,
            "cpc": round(spend / clicks, 2) if clicks else None,
            "freq": round(impr / reach, 2) if reach else None,
            "melhor_estrutura": (
                {"campanha": melhor["campanha"], "conjunto": melhor["conjunto"], "cpc": melhor["cpc"]}
                if melhor else None
            ),
            "pior_estrutura": (
                {"campanha": pior["campanha"], "conjunto": pior["conjunto"], "cpc": pior["cpc"]}
                if pior and pior is not melhor else None
            ),
        })
    out.sort(key=lambda r: -r["spend"])
    return out


def whatsapp_numeros(label: str, start, end, cur: dict, saude: dict) -> dict:
    """Números já formatados (moeda/percentual) para o bloco copiável do
    WhatsApp — a Routine do Claude só preenche destaques/ações em texto,
    nunca recalcula nem inventa estes valores (regra §6 do briefing)."""
    return {
        "periodo_label": label,
        "periodo_range": f"{start.strftime('%d/%m/%Y')} a {end.strftime('%d/%m/%Y')}",
        "gasto": money(cur["spend"]), "cpm": money(cur["cpm"]), "ctr": pct(cur["ctr"]),
        "impressoes": num(cur["impr"]), "alcance": num(cur["reach"]),
        "frequencia": ("—" if cur["freq"] is None else f"{cur['freq']:.2f}x".replace(".", ",")),
        "cliques": num(cur["clicks"]), "cpc": money(cur["cpc"]),
        "visitas_perfil": num(cur["visitas"]), "custo_por_visita": money(cur["cpv"]),
        "seguidores": num(cur["seguidores"]), "custo_por_seguidor": money(cur["cps"]),
        "conv_clique_visita": pct(cur["txvis"]), "conv_clique_seguidor": pct(cur["txseg"]),
        "saude_funil": (
            f"{saude['nota']:.1f}/10 — {saude['classificacao']}" + (" (provisória)" if saude["provisoria"] else "")
            if saude["nota"] is not None else "Nota provisória — dados insuficientes"
        ),
    }


def periodo_payload(media: list[dict], seg: list[dict], today, start, end, key, date_min, date_max,
                     meta_cpc, meta_cps, volume_min) -> dict:
    cur = derived(agg(media, seg, start, end))
    ref7 = derived(agg(media, seg, today - timedelta(days=6), today))
    ref14 = derived(agg(media, seg, today - timedelta(days=13), today))
    ref30 = derived(agg(media, seg, today - timedelta(days=29), today))

    p_start, p_end, metodo = previous_period(key, start, end, today, date_min, date_max)
    anterior = derived(agg(media, seg, p_start, p_end)) if p_start else None

    saude = funnel_health(cur, ref30, meta_cpc, meta_cps, volume_min, [ref7, ref14, ref30])
    por_anuncio = breakdown(media, seg, start, end, "ad")

    return {
        "range": {"start": start.strftime("%Y-%m-%d"), "end": end.strftime("%Y-%m-%d")},
        "totais": totais_dict(cur),
        # Série diária AGREGADA do período (não por estrutura) — só a base p/ o
        # Claude ver tendência geral (CPM subindo / Tx-MQL caindo N dias). Limitada
        # aos últimos 60 dias com atividade p/ não inchar "todo período". A série
        # por campanha/conjunto/anúncio foi REMOVIDA de propósito: ela respondia por
        # ~75% do tamanho do arquivo (≈280k tokens) e ninguém a consome — o veredito
        # por estrutura usa as métricas agregadas de por_campanha/conjunto/anuncio.
        "serie_diaria": daily_series(media, seg, start, end)[-60:],
        "nota_saude": saude,
        "whatsapp_numeros": whatsapp_numeros("", start, end, cur, saude),
        "comparativos": {
            "7d": totais_dict(ref7), "14d": totais_dict(ref14), "30d": totais_dict(ref30),
            "periodo_anterior": {
                "range": ({"start": p_start.strftime("%Y-%m-%d"), "end": p_end.strftime("%Y-%m-%d")}
                          if p_start else None),
                "metodo": metodo,
                "totais": totais_dict(anterior) if anterior else None,
                "variacao": compare(cur, anterior),
            },
        },
        "por_campanha": breakdown(media, seg, start, end, "camp"),
        "por_conjunto": breakdown(media, seg, start, end, "adset"),
        "por_anuncio": por_anuncio,
        "criativos_consolidado": consolidado_criativos(por_anuncio),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--media-file", help="CSV local da Planilha 1 (midia paga)")
    ap.add_argument("--seg-file", action="append", default=None,
                    help="CSV local de uma aba mensal da Planilha 2 (repetivel)")
    ap.add_argument("--out", default="build/relatorios_dados.json")
    args = ap.parse_args()

    media_rows = bp.load_rows(bp.aba_url(bp.SPREADSHEET_MEDIA, bp.ABA_MEDIA), args.media_file)
    if args.seg_file:
        controle_abas = [(os.path.basename(c), bp.read_csv_file(c)) for c in args.seg_file]
    else:
        controle_abas = [(aba, bp.fetch_csv(bp.aba_url(bp.SPREADSHEET_CONTROLE, aba)))
                         for aba in bp.ABAS_CONTROLE]
    data = bp.process(media_rows, controle_abas)
    media, seg = data["media"], data["seg"]

    now_brt = datetime.now(BRT)
    today = now_brt.date()
    date_min = d(data["build"]["date_min"]) if data["build"]["date_min"] else None
    date_max = d(data["build"]["date_max"]) if data["build"]["date_max"] else None

    periods = build_periods(today, date_min, date_max)

    out = {
        "generated_at": now_brt.strftime("%d/%m/%Y %H:%M"),
        "generated_at_iso": now_brt.isoformat(),
        "fonte": "Números brutos do funil de distribuição de conteúdo (mídia paga × contagem "
                 "diária de visitas ao perfil e seguidores) — insumo para a Routine do Claude "
                 "escrever build/relatorios.json (Insights de Tráfego). Sem interpretação/texto "
                 "aqui, só aritmética.",
        "observacoes": [
            "Gasto, impressões, alcance e cliques vêm do gerenciador (Planilha 1) — é a fonte "
            "de verdade do investimento.",
            "Visitas ao perfil e seguidores vêm da planilha de controle (Planilha 2) e existem "
            "só por DIA: não há quebra por campanha, conjunto ou anúncio. Em qualquer recorte "
            "por estrutura essas duas etapas voltam null — não as atribua a um criativo.",
            "Custo por visita, custo por seguidor e as taxas de conversão dessas etapas são "
            "calculados sobre o gasto/cliques APENAS dos dias que têm contagem.",
        ],
        "params": {
            "tax_factor": bp.TAX_FACTOR,
            "sample_min_spend": bp.SAMPLE_MIN_SPEND,
            "sample_min_clicks": bp.SAMPLE_MIN_CLICKS,
            "meta_cpc": bp.META_CPC,
            "meta_cps": bp.META_CPS,
            "volume_min_amostral": bp.VOLUME_MIN_AMOSTRAL,
            "n_dias_corte": bp.N_DIAS_CORTE,
        },
        "periodos": {},
    }
    for key, (start, end, label) in periods.items():
        payload = periodo_payload(media, seg, today, start, end, key, date_min, date_max,
                                   bp.META_CPC, bp.META_CPS, bp.VOLUME_MIN_AMOSTRAL)
        payload["whatsapp_numeros"]["periodo_label"] = label
        out["periodos"][key] = {"label": label, **payload}

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("== coletar_dados_relatorio ok ==", file=sys.stderr)
    print(f"  periodos: {list(out['periodos'].keys())}", file=sys.stderr)
    print(f"  out: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
