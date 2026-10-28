'use strict';

/* ---------- utilidades ---------- */
const $ = (id) => document.getElementById(id);
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (cents) => brl.format(cents / 100);
const CATEGORIAS_INICIAIS = ['Compras pessoais', 'Saúde', 'Alimentação', 'Compras pela internet', 'Despesas fixas', 'Despesas com veículos'];

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
    $('meta-edit').textContent = `Meta ${fmt(meta.valor)} · Editar`;
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
  $('cats').replaceChildren(...categorias.map((c) => {
    const v = porCat[c.nome] || 0;
    const el = document.createElement('div');
    el.className = 'cat' + (v ? '' : ' zero');
    const s = document.createElement('span'); s.textContent = c.nome;
    const b = document.createElement('b'); b.textContent = fmt(v);
    el.append(s, b);
    return el;
  }));

  // lista
  $('empty').hidden = doMes.length > 0;
  $('list').replaceChildren(...doMes.map((l) => {
    const li = document.createElement('li');
    li.addEventListener('click', () => editar(l.id));
    const d = document.createElement('div'); d.className = 'd';
    const t = document.createElement('div'); t.className = 't';
    t.textContent = l.descricao || (l.tipo === 'entrada' ? 'Entrada' : l.categoria);
    const s = document.createElement('div'); s.className = 's';
    s.textContent = brData(l.data) + (l.tipo === 'saida' ? ' · ' + l.categoria : ' · Entrada');
    d.append(t, s);
    const v = document.createElement('div');
    v.className = 'v ' + (l.tipo === 'entrada' ? 'pos' : 'neg');
    v.textContent = (l.tipo === 'entrada' ? '+ ' : '− ') + fmt(l.valor);
    li.append(d, v);
    return li;
  }));

  renderCategoriaSelect();
}

function renderCategoriaSelect() {
  const sel = $('categoria');
  const atual = sel.value;
  sel.replaceChildren(...categorias.map((c) => new Option(c.nome, c.nome)));
  if (categorias.some((c) => c.nome === atual)) sel.value = atual;
}

/* ---------- formulário ---------- */
const tipoSel = () => document.querySelector('input[name="tipo"]:checked').value;

function dataPadrao() {
  // ao ver outro mês, sugere o dia 1 desse mês; no mês atual, hoje
  return mesAtual === mesDe(hoje()) ? hoje() : mesAtual + '-01';
}

function limparForm() {
  editandoId = null;
  $('form').reset();
  $('data').value = dataPadrao();
  $('form-title').textContent = 'Novo lançamento';
  $('save').textContent = 'Salvar';
  $('edit-actions').hidden = true;
  atualizarTipo();
}

function atualizarTipo() {
  $('cat-field').hidden = tipoSel() === 'entrada';
}

function editar(id) {
  const l = lancamentos.find((x) => x.id === id);
  if (!l) return;
  editandoId = id;
  document.querySelector(`input[name="tipo"][value="${l.tipo}"]`).checked = true;
  $('valor').value = (l.valor / 100).toFixed(2).replace('.', ',');
  if (l.tipo === 'saida') $('categoria').value = l.categoria;
  $('descricao').value = l.descricao;
  $('data').value = l.data;
  $('form-title').textContent = 'Editar lançamento';
  $('save').textContent = 'Salvar alteração';
  $('edit-actions').hidden = false;
  atualizarTipo();
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
    categoria: tipo === 'saida' ? $('categoria').value : '',
    descricao: $('descricao').value.trim(),
    data: $('data').value,
  };
  if (editandoId) reg.id = editandoId;
  await put('lancamentos', reg);
  const eraEdicao = !!editandoId;
  mesAtual = mesDe(reg.data); // mostra o mês do lançamento salvo
  await carregar();
  limparForm();
  render();
  toast(eraEdicao ? 'Alteração salva' : 'Lançamento salvo');
}

async function apagar() {
  if (!editandoId || !confirm('Apagar este lançamento?')) return;
  await del('lancamentos', editandoId);
  await carregar();
  limparForm();
  render();
  toast('Lançamento apagado');
}

async function novaCategoria() {
  const nome = $('cat-name').value.trim();
  if (!nome) return;
  if (categorias.some((c) => c.nome.toLowerCase() === nome.toLowerCase())) {
    $('categoria').value = categorias.find((c) => c.nome.toLowerCase() === nome.toLowerCase()).nome;
  } else {
    await put('categorias', { nome, ordem: Date.now() });
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
    if (!c) { toast('Valor de meta inválido'); return; }
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
      'Categoria': l.tipo === 'entrada' ? '—' : l.categoria,
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
    for (let i = 0; i < CATEGORIAS_INICIAIS.length; i++) await put('categorias', { nome: CATEGORIAS_INICIAIS[i], ordem: i });
  }
  await carregar();
  limparForm();
  render();

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
  $('export').addEventListener('click', exportar);

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

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
