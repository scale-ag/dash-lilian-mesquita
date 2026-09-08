# Dashboard de Distribuição de Conteúdo · Lilian Mesquita

Dashboard **100% na nuvem** do funil de **Distribuição de conteúdo** de
**Lilian Mesquita**: um app de BI estático (HTML/CSS/JS puro + Chart.js via CDN)
publicado no GitHub Pages, que cruza o gerenciador de mídia paga com a planilha
de controle de tráfego e se reconstrói sozinho a cada ~30 min.

**URL pública:** https://scale-ag.github.io/dash-lilian-mesquita/

Somente leitura das planilhas — a dashboard nunca escreve nelas.

## Funil

```
Gasto → Impressões → Alcance → Cliques no link → Visitas no Perfil → Seguidores
```

Não há lead, MQL, venda nem faturamento nesta operação: é um funil de topo, cujo
resultado final é seguidor no perfil. As métricas de custo são **CPM**, **CPC**,
**Custo por Visita (CPV)** e **Custo por Seguidor (CPS)**; a **Frequência**
(impressões ÷ alcance) é o termômetro de saturação do público.

## Fontes de dados (duas planilhas — não confundir)

| # | Planilha | Aba(s) lida(s) | O que vem dela |
|---|----------|----------------|----------------|
| 1 | [Extração Dashboard](https://docs.google.com/spreadsheets/d/1vZgI8ju2OcQit2oEEGPbK-pm19gulnpiFH91TEh3ecI) | `Página1` | Data · Campaign Name · Ad Set Name · Ad Name · Impressões · Cliques no link · Amount Spent · Alcance |
| 2 | [Controle de tráfego — 2026](https://docs.google.com/spreadsheets/d/1ESPchuMZHmXrDIyl5N8Kzy9i20Et0-9EkDVXe_DhSNs) | `📈 Ago` e `📈 Setembro` | Visitas ao perfil · Custo por Visita · Seguidores · CPS (bloco `META — Seguidores` + `Meta - Visitas no Perfil do Instagram`) |

Regras que valem em todo o projeto:

- **A Planilha 1 é a fonte de verdade do investimento.** Gasto, impressões,
  alcance e cliques saem só dela, e é a única com quebra por
  campanha/conjunto/anúncio. Em agosto o investimento lançado à mão na Planilha 2
  não reconcilia com o gerenciador — o build loga a diferença dia a dia, mas
  nunca usa o número do controle em nenhum cálculo.
- **Visitas ao perfil e Seguidores existem só por DIA.** A Planilha 2 não quebra
  por criativo, então essas duas etapas somem de qualquer tabela ou filtro por
  campanha/conjunto/anúncio (aparecem como "sem dado", nunca como zero).
- **Fora da janela coberta pela Planilha 2** (antes de 07/08) o valor é ausência
  de dado, não zero — por isso o custo por visita/seguidor é calculado só sobre o
  gasto dos dias que têm contagem.
- A aba `📈 Set` da Planilha 2 é resíduo do template e **não é lida**: ela
  conflita com a `📈 Setembro`, que é a que o gestor preenche.

A leitura é feita pelo endpoint `gviz` **por nome de aba** (não por gid): estas
planilhas não expõem o menu de abas no HTML, então descobrir gid é pouco
confiável, enquanto o nome da aba é estável e visível para o gestor.

### Imposto da mídia
`TAX_FACTOR = 1.1385` (13,85%) em `build/build.py`. O toggle **Imposto Meta**
nasce ativo e aplica o fator em todo o gasto e derivados (CPM, CPC, CPV, CPS);
desligá-lo mostra o gasto sem imposto.

### Nomenclatura das campanhas
`SIGLA | ETAPA | PÚBLICO | OBJETIVO | BUDGET | DATA DE UPLOAD | DESCRIÇÃO`
(definida na aba `✏️ Nomenclaturas` da Planilha 2). Exemplo:

```
LM | E1-DIST |  | ENGJ | ABO | 2026-06-02 | Visitas no Perfil
```

Sigla do cliente `LM`; **sigla do funil `E1-DIST`** (Etapa 1 — Distribuição), a
única em uso na conta.

## Páginas

1. **Visão Geral** — funil vertical + KPIs secundários, evolução diária
   (cliques/seguidores em barras, gasto/CPC/CPS em linha), distribuição do
   investimento por objetivo/público/posicionamento, cliques por anúncio e
   tabela diária com heatmap.
2. **Captura mídia paga** — mesmo funil, donut de frequência, compilado de
   anúncios por CPC, três tabelas hierárquicas (Campanha → Conjunto → Anúncio)
   com filtro cruzado bidirecional, e a tabela de seguidores por dia.
3. **Relatório** — espelha a Visão Geral, com painel de metas editável
   (CPC/CPS, salvo no navegador), tabela de anúncios com status de amostra e os
   Insights de Tráfego.

## Rodar local

```bash
python build/build.py --media-file midia.csv \
  --seg-file ago.csv --seg-file setembro.csv --out dist/index.html
```

O sandbox do agente não alcança `docs.google.com`; use CSVs locais para testar.
O runner do GitHub Actions tem internet e busca os CSVs ao vivo.

## Automação

- `.github/workflows/deploy.yml` — roda o build e publica no Pages
  (`workflow_dispatch` + `schedule` + `push` em `build/**`).
- `.github/workflows/briefing.yml` — roda `coletar_dados_relatorio.py` 1×/dia e
  commita `build/relatorios_dados.json` (só números, sem IA).
- Disparo externo a cada 30 min pelo cron-job.org — ver [SETUP-CRON.md](SETUP-CRON.md).
