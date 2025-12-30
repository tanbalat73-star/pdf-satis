// =====================
// helpers
// =====================
const $ = (id) => document.getElementById(id);
const fmtTL = (n) => String(Number(n || 0));

let PRODUCTS = [];
let SELLER = null;
let CART = new Map(); // id -> product

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "İşlem başarısız");
  return data;
}

function escapeHTML(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// =====================
// PRODUCT PAGE (index.html)
// =====================
async function initProductPage() {
  const productsEl = $("products");
  if (!productsEl) return; // bu sayfa değil

  // ürün+satıcı
  const data = await fetchJSON("/api/products");
  PRODUCTS = data.products || [];
  SELLER = data.seller || null;

  // havale kutusu
  const sellerBox = $("sellerBox");
  if (sellerBox && SELLER) {
    sellerBox.innerHTML = `
      <b>Havale Bilgileri</b><br/>
      IBAN: <code>${escapeHTML(SELLER.iban)}</code><br/>
      Alıcı: <b>${escapeHTML(SELLER.accountName)}</b><br/>
      <span class="muted">Ödeme açıklamasına ad-soyad veya sipariş kodunu yazmanız önerilir.</span>
    `;
  }

  // ürün listesi
  if (PRODUCTS.length === 0) {
    productsEl.innerHTML = `<div class="muted">Henüz ürün yok. Admin panelden PDF yükleyin.</div>`;
  } else {
    productsEl.innerHTML = "";
    for (const p of PRODUCTS) {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `
        <div>
          <div class="title">${escapeHTML(p.title)}</div>
          <div class="sub"><span class="badge">${escapeHTML(p.priceTRY)} TL</span></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn secondary" data-add="${p.id}">Sepete Ekle</button>
          <button class="btn" data-buyone="${p.id}">Tek Al</button>
        </div>
      `;
      productsEl.appendChild(row);
    }
  }

  // ürün butonları (delegation)
  productsEl.addEventListener("click", (e) => {
    const t = e.target;
    const addId = t?.getAttribute?.("data-add");
    const buyOneId = t?.getAttribute?.("data-buyone");

    if (addId) {
      const p = PRODUCTS.find((x) => x.id === addId);
      if (p) CART.set(p.id, p);
      renderCart();
      return;
    }

    if (buyOneId) {
      const p = PRODUCTS.find((x) => x.id === buyOneId);
      if (p) {
        CART.clear();
        CART.set(p.id, p);
        renderCart();
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      }
    }
  });

  renderCart();
  bindOrderForm();
}

function bindOrderForm() {
  const formEl = $("orderForm");
  if (!formEl) return;

  // aynı event iki kere bağlanmasın
  if (formEl.dataset.bound === "1") return;
  formEl.dataset.bound = "1";

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();

    const msgEl = $("orderMsg");
    if (msgEl) msgEl.textContent = "";

    const items = [...CART.keys()];
    if (items.length === 0) {
      if (msgEl) msgEl.textContent = "Sepet boş. En az 1 PDF seçmelisin.";
      return;
    }

    // FormData hazırla
    const fd = new FormData(formEl);
    fd.set("items", JSON.stringify(items)); // server JSON.parse

    try {
      // ✅ server.js tek endpoint: /api/order
      const res = await fetch("/api/order", {
        method: "POST",
        body: fd,
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "Sipariş oluşturulamadı");

      if (msgEl) {
        msgEl.textContent =
          `✅ Sipariş oluşturuldu!\n\n` +
          `Sipariş Kodu: ${out.orderCode}\n` +
          `Toplam: ${out.totalTRY} TL\n\n` +
          `Havale Bilgileri:\nIBAN: ${out.iban}\nAlıcı: ${out.accountName}\n\n` +
          `Ödeme sonrası admin onaylayacak.\n` +
          `Sipariş sorgu: /order.html`;
      }

      CART.clear();
      renderCart();
      formEl.reset();
    } catch (err) {
      if (msgEl) msgEl.textContent = "❌ " + (err?.message || "Hata");
    }
  });
}

