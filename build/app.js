const DATA = JSON.parse(document.getElementById('payload').textContent);
/* Duas fontes, propositalmente separadas (ver build/build.py):
   MEDIA — Planilha 1 "Extração Dashboard": uma linha por dia×campanha×conjunto×
     anúncio, com gasto/impressões/cliques/alcance. É a ÚNICA fonte de gasto e a
     única que tem quebra por anúncio.
   SEG   — Planilha 2 "Controle de tráfego": uma linha por DIA, só com a contagem
     de seguidores. Não tem quebra por campanha/anúncio — seguidor só existe no
     nível do dia, então toda tabela por anúncio mostra "-" nessa coluna. */
const MEDIA = DATA.media, SEG = DATA.seg||[], B = DATA.build;
const TAX = B.tax_factor || 1.0;

/* ---------------- format ---------------- */
const nf0=new Intl.NumberFormat('pt-BR',{maximumFractionDigits:0});
const nf1=new Intl.NumberFormat('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1});
const nf2=new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const brl=v=>(v==null||!isFinite(v))?'-':'R$ '+nf2.format(v);
const pct=v=>(v==null||!isFinite(v))?'-':nf2.format(v*100)+'%';
const intf=v=>(v==null||!isFinite(v))?'-':nf0.format(v);
const numf=v=>(v==null||!isFinite(v))?'-':nf1.format(v);
const dimf=v=>v==null?'-':String(v);
const norm=s=>(s==null?'':String(s)).trim().toLowerCase();
const brdate=d=>{ if(!d) return '-'; const p=d.split('-'); return p[2]+'/'+p[1]+'/'+p[0]; };
const WD=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const weekday=d=>{ const dt=new Date(d+'T00:00:00'); return isNaN(dt)?'':WD[dt.getDay()]; };
const escHtml=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const NA_TAG='<span class="na-tag">sem dado</span>';

/* ---------------- date helpers ---------------- */
function pad(n){return String(n).padStart(2,'0');}
function dstr(dt){return dt.getFullYear()+'-'+pad(dt.getMonth()+1)+'-'+pad(dt.getDate());}
function addDays(s,n){const dt=new Date(s+'T00:00:00');dt.setDate(dt.getDate()+n);return dstr(dt);}
const TODAY = B.today || B.date_max;

/* ---------------- STATE ---------------- */
const STATE = {
  page:'geral', from:null, to:null, preset:'mes', tax:true,
  selDays:new Set(), mSelC:new Set(), mSelA:new Set(), mSelAd:new Set(),
  sort:{}, colw:(()=>{ try{ return JSON.parse(localStorage.getItem('dm_colw')||'{}'); }catch(e){ return {}; } })(),
};
const taxf = ()=> STATE.tax ? TAX : 1;

function dateActive(d){
  if(!d) return false;
  if(STATE.selDays.size) return STATE.selDays.has(d);
  if(STATE.from && d<STATE.from) return false;
  if(STATE.to && d>STATE.to) return false;
  return true;
}
const mediaActive = ()=> MEDIA.filter(m=>dateActive(m.d));
const segActive   = ()=> SEG.filter(s=>dateActive(s.d));

/* Dias do período ativo em que a planilha de controle JÁ tinha registro. Fora
   dessa janela "0 seguidores" não é zero, é ausência de dado — sem isso o CPS
   de junho/julho (antes da planilha existir) apareceria como infinito e o
   funil mostraria "0 seguidores" onde o certo é "sem dado". */
function segCoberto(){
  if(!B.seg_date_min || !B.seg_date_max) return false;
  return segActive().length>0;
}

/* ---------------- aggregation ----------------
   O funil deste cliente é de DISTRIBUIÇÃO DE CONTEÚDO:
     Gasto → Impressões → Alcance → Cliques → Visitas no Perfil → Seguidores
   Não há lead, MQL, venda nem faturamento nesta operação — nenhuma das duas
   planilhas tem essas etapas, então elas não existem na dashboard.

   "Visitas no Perfil" é o objetivo das campanhas (aparece no Campaign Name) e
   também uma métrica real: a planilha de controle passou a trazer as colunas
   "Visitas ao perfil" e "Custo por Visita no Perfil" no bloco Meta — Visitas no
   Perfil do Instagram, com dado desde 01/09. Como Seguidores, ela existe só no
   nível do DIA — não há quebra por campanha ou criativo. */
function derive(a){
  const g=a.sp*taxf();
  // Visitas no Perfil e Seguidores vêm da planilha de controle, que registra por
  // DIA. Onde não há registro (junho/julho, antes de a planilha existir, ou
  // qualquer recorte por campanha/anúncio) o valor é null — "sem dado" — e não
  // zero: zero faria o custo por visita/seguidor explodir para infinito.
  const temVis=a.visOk!==false && a.vis>0;
  const temSeg=a.segOk!==false && a.seg>0;
  const vis=temVis?a.vis:null;
  return {
    gasto:g, impr:a.im, alcance:a.rc, clicks:a.cl,
    cpm:a.im?g/a.im*1000:null,
    freq:a.rc?a.im/a.rc:null,                  // impressões por pessoa alcançada
    ctr:a.im?a.cl/a.im:null,
    cpc:a.cl?g/a.cl:null,
    cpa:a.rc?g/a.rc*1000:null,                 // custo por mil pessoas alcançadas
    // O custo por visita é recalculado sobre o gasto do GERENCIADOR (com
    // imposto), não copiado da coluna da planilha de controle: em agosto os
    // dois investimentos divergem, e a fonte de verdade do gasto é a Planilha 1.
    vis, cpv:(vis?g/vis:null), txVis:(vis&&a.cl?vis/a.cl:null),
    seg:temSeg?a.seg:null,
    cps:temSeg?g/a.seg:null,
    txSeg:(temSeg&&a.cl)?a.seg/a.cl:null,      // cliques que viraram seguidor
  };
}

/* Agregação por dimensão (campanha/conjunto/anúncio/objetivo/público/plataforma).
   Só a mídia entra: seguidores não têm dimensão, então `segOk:false` marca o
   agregado como "sem contagem de seguidor" e derive() devolve null em vez de 0. */
function buildAgg(fM,dim){
  const m={};
  const get=k=>m[k]||(m[k]={sp:0,im:0,cl:0,rc:0,vis:0,visOk:false,seg:0,segOk:false});
  fM.forEach(r=>{const a=get(r[dim]); a.sp+=r.sp; a.im+=r.im; a.cl+=r.cl; a.rc+=r.rc;});
  return m;
}
function totals(fM,fS){
  let sp=0,im=0,cl=0,rc=0; fM.forEach(r=>{sp+=r.sp;im+=r.im;cl+=r.cl;rc+=r.rc;});
  const vis=fS.reduce((s,r)=>s+(r.vis||0),0);
  const seg=fS.reduce((s,r)=>s+(r.seg||0),0);
  return {sp,im,cl,rc,
    vis, visOk:fS.some(r=>r.visOk),
    seg, segOk:fS.some(r=>r.segOk)};
}
/* Série diária: mídia e seguidores casam pela DATA. Dias sem registro na
   planilha de controle ficam com segOk:false (sem dado), não com zero. */
function daily(fM,fS){
  const days={};
  const g=d=>days[d]||(days[d]={d, sp:0,im:0,cl:0,rc:0,vis:0,visOk:false,seg:0,segOk:false});
  fM.forEach(r=>{if(!r.d)return; const a=g(r.d); a.sp+=r.sp; a.im+=r.im; a.cl+=r.cl; a.rc+=r.rc;});
  fS.forEach(r=>{if(!r.d)return; const a=g(r.d);
    a.vis+=r.vis||0; if(r.visOk) a.visOk=true;
    a.seg+=r.seg||0; if(r.segOk) a.segOk=true;});
  return Object.values(days).sort((a,b)=>a.d<b.d?-1:1);
}

/* ---------------- generic interactive table ---------------- */
/* cfg: {id, cols:[{key,label,type,dim?,heat?:'gasto'|'clicks'|'seg'|'alcance'|'ctr',cls?}], rows:[{k,cells:{}, raw?}],
        total:{}, selectable, selSet, onSelect } */
// medição de texto (canvas) p/ auto-largura de coluna — "caiba o nome inteiro" (dim)
// e auto-ajuste em duplo-clique na borda, como Google Sheets / Looker Studio.
let _measureCtx=null;
function textWidth(s, font){
  if(!_measureCtx) _measureCtx=document.createElement('canvas').getContext('2d');
  _measureCtx.font=font;
  return _measureCtx.measureText(s==null?'':String(s)).width;
}
const fmtStd=(t,v)=> t==='brl'?brl(v):t==='pct'?pct(v):t==='int'?intf(v):t==='num'?numf(v):t==='date'?brdate(v):t==='html'?'':dimf(v);
const FONT_DIM='500 12.5px "Segoe UI",system-ui,-apple-system,Roboto,sans-serif';
const FONT_NUM='12.5px "Segoe UI",system-ui,-apple-system,Roboto,sans-serif';
const FONT_HEAD='700 11px "Segoe UI",system-ui,-apple-system,Roboto,sans-serif';
function autoDimWidth(cfg,c){
  let max=textWidth(c.label||'',FONT_HEAD);
  (cfg.rows||[]).forEach(r=>{ const w=textWidth(fmtStd(c.type,r.cells[c.key]),FONT_DIM); if(w>max) max=w; });
  if(cfg.total && cfg.total[c.key]!=null){ const w=textWidth(fmtStd(c.type,cfg.total[c.key]),FONT_DIM); if(w>max) max=w; }
  return Math.max(140, Math.min(640, Math.round(max)+34)); // + padding (10+10) + folga p/ seta de ordenação
}
function autoColWidth(cfg,c){
  if(c.type==='dim') return autoDimWidth(cfg,c);
  let max=textWidth(c.label||'',FONT_HEAD);
  (cfg.rows||[]).forEach(r=>{ const w=textWidth(fmtStd(c.type,r.cells[c.key]),FONT_NUM); if(w>max) max=w; });
  if(cfg.total && cfg.total[c.key]!=null){ const w=textWidth(fmtStd(c.type,cfg.total[c.key]),FONT_NUM); if(w>max) max=w; }
  return Math.max(60, Math.min(260, Math.round(max)+24));
}
function colWidth(cfg,c){ const saved=(STATE.colw[cfg.id]||{})[c.key];
  if(saved) return saved;
  if(c.w) return c.w;
  if(c.type==='date') return 96;
  if(c.type==='dim') return autoDimWidth(cfg,c);   // por padrão, cabe o nome inteiro
  if(c.type==='brl') return 110;   // "R$ 1.487,42" não cabia nos 92px padrão (cortava com "…")
  return 92; }
function renderTable(cfg){
  // tabelas com colunas travadas EM BANDA (band:'l'/'r' — não confundir com o
  // stk:'l1'/'r' do rel-adt, esquema à parte, só 1 coluna de cada lado) usam
  // um motor separado — ver renderSplitTable — porque aqui há VÁRIAS colunas
  // coladas de cada lado, e a soma delas pode superar a largura do card:
  // position:sticky por célula nesse caso gruda as bandas por cima do miolo
  // em vez de ao lado (o miolo fica permanentemente encoberto, sem posição
  // de scroll que o revele). 3 <table> lado a lado, cada uma só do tamanho
  // que precisa, não tem esse problema.
  if(cfg.cols.some(c=>c.band)) return renderSplitTable(cfg);
  const table=document.getElementById(cfg.id); if(!table) return;
  table.classList.toggle('dt-center', !!cfg.center);   // Mar01: dados centralizados
  const fit=!!cfg.fit;                                  // fit: cabe 100% da largura, sem scroll
  table.classList.toggle('dt-fit', fit);
  const sortState=STATE.sort[cfg.id];
  let rows=cfg.rows.slice();
  if(sortState){ const {key,dir}=sortState; const c=cfg.cols.find(x=>x.key===key);
    rows.sort((a,b)=>{ let va=a.cells[key], vb=b.cells[key];
      if(c && c.type==='dim'){ va=norm(va); vb=norm(vb); return dir==='asc'?(va<vb?-1:va>vb?1:0):(va>vb?-1:va<vb?1:0); }
      va=(va==null||!isFinite(va))?-Infinity:va; vb=(vb==null||!isFinite(vb))?-Infinity:vb;
      return dir==='asc'?va-vb:vb-va; }); }
  const ext={};
  cfg.cols.forEach(c=>{ if(c.heat){ const vs=rows.map(r=>r.cells[c.key]).filter(v=>v!=null&&isFinite(v)); ext[c.key]=[Math.min(...vs),Math.max(...vs)]; }});
  // métricas de custo sempre com "R$" (mesmo em tabelas densas/fit) — % nas de taxa, sem símbolo nas demais
  const fmt=(t,v)=> t==='brl'?brl(v):t==='pct'?pct(v):t==='int'?intf(v):t==='num'?numf(v):t==='date'?brdate(v):t==='html'?(v==null?'-':String(v)):dimf(v);
  const widths=fit?[]:cfg.cols.map(c=>colWidth(cfg,c)); const totalW=widths.reduce((a,b)=>a+b,0);
  // modo fit: dimensão/data com largura fixa; colunas numéricas dividem o resto por igual
  const fitW=c=> c.w?c.w+'px' : c.type==='date'?'74px' : c.type==='dim'?(c.big?'210px':'116px') : '';
  const colgroup='<colgroup>'+cfg.cols.map((c,i)=>{
    const w=fit?fitW(c):(widths[i]+'px'); return `<col${w?` style="width:${w}"`:''}>`;
  }).join('')+'</colgroup>';
  const esc=s=>String(s==null?'':s).replace(/"/g,'&quot;');
  const stkCls=c=>c.stk?' stk-'+c.stk:'';
  let thead='<thead><tr>'+cfg.cols.map((c,i)=>{
    const sc = sortState&&sortState.key===c.key ? (sortState.dir==='asc'?'sorted-asc':'sorted-desc') : '';
    return `<th class="${c.type==='dim'?'dim ':''}${sc}${stkCls(c)}" data-k="${c.key}" data-ci="${i}" title="${esc(c.label)}">${c.label}${fit?'':'<span class="rsz"></span>'}</th>`;
  }).join('')+'</tr></thead>';
  // title = valor SEMPRE completo (mesmo em fit, onde a célula pode abreviar/cortar) — passe o mouse p/ ver
  let tbody='<tbody>'+rows.map(r=>{
    const sel = cfg.selectable && cfg.selSet && cfg.selSet.has(r.k);
    const tds=cfg.cols.map(c=>{
      const v=r.cells[c.key]; let bg='';
      if(c.heat && ext[c.key]) bg=`background:${heat(v,ext[c.key][0],ext[c.key][1],c.heat)}`;
      const cls=(c.type==='dim'?'dim':'')+(c.cls&&c.cls(r)?' '+c.cls(r):'')+stkCls(c);
      const ttl=c.type==='html'?'':` title="${esc(fmtStd(c.type,v))}"`;
      return `<td class="${cls}" style="${bg}"${ttl}>${fmt(c.type,v)}</td>`;
    }).join('');
    return `<tr class="${sel?'sel':''}" data-k="${encodeURIComponent(r.k)}">${tds}</tr>`;
  }).join('')+'</tbody>';
  let tfoot='';
  if(cfg.total){ tfoot='<tfoot><tr>'+cfg.cols.map((c,i)=>{
    const v=cfg.total[c.key]; const isFirst=i===0&&v==null;
    return `<td class="${c.type==='dim'?'dim':''}${stkCls(c)}" title="${isFirst?'Total Geral':esc(fmtStd(c.type,v))}">${isFirst?'Total Geral':fmt(c.type,v)}</td>`;
  }).join('')+'</tr></tfoot>'; }
  table.style.width=fit?'100%':totalW+'px';
  table.innerHTML=colgroup+thead+tbody+tfoot;
  const cols=table.querySelector('colgroup').children;
  // sort handlers
  table.querySelectorAll('thead th').forEach(th=>{
    th.addEventListener('click',e=>{ if(e.target.classList.contains('rsz'))return;
      const k=th.dataset.k, cur=STATE.sort[cfg.id];
      if(!cur||cur.key!==k) STATE.sort[cfg.id]={key:k,dir:'asc'};
      else if(cur.dir==='asc') STATE.sort[cfg.id]={key:k,dir:'desc'};
      else delete STATE.sort[cfg.id];
      renderTable(cfg);
    });
  });
  // resize handlers (drag right border) -> resize the <col>, grow the table
  if(!fit) table.querySelectorAll('thead th .rsz').forEach(g=>{
    g.addEventListener('mousedown',e=>{ e.preventDefault(); e.stopPropagation();
      const th=g.parentElement, k=th.dataset.k, ci=+th.dataset.ci, x0=e.clientX;
      const w0=cols[ci].offsetWidth, tw0=table.offsetWidth;
      document.body.style.userSelect='none';
      const mv=ev=>{ const nw=Math.max(60,w0+(ev.clientX-x0)); cols[ci].style.width=nw+'px'; table.style.width=(tw0-w0+nw)+'px';
        STATE.colw[cfg.id]=STATE.colw[cfg.id]||{}; STATE.colw[cfg.id][k]=nw; };
      const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); document.body.style.userSelect=''; localStorage.setItem('dm_colw',JSON.stringify(STATE.colw)); };
      document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
    });
    // duplo-clique na borda = auto-ajustar largura ao conteúdo (como Sheets/Looker)
    g.addEventListener('dblclick',e=>{ e.preventDefault(); e.stopPropagation();
      const th=g.parentElement, k=th.dataset.k, c=cfg.cols.find(x=>x.key===k);
      const nw=autoColWidth(cfg,c);
      STATE.colw[cfg.id]=STATE.colw[cfg.id]||{}; STATE.colw[cfg.id][k]=nw;
      localStorage.setItem('dm_colw',JSON.stringify(STATE.colw));
      renderTable(cfg);
    });
  });
  // row select
  if(cfg.selectable && cfg.onSelect){
    table.querySelectorAll('tbody tr').forEach(tr=>{
      tr.addEventListener('click',e=>{ cfg.onSelect(decodeURIComponent(tr.dataset.k), e); });
    });
  }
  // hook pós-renderização (roda de novo em CADA re-render, inclusive ao ordenar,
  // pra chips/cores customizados nunca sumirem ao clicar num cabeçalho)
  if(cfg.afterRender) cfg.afterRender(table, rows);
}
/* ---------------- tabela "split" (colunas travadas em banda) ----------------
   3 <table> independentes lado a lado (esquerda fixa · meio com scroll
   próprio · direita fixa). Cada seção rola VERTICALMENTE por conta própria
   (max-height igual ao do .tbl-wrap ancestral + overflow-y:auto — ver CSS
   .dt-split-fixed/.dt-split-scroll) e um listener de 'scroll' sincroniza as
   3 (scrollTop) pra se comportarem como uma tabela só. Isso evita as 2
   armadilhas de quando isso era 1 única faixa por posição:
   1) cabeçalho "solto": se só o miolo tem overflow-x:auto, o CSS força
      overflow-y a virar "auto" nele também (canonicalização do spec) —
      mas como o miolo nunca chega a rolar de fato sozinho (cresce até
      caber o conteúdo), ele vira um scroll container que nunca se move,
      e o sticky do thead gruda relativo A ELE, não ao .tbl-wrap que
      realmente rola — daí o cabeçalho "sobe" junto com o resto ao rolar.
   2) banda cobrindo o miolo: position:sticky por célula numa única
      <table> não sobra espaço pro miolo quando (banda esquerda + banda
      direita) > largura do card — o miolo fica permanentemente atrás das
      bandas, sem posição de scroll que o revele.
   Cada seção rolando por si (bounded, overflow-y:auto de verdade) faz o
   sticky nativo funcionar sem ressalva nenhuma, e cada uma só ocupa o
   espaço que ela mesma precisa — cabendo tudo, o flex nem mostra barra de
   rolagem e fica idêntico a uma tabela única. */
