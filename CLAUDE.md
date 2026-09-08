# CLAUDE.md — Contexto do projeto (Lilian Mesquita · Distribuição de conteúdo)

> Este arquivo é lido automaticamente pelo Claude Code ao abrir o repositório.
> Ele carrega TODO o contexto necessário para continuar o trabalho sem depender
> de mensagens anteriores. Mantenha-o atualizado.

---

## O que é

Dashboard de **Distribuição de Conteúdo** — um app de BI estático (HTML/CSS/JS
puro + Chart.js via CDN) publicado no **GitHub Pages**, que cruza o gerenciador
de mídia paga com a planilha de controle de tráfego e se atualiza sozinho a cada ~30 min
(build 100% na nuvem via GitHub Actions, disparado externamente pelo cron-job.org).

- **URL pública:** https://scale-ag.github.io/dash-lilian-mesquita/
- **Somente leitura** das planilhas. Nunca escrever de volta.

## Fontes de dados — DUAS planilhas, nunca confundir

| # | Planilha | Aba(s) lida(s) | Colunas usadas |
|---|----------|----------------|----------------|
| 1 | **Extração Dashboard** `1vZgI8ju2OcQit2oEEGPbK-pm19gulnpiFH91TEh3ecI` | `Página1` | `[0]` Data · `[1]` Campaign Name · `[2]` Ad Set Name · `[3]` Ad Name · `[4]` Impressões · `[5]` Cliques no link · `[6]` Amount Spent · `[7]` Alcance |
| 2 | **Lilian Mesquita \| Controle de tráfego - 2026** `1ESPchuMZHmXrDIyl5N8Kzy9i20Et0-9EkDVXe_DhSNs` | `📈 Ago` e `📈 Setembro` | `[1]` Data · `[12]` Invest. · `[13]` Seguid. · `[14]` CPS · `[15]` Visitas ao perfil · `[16]` Custo por Visita |

Leitura pelo endpoint **gviz por NOME de aba**, não por gid:

```
https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv&headers=0&sheet=<nome>
```

Estas planilhas não expõem o menu de abas no HTML (`/htmlview` e `/edit` voltam
sem ele), então descobrir gid é pouco confiável; o nome da aba é estável e
visível para o gestor. `headers=0` devolve todas as linhas como dados — sem
isso o gviz funde os cabeçalhos mesclados das abas mensais numa linha só.

### Regras que valem em todo o projeto

- **A Planilha 1 é a fonte de verdade do investimento.** Gasto, impressões,
  alcance e cliques saem só dela, e é a única com quebra por
  campanha/conjunto/anúncio. Em agosto o investimento lançado à mão na Planilha 2
  **não reconcilia** com o gerenciador (razão P2/P1 de 0,80 a 2,17 por dia,
  ~R$ 146 de diferença); em setembro as duas batem ao centavo.
  `log_conferencia()` imprime a divergência dia a dia no build, mas o número do
  controle **nunca** entra em nenhum cálculo.
- **Visitas ao perfil e Seguidores existem só por DIA.** A Planilha 2 não quebra
  por criativo. Em qualquer tabela ou filtro por campanha/conjunto/anúncio essas
  duas etapas voltam `null` — atribuí-las a um anúncio seria invenção.
- **Fora da janela coberta pela Planilha 2** (antes de 07/08) o valor é ausência
  de dado, não zero. Por isso `derive()` em `app.js` e `agg()` em
  `relatorio_lib.py` calculam CPV/CPS e as taxas de conversão sobre o
  gasto/cliques **apenas dos dias que têm contagem** — sem isso o CPV do período
  inteiro dava R$ 1,05 em vez de R$ 0,32, e o CPS R$ 13,56 em vez de R$ 4,11.
- A aba `📈 Set` é resíduo do template e **não é lida**: conflita com a
  `📈 Setembro` (traz investimento sem contagem nos mesmos dias).
- A Planilha 2 é editada à mão e **já mudou de layout uma vez** (o bloco de
  Visitas no Perfil foi inserido depois, deslocando as colunas seguintes).
  `valida_layout_controle()` confere as identidades aritméticas de cada bloco
  (CPS = invest/seguidores, CPV = invest/visitas) e grita no log se as posições
  saírem do lugar, em vez de publicar número errado.

