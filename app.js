'use strict';

/* ---------- utilidades ---------- */
const $ = (id) => document.getElementById(id);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (cents) => brl.format(cents / 100);
const CATEGORIAS_INICIAIS = ['Compras pessoais', 'Saúde', 'Alimentação', 'Compras pela internet', 'Despesas fixas', 'Despesas com veículos'];

const CATEGORIAS_ENTRADA = ['Salário', 'Renda extra', 'Investimentos', 'Outras entradas'];

const pad2 = (n) => String(n).padStart(2, '0');
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const mesDe = (iso) => iso.slice(0, 7);
const brData = (iso) => iso.split('-').reverse().join('/');

// "1.234,56" | "12,5" | "12.50" -> centavos (ou null)
function parseValor(txt) {
  let s = String(txt).replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const c = Math.round(parseFloat(s) * 100);
  return c > 0 ? c : null;
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2000);
}

/* ---------- IndexedDB ---------- */
let db;
function abrirDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('financas', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('lancamentos', { keyPath: 'id', autoIncrement: true }).createIndex('data', 'data');
      d.createObjectStore('categorias', { keyPath: 'nome' });
      d.createObjectStore('metas', { keyPath: 'mes' });
      d.createObjectStore('config', { keyPath: 'chave' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
  });
}
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, v) => tx(store, 'readwrite', (s) => s.put(v));
const del = (store, k) => tx(store, 'readwrite', (s) => s.delete(k));
const getOne = (store, k) => tx(store, 'readonly', (s) => s.get(k));

/* ---------- estado ---------- */
let mesAtual = mesDe(hoje());
let lancamentos = [];
let categorias = [];
let metas = [];
let editandoId = null;

async function carregar() {
  [lancamentos, categorias, metas] = await Promise.all([getAll('lancamentos'), getAll('categorias'), getAll('metas')]);
  categorias.sort((a, b) => a.ordem - b.ordem);
}

// meta do mês; se não houver, herda a mais recente de um mês anterior
function metaDoMes(mes) {
  const m = metas.find((x) => x.mes === mes);
  if (m) return { valor: m.valor, herdada: false };
  const ant = metas.filter((x) => x.mes < mes).sort((a, b) => b.mes.localeCompare(a.mes))[0];
  return ant ? { valor: ant.valor, herdada: true } : null;
}