function renderSplitTable(cfg){
  const root=document.getElementById(cfg.id); if(!root) return;
  const wrap=root.closest('.tbl-wrap');
  const sortState=STATE.sort[cfg.id];
  let rows=cfg.rows.slice();
  if(sortState){ const {key,dir}=sortState; const c=cfg.cols.find(x=>x.key===key);
    rows.sort((a,b)=>{ let va=a.cells[key], vb=b.cells[key];
      if(c && c.type==='dim'){ va=norm(va); vb=norm(vb); return dir==='asc'?(va<vb?-1:va>vb?1:0):(va>vb?-1:va<vb?1:0); }
      va=(va==null||!isFinite(va))?-Infinity:va; vb=(vb==null||!isFinite(vb))?-Infinity:vb;
      return dir==='asc'?va-vb:vb-va; }); }
  const ext={};
  cfg.cols.forEach(c=>{ if(c.heat){ const vs=rows.map(r=>r.cells[c.key]).filter(v=>v!=null&&isFinite(v)); ext[c.key]=[Math.min(...vs),Math.max(...vs)]; }});
  const fmt=(t,v)=> t==='brl'?brl(v):t==='pct'?pct(v):t==='int'?intf(v):t==='num'?numf(v):t==='date'?brdate(v):t==='html'?(v==null?'-':String(v)):dimf(v);
  const esc=s=>String(s==null?'':s).replace(/"/g,'&quot;');
  const leftCols=cfg.cols.filter(c=>c.band==='l'), rightCols=cfg.cols.filter(c=>c.band==='r'), midCols=cfg.cols.filter(c=>!c.band);
  function section(cols){
    const widths=cols.map(c=>colWidth(cfg,c)); const totalW=widths.reduce((a,b)=>a+b,0);
    const colgroup='<colgroup>'+cols.map((c,i)=>`<col style="width:${widths[i]}px">`).join('')+'</colgroup>';
    const thead='<thead><tr>'+cols.map(c=>{
      const sc = sortState&&sortState.key===c.key ? (sortState.dir==='asc'?'sorted-asc':'sorted-desc') : '';
      return `<th class="${c.type==='dim'?'dim ':''}${sc}" data-k="${c.key}" title="${esc(c.label)}">${c.label}<span class="rsz"></span></th>`;
    }).join('')+'</tr></thead>';
    const tbody='<tbody>'+rows.map(r=>{
      const sel = cfg.selectable && cfg.selSet && cfg.selSet.has(r.k);
      const tds=cols.map(c=>{
        const v=r.cells[c.key]; let bg='';
        if(c.heat && ext[c.key]) bg=`background:${heat(v,ext[c.key][0],ext[c.key][1],c.heat)}`;
        const cls=(c.type==='dim'?'dim':'')+(c.cls&&c.cls(r)?' '+c.cls(r):'');
        const ttl=c.type==='html'?'':` title="${esc(fmtStd(c.type,v))}"`;
        return `<td class="${cls}" style="${bg}"${ttl}>${fmt(c.type,v)}</td>`;
      }).join('');
      return `<tr class="${sel?'sel':''}" data-k="${encodeURIComponent(r.k)}">${tds}</tr>`;
    }).join('')+'</tbody>';
    let tfoot='';
    if(cfg.total){ tfoot='<tfoot><tr>'+cols.map(c=>{
      const v=cfg.total[c.key]; const isFirst=cfg.cols.indexOf(c)===0&&v==null;
      return `<td class="${c.type==='dim'?'dim':''}" title="${isFirst?'Total Geral':esc(fmtStd(c.type,v))}">${isFirst?'Total Geral':fmt(c.type,v)}</td>`;
    }).join('')+'</tr></tfoot>'; }
    return `<table class="dt${cfg.center?' dt-center':''}" style="width:${totalW}px">${colgroup}${thead}${tbody}${tfoot}</table>`;
  }
  // altura de cada seção = a mesma altura máxima do .tbl-wrap ancestral
  // (tbl-normal/tbl-double/inline) — rolam juntas dentro do mesmo limite
  // visual de sempre, sem precisar que o .tbl-wrap role por fora.
  const maxH=wrap?parseFloat(getComputedStyle(wrap).maxHeight):NaN;
  const hStyle=isFinite(maxH)?` style="max-height:${maxH}px"`:'';
  // troca a própria tag por <div> (um <table> não pode ter <div> como filho —
  // o parser HTML descarta; outerHTML recria o nó com a tag certa). Funciona
  // tanto na 1ª renderização (raiz ainda é a <table> do template) quanto nas
  // seguintes (raiz já é a <div class="dt-split"> da renderização anterior).
  root.outerHTML =
    `<div id="${cfg.id}" class="dt-split">`+
      `<div class="dt-split-fixed dt-split-l"${hStyle}>${section(leftCols)}</div>`+
      `<div class="dt-split-scroll"${hStyle}>${section(midCols)}</div>`+
      `<div class="dt-split-fixed dt-split-r"${hStyle}>${section(rightCols)}</div>`+
    `</div>`;
  const fresh=document.getElementById(cfg.id);
  // as 3 seções rolam verticalmente cada uma por conta própria (CSS acima) —
  // sincroniza scrollTop entre elas pra se comportarem como 1 tabela só,
  // não importa sobre qual seção o mouse rolou.
  const secs=[...fresh.querySelectorAll('.dt-split-l, .dt-split-scroll, .dt-split-r')];
  let syncing=false;
  secs.forEach(el=>el.addEventListener('scroll',()=>{
    if(syncing) return; syncing=true;
    secs.forEach(o=>{ if(o!==el) o.scrollTop=el.scrollTop; });
    requestAnimationFrame(()=>{ syncing=false; });
  }));
  // sort: clicar em QUALQUER cabeçalho (das 3 tabelas) reordena as 3 juntas
  fresh.querySelectorAll('thead th').forEach(th=>{
    th.addEventListener('click',e=>{ if(e.target.classList.contains('rsz'))return;
      const k=th.dataset.k, cur=STATE.sort[cfg.id];
      if(!cur||cur.key!==k) STATE.sort[cfg.id]={key:k,dir:'asc'};
      else if(cur.dir==='asc') STATE.sort[cfg.id]={key:k,dir:'desc'};
      else delete STATE.sort[cfg.id];
      renderSplitTable(cfg);
    });
  });
  // resize: cada coluna só afeta a largura da SUA seção (as 3 tabelas são
  // independentes, então redimensionar ao vivo não desalinha nada)
  fresh.querySelectorAll('thead th .rsz').forEach(g=>{
    g.addEventListener('mousedown',e=>{ e.preventDefault(); e.stopPropagation();
      const th=g.parentElement, k=th.dataset.k, x0=e.clientX;
      const sectionTable=th.closest('table'), ths=[...th.parentElement.children];
      const ci=ths.indexOf(th), col=sectionTable.querySelector('colgroup').children[ci];
      const w0=col.offsetWidth, tw0=sectionTable.offsetWidth;
      document.body.style.userSelect='none';
      const mv=ev=>{ const nw=Math.max(60,w0+(ev.clientX-x0)); col.style.width=nw+'px'; sectionTable.style.width=(tw0-w0+nw)+'px';
        STATE.colw[cfg.id]=STATE.colw[cfg.id]||{}; STATE.colw[cfg.id][k]=nw; };
      const up=()=>{ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); document.body.style.userSelect=''; localStorage.setItem('dm_colw',JSON.stringify(STATE.colw)); };
      document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
    });
    g.addEventListener('dblclick',e=>{ e.preventDefault(); e.stopPropagation();
      const th=g.parentElement, k=th.dataset.k, c=cfg.cols.find(x=>x.key===k);
      const nw=autoColWidth(cfg,c);
      STATE.colw[cfg.id]=STATE.colw[cfg.id]||{}; STATE.colw[cfg.id][k]=nw;
      localStorage.setItem('dm_colw',JSON.stringify(STATE.colw));
      renderSplitTable(cfg);
    });
  });
  if(cfg.selectable && cfg.onSelect){
    fresh.querySelectorAll('tbody tr').forEach(tr=>{
      tr.addEventListener('click',e=>{ cfg.onSelect(decodeURIComponent(tr.dataset.k), e); });
    });
  }
  if(cfg.afterRender) cfg.afterRender(fresh, rows);
}

