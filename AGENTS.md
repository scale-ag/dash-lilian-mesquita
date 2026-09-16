# AGENTS.md — Dashboard de Distribuição de Conteúdo · Lilian Mesquita

> Contexto completo em **`CLAUDE.md`** (mesma pasta) — leia-o antes de mexer no
> projeto. Este arquivo é um resumo para agentes/ferramentas que seguem a
> convenção `AGENTS.md`.

## O que este projeto é

App de BI estático (HTML/CSS/JS puro + Chart.js via CDN) publicado no GitHub
Pages em **https://scale-ag.github.io/dash-lilian-mesquita/**, reconstruído a
cada ~30 min por GitHub Actions. Somente leitura das planilhas.

Funil: `Gasto → Impressões → Cliques no link → Visitas no Perfil →
Seguidores`. **Não há lead, MQL, venda, faturamento nem ROAS** — se você
encontrar esses termos em algum texto, é resíduo do template de onde este repo
nasceu e deve ser corrigido.

## As 6 regras que mais quebram este projeto

1. **Duas planilhas, papéis distintos.** A *Extração Dashboard* (Planilha 1) é a
   fonte de verdade de gasto/impressões/cliques e a única com quebra por
   campanha/conjunto/anúncio. A *Controle de tráfego* (Planilha 2) entra só com
   Visitas ao perfil e Seguidores. Nunca busque investimento na 2 nem visita na 1.
2. **Visitas e Seguidores existem só por DIA.** A Planilha 2 não quebra por
   criativo. Em qualquer recorte por estrutura essas etapas voltam `null` —
   atribuí-las a um anúncio seria invenção. Por anúncio, o resultado mais
   profundo é o **clique**.
3. **Custos das duas últimas etapas usam só os dias com contagem.** A Planilha 2
   começa em 07/08; a mídia roda desde 03/06. Dividir o gasto do período inteiro
   pelas visitas de agosto/setembro dava R$ 1,05 por visita em vez de R$ 0,32.
4. **A Planilha 2 é editada à mão e já mudou de layout.** A leitura é posicional
   (`COL_CTRL_*` em `build.py`); `valida_layout_controle()` confere a aritmética
   de cada bloco e avisa no log se as colunas saírem do lugar.
5. **A aba `📈 Set` não é lida** — é resíduo do template e conflita com a
   `📈 Setembro`.
6. **Nunca some alcance.** A Planilha 1 tem uma coluna de alcance, mas alcance é
   deduplicado (o Meta conta pessoas) e as linhas são por anúncio × dia — somar
   não devolve alcance, nem entre dias nem entre anúncios. A soma de agosto/2026
   dava 29.833 contra 22.333 reais, e a frequência derivada caía de 1,53 para
   1,06. A coluna não é lida; se alguém pedir a métrica de volta, ela precisa vir
   já deduplicada pelo Meta, de uma nova fonte.

> **A dashboard só é tão completa quanto a Planilha 1.** Em agosto/2026 a
> extração tinha R$ 770,42 / 31.611 impressões contra R$ 819,23 / 34.170 no
> gerenciador. O build loga os totais por mês e as linhas descartadas por data
> inválida, e o bloco "Conferência da extração" (aba de mídia paga) mostra isso
> na página — antes de suspeitar do cálculo, confira a extração.

## Onde mexer

| Quero mudar | Arquivo |
|---|---|
| Planilha, aba, posição de coluna, imposto, metas default | `build/build.py` (constantes do topo) |
| Métricas, funil, KPIs, tabelas, gráficos, filtro cruzado | `build/app.js` |
| Só cores | `build/identidade-visual.css` |
| Layout/componentes | `build/estilos.css` |
| Título, logo, estrutura das 3 páginas | `build/template.html` |
| Números que alimentam os Insights | `build/coletar_dados_relatorio.py` + `build/relatorio_lib.py` |
| Como os Insights são redigidos | `build/GUIA-RELATORIOS.md` + `build/GUIA-INTERPRETACAO-METRICAS.md` |

`render()` em `build.py` costura `template.html` + `identidade-visual.css` +
`estilos.css` + `app.js` nos placeholders `__STYLES__`/`__APP_JS__`. O
`build.py` **não agrega**: exporta as linhas cruas (`media[]`/`seg[]`) e toda a
lógica roda no navegador.

## Testar

```bash
python build/build.py --media-file midia.csv \
  --seg-file ago.csv --seg-file setembro.csv --out dist/index.html
```

O sandbox de agente não alcança `docs.google.com` (o proxy nega o CONNECT) nem o
CDN do Chart.js — use CSVs locais, e para validar a página num navegador
substitua o Chart.js por um stub. O runner do GitHub Actions alcança tudo.

## Insights de Tráfego (opcional, ainda não ativado)

`build/relatorios.json` e `build/relatorios_dados.json` começam vazios (`{}`) e a
aba Relatório mostra "os insights ainda não foram gerados". Para ativar:
`briefing.yml` já gera os números 1×/dia; falta criar a **Routine do Claude**
(`create_trigger` apontando para este repo) que lê esse JSON + os dois guias e
escreve `relatorios.json` na `main`. Não vem pronta.