/* ---------- renderização ---------- */
function rotuloMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const t = new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function render() {
  $('month-label').textContent = rotuloMes(mesAtual);
  const doMes = lancamentos
    .filter((l) => mesDe(l.data) === mesAtual)
    .sort((a, b) => b.data.localeCompare(a.data) || b.id - a.id);

  const entradas = doMes.filter((l) => l.tipo === 'entrada').reduce((s, l) => s + l.valor, 0);
  const saidas = doMes.filter((l) => l.tipo === 'saida').reduce((s, l) => s + l.valor, 0);

  // saldo
  const saldo = entradas - saidas;
  $('saldo').textContent = fmt(saldo);
  $('saldo').className = 'saldo ' + (saldo < 0 ? 'neg' : saldo > 0 ? 'pos' : '');
  $('tot-in').textContent = fmt(entradas);
  $('tot-out').textContent = fmt(saidas);

  // meta
  const meta = metaDoMes(mesAtual);
  $('meta-gasto').textContent = fmt(saidas);
  const fill = $('bar-fill');
  if (meta && meta.valor > 0) {
    const pct = saidas / meta.valor;
    fill.style.width = Math.min(pct, 1) * 100 + '%';
    fill.style.background = pct > 1 ? 'var(--bad)' : pct >= 0.8 ? 'var(--warn)' : 'var(--ok)';
    const rest = meta.valor - saidas;
    $('meta-rest-wrap').firstChild.textContent = rest < 0 ? 'Estourou ' : 'Restante ';
    $('meta-rest').textContent = fmt(Math.abs(rest));
    $('meta-rest').style.color = rest < 0 ? 'var(--bad)' : '';
    $('meta-edit').textContent = `Limite ${fmt(meta.valor)} · Editar`;
  } else {
    fill.style.width = '0';
    $('meta-rest-wrap').firstChild.textContent = 'Restante ';
    $('meta-rest').textContent = '—';
    $('meta-rest').style.color = '';
    $('meta-edit').textContent = 'Definir';
  }

  // categorias
  const porCat = {};
  doMes.filter((l) => l.tipo === 'saida').forEach((l) => (porCat[l.categoria] = (porCat[l.categoria] || 0) + l.valor));
  $('cats').replaceChildren(...categorias.filter((c) => tipoCat(c) === 'saida').map((c) => {
    const v = porCat[c.nome] || 0;
    const el = document.createElement('div');
    el.className = 'cat' + (v ? '' : ' zero');
    const s = document.createElement('span'); s.textContent = c.nome;
    const b = document.createElement('b'); b.textContent = fmt(v);
    el.append(s, b);
    return el;
  }));

  // lista
  const soEntradas = tipoSel() === 'entrada';
  const visiveis = soEntradas ? doMes.filter((l) => l.tipo === 'entrada') : doMes;
  $('list-title').textContent = soEntradas ? 'Entradas' : 'Lançamentos';
  $('empty').textContent = soEntradas ? 'Nenhuma entrada neste mês.' : 'Nenhum lançamento neste mês.';
  $('empty').hidden = visiveis.length > 0;
  $('list').replaceChildren(...visiveis.map((l) => {
    const li = document.createElement('li');
    li.addEventListener('click', () => editar(l.id));
    const d = document.createElement('div'); d.className = 'd';
    const t = document.createElement('div'); t.className = 't';
    t.textContent = l.descricao || (l.tipo === 'entrada' ? 'Entrada' : l.categoria);
    const s = document.createElement('div'); s.className = 's';
    s.textContent = brData(l.data) + ' · ' + (l.categoria || (l.tipo === 'entrada' ? 'Entrada' : 'Sem categoria'));
    d.append(t, s);
    const v = document.createElement('div');
    v.className = 'v ' + (l.tipo === 'entrada' ? 'pos' : 'neg');
    v.textContent = (l.tipo === 'entrada' ? '+ ' : '− ') + fmt(l.valor);
    li.append(d, v);
    return li;
  }));

  renderEntradas(doMes, entradas);
  renderCategoriaSelect();
  renderPeriodo();
}

const tipoCat = (c) => c.tipo || 'saida'; // categorias antigas não têm o campo

function renderEntradas(doMes, total) {
  const ins = doMes.filter((l) => l.tipo === 'entrada');
  $('e-total').textContent = fmt(total);
  $('e-count').textContent = `${ins.length} ${ins.length === 1 ? 'entrada' : 'entradas'} neste mês`;
  const por = {};
  ins.forEach((l) => {
    const k = l.categoria || 'Sem categoria';
    por[k] = por[k] || { v: 0, n: 0 };
    por[k].v += l.valor; por[k].n++;
  });
  const nomes = categorias.filter((c) => tipoCat(c) === 'entrada').map((c) => c.nome);
  Object.keys(por).forEach((k) => { if (!nomes.includes(k)) nomes.push(k); });
  $('e-cats').replaceChildren(...nomes.map((nome) => {
    const d = por[nome] || { v: 0, n: 0 };
    const el = document.createElement('div');
    el.className = 'cat in' + (d.v ? '' : ' zero');
    const s = document.createElement('span'); s.textContent = nome;
    const b = document.createElement('b'); b.textContent = fmt(d.v);
    const q = document.createElement('small'); q.textContent = d.n ? `${d.n} ${d.n === 1 ? 'entrada' : 'entradas'}` : 'nenhuma';
    el.append(s, b, q);
    return el;
  }));
}