/* Heatmap por coluna: cor FIXA por métrica (definida em identidade-visual.css),
   só a OPACIDADE varia com o valor (maior valor = mais vibrante).
   As variáveis CSS mantêm os nomes do template (gasto/leads/mqls/vendas/roas);
   aqui elas são reaproveitadas para as métricas deste funil, uma cor por
   métrica: Gasto=vermelho · Cliques=azul · Seguidores=ciano · Alcance=verde ·
   CTR=amarelo. */
const HEAT_HUE={gasto:'--heat-gasto', clicks:'--heat-cliques', seg:'--heat-seg',
                alcance:'--heat-alcance', ctr:'--heat-ctr'};
function heat(v,lo,hi,kind){
  if(v==null||!isFinite(v)||hi===lo||!HEAT_HUE[kind]) return 'transparent';
  const t=Math.max(0,Math.min(1,(v-lo)/(hi-lo)));
  const c=hx2rgb(cvar(HEAT_HUE[kind]));
  return `rgba(${c[0]},${c[1]},${c[2]},${(0.06+0.5*t).toFixed(3)})`;
}

function toggleSet(set,key,ctrl,others){
  if(ctrl){ set.has(key)?set.delete(key):set.add(key); }
  else { const only=set.has(key)&&set.size===1; set.clear(); if(!only) set.add(key); }
  if(others) others.forEach(s=>s.clear());
}

/* ---------------- funil ---------------- */
function funnelHTML(steps){ return steps.map(s=>`
    <div class="step ${s[3]?'na':''} ${s[4]||''}"><div class="step-main"><div class="m-label">${s[0]}</div><div class="m-val">${s[1]}</div></div>
    <div class="secs">${s[2].map(x=>`<div><span class="s-label">${x[0]}</span><span class="s-val">${x[1]}</span></div>`).join('')}</div></div>`).join(''); }

/* ---------------- charts ---------------- */
const charts={};
const cvar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hx2rgb=h=>{h=(h||'').replace('#','').trim();if(h.length===3)h=h.split('').map(c=>c+c).join('');const n=parseInt(h||'888888',16);return [(n>>16)&255,(n>>8)&255,n&255];};
const CHART_SERIES=['--cc1','--cc2','--cc3','--cc4','--cc5','--cc6','--cc7','--cc8','--cc9','--cc10'];
const chartPalette=()=>CHART_SERIES.map(v=>cvar(v)||'#888888');
const cmuted=()=>cvar('--muted')||'#6B7280', cink=()=>cvar('--ink')||'#1A1D2E', cgrid=()=>cvar('--grid')||'#EEF0F5';
function destroy(id){ if(charts[id]){ charts[id].destroy(); delete charts[id]; } }

/* Evolução diária: Cliques e Seguidores em barras (volume) · Gasto, CPC e CPS
   em linha no eixo de R$. Seguidores só existem a partir de 07/08 — spanGaps
   deixa a linha de CPS interromper nos dias sem dado em vez de cair a zero. */