### Funil
```
Gasto → Impressões → Alcance → Cliques no link → Visitas no Perfil → Seguidores
```
Não há lead, MQL, venda, faturamento nem ROAS nesta operação — nenhuma das duas
planilhas tem essas etapas, e elas não existem na dashboard. Métricas de custo:
**CPM · CPC · CPV · CPS**; **Frequência** (impressões ÷ alcance) é o termômetro
de saturação do público.

> **Cliques→Visita passa de 100%** e isso está certo: "cliques no link" é uma
> métrica mais estreita que visita ao perfil (dá para tocar no nome do perfil
> sem clicar no link). Serve como proporção, não como taxa de conversão fechada.

### Imposto da mídia paga
`TAX_FACTOR = 1.1385` (13,85%) em `build.py`. O toggle "Imposto Meta" nasce
**ativo** (`STATE.tax=true`) e aplica o fator em todo o gasto e derivados.

### Convenções de campanha
Nomenclatura da aba `✏️ Nomenclaturas` da Planilha 2:
`SIGLA | ETAPA | PÚBLICO | OBJETIVO | BUDGET | DATA DE UPLOAD | DESCRIÇÃO`

```
LM | E1-DIST |         | ENGJ | ABO | 2026-06-02 | Visitas no Perfil
LM | E1-DIST | P2-FRIO | TRFG | ABO | 2026-09-03 | Impulsionar
```

`MAIN_PRODUCT_PREFIX = "LM"` (sigla do cliente) e **`SIGLA_FUNIL = "E1-DIST"`**
(Etapa 1 — Distribuição), a única sigla de funil em uso na conta. `build.py`
deriva do nome três dimensões extras: `obj` (último campo — o objetivo),
`pub` (último campo do Ad Set Name — o público) e `plat` (1º campo do Ad Set
Name — o posicionamento, com o número de ordem descartado).

## Arquitetura / arquivos

```
build/build.py            # lê os CSVs (read-only) das 2 planilhas, emite REGISTROS BRUTOS (media[]/seg[]); render() COSTURA os 4 arquivos abaixo
build/template.html       # esqueleto HTML. Placeholders __STYLES__, __APP_JS__, __DATA_JSON__, __BUILD_ID__, __GENERATED_BRT__
build/identidade-visual.css  # TODAS as cores (tema claro=padrão / escuro). Mexa AQUI p/ trocar só cor
build/estilos.css         # layout/componentes (sidebar, topbar, period-picker, funil, tabelas, gráficos, aba Relatório)
build/app.js              # lógica + renderização (KPIs, funil, tabelas, filtro cruzado, period-picker, heatmap, Relatório)
build/relatorios.json     # Insights de Tráfego por período (aba Relatório) — VERSIONADO; lido no build, sem API. Vazio no template ({}).
build/relatorios_dados.json      # números brutos por período (insumo p/ a Routine escrever relatorios.json) — não lido pelo site. Vazio no template ({}).
build/relatorio_lib.py           # datas/agregação usadas por coletar_dados_relatorio.py
build/coletar_dados_relatorio.py # gera relatorios_dados.json (só números, sem texto) — roda no briefing.yml, 1x/dia
build/GUIA-RELATORIOS.md            # formato/estrutura dos Insights da aba Relatório (os 7 blocos)
build/GUIA-INTERPRETACAO-METRICAS.md # regras de diagnóstico por métrica — leitura obrigatória p/ redigir
.github/workflows/deploy.yml    # roda build.py e publica no Pages (workflow_dispatch + schedule + push)
.github/workflows/briefing.yml  # roda coletar_dados_relatorio.py e commita relatorios_dados.json na main (cron 1x/dia)
dist/index.html           # saída gerada (gitignored; o Actions reconstrói)
GUIA-REPLICACAO.md        # como replicar este modelo para outros relatórios/clientes
SETUP-CRON.md             # valores exatos do cron-job.org (com marcadores a preencher)
```