function renderCart() {
  const cartEl = $("cart");
  const totalEl = $("total");
  if (!cartEl || !totalEl) return;

  const items = [...CART.values()];
  cartEl.innerHTML = "";

  if (items.length === 0) {
    cartEl.innerHTML = `<div class="muted">Sepet boş.</div>`;
    totalEl.textContent = "0";
    return;
  }

  let total = 0;
  for (const p of items) {
    total += Number(p.priceTRY || 0);

    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div>
        <div class="title">${escapeHTML(p.title)}</div>
        <div class="sub"><span class="badge">${escapeHTML(p.priceTRY)} TL</span></div>
      </div>
      <button class="btn danger" data-remove="${p.id}">Kaldır</button>
    `;
    cartEl.appendChild(row);
  }

  cartEl.onclick = (e) => {
    const rid = e.target?.getAttribute?.("data-remove");
    if (rid) {
      CART.delete(rid);
      renderCart();
    }
  };

  totalEl.textContent = fmtTL(total);
}

// =====================
// ORDER PAGE (order.html)
// =====================
async function initOrderPage() {
  const form = $("queryForm");
  if (!form) return; // bu sayfa değil

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const statusEl = $("status");
    const downloadsBox = $("downloadsBox");
    const downloadsEl = $("downloads");
    const expiresEl = $("expires");

    if (statusEl) statusEl.textContent = "";
    if (downloadsBox) downloadsBox.style.display = "none";
    if (downloadsEl) downloadsEl.innerHTML = "";
    if (expiresEl) expiresEl.textContent = "";

    const fd = new FormData(form);
    const code = String(fd.get("orderCode") || "").trim().toUpperCase();

    if (!code) {
      if (statusEl) statusEl.textContent = "Sipariş kodu boş olamaz.";
      return;
    }

    try {
      const out = await fetchJSON(`/api/order/${encodeURIComponent(code)}`);

      const lines = [
        `Sipariş Kodu: ${out.orderCode}`,
        `Durum: ${out.status}`,
        `Toplam: ${out.totalTRY} TL`,
        `Ürün sayısı: ${out.items?.length || 0}`,
        `Oluşturma: ${out.createdAt || "-"}`,
        `Onay: ${out.approvedAt || "-"}`,
      ];
      if (statusEl) statusEl.textContent = lines.join("\n");

      if (out.status === "approved" && out.downloadToken) {
        await showDownloads(out.downloadToken);
      } else {
        if (statusEl) statusEl.textContent += `\n\nOnay bekleniyor. Admin onayladığında indirme açılır.`;
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = "❌ " + (err?.message || "Hata");
    }
  });
}

async function showDownloads(token) {
  const out = await fetchJSON(`/api/downloads?token=${encodeURIComponent(token)}`);

  const downloadsBox = $("downloadsBox");
  const downloadsEl = $("downloads");
  const expiresEl = $("expires");

  if (downloadsBox) downloadsBox.style.display = "block";
  if (downloadsEl) downloadsEl.innerHTML = "";

  for (const it of out.items || []) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div>
        <div class="title">${escapeHTML(it.title)}</div>
        <div class="sub"><span class="badge">${escapeHTML(it.priceTRY)} TL</span></div>
      </div>
      <a href="/download/${encodeURIComponent(it.id)}?token=${encodeURIComponent(token)}">
        <button class="btn">İndir</button>
      </a>
    `;
    downloadsEl.appendChild(row);
  }

  if (expiresEl) {
    expiresEl.textContent = out.tokenExpiresAt ? `Link geçerlilik: ${out.tokenExpiresAt}` : "";
  }
}

// =====================
// boot
// =====================
initProductPage().catch(() => {});
initOrderPage().catch(() => {});