function comboChart(id, d){
  destroy(id); const el=document.getElementById(id); if(!el) return;
  const labels=d.map(x=>x.d.slice(5)), mut=cmuted(), gr=cgrid();
  const cCl=cvar('--chart-cliques'), cSeg=cvar('--chart-seg'), cGasto=cvar('--chart-gasto'),
        cCpc=cvar('--chart-cpc')||cink(), cCps=cvar('--chart-cps');
  charts[id]=new Chart(el,{
    data:{labels, datasets:[
      {type:'bar',label:'Cliques',data:d.map(x=>x.cl),backgroundColor:cCl,yAxisID:'y',borderRadius:3,order:3},
      {type:'bar',label:'Seguidores',data:d.map(x=>x.segOk?x.seg:null),backgroundColor:cSeg,yAxisID:'y',borderRadius:3,order:3},
      {type:'line',label:'Gasto',data:d.map(x=>+(x.sp*taxf()).toFixed(2)),borderColor:cGasto,backgroundColor:cGasto,yAxisID:'y1',borderWidth:2,pointRadius:2,tension:.25,order:1},
      {type:'line',label:'CPC',data:d.map(x=>x.cl?+((x.sp*taxf())/x.cl).toFixed(2):null),borderColor:cCpc,backgroundColor:cCpc,yAxisID:'y1',borderWidth:2,pointRadius:2,spanGaps:true,tension:.25,order:0},
      {type:'line',label:'CPS',data:d.map(x=>(x.segOk&&x.seg)?+((x.sp*taxf())/x.seg).toFixed(2):null),borderColor:cCps,backgroundColor:cCps,yAxisID:'y1',borderWidth:2,pointRadius:2,spanGaps:true,tension:.25,order:0},
    ]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{labels:{color:cink(),boxWidth:10,usePointStyle:true,font:{size:11}}},
        tooltip:{callbacks:{label:c=>{const v=c.raw; return c.dataset.label+': '+(c.dataset.yAxisID==='y1'?brl(v):intf(v));}}}},
      scales:{x:{ticks:{color:mut,font:{size:10}},grid:{display:false}},
        y:{position:'left',ticks:{color:mut,font:{size:10}},grid:{color:gr},beginAtZero:true,title:{display:true,text:'Cliques / Seguidores',color:mut,font:{size:10}}},
        y1:{position:'right',ticks:{color:mut,font:{size:10}},grid:{display:false},beginAtZero:true,title:{display:true,text:'R$',color:mut,font:{size:10}}}}}
  });
}

/* Donut de FREQUÊNCIA: quanto das impressões foi para gente nova (alcance) e
   quanto foi repetição para quem já tinha visto. Numa campanha de distribuição
   é o sinal mais direto de saturação do público. */
function donutFreq(id, alcance, impr){
  destroy(id); const el=document.getElementById(id); if(!el) return;
  const repet=Math.max(0,impr-alcance);
  charts[id]=new Chart(el,{type:'doughnut',
    data:{labels:['Alcance (pessoas únicas)','Impressões repetidas'],datasets:[{data:[alcance,repet],
      backgroundColor:[cvar('--good'),cvar('--bad')],borderColor:cvar('--surface'),borderWidth:2}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'68%',
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.label+': '+intf(c.raw)+(impr?' ('+pct(c.raw/impr)+')':'')}}}}});
  const el2=document.getElementById('mFreqVal'); if(el2) el2.textContent=alcance?numf(impr/alcance)+'x':'-';
}

/* CPC por dimensão (campanha/conjunto/anúncio) por dia — 1 linha por membro.
   Legenda é um painel HTML próprio (fora do canvas): a legenda nativa do
   Chart.js trunca nomes longos porque respeita a largura do canvas, e os nomes
   de campanha deste cliente têm 7 campos separados por "|".
   Clique numa linha do gráfico OU da legenda filtra a tabela; quando a tabela
   já tem seleção, o gráfico plota só as linhas selecionadas. */
function cpcByDimChart(id, fM, agg, dim, selSet){
  destroy(id); const el=document.getElementById(id); const legEl=document.getElementById(id+'Legend');
  if(!el) return;
  const days=[...new Set(fM.filter(r=>r.d).map(r=>r.d))].sort();
  // ordena por CPC (melhor primeiro; sem clique/gasto fica no fim) — ordem estável p/ cor e legenda
  const members=[...new Set(fM.map(r=>r[dim]))].sort((a,b)=>{
    const ca=agg[a]?derive(agg[a]).cpc:null, cb=agg[b]?derive(agg[b]).cpc:null;
    if(ca==null&&cb==null) return 0; if(ca==null) return 1; if(cb==null) return -1; return ca-cb;
  });
  const pal=chartPalette(), mut=cmuted();
  const dimChar={'camp':'C','adset':'A','ad':'D'}[dim]||'C';
  const plotMembers = (selSet&&selSet.size) ? members.filter(m=>selSet.has(m)) : members;
  const dsets=plotMembers.map(mv=>{
    const idx=members.indexOf(mv);
    const spDay={}, clDay={}; days.forEach(d=>{spDay[d]=0; clDay[d]=0;});
    fM.forEach(r=>{ if(r[dim]===mv && r.d!=null && spDay[r.d]!=null){ spDay[r.d]+=r.sp; clDay[r.d]+=r.cl; } });
    const data=days.map(d=> clDay[d]>0 ? +((spDay[d]*taxf())/clDay[d]).toFixed(2) : null);
    const col=pal[idx%pal.length];
    return {label:String(mv), data, borderColor:col, backgroundColor:col, borderWidth:2, pointRadius:2, tension:.25, spanGaps:true};
  });
  charts[id]=new Chart(el,{type:'line',
    data:{labels:days.map(d=>d.slice(5)), datasets:dsets},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'nearest',intersect:false},
      onClick:(e,act)=>{ if(act.length){ const idx=act[0].datasetIndex;
        if(idx!=null&&dsets[idx]) selDim(dimChar,dsets[idx].label,false); } },
      plugins:{
        legend:{display:false},
        // array de 2 linhas: o Chart.js nunca trunca texto de tooltip, então o
        // nome completo da campanha cabe mesmo com 7 campos.
        tooltip:{displayColors:true,
          callbacks:{title:()=>'', label:c=>[c.dataset.label, (c.raw==null?'-':brl(c.raw))+' / clique']}}
      },
      scales:{x:{ticks:{color:mut,font:{size:9}},grid:{display:false}},
        y:{ticks:{color:mut,font:{size:9},callback:v=>'R$'+nf2.format(v)},grid:{color:cgrid()},beginAtZero:true}}
    }
  });
  if(legEl){
    legEl.innerHTML = members.map((mv,idx)=>{
      const col=pal[idx%pal.length];
      const cpc = agg[mv]!=null ? derive(agg[mv]).cpc : null;
      const sel = !!(selSet && selSet.has(mv));
      return `<div class="cl-row${sel?' sel':''}" data-mv="${escHtml(mv)}" title="${escHtml(mv)}">`
        +`<span class="cl-swatch" style="background:${col}"></span>`
        +`<span class="cl-name">${escHtml(mv)}</span>`
        +`<span class="cl-val">${brl(cpc)}</span></div>`;
    }).join('');
    legEl.querySelectorAll('.cl-row').forEach(row=>{
      row.addEventListener('click',()=>selDim(dimChar,row.dataset.mv,false));
    });
  }
}

function hbar(id, items, valFn, colorFn, top, unit){
  destroy(id); const el=document.getElementById(id); if(!el) return;
  unit=unit||'cliques';
  let arr=items.slice().sort((a,b)=>valFn(b)-valFn(a)); if(top) arr=arr.slice(0,top);
  const mut=cmuted();
  charts[id]=new Chart(el,{type:'bar', plugins:[barLabels(unit)],
    data:{labels:arr.map(x=>x.label), datasets:[{label:unit,data:arr.map(valFn),backgroundColor:arr.map(colorFn||(()=>cvar('--chart-cliques'))),borderRadius:3}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,layout:{padding:{right:28}},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>unit==='R$'?brl(c.raw):intf(c.raw)+' '+unit}}},
      scales:{x:{beginAtZero:true,ticks:{color:mut,precision:0,font:{size:10}},grid:{color:cgrid()}},
              y:{ticks:{color:mut,font:{size:10}},grid:{display:false}}}}});
}
/* rotulo no topo de cada barra — formata em R$ quando a barra e' de dinheiro */
const barLabels=unit=>({id:'barLabels',afterDatasetsDraw(ch){const{ctx}=ch;ctx.save();ctx.font='600 11px Segoe UI,system-ui';ctx.fillStyle=cmuted();ctx.textBaseline='middle';
  ch.getDatasetMeta(0).data.forEach((el,i)=>{const v=ch.data.datasets[0].data[i]; if(!v)return; ctx.fillText(unit==='R$'?brl(v):intf(v),el.x+5,el.y);});ctx.restore();}});

/* ---------------- KPI cards ---------------- */
function kpiCard(k){ return `<div class="kpi ${k.hero?'hero':''}"><div class="kl"><span>${k.label}</span>${k.pill?`<span class="pill q">${k.pill}</span>`:''}</div><div class="kv">${k.val}</div><div class="ka">${k.aux||''}</div></div>`; }

/* ---------------- PAGE 1: Visão Geral ---------------- */
/* IDs dos elementos por página — a Visão Geral e o Relatório compartilham o
   MESMO corpo (renderGeralCore), só mudam os alvos no DOM. */
const GERAL_IDS={funnel:'geralFunnel',kpis2:'geralKpis2',combo:'gCombo',obj:'gObj',pub:'gPub',plat:'gPlat',ad:'gAd',daily:'gDaily'};
const REL_IDS  ={funnel:'relFunnel', kpis2:'relKpis2', combo:'rCombo',obj:'rObj',pub:'rPub',plat:'rPlat',ad:'rAd',daily:'rDaily'};
function renderGeral(){ renderGeralCore(GERAL_IDS); }

/* Etapas do funil de distribuição, na ordem em que o tráfego caminha. Visitas
   no Perfil e Seguidores vêm da planilha de controle e só existem por DIA:
   fora da janela que ela cobre, e em qualquer recorte por criativo, aparecem
   como "sem dado" em vez de zero. */