### Aba Relatório
Terceira página (sidebar, entre a de mídia paga e o rodapé). **Espelha a Visão
Geral** (mesmo funil/KPIs/gráficos/tabela diária, via `renderGeralCore(REL_IDS)`)
e, abaixo, acrescenta 3 blocos novos + um painel de metas editável:
- **Metas & parâmetros (painel editável)** — no topo da aba: Meta CPC, Meta CPS,
  Volume mínimo amostral (cliques), N dias p/ corte. Persiste em
  `localStorage['dm_metas']`, default de `build.py` (`META_CPC`/`META_CPS`=None →
  "não definida"; `VOLUME_MIN_AMOSTRAL`/`N_DIAS_CORTE`). Editar recolore **CPC/CPS**
  na tabela de anúncios (verde ≤ meta · amarelo até +30% · vermelho acima) e ajusta
  o badge Em observação/Avaliável, **tudo ao vivo** (`METAS` + `renderRelAds()`).
- **Tabela de anúncios** — 16 colunas + coluna **Status** (Anúncio · Status ·
  Campanha · Conjunto · Gasto · Impr · CPM · Alcance · Freq · Cliques · CTR · CPC ·
  Visitas · CPV · Seguidores · CPS). Anúncio e Status ficam **sticky**.
  Ranking pelo **clique** — o resultado mais profundo que existe por criativo neste
  funil — com amostra relevante primeiro; sem amostra → badge **"Em observação"**.
  As colunas Visitas/CPV/Seguidores/CPS ficam "-" por anúncio, porque a contagem é
  diária. Limiares em `build.py`: `SAMPLE_MIN_SPEND`, `SAMPLE_MIN_CLICKS`,
  `TOP_ADS_N`.
- **Insights de Tráfego** — texto por período redigido pelo **Claude** (linguagem de
  gestor de tráfego), lido de `build/relatorios.json` (sem API no build/navegador —
  o site só exibe o texto já pronto). Formato em **4 quadrantes** por período. Cada
  período compara com o período anterior **correto para aquela janela** (regra em
  `relatorio_lib.previous_period`). Chaves de período fixas
  (`hoje/ontem/3d/7d/14d/30d/mes/mespass/todo`), tags `Escalar/Otimizar/Cortar/Observar`.
  Toda a aritmética é pré-calculada em `build/relatorios_dados.json` — a Routine só
  interpreta, nunca recalcula. Regras completas em `build/GUIA-RELATORIOS.md` +
  `build/GUIA-INTERPRETACAO-METRICAS.md`. `app.js` ainda reconhece o formato antigo
  (`{"html": "…"}`) como fallback.

### Briefing automático do gestor (Routine do Claude, sem chamada à API Anthropic)
`build/relatorios.json` pode ser escrito 1×/dia por uma **Routine do Claude**
(Claude Code Remote — mesma infraestrutura de sessão/agente deste repo, agendada;
não é chamada paga à API). Fluxo em 2 etapas, porque o ambiente da Routine não
alcança `docs.google.com` (só o runner do GitHub Actions alcança):
1. `build/coletar_dados_relatorio.py` (GitHub Actions, `.github/workflows/briefing.yml`,
   1×/dia) agrega **só números** em `build/relatorios_dados.json` e commita na `main`.
2. A Routine do Claude lê esse JSON + `build/GUIA-RELATORIOS.md` +
   `build/GUIA-INTERPRETACAO-METRICAS.md`, redige `build/relatorios.json` e faz
   commit/push direto na `main`, disparando o `deploy.yml`. **Precisa ser criada
   por cliente** (`create_trigger` apontando para o repo novo) — não vem pronta.

O gerador determinístico `build/gerar_relatorios.py` que vinha no template foi
**removido**: seus 448 linhas de texto falavam em MQL/CPMQL/CAC/ROAS e
produziriam prosa errada para este funil. Se um fallback sem IA voltar a ser
necessário, ele precisa ser reescrito para as métricas de distribuição.

Funil completo: `Gasto → Impressões → Alcance → Cliques → Visitas no Perfil →
Seguidores`. Visitas e Seguidores aparecem "-" fora da janela que a planilha de
controle cobre e em qualquer recorte por campanha/conjunto/anúncio.

