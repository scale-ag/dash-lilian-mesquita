#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Funções puras de datas/agregação usadas por `coletar_dados_relatorio.py`
(coleta de números para a Routine do Claude escrever os Insights). Nenhuma lógica de
texto/interpretação mora aqui — só aritmética sobre os registros brutos de
`build.py` (`media[]`/`seg[]`).

Funil de DISTRIBUIÇÃO DE CONTEÚDO: Gasto → Impressões → Alcance → Cliques →
Visitas no Perfil → Seguidores. Visitas e Seguidores vêm da planilha de
controle e só existem por DIA (sem quebra por campanha/anúncio) e só dentro da
janela que ela cobre — por isso o custo e a taxa de conversão dessas duas
etapas são calculados sobre o gasto/cliques APENAS dos dias com contagem.
"""
from __future__ import annotations

from datetime import datetime, timedelta, date

import build as bp

BRT = bp.BRT


def d(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def ds(x: date) -> str:
    return x.strftime("%Y-%m-%d")


def month_bounds(any_day: date, offset_months: int = 0):
    y, m = any_day.year, any_day.month
    m += offset_months
    while m < 1:
        m += 12
        y -= 1
    while m > 12:
        m -= 12
        y += 1
    first = date(y, m, 1)
    if m == 12:
        last = date(y, 12, 31)
    else:
        nxt = date(y, m + 1, 1)
        last = nxt - timedelta(days=1)
    return first, last


def build_periods(today: date, date_min: date | None, date_max: date | None):
    """Espelha PRESETS de build/app.js — chaves fixas lidas por relBriefKey()."""
    dmin = date_min or today
    dmax = date_max or today
    mes_f, _ = month_bounds(today, 0)
    mespass_f, mespass_l = month_bounds(today, -1)
    return {
        "hoje":    (today, today, "Hoje"),
        "ontem":   (today - timedelta(days=1), today - timedelta(days=1), "Ontem"),
        "3d":      (today - timedelta(days=2), today, "3 dias"),
        "7d":      (today - timedelta(days=6), today, "7 dias"),
        "14d":     (today - timedelta(days=13), today, "14 dias"),
        "30d":     (today - timedelta(days=29), today, "30 dias"),
        "mes":     (mes_f, today, "Este mês"),
        "mespass": (mespass_f, mespass_l, "Mês passado"),
        "todo":    (dmin, dmax, "Todo período"),
    }


def in_range(row_date: str | None, start: date, end: date) -> bool:
    if not row_date:
        return False
    try:
        rd = d(row_date)
    except ValueError:
        return False
    return start <= rd <= end


def agg(media: list[dict], seg: list[dict], start: date, end: date, camp: str | None = None,
        adset: str | None = None, ad: str | None = None) -> dict:
    """Agrega a mídia no recorte pedido e casa com a contagem diária de visitas
    e seguidores.

    Filtrar por campanha/conjunto/anúncio NÃO filtra visitas/seguidores: a
    planilha de controle registra por dia, sem quebra por criativo, então
    atribuir essas contagens a um anúncio seria invenção. Num recorte por
    dimensão as duas etapas saem como None."""
    def keep(r):
        if not in_range(r["d"], start, end):
            return False
        if camp is not None and r["camp"] != camp:
            return False
        if adset is not None and r["adset"] != adset:
            return False
        if ad is not None and r["ad"] != ad:
            return False
        return True

    m = [r for r in media if keep(r)]
    spend = sum(r["sp"] for r in m) * bp.TAX_FACTOR
    impr = sum(r["im"] for r in m)
    clicks = sum(r["cl"] for r in m)
    reach = sum(r["rc"] for r in m)

    por_dimensao = camp is not None or adset is not None or ad is not None
    s = [r for r in seg if in_range(r["d"], start, end)] if not por_dimensao else []
    dias_vis = {r["d"] for r in s if r.get("visOk")}
    dias_seg = {r["d"] for r in s if r.get("segOk")}
    # gasto/cliques restritos aos dias que têm cada contagem — sem isso o custo
    # por visita/seguidor herdaria o gasto de dias que a planilha não cobre.
    m_todos = [r for r in media if in_range(r["d"], start, end)]
    spend_vis = sum(r["sp"] for r in m_todos if r["d"] in dias_vis) * bp.TAX_FACTOR
    clicks_vis = sum(r["cl"] for r in m_todos if r["d"] in dias_vis)
    spend_seg = sum(r["sp"] for r in m_todos if r["d"] in dias_seg) * bp.TAX_FACTOR
    clicks_seg = sum(r["cl"] for r in m_todos if r["d"] in dias_seg)

    return {"spend": spend, "impr": impr, "clicks": clicks, "reach": reach,
            "visitas": sum(r["vis"] for r in s) if dias_vis else None,
            "seguidores": sum(r["seg"] for r in s) if dias_seg else None,
            "spend_vis": spend_vis, "clicks_vis": clicks_vis,
            "spend_seg": spend_seg, "clicks_seg": clicks_seg}


def derived(a: dict) -> dict:
    spend, impr, clicks, reach = a["spend"], a["impr"], a["clicks"], a["reach"]
    visitas, seguidores = a.get("visitas"), a.get("seguidores")
    return {
        "cpm": (spend / impr * 1000) if impr else None,
        "ctr": (clicks / impr) if impr else None,
        "cpc": (spend / clicks) if clicks else None,
        "freq": (impr / reach) if reach else None,
        "cpv": (a["spend_vis"] / visitas) if visitas else None,
        "txvis": (visitas / a["clicks_vis"]) if visitas and a["clicks_vis"] else None,
        "cps": (a["spend_seg"] / seguidores) if seguidores else None,
        "txseg": (seguidores / a["clicks_seg"]) if seguidores and a["clicks_seg"] else None,
        **a,
    }


def shift_back(start: date, end: date, n: int) -> tuple[date, date]:
    """Janela imediatamente anterior, mesmo tamanho, deslocada n vezes."""
    span = (end - start).days + 1
    new_end = start - timedelta(days=1 + span * (n - 1))
    new_start = new_end - timedelta(days=span - 1)
    return new_start, new_end


# --------------------------------------------------------------------------- #
# Período de comparação por janela (regra §7 do briefing) — cada uma das 9
# janelas usa um "período anterior equivalente" diferente; "todo" nunca
# inventa um período anterior (usa metade recente x metade antiga como
# benchmark, quando há histórico suficiente).
# --------------------------------------------------------------------------- #
def previous_period(key: str, start: date, end: date, today: date,
                     date_min: date | None, date_max: date | None):
    """Retorna (prev_start, prev_end, metodo) ou (None, None, metodo) quando
    não existe período anterior válido (ex.: "todo" com histórico curto)."""
    if key in ("hoje", "ontem", "3d", "7d", "14d", "30d"):
        p_start, p_end = shift_back(start, end, 1)
        return p_start, p_end, "período imediatamente anterior, mesma duração"

    if key == "mes":
        n_dias = (end - start).days + 1
        prev_first, prev_last = month_bounds(today, -1)
        p_start = prev_first
        p_end = min(prev_first + timedelta(days=n_dias - 1), prev_last)
        return p_start, p_end, "mesmo intervalo de dias (1–{}) do mês anterior".format(n_dias)

    if key == "mespass":
        p_start, p_end = month_bounds(today, -2)
        return p_start, p_end, "mês retrasado completo"

    if key == "todo":
        dmin = date_min or start
        dmax = date_max or end
        total_days = (dmax - dmin).days + 1
        if total_days < 14:
            return None, None, "histórico curto demais para dividir — usado só como benchmark, sem variação forçada"
        mid = dmin + timedelta(days=total_days // 2)
        return dmin, mid - timedelta(days=1), "metade mais antiga do histórico vs. metade mais recente"

    p_start, p_end = shift_back(start, end, 1)
    return p_start, p_end, "período imediatamente anterior, mesma duração"


RATE_METRICS = {"ctr", "txvis", "txseg"}
MATERIAL_PCT = 0.10     # variação relativa mínima p/ considerar mudança relevante
MATERIAL_PP = 0.03      # variação em pontos percentuais mínima p/ métricas de taxa


def compare(cur: dict, prev: dict | None) -> dict:
    """Compara duas agregações `derived()` métrica a métrica. Só marca
    `material=True` quando a variação passa os limiares mínimos — evita
    listar oscilações irrelevantes como se fossem alerta (regra §7)."""
    metrics = ["spend", "impr", "clicks", "reach", "visitas", "seguidores",
               "cpm", "ctr", "cpc", "freq", "cpv", "txvis", "cps", "txseg"]
    out = {}
    for m in metrics:
        cv, pv = cur.get(m), (prev or {}).get(m)
        row = {"atual": cv, "anterior": pv, "delta_abs": None, "delta_pct": None,
               "delta_pp": None, "direcao": "sem_dado", "material": False}
        if cv is not None and pv is not None:
            row["delta_abs"] = round(cv - pv, 4)
            row["delta_pct"] = round((cv - pv) / pv, 4) if pv else None
            if m in RATE_METRICS:
                row["delta_pp"] = round((cv - pv) * 100, 2)
            # frequência alta = público saturando, então entra junto dos custos
            higher_is_better = m not in ("spend", "cpm", "cpc", "cpv", "cps", "freq")
            if abs(cv - pv) < 1e-9:
                row["direcao"] = "estavel"
            else:
                melhorou = (cv > pv) == higher_is_better
                row["direcao"] = "melhorou" if melhorou else "piorou"
            if m in RATE_METRICS:
                row["material"] = row["delta_pp"] is not None and abs(row["delta_pp"]) >= MATERIAL_PP * 100
            else:
                row["material"] = row["delta_pct"] is not None and abs(row["delta_pct"]) >= MATERIAL_PCT
        elif cv is not None and pv is None:
            row["direcao"] = "sem_periodo_anterior"
        out[m] = row
    return out


# --------------------------------------------------------------------------- #
# Nota de saúde do funil (0–10) — metodologia única, reaplicada em todos os
# períodos. Cada subnota só é calculada quando os dados que a sustentam
# existem; ausência de dado NUNCA vira nota 0 (fica None + a nota geral é
# marcada como provisória). Ver GUIA-RELATORIOS.md §5 para a leitura completa.
# --------------------------------------------------------------------------- #
def _clamp(v, lo=0.0, hi=10.0):
    return max(lo, min(hi, v))


def _classificacao(nota: float) -> str:
    if nota >= 8.0:
        return "Excelente"
    if nota >= 6.5:
        return "Saudável, com atenção"
    if nota >= 5.0:
        return "Atenção"
    if nota >= 3.0:
        return "Crítico"
    return "Crítico grave"


def funnel_health(cur: dict, baseline: dict, meta_cpc, meta_cps,
                   volume_min: int, sample_windows: list[dict]) -> dict:
    """`cur` e `baseline` são dicts `derived()` do período atual e de uma
    janela de referência (normalmente 30d). `sample_windows` é uma lista de
    dicts `derived()` (ex.: 7d/14d/30d) usada para medir consistência."""
    sub = {}

    # Aquisição: custo de mídia (CPM) e capacidade de gerar clique (CTR) vs.
    # baseline de 30 dias da própria conta.
    if cur.get("cpm") is not None and baseline.get("cpm") and cur.get("ctr") is not None and baseline.get("ctr"):
        cpm_var = (cur["cpm"] - baseline["cpm"]) / baseline["cpm"]
        ctr_var = (cur["ctr"] - baseline["ctr"]) / baseline["ctr"]
        sub["aquisicao"] = round(_clamp(10 - cpm_var * 10 + ctr_var * 5), 1)
    else:
        sub["aquisicao"] = None

    # Saturação do público: frequência (impressões por pessoa alcançada). Até
    # ~1,5x o público ainda está sendo renovado; daí para cima o mesmo criativo
    # começa a repetir para quem já viu, que é o desgaste típico deste funil.
    if cur.get("freq") is not None:
        sub["saturacao_publico"] = round(_clamp(10 - max(0.0, cur["freq"] - 1.5) * 5), 1)
    else:
        sub["saturacao_publico"] = None

    # Custo por clique vs. meta (se definida) ou vs. baseline de 30 dias.
    if cur.get("cpc") is not None:
        ref = meta_cpc if meta_cpc is not None else baseline.get("cpc")
        sub["custo_clique"] = round(_clamp(10 - ((cur["cpc"] - ref) / ref) * 10), 1) if ref else None
    else:
        sub["custo_clique"] = None

    # Conversão em perfil: quanto do clique vira visita ao perfil.
    if cur.get("txvis") is not None and baseline.get("txvis"):
        sub["conversao_perfil"] = round(_clamp(10 * cur["txvis"] / baseline["txvis"]), 1)
    else:
        sub["conversao_perfil"] = None

    # Resultado final do funil: custo por seguidor vs. meta ou baseline.
    if cur.get("cps") is not None:
        ref = meta_cps if meta_cps is not None else baseline.get("cps")
        sub["custo_seguidor"] = round(_clamp(10 - ((cur["cps"] - ref) / ref) * 10), 1) if ref else None
    else:
        sub["custo_seguidor"] = None

    # Consistência: quanto o CTR varia entre as janelas de amostra (7/14/30d) —
    # baixa variação = leitura mais confiável entre janelas.
    ctrs = [w["ctr"] for w in sample_windows if w.get("ctr") is not None]
    if len(ctrs) >= 2 and max(ctrs) > 0:
        spread = (max(ctrs) - min(ctrs)) / max(ctrs)
        sub["consistencia"] = round(_clamp(10 - spread * 10), 1)
    else:
        sub["consistencia"] = None

    # Confiabilidade dos dados: volume de cliques no período vs. volume mínimo
    # amostral configurado no painel da aba Relatório.
    clicks = cur.get("clicks") or 0
    sub["confiabilidade_dados"] = round(_clamp(10 * clicks / volume_min if volume_min else 10), 1)

    disponiveis = {k: v for k, v in sub.items() if v is not None}
    if not disponiveis:
        return {
            "nota": None, "provisoria": True, "classificacao": "Sem dado suficiente",
            "motivo": "Nenhuma subnota pôde ser calculada neste período (sem volume/histórico comparável).",
            "subnotas": sub,
        }

    nota = round(sum(disponiveis.values()) / len(disponiveis), 1)
    faltantes = [k for k, v in sub.items() if v is None]
    provisoria = bool(faltantes)
    motivo = (
        "Nota provisória: sem dados suficientes para " + ", ".join(faltantes) + "."
        if provisoria else ""
    )
    return {
        "nota": nota, "provisoria": provisoria, "classificacao": _classificacao(nota),
        "motivo": motivo, "subnotas": sub,
    }


# --------------------------------------------------------------------------- #
# Formatação (moeda/percentual dos números já prontos do bloco de WhatsApp)
# --------------------------------------------------------------------------- #
def money(v) -> str:
    if v is None:
        return "—"
    return f"R$ {v:,.2f}".replace(",", "#").replace(".", ",").replace("#", ".")


def pct(v) -> str:
    if v is None:
        return "—"
    return f"{v * 100:.1f}%".replace(".", ",")


def num(v) -> str:
    if v is None:
        return "—"
    return f"{v:,.0f}".replace(",", ".")


def meta_status(nome: str, valor) -> str:
    return "meta não definida" if valor is None else f"meta {nome} = {money(valor)}"