function funilSteps(t,dv){
  return [
    ['Gasto Total', brl(dv.gasto), [], false, 'hl-gasto'],
    ['Impressões', intf(t.im), [['CPM',brl(dv.cpm)]]],
    ['Alcance', intf(t.rc), [['Frequência',dv.freq!=null?numf(dv.freq)+'x':'-'],['CPM alcance',brl(dv.cpa)]]],
    ['Cliques no link', intf(t.cl), [['CTR',pct(dv.ctr)],['CPC',brl(dv.cpc)]]],
    ['Visitas no Perfil', dv.vis!=null?intf(dv.vis):NA_TAG,
      [['Custo/Visita',dv.cpv!=null?brl(dv.cpv):NA_TAG],['Cliques→Visita',dv.txVis!=null?pct(dv.txVis):NA_TAG]], dv.vis==null],
    ['Seguidores', dv.seg!=null?intf(dv.seg):NA_TAG,
      [['CPS',dv.cps!=null?brl(dv.cps):NA_TAG],['Cliques→Seguidor',dv.txSeg!=null?pct(dv.txSeg):NA_TAG]], dv.seg==null, 'hl-seg'],
  ];
}

function renderGeralCore(ids){
  const fM=mediaActive(), fS=segActive();
  const t=totals(fM,fS), dv=derive(t);
  document.getElementById(ids.funnel).innerHTML=funnelHTML(funilSteps(t,dv));

  // ---- KPIs secundários: não repetem o funil ----
  const dd=daily(fM,fS), nDays=dd.length||1;
  const diasSeg=dd.filter(x=>x.segOk).length;
  const adAgg=buildAgg(fM,'ad');
  let topAd=null, bestAd=null, nAdsAtivos=0;
  Object.entries(adAgg).forEach(([ad,a])=>{
    if(a.sp>0) nAdsAtivos++;
    if(topAd==null||a.cl>topAd.v) topAd={ad,v:a.cl};
    if(a.cl>0){ const c=(a.sp*taxf())/a.cl; if(bestAd==null||c<bestAd.v) bestAd={ad,v:c}; }
  });
  const nCampAtivas=Object.values(buildAgg(fM,'camp')).filter(a=>a.sp>0).length;
  const concTop=(t.cl&&topAd)?topAd.v/t.cl:null;
  // melhor dia de CPS no período (só entre dias que têm contagem de seguidor)
  let bestDia=null;
  dd.forEach(x=>{ if(x.segOk&&x.seg>0){ const c=(x.sp*taxf())/x.seg; if(bestDia==null||c<bestDia.v) bestDia={d:x.d,v:c}; } });
  const adShort=s=>{ s=String(s||'—'); return s.length>22?s.slice(0,21)+'…':s; };
  const k2=[
    {label:'Gasto por dia (média)',val:brl(dv.gasto/nDays),aux:intf(t.cl/nDays)+' cliques/dia'},
    {label:'Seguidores por dia (média)',val:diasSeg?numf(t.seg/diasSeg):'-',aux:diasSeg?diasSeg+' dia(s) com contagem':'sem contagem no período'},
    {label:'Melhor CPS (dia)',val:bestDia?brl(bestDia.v):'-',aux:bestDia?brdate(bestDia.d):'—'},
    {label:'Melhor CPC (anúncio)',val:bestAd?brl(bestAd.v):'-',aux:bestAd?adShort(bestAd.ad):'—'},
    {label:'Top anúncio (cliques)',val:topAd?intf(topAd.v):'-',aux:topAd?adShort(topAd.ad):'—'},
    {label:'Concentração top anúncio',val:pct(concTop),aux:'% dos cliques no melhor anúncio'},
    {label:'Anúncios ativos',val:intf(nAdsAtivos),aux:intf(nCampAtivas)+' campanhas c/ gasto'},
    {label:'Frequência média',val:dv.freq!=null?numf(dv.freq)+'x':'-',aux:intf(t.rc)+' pessoas alcançadas'},
  ];
  document.getElementById(ids.kpis2).innerHTML=k2.map(kpiCard).join('');
  comboChart(ids.combo, dd);

  // ---- Distribuição do investimento (barras horizontais, por gasto) ----
  const barra=(host,dim,cor)=>{
    const agg=buildAgg(fM,dim);
    const arr=Object.entries(agg).map(([label,a])=>({label,v:+(a.sp*taxf()).toFixed(2)}))
      .filter(x=>x.v>0);
    hbar(host, arr, x=>x.v, ()=>cvar(cor), 10, 'R$');
  };
  barra(ids.obj,'obj','--chart-gasto');
  barra(ids.pub,'pub','--chart-cliques');
  barra(ids.plat,'plat','--chart-seg');
  // por anúncio: cliques, não gasto (é a leitura útil de criativo)
  const aggAd=buildAgg(fM,'ad');
  hbar(ids.ad, Object.entries(aggAd).map(([label,a])=>({label,v:a.cl})).filter(x=>x.v>0),
       x=>x.v, ()=>cvar('--chart-cps'), 10, 'cliques');

  // ---- tabela diária: último dia no topo + heatmap ----
  const dl=dd.slice().reverse();
  renderTable({id:ids.daily, cols:DAILY_COLS, center:true, fit:true,
    rows:dl.map(x=>({k:x.d, cells:dailyCells(x,derive(x))})),
    total:dailyCells({...t,d:null},dv,true),
    selectable:true, selSet:STATE.selDays,
    onSelect:(k,e)=>{ toggleSet(STATE.selDays,k,e&&(e.ctrlKey||e.metaKey)); syncDateInputs(); renderAll(); },
  });
}

/* colunas das tabelas diárias (mesma ordem do funil, custo sempre ao lado do
   volume que ele custeia) */
const DAILY_COLS=[
  {key:'date',label:'Data',type:'date'},{key:'wd',label:'Dia',type:'dim',w:70},
  {key:'gasto',label:'Gasto',type:'brl',heat:'gasto'},
  {key:'im',label:'Impr.',type:'int'},{key:'cpm',label:'CPM',type:'brl'},
  {key:'rc',label:'Alcance',type:'int',heat:'alcance'},{key:'freq',label:'Freq.',type:'num'},
  {key:'cl',label:'Cliques',type:'int',heat:'clicks'},{key:'ctr',label:'CTR',type:'pct',heat:'ctr'},{key:'cpc',label:'CPC',type:'brl'},
  {key:'vis',label:'Visitas',type:'int'},{key:'cpv',label:'CPV',type:'brl'},
  {key:'seg',label:'Seguidores',type:'int',heat:'seg'},{key:'cps',label:'CPS',type:'brl'},
  {key:'txSeg',label:'Cl→Seg',type:'pct'},
];
function dailyCells(x,d,isTotal){
  return {date:isTotal?null:x.d, wd:isTotal?'':weekday(x.d),
    gasto:d.gasto, im:x.im, cpm:d.cpm, rc:x.rc, freq:d.freq,
    cl:x.cl, ctr:d.ctr, cpc:d.cpc,
    vis:d.vis, cpv:d.cpv, seg:d.seg, cps:d.cps, txSeg:d.txSeg};
}

/* ---------------- PAGE 3: Relatório ----------------
   Espelha a Visão Geral (renderGeralCore com IDs próprios) e, abaixo,
   acrescenta o painel de Metas, a tabela de Anúncios e os Insights de Tráfego. */
const SAMPLE_MIN_SPEND  = (B.sample_min_spend!=null?B.sample_min_spend:30);
const SAMPLE_MIN_CLICKS = (B.sample_min_clicks!=null?B.sample_min_clicks:30);

/* ---- Metas & parâmetros (painel editável) — ajusta cores/amostra AO VIVO ----
   Defaults vêm do build.py; o gestor edita no painel (persistido em
   localStorage 'dm_metas') e a tabela de anúncios recolore CPC/CPS e reavalia a
   amostra na hora. Meta null = "não definida" (métrica fica sem cor). */
const METAS_DEFAULT = {
  cpc: (B.meta_cpc!=null?B.meta_cpc:null),
  cps: (B.meta_cps!=null?B.meta_cps:null),
  volMin:(B.volume_min_amostral!=null?B.volume_min_amostral:SAMPLE_MIN_CLICKS),
  nDias: (B.n_dias_corte!=null?B.n_dias_corte:5),
};
function loadMetas(){
  let saved={}; try{ saved=JSON.parse(localStorage.getItem('dm_metas')||'{}'); }catch(e){}
  const m={...METAS_DEFAULT};
  ['cpc','cps'].forEach(k=>{ if(saved[k]!=null&&isFinite(saved[k])) m[k]=saved[k]; else if(k in saved && saved[k]===null) m[k]=null; });
  if(saved.volMin!=null&&isFinite(saved.volMin)&&saved.volMin>=1) m.volMin=saved.volMin;
  if(saved.nDias!=null&&isFinite(saved.nDias)&&saved.nDias>=1) m.nDias=saved.nDias;
  return m;
}
const METAS = loadMetas();
function saveMetas(){ try{ localStorage.setItem('dm_metas', JSON.stringify(METAS)); }catch(e){} }
/* código de cor de um CUSTO vs meta (menor=melhor): verde ≤ meta; amarelo até
   meta×1,3 (atenção); vermelho acima (teto). Meta não definida => sem cor. */
function metaColorClass(v, meta){
  if(meta==null||v==null||!isFinite(v)||!isFinite(meta)||meta<=0) return '';
  if(v<=meta) return 'mc-green';
  if(v<=meta*1.3) return 'mc-yellow';
  return 'mc-red';
}

/* ad -> (campanha, conjunto) dominantes por gasto. Um anúncio pode rodar em
   mais de uma campanha/conjunto; fica com a combinação de maior gasto. */
function adStructMap(fM){
  const acc={};
  fM.forEach(r=>{ const byCamp=acc[r.ad]=acc[r.ad]||{};
    const byAdset=byCamp[r.camp]=byCamp[r.camp]||{};
    byAdset[r.adset]=(byAdset[r.adset]||0)+r.sp; });
  const out={};
  Object.entries(acc).forEach(([ad,byCamp])=>{
    let best=null;
    Object.entries(byCamp).forEach(([camp,byAdset])=>{
      Object.entries(byAdset).forEach(([adset,sp])=>{ if(!best||sp>best.sp) best={camp,adset,sp}; });
    });
    out[ad]={camp:best.camp,adset:best.adset};
  });
  return out;
}
/* Amostra relevante para JULGAR um anúncio (senão: "Em observação"). Neste
   funil não há conversão por anúncio — seguidor só existe no nível do dia —
   então a amostra profunda disponível é o CLIQUE. O limiar vem do painel de
   metas (volume mínimo amostral), editável ao vivo. */
function adSampleOk(a){ return a.sp>=SAMPLE_MIN_SPEND && a.cl>=METAS.volMin; }
/* Qualidade pelo resultado mais profundo disponível: clique (com custo) acima
   de só-impressão. Dentro do mesmo nível, mais volume e menor custo = melhor. */