> **Layout modular:** o front-end é separado em `identidade-visual.css` + `estilos.css`
> + `app.js`, costurados por `render()` nos placeholders `__STYLES__`/`__APP_JS__`.
> Página 1 usa **funil vertical** + KPIs secundários. Topbar tem **seletor de
> período em calendário** (default "Este mês"). **Heatmap** = cor FIXA por
> métrica (só opacidade varia): **Gasto=vermelho · Cliques=azul · Seguidores=ciano
> · Alcance=verde · CTR=amarelo**
> (`--heat-gasto/cliques/seg/alcance/ctr`).

O `build.py` **não agrega**: exporta as linhas cruas e TODA a lógica (filtros de
data, filtro cruzado, KPIs, tabelas, gráficos, heatmap, imposto) roda no navegador.

## Rodar/testar local

```bash
python build/build.py --leads-file leads.csv --meta-file meta.csv --out dist/index.html
# (o sandbox do agente NÃO alcança docs.google.com; use CSVs locais para testar.
#  O runner do GitHub Actions tem internet e busca os CSVs ao vivo.)
```

## Especificação funcional (resumo)

Três **páginas separadas** (sidebar):
1. **Visão Geral de Leads** — funil vertical (Gasto → Impressões → Cliques → Leads →
   MQLs → Vendas/Faturamento) + KPIs secundários; gráfico combinado diário +
   tabela diária com heatmap (todos os leads); barras por origem/faixa/plataforma/profissão.
2. **Captura mídia paga** — funil em etapas; combinado diário; barras por utm_content;
   tabela diária com heatmap (só mídia paga); 3 tabelas hierárquicas Campanha →
   Conjunto → Anúncio, cada uma com gráfico de linha embaixo.
3. **Relatório** — espelha a Visão Geral + painel de Metas editável + Top/Piores
   Anúncios (17 colunas + Status) + Insights de Tráfego. Ver `build/GUIA-RELATORIOS.md`.

**Ordem das colunas nas tabelas:** `Data · Dia · Gasto · CPM · CTR · ConvForm · Leads ·
CPL · Tx‑MQL · MQLs · CPMQL · ConvMQL · Vendas · CAC · Fat. · Receita · ROAS`. Nas
tabelas diárias entram também **Checkouts** e **VisCHK** (da coluna "Adds to Cart"
do Meta Ads, proxy de Checkout). Sem essas colunas, ficam "-".

**Regras obrigatórias das tabelas** (ver `GUIA-REPLICACAO.md`): cabeçalho sticky;
ordenação tri‑state; colunas redimensionáveis (persist localStorage); linha
"Total Geral" fixa; dimensão nunca truncada; seleção com toggle + Ctrl multi;
filtro cruzado bidirecional; tabela diária com último dia no topo; heatmap de cor
fixa por métrica.

## Lacunas de dados conhecidas
- **Visitas ao perfil e Seguidores por criativo** → a planilha de controle conta
  por dia; só existiriam com um export do Meta no nível de anúncio.
- **Junho e julho** → a planilha de controle começa em 07/08, então esses meses
  têm mídia mas não têm visitas nem seguidores.
- **Agosto: gerenciador × controle divergem** em 13 dias (07/08 a 20/08). A
  dashboard usa sempre o gerenciador; o build loga a diferença.

## Publicação — problemas conhecidos
1. **Push:** se a integração GitHub da sessão for somente‑leitura (403), o caminho
   é `git push` direto para `github.com` com o **PAT do usuário**. Nunca gravar o
   token no `.git/config` (usar URL efêmera `https://x-access-token:<TOKEN>@github.com/...`).
2. **cron-job.org só funciona na `main`:** `workflow_dispatch` só existe na branch
   padrão. Levar `build/` + `.github/workflows/deploy.yml` para a `main`.
3. **Pages liga sozinho:** `actions/configure-pages@v5` com `enablement: true`
   (precisa `permissions: pages: write, id-token: write`).
4. **Proxy do sandbox:** o ambiente do agente costuma NÃO alcançar `docs.google.com`,
   `*.github.io` nem a API REST de Actions/Pages — mas o runner do Actions alcança tudo.
5. **Token exposto:** se um token foi colado no chat, **revogar e gerar um novo**.

## Branch / git
- Desenvolvimento na branch designada da sessão; manter sincronizada com `main`.