/* ---------- gasto por período ---------- */
function addDias(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const x = new Date(a, m - 1, d + n);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

function renderPeriodo() {
  const de = $('p-de').value, ate = $('p-ate').value;
  const total = $('p-total'), cats = $('p-cats');
  cats.replaceChildren();
  if (!de || !ate) { $('p-info').textContent = 'Escolha as duas datas.'; total.textContent = fmt(0); $('p-in').textContent = fmt(0); $('p-count').textContent = ''; return; }
  if (de > ate) { $('p-info').textContent = 'A data inicial é depois da final.'; total.textContent = fmt(0); $('p-in').textContent = fmt(0); $('p-count').textContent = ''; return; }

  const doPeriodo = lancamentos.filter((l) => l.data >= de && l.data <= ate);
  const saidas = doPeriodo.filter((l) => l.tipo === 'saida');
  const soma = saidas.reduce((s, l) => s + l.valor, 0);
  const entradas = doPeriodo.filter((l) => l.tipo === 'entrada').reduce((s, l) => s + l.valor, 0);

  $('p-info').textContent = `${brData(de)} a ${brData(ate)} · total de saídas`;
  total.textContent = fmt(soma);
  $('p-in').textContent = fmt(entradas);
  $('p-count').textContent = `${saidas.length} ${saidas.length === 1 ? 'saída' : 'saídas'}`;

  const porCat = {};
  saidas.forEach((l) => (porCat[l.categoria] = (porCat[l.categoria] || 0) + l.valor));
  Object.entries(porCat).sort((a, b) => b[1] - a[1]).forEach(([nome, v]) => {
    const el = document.createElement('div'); el.className = 'pcat';
    const top = document.createElement('div'); top.className = 'top';
    const n = document.createElement('span'); n.textContent = nome;
    const val = document.createElement('span'); val.textContent = `${fmt(v)} · ${Math.round((v / soma) * 100)}%`;
    top.append(n, val);
    const mini = document.createElement('div'); mini.className = 'mini';
    const bar = document.createElement('i'); bar.style.width = (v / soma) * 100 + '%';
    mini.append(bar);
    el.append(top, mini);
    cats.append(el);
  });
}

function periodoRapido(p) {
  const h = hoje();
  if (p === 'mes') $('p-de').value = h.slice(0, 8) + '01';
  else if (p === 'ano') $('p-de').value = h.slice(0, 4) + '-01-01';
  else $('p-de').value = addDias(h, -(Number(p) - 1));
  $('p-ate').value = h;
  renderPeriodo();
}

function renderCategoriaSelect() {
  const sel = $('categoria');
  const atual = sel.value;
  const lista = categorias.filter((c) => tipoCat(c) === tipoSel());
  sel.replaceChildren(...lista.map((c) => new Option(c.nome, c.nome)));
  if (lista.some((c) => c.nome === atual)) sel.value = atual;
}

/* ---------- formulário ---------- */
const tipoSel = () => document.querySelector('input[name="tipo"]:checked').value;

function dataPadrao() {
  // ao ver outro mês, sugere o dia 1 desse mês; no mês atual, hoje
  return mesAtual === mesDe(hoje()) ? hoje() : mesAtual + '-01';
}

function limparForm(manterTipo) {
  editandoId = null;
  $('form').reset();
  if (manterTipo) document.querySelector(`input[name="tipo"][value="${manterTipo}"]`).checked = true;
  $('data').value = dataPadrao();
  $('form-title').textContent = 'Novo lançamento';
  $('save').textContent = 'Salvar';
  $('edit-actions').hidden = true;
  atualizarTipo();
}

function atualizarTipo() {
  const entrada = tipoSel() === 'entrada';
  // aba Entrada: só cards e informações de entradas
  $('sec-entradas').hidden = !entrada;
  ['sec-saidas', 'sec-limite', 'sec-saldo', 'sec-periodo'].forEach((id) => ($(id).hidden = entrada));
  render();
}

function editar(id) {
  const l = lancamentos.find((x) => x.id === id);
  if (!l) return;
  editandoId = id;
  document.querySelector(`input[name="tipo"][value="${l.tipo}"]`).checked = true;
  atualizarTipo();
  $('valor').value = (l.valor / 100).toFixed(2).replace('.', ',');
  if (l.categoria) $('categoria').value = l.categoria;
  $('descricao').value = l.descricao;
  $('data').value = l.data;
  $('form-title').textContent = 'Editar lançamento';
  $('save').textContent = 'Salvar alteração';
  $('edit-actions').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function salvar(e) {
  e.preventDefault();
  const valor = parseValor($('valor').value);
  if (!valor) { toast('Informe um valor válido'); $('valor').focus(); return; }
  if (!$('data').value) { toast('Informe a data'); return; }
  const tipo = tipoSel();
  const reg = {
    tipo,
    valor,
    categoria: $('categoria').value,
    descricao: $('descricao').value.trim(),
    data: $('data').value,
  };
  if (editandoId) reg.id = editandoId;
  await put('lancamentos', reg);
  const eraEdicao = !!editandoId;
  mesAtual = mesDe(reg.data); // mostra o mês do lançamento salvo
  await carregar();
  limparForm(tipo); // continua na mesma aba (Saída/Entrada)
  render();
  toast(eraEdicao ? 'Alteração salva' : 'Lançamento salvo');
}

async function apagar() {
  if (!editandoId || !confirm('Apagar este lançamento?')) return;
  await del('lancamentos', editandoId);
  const tipo = tipoSel();
  await carregar();
  limparForm(tipo);
  render();
  toast('Lançamento apagado');
}

async function novaCategoria() {
  const nome = $('cat-name').value.trim();
  if (!nome) return;
  const igual = categorias.find((c) => c.nome.toLowerCase() === nome.toLowerCase());
  if (igual) {
    if (tipoCat(igual) === tipoSel()) $('categoria').value = igual.nome;
    else { toast('Já existe uma categoria com esse nome'); return; }
  } else {
    await put('categorias', { nome, tipo: tipoSel(), ordem: Date.now() });
    await carregar();
    renderCategoriaSelect();
    $('categoria').value = nome;
    render();
  }
  $('cat-name').value = '';
  $('cat-new').hidden = true;
}

async function salvarMeta() {
  const v = $('meta-input').value.trim();
  if (v === '' || v === '0') {
    await del('metas', mesAtual);
  } else {
    const c = parseValor(v);
    if (!c) { toast('Valor de limite inválido'); return; }
    await put('metas', { mes: mesAtual, valor: c });
  }
  await carregar();
  $('meta-form').hidden = true;
  render();
}

/* ---------- exportar XLSX ---------- */
async function exportar() {
  if (!lancamentos.length) { toast('Nada para exportar'); return; }
  const linhas = [...lancamentos]
    .sort((a, b) => a.data.localeCompare(b.data) || a.id - b.id)
    .map((l) => ({
      'Data': brData(l.data),
      'Tipo': l.tipo === 'entrada' ? 'Entrada' : 'Saída',
      'Categoria': l.categoria || '—',
      'Descrição': l.descricao,
      'Valor (R$)': l.valor / 100,
    }));
  const ws = XLSX.utils.json_to_sheet(linhas);
  ws['!cols'] = [{ wch: 12 }, { wch: 9 }, { wch: 24 }, { wch: 36 }, { wch: 14 }];
  linhas.forEach((_, i) => { const c = ws['E' + (i + 2)]; if (c) c.z = '"R$" #,##0.00'; });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  const bytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const nome = `financas-${hoje()}.xlsx`;
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const blob = new Blob([bytes], { type: mime });

  // iPhone: folha de compartilhamento -> "Salvar em Arquivos"
  try {
    const file = new File([blob], nome, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: nome });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- PIN ---------- */
let pinBuf = '';
let pinModo = 'entrar'; // 'criar' | 'confirmar' | 'entrar'
let pinPrimeiro = '';
let pinCfg = null;
let desbloqueado = false;

function cyrb(str) { // reserva para contextos sem crypto.subtle (http fora do localhost)
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
async function hashPin(pin, salt) {
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return cyrb(salt + ':' + pin);
}
function novoSalt() {
  const a = new Uint8Array(16);
  (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => (a[i] = Math.random() * 256));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pinUI() {
  [...$('dots').children].forEach((d, i) => d.classList.toggle('on', i < pinBuf.length));
  $('lock-title').textContent = pinModo === 'criar' ? 'Crie um PIN de 4 dígitos' : pinModo === 'confirmar' ? 'Confirme o PIN' : 'Digite seu PIN';
}
function erroPin(msg) {
  $('lock-msg').textContent = msg;
  $('dots').classList.remove('shake'); void $('dots').offsetWidth; $('dots').classList.add('shake');
  pinBuf = ''; pinUI();
}

async function pinCompleto() {
  if (pinModo === 'criar') {
    pinPrimeiro = pinBuf; pinBuf = ''; pinModo = 'confirmar';
    $('lock-msg').textContent = ''; pinUI();
  } else if (pinModo === 'confirmar') {
    if (pinBuf !== pinPrimeiro) { pinModo = 'criar'; erroPin('Os PINs não conferem. Tente de novo.'); return; }
    const salt = novoSalt();
    pinCfg = { chave: 'pin', salt, hash: await hashPin(pinBuf, salt) };
    await put('config', pinCfg);
    destravar();
  } else {
    if ((await hashPin(pinBuf, pinCfg.salt)) === pinCfg.hash) destravar();
    else erroPin('PIN incorreto');
  }
}

function destravar() {
  pinBuf = ''; desbloqueado = true;
  $('lock').hidden = true; $('app').hidden = false;
  $('lock-msg').textContent = '';
}
function travar() {
  desbloqueado = false; pinBuf = ''; pinModo = 'entrar';
  $('app').hidden = true; $('lock').hidden = false; pinUI();
}

function tecla(k) {
  if (k === 'del') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 4) pinBuf += k;
  pinUI();
  if (pinBuf.length === 4) setTimeout(pinCompleto, 120);
}

/* ---------- inicialização ---------- */
async function init() {
  db = await abrirDB();

  if (!(await getAll('categorias')).length) {
    for (let i = 0; i < CATEGORIAS_INICIAIS.length; i++) await put('categorias', { nome: CATEGORIAS_INICIAIS[i], tipo: 'saida', ordem: i });
  }
  if (!(await getAll('categorias')).some((c) => c.tipo === 'entrada')) {
    for (let i = 0; i < CATEGORIAS_ENTRADA.length; i++) await put('categorias', { nome: CATEGORIAS_ENTRADA[i], tipo: 'entrada', ordem: 1000 + i });
  }
  await carregar();
  limparForm();
  periodoRapido('mes');
  render();
  ['p-de', 'p-ate'].forEach((id) => $(id).addEventListener('change', renderPeriodo));
  document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => periodoRapido(c.dataset.p)));

  // PIN
  pinCfg = (await getOne('config', 'pin')) || null;
  pinModo = pinCfg ? 'entrar' : 'criar';
  $('lock').hidden = false;
  pinUI();

  $('pad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) tecla(b.dataset.k || b.textContent);
  });
  document.addEventListener('keydown', (e) => {
    if ($('lock').hidden) return;
    if (/^\d$/.test(e.key)) tecla(e.key);
    else if (e.key === 'Backspace') tecla('del');
  });

  let saiuEm = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saiuEm = Date.now();
    else if (desbloqueado && saiuEm && Date.now() - saiuEm > 60000) travar();
  });

  // eventos da tela
  $('form').addEventListener('submit', salvar);
  document.querySelectorAll('input[name="tipo"]').forEach((r) => r.addEventListener('change', atualizarTipo));
  $('cancel').addEventListener('click', limparForm);
  $('delete').addEventListener('click', apagar);
  $('cat-add').addEventListener('click', () => { $('cat-new').hidden = !$('cat-new').hidden; $('cat-name').focus(); });
  $('cat-ok').addEventListener('click', novaCategoria);
  $('cat-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); novaCategoria(); } });
  const fecharMenu = () => { $('menu').hidden = true; $('more').setAttribute('aria-expanded', 'false'); };
  $('more').addEventListener('click', (e) => {
    e.stopPropagation();
    $('menu').hidden = !$('menu').hidden;
    $('more').setAttribute('aria-expanded', String(!$('menu').hidden));
  });
  document.addEventListener('click', fecharMenu);
  $('export').addEventListener('click', () => { fecharMenu(); exportar(); });

  $('meta-edit').addEventListener('click', () => {
    const f = $('meta-form');
    f.hidden = !f.hidden;
    if (!f.hidden) {
      const m = metaDoMes(mesAtual);
      $('meta-input').value = m ? (m.valor / 100).toFixed(2).replace('.', ',') : '';
      $('meta-input').focus();
    }
  });
  $('meta-ok').addEventListener('click', salvarMeta);
  $('meta-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') salvarMeta(); });

  const trocarMes = (delta) => {
    const [a, m] = mesAtual.split('-').map(Number);
    const d = new Date(a, m - 1 + delta, 1);
    mesAtual = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    $('meta-form').hidden = true;
    if (!editandoId) $('data').value = dataPadrao();
    render();
  };
  $('prev').addEventListener('click', () => trocarMes(-1));
  $('next').addEventListener('click', () => trocarMes(1));

  // iOS ignora user-scalable=no: bloqueia o zoom por pinça e por toque duplo
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((g) => document.addEventListener(g, (e) => e.preventDefault()));
  let ultimoToque = 0;
  document.addEventListener('touchend', (e) => {
    const agora = Date.now();
    if (agora - ultimoToque < 300 && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault();
    ultimoToque = agora;
  }, { passive: false });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