function adQuality(a){
  const d=derive(a);
  if(a.cl>0) return {tier:1, vol:a.cl, cost:d.cpc==null?Infinity:d.cpc};
  return       {tier:0, vol:a.im, cost:d.cpm==null?Infinity:d.cpm};
}
function cmpBest(a,b){ const qa=adQuality(a), qb=adQuality(b);   // <0 => a antes (melhor)
  if(qa.tier!==qb.tier) return qb.tier-qa.tier;
  if(qa.vol!==qb.vol)   return qb.vol-qa.vol;
  return qa.cost-qb.cost; }

const AD_COLS=[
  {key:'ad',label:'Anúncio',type:'dim',big:true,stk:'l1'},{key:'status',label:'Status',type:'dim',w:140},
  {key:'camp',label:'Campanha',type:'dim',big:true},{key:'adset',label:'Conjunto',type:'dim',big:true},
  {key:'gasto',label:'Gasto',type:'brl'},{key:'im',label:'Impr.',type:'int'},
  {key:'cpm',label:'CPM',type:'brl'},{key:'rc',label:'Alcance',type:'int'},{key:'freq',label:'Freq.',type:'num'},
  {key:'cl',label:'Cliques',type:'int'},{key:'ctr',label:'CTR',type:'pct'},{key:'cpc',label:'CPC',type:'brl'},
  {key:'vis',label:'Visitas',type:'int'},{key:'cpv',label:'CPV',type:'brl'},
  {key:'seg',label:'Seguidores',type:'int'},{key:'cps',label:'CPS',type:'brl'},
];
function adRowCells(ad,a,struct){
  const d=derive(a);
  return {ad, camp:struct.camp, adset:struct.adset,
    gasto:d.gasto, im:a.im, cpm:d.cpm, rc:a.rc, freq:d.freq,
    cl:a.cl, ctr:d.ctr, cpc:d.cpc,
    // Visitas no Perfil: sem fonte. Seguidores: existem só por DIA, não por
    // anúncio — a planilha de controle não quebra por criativo, então
    // atribuir seguidor a um anúncio seria invenção. Ficam "-" de propósito.
    vis:null, cpv:null, seg:null, cps:null,
    _cpc:d.cpc, _cps:null, status:null};
}
const statusChip=obs=>obs?'<span class="rel-chip c-yellow">Em observação</span>':'<span class="rel-chip c-green">Avaliável</span>';
function relRenderAdTable(id,list){
  const el=document.getElementById(id); if(!el) return;
  const cols=AD_COLS;
  const rows=list.map(item=>{
    const cells=adRowCells(item.ad,item.a,item.struct);
    cells.status='';  // placeholder textual; o chip real entra via afterRender
    return {k:item.ad, cells, _obs:item.obs, _cpc:cells._cpc, _cps:cells._cps};
  });
  renderTable({
    id, cols, rows, center:true,
    // roda em TODA renderização (inclusive ao ordenar por um cabeçalho) — chip
    // de status e cores de meta nunca somem ao clicar pra ordenar
    afterRender:(table,sortedRows)=>{
      table.querySelectorAll('tbody tr').forEach((tr,idx)=>{
        const item=sortedRows[idx]; if(!item) return;
        const tds=tr.querySelectorAll('td');
        cols.forEach((c,ci)=>{
          if(ci>=tds.length) return;
          const td=tds[ci];
          if(c.key==='status') td.innerHTML=statusChip(item._obs);
          if(c.key==='cpc'){ const mc=metaColorClass(item._cpc,METAS.cpc); if(mc) td.classList.add(mc); }
          if(c.key==='cps'){ const mc=metaColorClass(item._cps,METAS.cps); if(mc) td.classList.add(mc); }
        });
      });
    }
  });
}

/* Tabela de anúncios: mostra TODOS os anúncios com gasto (campeões com amostra
   relevante primeiro, depois por qualidade). Só quem tem amostra relevante
   recebe "Avaliável"; o resto fica "Em observação" — o pill do título diz
   quantos são campeões DE quantos, pra não sugerir que toda linha é vencedora. */
function renderRelAds(){
  const fM=mediaActive();
  const struct=adStructMap(fM);
  const agg=buildAgg(fM,'ad');
  const pool=Object.entries(agg).filter(([ad,a])=>a.sp>0)
    .map(([ad,a])=>({ad, a, struct:struct[ad]||{camp:'—',adset:'—'}}));

  const all=pool.slice().sort((x,y)=>{ const sx=adSampleOk(x.a), sy=adSampleOk(y.a);
    if(sx!==sy) return sx?-1:1; return cmpBest(x.a,y.a); })
    .map(it=>({...it, obs:!adSampleOk(it.a)}));
  const champs=all.filter(it=>!it.obs).length;

  relRenderAdTable('relTop',all);
  document.getElementById('relTopCount').textContent =
    champs+' '+(champs===1?'campeão':'campeões')+' de '+all.length+' anúncio'+(all.length===1?'':'s')+' com gasto';
}

/* nota de referência do painel de metas (mostra as metas ativas + legenda de cor) */
function renderMetasNote(){
  const el=document.getElementById('relMetasNote'); if(!el) return;
  const cpc=METAS.cpc==null?'<b>não definida</b>':('<b>'+brl(METAS.cpc)+'</b>');
  const cps=METAS.cps==null?'<b>não definida</b>':('<b>'+brl(METAS.cps)+'</b>');
  const semMeta=(METAS.cpc==null||METAS.cps==null);
  el.innerHTML=`Referência ativa — Meta CPC: ${cpc} · Meta CPS: ${cps} · Amostra mínima: <b>${intf(METAS.volMin)} cliques</b> · Corte após <b>${intf(METAS.nDias)} dias</b> acima do teto. `
    +(semMeta?'Preencha as metas para colorir CPC/CPS na tabela de anúncios. ':'')
    +'A coluna CPS fica “-” por anúncio: a planilha de controle conta seguidor por <b>dia</b>, não por criativo. '
    +'Código de cor: <span class="mc-lg mc-green">verde ≤ meta</span> <span class="mc-lg mc-yellow">amarelo até +30%</span> <span class="mc-lg mc-red">vermelho acima</span>.';
}
function syncMetasInputs(){
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.value=(v==null?'':v); };
  set('metaCpc',METAS.cpc); set('metaCps',METAS.cps); set('metaVolMin',METAS.volMin); set('metaNdias',METAS.nDias);
  renderMetasNote();
}

function renderRelatorio(){
  renderGeralCore(REL_IDS);   // espelho da Visão Geral (funil, KPIs, gráficos, tabela diária)

  const pr=PRESETS.find(p=>p[0]===STATE.preset);
  document.getElementById('relPeriodName').textContent = STATE.selDays.size?'Dias selecionados':(pr?pr[1]:'Personalizado');
  let rangeTxt='';
  if(STATE.from&&STATE.to){ const nD=Math.round((new Date(STATE.to+'T00:00:00')-new Date(STATE.from+'T00:00:00'))/86400000)+1;
    rangeTxt=`${brdate(STATE.from)} a ${brdate(STATE.to)}`+(nD>0?` · ${nD} dia${nD>1?'s':''}`:''); }
  document.getElementById('relPeriodRange').textContent=rangeTxt;

  renderMetasNote();
  renderRelAds();
  renderRelBrief();
}

function relBriefKey(){ if(STATE.selDays.size) return null; return STATE.preset||null; }

/* Nota de saúde do funil: cor por faixa (mesmas faixas de build/relatorio_lib.py::_classificacao) */
function healthClass(nota){
  if(nota==null) return 'rh-none';
  if(nota>=8) return 'rh-excelente';
  if(nota>=6.5) return 'rh-saudavel';
  if(nota>=5) return 'rh-atencao';
  if(nota>=3) return 'rh-critico';
  return 'rh-critico-grave';
}

function renderHealthBadge(ns){
  if(!ns) return '';
  const cls=healthClass(ns.nota);
  const notaTxt = ns.nota==null ? '—/10' : nf1.format(ns.nota)+'/10';
  const prov = ns.provisoria ? '<span class="rh-prov">Nota provisória</span>' : '';
  const motivo = ns.motivo ? `<p class="rh-motivo">${ns.motivo}</p>` : '';
  const subnotas = ns.subnotas ? Object.entries(ns.subnotas)
    .map(([k,v])=>`<span class="rh-sub">${k.replace(/_/g,' ')}: ${v==null?'—':nf1.format(v)}</span>`).join('') : '';
  return `<div class="rel-health ${cls}">
    <div class="rh-top"><span class="rh-nota">${notaTxt}</span><span class="rh-classe">${ns.classificacao||''}</span>${prov}</div>
    ${motivo}
    <div class="rh-subs">${subnotas}</div>
  </div>`;
}

