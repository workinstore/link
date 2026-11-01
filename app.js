/* =====================================================================
   LINK GATILHO — app.js
   ---------------------------------------------------------------------
   1) Crie um projeto no Firebase, ative Authentication (E-mail/Senha)
      e crie o usuário admin@admin.com em Authentication > Users.
   2) Ative o Realtime Database e cole as REGRAS abaixo em "Regras".
   3) Preencha firebaseConfig com os dados do seu projeto.
   4) GITHUB PAGES: envie os 3 arquivos para a raiz do repositório,
      ative Settings > Pages (branch main, pasta /root) e adicione
      SEU_USUARIO.github.io em Firebase > Authentication > Settings >
      Authorized domains. Sem build, sem servidor: 100% estático.

   URLs:
     index.html           -> painel (login)
     index.html?g=ID      -> LINK GATILHO (gera o link temporário)
     index.html?t=TOKEN   -> LINK TEMPORÁRIO (mostra o conteúdo)

   REGRAS DO REALTIME DATABASE (somente admin@admin.com pode gerenciar):
   {
     "rules": {
       "links": {
         ".read": "auth != null && auth.token.email === 'admin@admin.com'",
         "$id": {
           ".read": true,
           ".write": "auth != null && auth.token.email === 'admin@admin.com'"
         }
       },
       "tokens": {
         ".read": false,
         "$token": {
           ".read": true,
           ".write": "!data.exists() && newData.exists()",
           ".validate": "newData.hasChildren(['linkId','url','mode','expiresAt']) && root.child('links/' + newData.child('linkId').val() + '/url').val() === newData.child('url').val() && newData.child('expiresAt').val() > now && newData.child('expiresAt').val() <= now + (root.child('links/' + newData.child('linkId').val() + '/ttl').val() * 60000) + 60000"
         }
       }
     }
   }
   Obs.: ".read" no nível de cada item (e não da lista) impede que
   visitantes listem todos os links/tokens — só lê quem conhece o ID.
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getDatabase, ref, get, set, push, update, remove, onValue,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ---------- CONFIGURAÇÃO (preencha) ----------
const firebaseConfig = {
  apiKey: "AIzaSyDRarwiJUkJSy8ySzOZHTdLzlfqqrs2-sA",
  authDomain: "link-38983.firebaseapp.com",
  databaseURL: "https://link-38983-default-rtdb.firebaseio.com",
  projectId: "link-38983",
  storageBucket: "link-38983.firebasestorage.app",
  messagingSenderId: "850875896",
  appId: "1:850875896:web:6b3691a11cad09d4ae320d"
};


const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Único administrador permitido
const ADMIN_EMAIL = "admin@admin.com";
const isAdmin = (u) => !!u && (u.email || "").toLowerCase() === ADMIN_EMAIL;

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const views = ["view-status", "view-login", "view-admin", "view-viewer"];
function show(id) { views.forEach((v) => $(v).classList.toggle("hidden", v !== id)); }

function status(title, text = "", loading = true) {
  $("status-title").textContent = title;
  $("status-text").textContent = text;
  $("status-spinner").classList.toggle("hidden", !loading);
  show("view-status");
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function randomToken(len = 32) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

const baseUrl = () => location.origin + location.pathname.replace(/index\.html$/, "");
const triggerUrl = (id) => `${baseUrl()}?g=${encodeURIComponent(id)}`;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Título e favicon da página ----------
function setPageMeta(title, icon) {
  document.title = title || "\u200E";
  $("page-icon").href = icon || "data:,";
}
const faviconFor = (url) => {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`; }
  catch { return ""; }
};
// Capta título e ícone da página original (serviço público com CORS liberado)
async function fetchPageMeta(url) {
  let title = "", icon = "";
  try {
    const r = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(url)}`);
    const j = await r.json();
    if (j.status === "success") { title = j.data.title || ""; icon = (j.data.logo && j.data.logo.url) || ""; }
  } catch (e) { console.warn("microlink", e); }
  if (!title) {
    try {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`);
      const html = (await r.json()).contents || "";
      const doc = new DOMParser().parseFromString(html, "text/html");
      title = (doc.querySelector("title")?.textContent || "").trim();
      const l = doc.querySelector('link[rel~="icon"]');
      if (!icon && l) icon = new URL(l.getAttribute("href"), url).href;
    } catch (e) { console.warn("allorigins", e); }
  }
  if (!title) { try { title = new URL(url).hostname; } catch {} }
  return { title, icon: icon || faviconFor(url) };
}

// ---------- Roteamento ----------
const params = new URLSearchParams(location.search);
if (params.get("g") || params.get("t")) setPageMeta("Carregando…", "");
if (params.get("g")) handleTrigger(params.get("g"));
else if (params.get("t")) handleToken(params.get("t"));
else initAdmin();

// ---------- 1) LINK GATILHO: gera link temporário ----------
async function handleTrigger(linkId) {
  status("Gerando acesso seguro…");
  try {
    const snap = await get(ref(db, `links/${linkId}`));
    if (!snap.exists() || snap.val().active === false) {
      return status("Link indisponível", "Este link não existe ou foi desativado.", false);
    }
    const link = snap.val();
    const ttl = Number(link.ttl) || 10;
    const token = randomToken();
    await set(ref(db, `tokens/${token}`), {
      linkId,
      url: link.url,
      mode: link.mode || "iframe",
      pageTitle: link.pageTitle || "",
      favicon: link.favicon || faviconFor(link.url),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 60000,
    });
    // troca a URL sem deixar o gatilho no histórico
    location.replace(`${baseUrl()}?t=${token}`);
  } catch (e) {
    console.error(e);
    status("Erro", "Não foi possível gerar o acesso. Tente novamente.", false);
  }
}

// ---------- 2) LINK TEMPORÁRIO: exibe conteúdo ----------
async function handleToken(token) {
  status("Abrindo…");
  try {
    const snap = await get(ref(db, `tokens/${token}`));
    if (!snap.exists()) return status("Link inválido", "Acesse novamente pelo link original.", false);
    const data = snap.val();
    if (Date.now() > data.expiresAt) {
      return status("Link expirado", "Este acesso temporário expirou. Use o link original para gerar um novo.", false);
    }

    if (data.mode === "redirect") return location.replace(data.url);

    let pTitle = data.pageTitle, pIcon = data.favicon;
    if (!pTitle) {
      const l = await get(ref(db, `links/${data.linkId}`)).catch(() => null);
      const v = l && l.exists() ? l.val() : {};
      pTitle = v.pageTitle || ""; pIcon = pIcon || v.favicon;
    }
    setPageMeta(pTitle || new URL(data.url).hostname, pIcon || faviconFor(data.url));
    $("viewer-frame").title = pTitle || "Conteúdo";
    show("view-viewer");
    $("viewer-frame").src = data.url;

    const tick = () => {
      const left = data.expiresAt - Date.now();
      if (left <= 0) {
        $("viewer-frame").src = "about:blank";
        return status("Link expirado", "O tempo deste acesso acabou. Use o link original novamente.", false);
      }
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      $("viewer-timer").textContent = `Expira em ${m}:${String(s).padStart(2, "0")}`;
      setTimeout(tick, 1000);
    };
    tick();
  } catch (e) {
    console.error(e);
    status("Erro", "Não foi possível abrir o conteúdo.", false);
  }
}

// ---------- 3) PAINEL ADMIN ----------
let allLinks = {};

function initAdmin() {
  status("Carregando…");
  onAuthStateChanged(auth, (user) => {
    if (!user) return show("view-login");
    if (!isAdmin(user)) {
      signOut(auth);
      $("login-error").textContent = "Acesso restrito ao administrador.";
      return show("view-login");
    }
    $("user-email").textContent = user.email;
    show("view-admin");
    onValue(ref(db, "links"), (snap) => {
      allLinks = snap.val() || {};
      renderList();
    }, (err) => toast("Sem permissão: confira as regras/UID."));
  });

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    const email = $("login-email").value.trim().toLowerCase();
    if (email !== ADMIN_EMAIL) {
      $("login-error").textContent = "Acesso restrito ao administrador.";
      return;
    }
    const btn = $("login-btn"), spin = $("login-spin");
    btn.disabled = true;
    spin.classList.remove("hidden");
    try {
      await signInWithEmailAndPassword(auth, email, $("login-pass").value);
    } catch {
      $("login-error").textContent = "E-mail ou senha inválidos.";
    } finally {
      btn.disabled = false;
      spin.classList.add("hidden");
    }
  });

  $("btn-logout").addEventListener("click", () => signOut(auth));
  $("btn-cancel").addEventListener("click", resetForm);
  $("search").addEventListener("input", renderList);
  $("link-favicon").addEventListener("input", previewFav);
  $("btn-fetch").addEventListener("click", async () => {
    const url = $("link-url").value.trim();
    if (!url) return toast("Informe a URL primeiro");
    const b = $("btn-fetch"); b.disabled = true; b.textContent = "Captando…";
    const m = await fetchPageMeta(url);
    $("link-ptitle").value = m.title; $("link-favicon").value = m.icon; previewFav();
    b.disabled = false; b.textContent = "Captar título e ícone";
    toast("Título e ícone captados");
  });

  $("link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("link-id").value;
    const url = $("link-url").value.trim();
    let pageTitle = $("link-ptitle").value.trim(), favicon = $("link-favicon").value.trim();
    if (!pageTitle || !favicon) {
      toast("Captando título e ícone…");
      const m = await fetchPageMeta(url);
      pageTitle = pageTitle || m.title; favicon = favicon || m.icon;
    }
    const data = {
      pageTitle, favicon,
      title: $("link-title").value.trim(),
      url: $("link-url").value.trim(),
      ttl: Math.max(1, Math.min(1440, Number($("link-ttl").value) || 10)),
      mode: $("link-mode").value,
      active: true,
      updatedAt: Date.now(),
    };
    try {
      if (id) {
        await update(ref(db, `links/${id}`), data);
        toast("Link atualizado");
      } else {
        await set(push(ref(db, "links")), { ...data, createdAt: Date.now() });
        toast("Link criado");
      }
      resetForm();
    } catch (err) {
      console.error(err);
      toast("Erro ao salvar");
    }
  });
}

function resetForm() {
  $("link-form").reset();
  $("link-id").value = "";
  $("link-ttl").value = 10;
  $("form-title").textContent = "Novo link";
  $("btn-cancel").classList.add("hidden");
  previewFav();
}

function previewFav() {
  const v = $("link-favicon").value.trim(), img = $("fav-preview");
  img.classList.toggle("hidden", !v);
  if (v) img.src = v;
}

function renderList() {
  const q = $("search").value.toLowerCase();
  const entries = Object.entries(allLinks)
    .filter(([, l]) => (l.title + l.url).toLowerCase().includes(q))
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  $("empty").classList.toggle("hidden", entries.length > 0);
  $("link-list").innerHTML = entries.map(([id, l]) => `
    <li class="item">
      <div class="row between">
        <h3>${l.favicon ? `<img src="${escapeHtml(l.favicon)}" alt="" />` : ""}${escapeHtml(l.title)}</h3>
        <div class="row">
          <span class="badge">${l.ttl} min</span>
          <span class="badge">${l.mode === "redirect" ? "redireciona" : "embutido"}</span>
          ${l.active === false ? '<span class="badge">inativo</span>' : ""}
        </div>
      </div>
      <div class="url">${escapeHtml(l.url)}</div>
      ${l.pageTitle ? `<div class="muted">Aba: ${escapeHtml(l.pageTitle)}</div>` : ""}
      <div class="trigger">
        <code>${escapeHtml(triggerUrl(id))}</code>
        <button class="btn sm primary" data-act="copy" data-id="${id}">Copiar</button>
      </div>
      <div class="row">
        <button class="btn sm ghost" data-act="open" data-id="${id}">Testar</button>
        <button class="btn sm ghost" data-act="edit" data-id="${id}">Editar</button>
        <button class="btn sm ghost" data-act="toggle" data-id="${id}">${l.active === false ? "Ativar" : "Desativar"}</button>
        <button class="btn sm ghost danger" data-act="del" data-id="${id}">Excluir</button>
      </div>
    </li>`).join("");
}

$("link-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id, l = allLinks[id];
  switch (btn.dataset.act) {
    case "copy":
      await navigator.clipboard.writeText(triggerUrl(id));
      toast("Link gatilho copiado");
      break;
    case "open":
      window.open(triggerUrl(id), "_blank", "noopener");
      break;
    case "edit":
      $("link-id").value = id;
      $("link-title").value = l.title;
      $("link-url").value = l.url;
      $("link-ttl").value = l.ttl;
      $("link-mode").value = l.mode || "iframe";
      $("link-ptitle").value = l.pageTitle || "";
      $("link-favicon").value = l.favicon || "";
      previewFav();
      $("form-title").textContent = "Editar link";
      $("btn-cancel").classList.remove("hidden");
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "toggle":
      await update(ref(db, `links/${id}`), { active: l.active === false });
      break;
    case "del":
      if (confirm(`Excluir "${l.title}"?`)) { await remove(ref(db, `links/${id}`)); toast("Excluído"); }
      break;
  }
});