function renderWhatsappBlock(texto){
  if(!texto) return '';
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<div class="rel-wa">
    <div class="rel-wa-head"><b>Bloco para copiar (WhatsApp)</b>
      <button type="button" class="rel-wa-copy" onclick="copyWhatsappBlock(this)">Copiar</button>
    </div>
    <pre class="rel-wa-box" id="relWaText">${esc(texto)}</pre>
  </div>`;
}

function copyWhatsappBlock(btn){
  const el=document.getElementById('relWaText'); if(!el) return;
  const text=el.textContent;
  const done=()=>{ const old=btn.textContent; btn.textContent='Copiado!'; setTimeout(()=>{btn.textContent=old;},1500); };
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done).catch(()=>fallbackCopy(text,done)); }
  else fallbackCopy(text,done);
}
function fallbackCopy(text,done){
  const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); done(); }catch(e){}
  document.body.removeChild(ta);
}

const QUAD_TITLES={
  quadro1_resumo:'1 · Resumo executivo e saúde do funil',
  quadro2_diagnostico:'2 · Diagnóstico do funil',
  quadro3_campeoes:'3 · Campanhas, estruturas e anúncios campeões',
  quadro4_acoes:'4 · Ações priorizadas',
};

function renderRelBrief(){
  const wrap=document.getElementById('relBrief'), stampEl=document.getElementById('relBriefStamp');
  const bf=DATA.briefings||{}, per=bf.periodos||{}, key=relBriefKey();
  stampEl.textContent = bf.generated_at ? `Insights gerados por IA · última atualização ${bf.generated_at} · atualiza 1×/dia (23h59 BRT)` : '';
  if(!Object.keys(per).length){
    wrap.innerHTML='<div class="rel-brief-empty">Os insights por IA ainda não foram gerados. São atualizados automaticamente 1×/dia.</div>'; return; }
  if(!key || !per[key]){
    wrap.innerHTML='<div class="rel-brief-empty">Insights disponíveis para os períodos predefinidos (Hoje, Ontem, 3, 7, 14, 30 dias, Este mês, Mês passado, Todo período). Selecione um desses no seletor de período.</div>'; return; }
  const item=per[key];

  // Schema novo (4 quadrantes + nota de saúde + bloco WhatsApp)
  const temQuadrantes = item.quadro1_resumo || item.quadro2_diagnostico || item.quadro3_campeoes || item.quadro4_acoes;
  if(temQuadrantes){
    const quads = Object.keys(QUAD_TITLES).map(k=>
      `<div class="rel-quad-card"><h4>${QUAD_TITLES[k]}</h4><div class="rel-quad-body rel-brief">${item[k]||'<p>—</p>'}</div></div>`
    ).join('');
    wrap.innerHTML = renderHealthBadge(item.nota_saude) + renderWhatsappBlock(item.whatsapp) +
      `<div class="rel-quad-grid">${quads}</div>`;
    return;
  }

  // Fallback: schema antigo (bloco único de html/texto), enquanto a última
  // geração real ainda não tiver rodado no novo formato.
  wrap.innerHTML = item.html || item.texto || '<div class="rel-brief-empty">Sem conteúdo.</div>';
}

/* ---------------- PAGE 2: Captura mídia paga ---------------- */
/* Filtro cruzado: cada tabela é montada com o escopo que EXCLUI a própria
   dimensão, então as linhas irmãs continuam visíveis para multi-seleção. */
function metaScope(ex){ let fM=mediaActive(), fS=segActive();
  if(ex!=='C'&&STATE.mSelC.size) fM=fM.filter(r=>STATE.mSelC.has(r.camp));
  if(ex!=='A'&&STATE.mSelA.size) fM=fM.filter(r=>STATE.mSelA.has(r.adset));
  if(ex!=='D'&&STATE.mSelAd.size) fM=fM.filter(r=>STATE.mSelAd.has(r.ad));
  // Seguidores são por DIA e não têm dimensão de campanha/anúncio: filtrar por
  // criativo deixaria de fazer sentido, então a contagem só acompanha o
  // recorte de DATA. Com qualquer filtro de dimensão ativo ela sai de cena
  // (segOk falso) em vez de sugerir que aquele anúncio trouxe os seguidores.
  const temDim=STATE.mSelC.size||STATE.mSelA.size||STATE.mSelAd.size;
  return {fM, fS: temDim?[]:fS};
}
/* seleção múltipla: Ctrl adiciona (OR) sem sumir as demais linhas; clique
   simples troca a âncora */
function selDim(dim,key,ctrl){
  const sets={C:STATE.mSelC,A:STATE.mSelA,D:STATE.mSelAd}, s=sets[dim];
  if(ctrl){ s.has(key)?s.delete(key):s.add(key); }
  else { const sole=s.has(key)&&s.size===1&&!Object.entries(sets).some(([k2,x])=>k2!==dim&&x.size);
    Object.values(sets).forEach(x=>x.clear()); if(!sole) s.add(key); }
  renderMeta();
}
function renderMeta(){
  const F=metaScope(null), fM=F.fM, fS=F.fS;
  const t=totals(fM,fS), dv=derive(t);
  document.getElementById('metaFunnel').innerHTML=funnelHTML(funilSteps(t,dv));

  comboChart('mCombo', daily(fM,fS));
  // cliques por anúncio (top 10)
  const clByAd={}; fM.forEach(r=>{ clByAd[r.ad]=(clByAd[r.ad]||0)+r.cl; });
  hbar('mClAd', Object.entries(clByAd).map(([label,v])=>({label,v})).filter(x=>x.v>0),
       x=>x.v, ()=>cvar('--chart-seg'), 10, 'cliques');
  // frequência: quanto das impressões foi para gente nova
  donutFreq('mFreqDonut', t.rc, t.im);
  // Compilado dos anúncios: menor CPC no topo
  const adAggM=buildAgg(fM,'ad');
  const topRows=Object.entries(adAggM).map(([ad,a])=>{const d=derive(a);
      return {k:ad, cells:{dim:ad,cl:a.cl,cpc:d.cpc,im:a.im,ctr:d.ctr,cpm:d.cpm},
              _ord:(d.cpc!=null?d.cpc:Infinity)};})
    .sort((a,b)=>a._ord-b._ord).slice(0,10);
  renderTable({id:'mTopCpc', center:true,
    cols:[{key:'dim',label:'Anúncios',type:'dim',big:true},{key:'cl',label:'Cliques',type:'int'},
      {key:'cpc',label:'CPC',type:'brl'},{key:'im',label:'Impr.',type:'int'},
      {key:'ctr',label:'CTR',type:'pct'},{key:'cpm',label:'CPM',type:'brl'}],
    rows:topRows});

  const dl=daily(fM,fS).slice().reverse();
  renderTable({id:'tDaily', cols:DAILY_COLS, center:true, fit:true,
    rows:dl.map(x=>({k:x.d, cells:dailyCells(x,derive(x))})),
    total:dailyCells({...t,d:null},dv,true),
    selectable:true, selSet:STATE.selDays,
    onSelect:(k,e)=>{ toggleSet(STATE.selDays,k,e&&(e.ctrlKey||e.metaKey)); syncDateInputs(); renderAll(); },
  });

  // hierarquia — band:'l' (dim+Gasto) fica grudado na borda esquerda; as demais
  // colunas rolam horizontalmente juntas. Sem colunas de seguidor: a contagem
  // não existe por campanha/conjunto/anúncio.
  const hcols=[
    {key:'dim',label:'',type:'dim',big:true,band:'l'},{key:'gasto',label:'Gasto',type:'brl',band:'l'},
    {key:'im',label:'Impr.',type:'int'},{key:'cpm',label:'CPM',type:'brl'},
    {key:'rc',label:'Alcance',type:'int'},{key:'freq',label:'Freq.',type:'num'},
    {key:'cl',label:'Cliques',type:'int'},{key:'ctr',label:'CTR',type:'pct'},{key:'cpc',label:'CPC',type:'brl'},
    {key:'vis',label:'Visitas',type:'int'},{key:'cpv',label:'CPV',type:'brl'},
  ];
  function hierRows(map){ return Object.entries(map).map(([k,a])=>{const d=derive(a);
    return {k, cells:{dim:k,gasto:d.gasto,im:a.im,cpm:d.cpm,rc:a.rc,freq:d.freq,
      cl:a.cl,ctr:d.ctr,cpc:d.cpc,vis:d.vis,cpv:d.cpv}};}); }
  function totRowOf(tt){const d=derive(tt);return{dim:null,gasto:d.gasto,im:tt.im,cpm:d.cpm,rc:tt.rc,freq:d.freq,
    cl:tt.cl,ctr:d.ctr,cpc:d.cpc,vis:d.vis,cpv:d.cpv};}
  const Sc=metaScope('C'), Sa=metaScope('A'), Sd=metaScope('D');
  const aggC=buildAgg(Sc.fM,'camp'), aggA=buildAgg(Sa.fM,'adset'), aggD=buildAgg(Sd.fM,'ad');
  renderTable({id:'tCamp', cols:hcols.map((c,i)=>i===0?{...c,label:'Campanha'}:c), rows:hierRows(aggC), total:totRowOf(totals(Sc.fM,Sc.fS)),
    selectable:true, selSet:STATE.mSelC, onSelect:(k,e)=>selDim('C',k,e&&(e.ctrlKey||e.metaKey))});
  renderTable({id:'tAdset', cols:hcols.map((c,i)=>i===0?{...c,label:'Conjunto',big:true}:c), rows:hierRows(aggA), total:totRowOf(totals(Sa.fM,Sa.fS)),
    selectable:true, selSet:STATE.mSelA, onSelect:(k,e)=>selDim('A',k,e&&(e.ctrlKey||e.metaKey))});
  renderTable({id:'tAd', cols:hcols.map((c,i)=>i===0?{...c,label:'Anúncio'}:c), rows:hierRows(aggD), total:totRowOf(totals(Sd.fM,Sd.fS)),
    selectable:true, selSet:STATE.mSelAd, onSelect:(k,e)=>selDim('D',k,e&&(e.ctrlKey||e.metaKey))});

  cpcByDimChart('chCamp', Sc.fM, aggC, 'camp', STATE.mSelC);
  cpcByDimChart('chAdset', Sa.fM, aggA, 'adset', STATE.mSelA);
  cpcByDimChart('chAd', Sd.fM, aggD, 'ad', STATE.mSelAd);

  // Seguidores por dia — a única granularidade em que a métrica existe.
  // Fica no fim da página como o "detalhe" da etapa final do funil.
  const segDias=daily(mediaActive(),segActive()).filter(x=>x.segOk).slice().reverse();
  document.getElementById('segCount').textContent=
    intf(segDias.reduce((s,x)=>s+x.seg,0))+' seguidores em '+segDias.length+' dia(s)';
  renderTable({id:'tSeg', center:true,
    cols:[{key:'d',label:'Data',type:'date'},{key:'wd',label:'Dia',type:'dim',w:70},
      {key:'gasto',label:'Gasto do dia',type:'brl'},{key:'cl',label:'Cliques',type:'int'},
      {key:'seg',label:'Seguidores',type:'int',heat:'seg'},{key:'cps',label:'CPS',type:'brl'},
      {key:'txSeg',label:'Cl→Seg',type:'pct'}],
    rows:segDias.map(x=>{const d=derive(x);
      return {k:x.d, cells:{d:x.d,wd:weekday(x.d),gasto:d.gasto,cl:x.cl,seg:x.seg,cps:d.cps,txSeg:d.txSeg}};})});
}

/* ---------------- date presets ---------------- */
const PRESETS=[
  ['hoje','Hoje',()=>[TODAY,TODAY]],
  ['ontem','Ontem',()=>[addDays(TODAY,-1),addDays(TODAY,-1)]],
  ['3d','3 dias',()=>[addDays(TODAY,-2),TODAY]],
  ['7d','7 dias',()=>[addDays(TODAY,-6),TODAY]],
  ['14d','14 dias',()=>[addDays(TODAY,-13),TODAY]],
  ['30d','30 dias',()=>[addDays(TODAY,-29),TODAY]],
  ['mes','Este mês',()=>{const [y,m]=TODAY.split('-');return [`${y}-${m}-01`,TODAY];}],
  ['mespass','Mês passado',()=>{const dt=new Date(TODAY+'T00:00:00');const f=new Date(dt.getFullYear(),dt.getMonth()-1,1);const l=new Date(dt.getFullYear(),dt.getMonth(),0);return [dstr(f),dstr(l)];}],
  ['todo','Todo período',()=>[B.date_min,B.date_max]],
];
/* rótulo do botão de período — mostra o intervalo aplicado dentro do próprio botão */
function syncDateInputs(){
  const el=document.getElementById('periodBtnLabel'); if(!el) return;
  if(STATE.selDays.size){ el.textContent=STATE.selDays.size+(STATE.selDays.size>1?' dias selecionados':' dia selecionado'); return; }
  const pr=PRESETS.find(p=>p[0]===STATE.preset);
  if(STATE.from&&STATE.to) el.textContent=brdate(STATE.from)+' – '+brdate(STATE.to)+(pr?' · '+pr[1]:'');
  else el.textContent='Selecionar período';
}
function applyPreset(id){ const p=PRESETS.find(x=>x[0]===id); if(!p)return; const [f,t]=p[2]();
  STATE.from=f; STATE.to=t; STATE.preset=id; STATE.selDays.clear(); ppClose(); syncDateInputs(); renderAll(); }

/* ---- popover do seletor de período (estilo Data Studio) ---- */
const MONTHS_PT=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const DOW_PT=['D','S','T','Q','Q','S','S'];
const PP={from:null,to:null,preset:'',fromView:'',toView:''};
function ymView(ds){ return (ds||TODAY).slice(0,7); }
function shiftView(view,delta){ const [y,m]=view.split('-').map(Number); const dt=new Date(y,m-1+delta,1); return dt.getFullYear()+'-'+pad(dt.getMonth()+1); }
function ppIsOpen(){ const pop=document.getElementById('periodPop'); return pop && !pop.hidden; }
function ppOpen(){
  PP.from=STATE.from; PP.to=STATE.to; PP.preset=STATE.selDays.size?'':STATE.preset;
  PP.fromView=ymView(STATE.from); PP.toView=ymView(STATE.to);
  document.getElementById('periodPop').hidden=false;
  document.getElementById('periodBtn').setAttribute('aria-expanded','true');
  ppRenderAll();
}
function ppClose(){ const pop=document.getElementById('periodPop'); if(pop) pop.hidden=true;
  const b=document.getElementById('periodBtn'); if(b) b.setAttribute('aria-expanded','false'); }
function ppRenderAll(){ ppRenderPresets(); ppRenderCal('from'); ppRenderCal('to'); ppRenderRange(); }
function ppRenderPresets(){
  const host=document.getElementById('ppPresets');
  host.innerHTML=PRESETS.map(p=>`<button class="pp-preset ${PP.preset===p[0]?'active':''}" data-p="${p[0]}">${p[1]}</button>`).join('');
  host.querySelectorAll('.pp-preset').forEach(c=>c.addEventListener('click',()=>{
    const p=PRESETS.find(x=>x[0]===c.dataset.p); const [f,t]=p[2]();
    PP.from=f; PP.to=t; PP.preset=p[0]; PP.fromView=ymView(f); PP.toView=ymView(t); ppRenderAll();
  }));
}
function ppRenderCal(side){
  const host=document.getElementById(side==='from'?'ppCalFrom':'ppCalTo');
  const view=side==='from'?PP.fromView:PP.toView;
  const [y,m]=view.split('-').map(Number);
  const startDow=new Date(y,m-1,1).getDay(), dim=new Date(y,m,0).getDate();
  let cells='';
  for(let i=0;i<startDow;i++) cells+='<span class="pp-day empty"></span>';
  for(let d=1;d<=dim;d++){
    const ds=view+'-'+pad(d);
    const inR=PP.from&&PP.to&&ds>=PP.from&&ds<=PP.to, isEdge=(ds===PP.from||ds===PP.to);
    const cls=['pp-day']; if(inR) cls.push('in'); if(ds===PP.from) cls.push('edge-l'); if(ds===PP.to) cls.push('edge-r'); if(isEdge) cls.push('sel');
    cells+=`<button class="${cls.join(' ')}" data-side="${side}" data-d="${ds}">${d}</button>`;
  }
  host.innerHTML=`<div class="pp-cal-head"><span class="pp-cal-title">${side==='from'?'Data de início':'Data de término'}</span></div>
    <div class="pp-cal-nav"><button class="pp-nav" data-nav="-1">‹</button><span class="pp-cal-month">${MONTHS_PT[m-1]} ${y}</span><button class="pp-nav" data-nav="1">›</button></div>
    <div class="pp-dow">${DOW_PT.map(x=>`<span>${x}</span>`).join('')}</div>
    <div class="pp-grid">${cells}</div>`;
  host.querySelectorAll('.pp-nav').forEach(b=>b.addEventListener('click',()=>{
    const nv=shiftView(view,+b.dataset.nav); if(side==='from') PP.fromView=nv; else PP.toView=nv; ppRenderCal(side);
  }));
  host.querySelectorAll('.pp-day[data-d]').forEach(b=>b.addEventListener('click',()=>ppPickDay(side,b.dataset.d)));
}
function ppPickDay(side,ds){
  PP.preset='';
  if(side==='from'){ PP.from=ds; if(PP.to&&PP.from>PP.to) PP.to=PP.from; }
  else { PP.to=ds; if(PP.from&&PP.to<PP.from) PP.from=PP.to; }
  ppRenderAll();
}
function ppRenderRange(){
  const el=document.getElementById('ppRange');
  if(PP.from&&PP.to){ const n=Math.round((new Date(PP.to+'T00:00:00')-new Date(PP.from+'T00:00:00'))/86400000)+1;
    el.textContent=brdate(PP.from)+' – '+brdate(PP.to)+(n>0?' · '+n+(n>1?' dias':' dia'):''); }
  else el.textContent='Selecione as datas';
}
function ppApply(){
  if(!PP.from||!PP.to){ ppClose(); return; }
  STATE.from=PP.from; STATE.to=PP.to; STATE.preset=PP.preset||''; STATE.selDays.clear();
  ppClose(); syncDateInputs(); renderAll();
}

/* ---------------- navigation & boot ---------------- */
function setPage(p){ STATE.page=p;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.page===p));
  document.getElementById('page-geral').classList.toggle('active',p==='geral');
  document.getElementById('page-meta').classList.toggle('active',p==='meta');
  document.getElementById('page-rel').classList.toggle('active',p==='rel');
  document.getElementById('ptitle').textContent = p==='meta'?'Captura mídia paga':(p==='rel'?'Relatório':'Visão Geral');
  document.getElementById('navToggle').checked=false;
  history.replaceState(null,'', p==='meta'?'#meta':(p==='rel'?'#rel':'#geral'));
  renderAll();
}
function renderAll(){ if(STATE.page==='meta') renderMeta(); else if(STATE.page==='rel') renderRelatorio(); else renderGeral(); }

function applyTheme(){ const t=localStorage.getItem('dm_theme'); if(t==='light') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme','dark'); }
applyTheme();
document.getElementById('themeBtn').addEventListener('click',()=>{ const dark=document.documentElement.getAttribute('data-theme')==='dark'; localStorage.setItem('dm_theme',dark?'light':'dark'); applyTheme(); renderAll(); });

document.querySelectorAll('.nav-item').forEach(n=>n.addEventListener('click',()=>setPage(n.dataset.page)));
document.getElementById('taxToggle').addEventListener('click',function(){ STATE.tax=!STATE.tax; this.classList.toggle('on',STATE.tax); renderAll(); });
/* seletor de período: abre/fecha popover, aplicar/cancelar, fechar ao clicar fora/Esc */
document.getElementById('periodBtn').addEventListener('click',e=>{ e.stopPropagation(); ppIsOpen()?ppClose():ppOpen(); });
document.getElementById('ppApply').addEventListener('click',ppApply);
document.getElementById('ppCancel').addEventListener('click',ppClose);
document.getElementById('periodPop').addEventListener('click',e=>e.stopPropagation());
document.addEventListener('click',()=>{ if(ppIsOpen()) ppClose(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&ppIsOpen()) ppClose(); });
document.getElementById('clearBtn').addEventListener('click',()=>{ STATE.mSelC.clear();STATE.mSelA.clear();STATE.mSelAd.clear();STATE.selDays.clear(); applyPreset('mes'); });
document.getElementById('refreshBtn').addEventListener('click',function(){ this.classList.add('loading'); location.href=location.pathname+'?t='+Date.now()+location.hash; });

/* painel de Metas & parâmetros — edita ao vivo, salva em localStorage e recolore
   as tabelas de anúncio (sem re-renderizar os gráficos) */
(function wireMetas(){
  const num=el=>{ const s=(el&&el.value||'').trim(); if(s==='') return null; const n=parseFloat(s.replace(',','.')); return isFinite(n)?n:null; };
  const onEdit=()=>{
    METAS.cpc=num(document.getElementById('metaCpc'));
    METAS.cps=num(document.getElementById('metaCps'));
    const vm=num(document.getElementById('metaVolMin')); METAS.volMin=(vm!=null&&vm>=1)?Math.round(vm):METAS_DEFAULT.volMin;
    const nd=num(document.getElementById('metaNdias')); METAS.nDias=(nd!=null&&nd>=1)?Math.round(nd):METAS_DEFAULT.nDias;
    saveMetas(); renderMetasNote();
    if(STATE.page==='rel') renderRelAds();   // só as tabelas, sem mexer nos gráficos
  };
  ['metaCpc','metaCps','metaVolMin','metaNdias'].forEach(id=>{ const el=document.getElementById(id); if(el) el.addEventListener('input',onEdit); });
  const rb=document.getElementById('relMetasReset');
  if(rb) rb.addEventListener('click',()=>{ METAS.cpc=METAS_DEFAULT.cpc; METAS.cps=METAS_DEFAULT.cps; METAS.volMin=METAS_DEFAULT.volMin; METAS.nDias=METAS_DEFAULT.nDias;
    try{ localStorage.removeItem('dm_metas'); }catch(e){} syncMetasInputs(); if(STATE.page==='rel') renderRelAds(); });
  syncMetasInputs();
})();

document.getElementById('updated').innerHTML='Última atualização:<br>'+B.generated_at_brt+' (BRT)';
document.getElementById('buildFoot').textContent='build __BUILD_ID__';
document.getElementById('buildFoot2').textContent='· build __BUILD_ID__';

syncDateInputs();
setPage(location.hash==='#meta'?'meta':(location.hash==='#rel'?'rel':'geral'));

/* auto-refresh com cache-bust ~30 min */
setTimeout(()=>{ location.href=location.pathname+'?t='+Date.now()+location.hash; }, 30*60*1000);
