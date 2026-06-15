// PAN MARKET V2 — script.js  (V2.3 — แก้ bugs + ฟีเจอร์ใหม่)

const GLOBAL_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbyvZ03g_8HVt0Iu5CVRqF-A4eCdGAbzGhp_Kmzsa7wys5YhXxiTGiNxn5OkycOuBNvwZQ/exec";

const NO_IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%23f3f4f6'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-size='48' fill='%23d1d5db'%3E🛒%3C/text%3E%3C/svg%3E";

// (HTML attribute onerror ไม่สามารถเข้าถึง JS module-scope variable ได้)
function imgFallback(el) {
  if (el._fallbackApplied) return; // ป้องกัน infinite loop
  el._fallbackApplied = true;
  el.src = NO_IMG_PLACEHOLDER;
}

// STATE
let products     = [];
let cart         = [];
let categories   = [];
let storeConfig  = {};
let adminOrders  = [];
let currentPage  = "home";
let currentAdminOrderFilter = "all";
let currentUser  = JSON.parse(localStorage.getItem("pan_user")) || null;

let pendingProductSave  = null;

let adminOrderSearchQuery = "";

// INIT
const _cache = {};
const CACHE_TTL = 3 * 60 * 1000; // cache 3 นาที

function cacheSet(key, data) {
  _cache[key] = { data, time: Date.now() };
}
function cacheGet(key) {
  const c = _cache[key];
  if (!c) return null;
  if (Date.now() - c.time > CACHE_TTL) { delete _cache[key]; return null; }
  return c.data;
}
function cacheClear(key) { delete _cache[key]; }

// AUTO-REFRESH จาก Sheet ทุก 3 นาที (background silent)
let _autoRefreshTimer = null;
function startAutoRefresh() {
  stopAutoRefresh();
  _autoRefreshTimer = setInterval(async () => {
    cacheClear("products");
    cacheClear("myOrders_" + (currentUser?.phone || ""));
    await loadProducts(0, true); // silent=true ไม่แสดง skeleton
    const tabs = {
      adminTabOrders:    () => loadAdminOrders(),
      adminTabProducts:  () => renderAdminProducts(),
      adminTabCustomers: () => loadAdminCustomers(),
    };
    for (const [tabId, fn] of Object.entries(tabs)) {
      const el = document.getElementById(tabId);
      if (el && !el.classList.contains("hidden")) { fn(); break; }
    }
  }, 3 * 60 * 1000); // ✅ ทุก 3 นาที แทน 30 วิ
}
function stopAutoRefresh() {
  if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
}
document.addEventListener("visibilitychange", () => {
  document.hidden ? stopAutoRefresh() : startAutoRefresh();
});

document.addEventListener("DOMContentLoaded", async () => {
  applyDarkModePreference();
  loadCartFromStorage();
  setupUser();
  loadStoreConfig();
  loadCategories();
  await loadProducts();
  startAutoRefresh();
});

// DARK MODE
function applyDarkModePreference() {
  const saved = localStorage.getItem("pan_theme");
  const isDark = saved === "dark";
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  const btn = document.getElementById("darkToggle");
  if (btn) btn.textContent = isDark ? "☀️" : "🌙";
}

function toggleDarkMode() {
  const current = document.documentElement.getAttribute("data-theme") === "dark";
  const next = !current;
  document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
  localStorage.setItem("pan_theme", next ? "dark" : "light");
  const btn = document.getElementById("darkToggle");
  if (btn) btn.textContent = next ? "☀️" : "🌙";
  if (typeof renderAdminChart === "function" && _adminSalesChart) renderAdminChart();
}

// HELPERS — IMAGE URL
// (format นี้แสดงใน <img> ได้โดยตรง ไม่ติด redirect)
function normalizeDriveUrl(url) {
  if (!url) return "";
  const s = String(url).trim();
  // จาก /file/d/ID/view
  const m1 = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) return `https://drive.google.com/thumbnail?id=${m1[1]}&sz=w800`;
  // จาก ?id=ID หรือ &id=ID
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return `https://drive.google.com/thumbnail?id=${m2[1]}&sz=w800`;
  // จาก lh3.googleusercontent.com/d/ID
  const m3 = s.match(/lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
  if (m3) return `https://drive.google.com/thumbnail?id=${m3[1]}&sz=w800`;
  // จาก thumbnail ที่มีอยู่แล้ว
  if (s.includes('drive.google.com/thumbnail')) return s;
  return s;
}

// ✅ getSlipUrlCandidates: คืน array ของ URL ที่จะลองแสดงรูปสลิป ตามลำดับ
// (lh3 -> drive thumbnail -> URL ดิบ) ใช้คู่กับ slipImgError เพื่อสลับ format
// อัตโนมัติถ้า format แรกโหลดไม่ขึ้น (กรณีไฟล์ยังไม่ public หรือ CDN บล็อก)
function getSlipUrlCandidates(url) {
  if (!url) return [];
  const s = String(url).trim();
  let fileId = "";
  const m1 = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m1) fileId = m1[1];
  if (!fileId) { const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]+)/); if (m2) fileId = m2[1]; }
  if (!fileId) { const m3 = s.match(/\/d\/([a-zA-Z0-9_-]+)/); if (m3) fileId = m3[1]; }
  const candidates = [];
  if (fileId) {
    candidates.push(`https://lh3.googleusercontent.com/d/${fileId}=w400`);
    candidates.push(`https://drive.google.com/thumbnail?id=${fileId}&sz=w800`);
  }
  if (!candidates.includes(s)) candidates.push(s);
  return candidates;
}

// ✅ slipImgError: handler กลางตอนรูปสลิปโหลดไม่ขึ้น
// ลอง URL format ถัดไปใน data-slip-urls ก่อน ถ้าหมดทุก format แล้วยังพังอยู่
// ค่อยแสดง fallback (ไอคอนใน card list / ลิงก์เปิดเต็มจอใน modal)
function slipImgError(img) {
  let urls = [];
  try { urls = JSON.parse(img.dataset.slipUrls || "[]"); } catch (e) {}
  const idx = Number(img.dataset.slipIdx || "0") + 1;
  if (idx < urls.length) {
    img.dataset.slipIdx = String(idx);
    img.src = urls[idx];
    return;
  }
  const openUrl = img.dataset.slipOpen || "";
  if (img.dataset.slipMode === "modal") {
    img.style.display = "none";
    const fb = document.getElementById(img.dataset.slipFallback);
    if (fb) fb.style.display = "block";
  } else {
    const div = document.createElement("div");
    div.className = "no-slip slip-thumb-fallback";
    div.title = "ดูสลิป";
    div.style.cursor = "pointer";
    div.style.fontSize = "18px";
    div.textContent = "🧾";
    div.addEventListener("click", (e) => { e.stopPropagation(); viewSlip(openUrl); });
    img.replaceWith(div);
  }
}

// USER SETUP
function setupUser() {
  const label    = document.getElementById("loginLabel");
  const adminNav = document.getElementById("adminNav");
  if (currentUser) {
    label.textContent = currentUser.name;
    if (currentUser.role === "admin") {
      adminNav.classList.remove("hidden");
      document.getElementById("sideAdminNav")?.classList.remove("hidden");
    }
  } else {
    label.textContent = "เข้าสู่ระบบ";
  }
}

// PAGE SWITCH
function switchPage(page) {
  currentPage = page;
  document.querySelectorAll("main section").forEach(s => s.classList.add("hidden"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));

  const pageMap = {
    home:    { section: "homePage",    nav: "navHome"    },
    cart:    { section: "cartPage",    nav: "navCart"    },
    profile: { section: "profilePage", nav: "navProfile" },
    admin:   { section: "adminPage",   nav: "adminNav"   }
  };
  const target = pageMap[page];
  if (!target) return;

  document.getElementById(target.section)?.classList.remove("hidden");
  document.getElementById(target.nav)?.classList.add("active");

  const sideMap = { home:"sideNavHome", cart:"sideNavCart", profile:"sideNavProfile", admin:"sideAdminNav" };
  document.querySelectorAll(".sidebar-nav .nav-btn").forEach(b => b.classList.remove("active"));
  const sideBtn = document.getElementById(sideMap[page]);
  if (sideBtn) sideBtn.classList.add("active");

  if (page === "cart") renderCart();

  if (page === "home") {
    const cached = cacheGet("products");
    if (cached) { renderProductList(cached); }
    else { loadProducts(); }
  }

  if (page === "profile") {
    loadProfile();
    loadMyOrders();
  }

  if (page === "admin") {
    loadAnalytics();
    document.querySelectorAll(".admin-tab").forEach(b => b.classList.remove("active"));
    const firstTab = document.querySelector(".admin-tab");
    if (firstTab) firstTab.classList.add("active");
    document.getElementById("adminTabOrders")?.classList.remove("hidden");
    document.getElementById("adminTabProducts")?.classList.add("hidden");
    document.getElementById("adminTabCustomers")?.classList.add("hidden");
    document.getElementById("adminTabStore")?.classList.add("hidden");
    loadAdminOrders();
  }
}

// STORE CONFIG
async function loadStoreConfig() {
  try {
    const res  = await fetch(`${GLOBAL_SCRIPT_URL}?action=getStoreConfig`);
    const data = await res.json();
    if (data.status === "success") {
      storeConfig = data.config || {};
      applyStoreConfig();
    }
  } catch (err) { console.error("loadStoreConfig:", err); }
}

function applyStoreConfig(cfg) {
  const c = cfg || storeConfig;
  setEl("shopName",         c.shopName    || "Pan Market");
  setEl("shopSubtitle",     c.shopSubtitle || "ช้อปง่าย ส่งไว");
  document.title = c.shopName || "Pan Market";

  setEl("heroBannerTag",      c.bannerTag      || "🔥 สดใหม่ทุกวัน");
  setEl("heroBannerTitle",    c.bannerTitle    || "ยินดีต้อนรับ 👋");
  setEl("heroBannerSubtitle", c.bannerSubtitle || "เลือกซื้อสินค้าที่คุณต้องการ");
  setEl("heroBannerEmoji",    c.bannerEmoji    || "🛒");

  if (c.themeColor) {
    document.documentElement.style.setProperty("--orange", c.themeColor);
  }

  // apply card style จาก config ที่แอดมินตั้งไว้
  applyCardStyleFromConfig();
}

function fillStoreConfigForms() {
  const c = storeConfig;
  setVal("bannerTagInput",      c.bannerTag      || "");
  setVal("bannerTitleInput",    c.bannerTitle    || "");
  setVal("bannerSubtitleInput", c.bannerSubtitle || "");
  setVal("bannerEmojiInput",    c.bannerEmoji    || "");
  setVal("storeNameInput",      c.shopName       || "");
  setVal("storeSubtitleInput",  c.shopSubtitle   || "");
  setVal("shippingFeeInput",    c.shippingFee    || "");
  setVal("minimumOrderInput",   c.minimumOrder   || "");
  setVal("bankNameInput",       c.bankName       || "");
  setVal("bankNumberInput",     c.bankNumber     || "");
  setVal("bankAccountNameInput",c.bankAccountName|| "");
  setVal("promptpayInput",      c.promptpay      || "");
  setVal("lineOAInput",         c.lineOA         || "");
}

// CATEGORIES
async function loadCategories() {
  try {
    const res  = await fetch(`${GLOBAL_SCRIPT_URL}?action=getCategories`);
    const data = await res.json();
    if (data.status === "success") {
      categories = data.categories || [];
      renderCategories();
      populateCategorySelect();
    }
  } catch (err) { console.error("loadCategories:", err); }
}

function renderCategories() {
  const container = document.getElementById("categoryContainer");
  if (!container) return;
  container.innerHTML = `<button class="category-btn active" onclick="clearCategoryFilter(this)">ทั้งหมด</button>`;
  categories.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = "category-btn";
    btn.textContent = cat.name;
    btn.dataset.cat = cat.name;
    btn.onclick = function() { filterByCategory(this.dataset.cat, this); };
    container.appendChild(btn);
  });
}

function populateCategorySelect() {
  const sel = document.getElementById("productCategory");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">-- เลือกหมวดหมู่ --</option>`;
  categories.forEach(cat => {
    const opt = document.createElement("option");
    opt.value = cat.name;
    opt.textContent = cat.name;
    if (cat.name === cur) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ✅ CATEGORY MANAGEMENT (admin)
async function loadAdminCategories() {
  const container = document.getElementById("adminCategoryList");
  if (!container) return;
  container.innerHTML = `<div class="loading-state" style="padding:16px 0"><div class="spinner" style="width:24px;height:24px;border-width:2px"></div></div>`;

  try {
    const res  = await fetch(`${GLOBAL_SCRIPT_URL}?action=getCategories`);
    const data = await res.json();
    if (data.status === "success") {
      categories = data.categories || [];
      renderAdminCategories();
      renderCategories();
      populateCategorySelect();
    } else {
      container.innerHTML = `<p style="color:var(--red);font-size:13px">โหลดไม่สำเร็จ</p>`;
    }
  } catch (err) {
    container.innerHTML = `<p style="color:var(--red);font-size:13px">เกิดข้อผิดพลาด</p>`;
  }
}

function renderAdminCategories() {
  const container = document.getElementById("adminCategoryList");
  if (!container) return;

  if (!categories.length) {
    container.innerHTML = `<div style="font-size:13px;color:var(--soft);padding:12px 0;text-align:center">ยังไม่มีหมวดหมู่</div>`;
    return;
  }

  container.innerHTML = "";
  categories.forEach(cat => {
    container.innerHTML += `
      <div class="cat-admin-item">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="cat-sort-badge">${cat.sort}</span>
          <span style="font-size:14px;font-weight:600;color:var(--dark)">${cat.name}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-small btn-ghost" onclick="openEditCategoryModal('${cat.id}','${escHtml(cat.name)}',${cat.sort})">✏️</button>
          <button class="btn-small btn-red"   onclick="deleteCategoryConfirm('${cat.id}','${escHtml(cat.name)}')">🗑️</button>
        </div>
      </div>`;
  });
}

async function addCategoryFromForm() {
  const name = document.getElementById("newCatName").value.trim();
  const sort = Number(document.getElementById("newCatSort")?.value) || (categories.length + 1);
  if (!name) { showToast("กรุณากรอกชื่อหมวดหมู่"); return; }

  const btn = document.getElementById("addCatBtn");
  btn.disabled = true; btn.textContent = "⏳";

  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body: JSON.stringify({ action: "addCategory", name, sort, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") {
      document.getElementById("newCatName").value = "";
      document.getElementById("newCatSort").value = "";
      await loadAdminCategories();
      showToast("เพิ่มหมวดหมู่แล้ว ✅");
    } else { showToast(data.message || "เพิ่มไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
  finally { btn.disabled = false; btn.textContent = "+ เพิ่ม"; }
}

function openEditCategoryModal(id, name, sort) {
  document.getElementById("editCatId").value = id;
  setVal("editCatName", name);
  setVal("editCatSort", sort);
  openModal("editCategoryModal");
}

async function saveEditCategory() {
  const id   = document.getElementById("editCatId").value;
  const name = document.getElementById("editCatName").value.trim();
  const sort = Number(document.getElementById("editCatSort").value) || 0;
  if (!name) { showToast("กรุณากรอกชื่อ"); return; }

  const btn = document.getElementById("saveEditCatBtn");
  btn.disabled = true; btn.textContent = "⏳";

  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body: JSON.stringify({ action: "editCategory", id, name, sort, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") {
      closeAllModals();
      await loadAdminCategories();
      showToast("แก้ไขหมวดหมู่แล้ว ✅");
    } else { showToast(data.message || "แก้ไขไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
  finally { btn.disabled = false; btn.textContent = "บันทึก"; }
}

async function deleteCategoryConfirm(id, name) {
  if (!confirm(`ลบหมวดหมู่ "${name}"?\n(สินค้าในหมวดนี้จะยังอยู่ แต่ไม่มีหมวดหมู่)`)) return;
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body: JSON.stringify({ action: "deleteCategory", id, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") {
      await loadAdminCategories();
      showToast("ลบหมวดหมู่แล้ว");
    } else { showToast(data.message || "ลบไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
}

// PRODUCTS
function showSkeletonProducts(count = 6) {
  const grid = document.getElementById("productGrid");
  if (!grid) return;
  const loading = document.getElementById("loadingState");
  if (loading) loading.classList.add("hidden");
  grid.innerHTML = Array(count).fill(`
    <div class="skeleton-card">
      <div class="skeleton-img"></div>
      <div class="skeleton-body">
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-line price"></div>
      </div>
    </div>`).join("");
}

async function loadProducts(retryCount = 0, silent = false) {
  const MAX_RETRY = 2;          // ลด retry เหลือ 2 ครั้ง (เร็วขึ้น)
  const TIMEOUT_MS = 10000;     // 10 วินาที / ครั้ง
  const grid    = document.getElementById("productGrid");
  const loading = document.getElementById("loadingState");

  if (loading) loading.classList.add("hidden");

  if (!silent) {
    if (retryCount === 0) {
      showSkeletonProducts(6);
    } else {
      const existing = grid?.querySelector(".retry-msg");
      if (!existing && grid) {
        const msg = document.createElement("p");
        msg.className = "retry-msg";
        msg.style.cssText = "grid-column:1/-1;text-align:center;padding:8px;font-size:13px;color:var(--soft)";
        msg.textContent = `🔄 กำลังเชื่อมต่อ... (${retryCount}/${MAX_RETRY})`;
        grid.insertAdjacentElement("afterbegin", msg);
      }
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res  = await fetch(`${GLOBAL_SCRIPT_URL}?action=getProducts`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();

    if (data.status === "success") {
      products = data.products || [];
      if (data.config) { storeConfig = data.config; applyStoreConfig(); }
      cacheSet("products", products);
      renderProductList(products);
      if (currentPage === "admin") renderStockAlert();
    } else {
      throw new Error(data.message || "server error");
    }
  } catch (err) {
    if (!silent && retryCount < MAX_RETRY) {
      const delay = (retryCount + 1) * 2000;
      setTimeout(() => loadProducts(retryCount + 1, false), delay);
    } else {
      if (grid) showError(grid, "โหลดสินค้าไม่สำเร็จ กรุณาลองใหม่");
    }
  }
}

function showError(container, msg) {
  if (!container) return;
  const loading = document.getElementById("loadingState");
  if (loading) loading.classList.add("hidden");
  container.innerHTML = `
    <div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📡</div>
      <p style="font-weight:600;color:var(--dark)">${msg}</p>
      <p style="font-size:12px;color:var(--soft);margin-top:-4px">อาจเกิดจากเครือข่ายขัดข้องหรือ Google Apps Script ไม่ตอบสนอง</p>
      <button class="btn-primary" style="width:auto;margin-top:12px;padding:10px 20px" onclick="loadProducts()">🔄 ลองใหม่</button>
    </div>`;
}

function renderProductList(list, kw) {
  const grid  = document.getElementById("productGrid");
  const count = document.getElementById("productCount");
  if (!grid) return;
  grid.innerHTML = "";
  if (count) count.textContent = list.length > 0 ? `${list.length} รายการ` : "";
  if (!list.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">${kw ? "🔍" : "📦"}</div><p>${kw ? `ไม่พบ "${kw}"` : "ไม่พบสินค้า"}</p>${kw ? `<button class="btn-clear" style="width:auto;margin-top:10px;padding:8px 20px;font-size:13px" onclick="clearSearch()">ล้างการค้นหา</button>` : ""}</div>`;
    return;
  }
  list.forEach(product => {
    const out    = product.stock <= 0;
    const imgSrc = normalizeDriveUrl(product.image) || "";
    const priceTxt = product.salePrice > 0
      ? `<span style="text-decoration:line-through;font-size:12px;color:var(--soft)">฿${Number(product.price).toLocaleString()}</span> ฿${Number(product.salePrice).toLocaleString()}`
      : `฿${Number(product.price).toLocaleString()}`;
    const nameHl = hlText(product.name, kw);
    const descHl = hlText(product.description||"", kw);

    grid.innerHTML += `
      <div class="product-card" onclick="openProductDetail('${product.id}')">
        <div class="p-img-wrap">
          <img src="${imgSrc || NO_IMG_PLACEHOLDER}" alt="${escHtml(product.name)}" loading="lazy" onerror="imgFallback(this)">
          ${out ? `<div class="p-badge out">หมด</div>` : ""}
          ${product.recommended ? `<div class="p-badge" style="top:auto;bottom:8px">⭐</div>` : ""}
        </div>
        <div class="product-info">
          <div class="product-name">${nameHl}</div>
          <div class="product-desc">${descHl}</div>
          <div class="product-footer">
            <div class="product-price">${priceTxt}</div>
            <button class="buy-btn ${out?"out-stock":""}" onclick="event.stopPropagation();addToCart('${product.id}')" ${out?"disabled":""}>+</button>
          </div>
        </div>
      </div>`;
  });
}

// SEARCH — instant + highlight + category sync
let _searchKw = "";
let _activeCat = "";
let _searchDebounce = null;

document.addEventListener("input", e => {
  if (e.target.id !== "searchInput") return;
  const raw = e.target.value;
  _searchKw = raw.toLowerCase().trim();
  const clearBtn = document.getElementById("searchClearBtn");
  if (clearBtn) clearBtn.classList.toggle("visible", raw.length > 0);
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => applyProductFilter(), 120);
});

function applyProductFilter() {
  let list = products;
  if (_activeCat) list = list.filter(p => p.category === _activeCat);
  if (_searchKw)  list = list.filter(p =>
    p.name.toLowerCase().includes(_searchKw) ||
    (p.description||"").toLowerCase().includes(_searchKw) ||
    (p.category||"").toLowerCase().includes(_searchKw)
  );
  renderProductList(list, _searchKw);
}

function clearSearch() {
  const input = document.getElementById("searchInput");
  if (input) input.value = "";
  _searchKw = "";
  const clearBtn = document.getElementById("searchClearBtn");
  if (clearBtn) clearBtn.classList.remove("visible");
  applyProductFilter();
  input?.focus();
}

function filterByCategory(catName, btn) {
  document.querySelectorAll(".category-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  _activeCat = catName;
  applyProductFilter();
}

function clearCategoryFilter(btn) {
  document.querySelectorAll(".category-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  _activeCat = "";
  applyProductFilter();
}

function hlText(text, kw) {
  if (!kw || !text) return escHtml(text || "");
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escHtml(text).replace(new RegExp(`(${escaped})`, "gi"),
    "<mark class='search-hl'>$1</mark>");
}

// PRODUCT DETAIL MODAL
function openProductDetail(productId) {
  const product = products.find(p => String(p.id) === String(productId));
  if (!product) return;
  const imgSrc = normalizeDriveUrl(product.image) || "";
  setEl("detailName",  product.name);
  document.getElementById("detailImg").src = imgSrc || NO_IMG_PLACEHOLDER;
  document.getElementById("detailImg").alt = product.name;
  setEl("detailDesc",  product.description || "ไม่มีรายละเอียด");
  setEl("detailPrice", product.salePrice > 0
    ? `฿${Number(product.salePrice).toLocaleString()}`
    : `฿${Number(product.price).toLocaleString()}`);
  setEl("detailUnit",  product.unit ? `/ ${product.unit}` : "");
  setEl("detailStock", product.stock > 0 ? `เหลือ ${product.stock} ชิ้น` : "สินค้าหมด");

  const addBtn = document.getElementById("detailAddBtn");
  addBtn.onclick = () => { addToCart(productId); closeAllModals(); };
  if (product.stock <= 0) {
    addBtn.textContent = "สินค้าหมด"; addBtn.disabled = true; addBtn.style.opacity = ".5";
  } else {
    addBtn.textContent = "เพิ่มลงตะกร้า 🛒"; addBtn.disabled = false; addBtn.style.opacity = "1";
  }
  openModal("detailModal");
}

// CART
function addToCart(productId) {
  const product = products.find(p => String(p.id) === String(productId));
  if (!product) return;
  if (product.stock <= 0) { showToast("สินค้าหมดแล้ว"); return; }
  const found = cart.find(item => String(item.id) === String(productId));
  if (found) {
    if (found.qty >= product.stock) {
      showToast(`มีสินค้าในตะกร้าเต็มแล้ว (${product.stock} ${product.unit || "ชิ้น"})`);
      return;
    }
    found.qty++;
  } else {
    cart.push({ ...product, qty: 1 });
  }
  saveCartToStorage(); updateCartBadge();
  showToast(`เพิ่ม "${product.name}" ลงตะกร้า 🛒`);
}

function saveCartToStorage()  { localStorage.setItem("pan_cart", JSON.stringify(cart)); }
function loadCartFromStorage() {
  try { cart = JSON.parse(localStorage.getItem("pan_cart") || "[]"); } catch (e) { cart = []; }
  updateCartBadge();
}

function updateCartBadge() {
  const badge = document.getElementById("cartBadge");
  if (!badge) return;
  const total = cart.reduce((s, i) => s + i.qty, 0);
  if (total > 0) { badge.textContent = total > 99 ? "99+" : total; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");
  const sideBadge = document.getElementById("cartBadgeSide");
  if (sideBadge) {
    sideBadge.textContent = badge.textContent;
    total > 0 ? sideBadge.classList.remove("hidden") : sideBadge.classList.add("hidden");
  }
}

function renderCart() {
  const container = document.getElementById("cartItems");
  const footer    = document.getElementById("cartFooter");
  const totalEl   = document.getElementById("cartTotal");
  if (!container) return;
  container.innerHTML = "";
  if (!cart.length) {
    container.innerHTML = `<div class="empty-state" style="padding-top:60px"><div class="empty-icon">🛒</div><p>ตะกร้าว่างเปล่า</p></div>`;
    footer?.classList.add("hidden"); return;
  }
  footer?.classList.remove("hidden");
  let total = 0;
  cart.forEach((item, i) => {
    const price    = item.salePrice > 0 ? item.salePrice : item.price;
    const subtotal = price * item.qty;
    total += subtotal;
    const imgSrc = normalizeDriveUrl(item.image) || "";
    container.innerHTML += `
      <div class="cart-item">
        <img src="${imgSrc || NO_IMG_PLACEHOLDER}" alt="${item.name}" onerror="imgFallback(this)">
        <div class="cart-item-info">
          <div class="cart-item-name">${item.name}</div>
          <div class="cart-item-price">฿${Number(price).toLocaleString()}</div>
          <div class="qty-row">
            <button class="qty-btn" onclick="decreaseQty(${i})">−</button>
            <span class="qty-num">${item.qty}</span>
            <button class="qty-btn" onclick="increaseQty(${i})">+</button>
          </div>
        </div>
        <button class="cart-del" onclick="removeCart(${i})">🗑️</button>
      </div>`;
  });
  if (totalEl) totalEl.textContent = `฿${total.toLocaleString()}`;
}

function increaseQty(i) {
  if (i>=0&&i<cart.length) {
    const item = cart[i];
    const product = products.find(p => String(p.id) === String(item.id));
    const maxStock = product ? (Number(product.stock) || 0) : (Number(item.stock) || 0);
    if (item.qty >= maxStock) {
      showToast(`มีสินค้าในตะกร้าเต็มแล้ว (${maxStock} ${item.unit || "ชิ้น"})`);
      return;
    }
    item.qty++; saveCartToStorage(); updateCartBadge(); renderCart();
  }
}
function decreaseQty(i) {
  if (i>=0&&i<cart.length) {
    if (cart[i].qty > 1) cart[i].qty--; else cart.splice(i,1);
    saveCartToStorage(); updateCartBadge(); renderCart();
  }
}
function removeCart(i) { if (i>=0&&i<cart.length) { cart.splice(i,1); saveCartToStorage(); updateCartBadge(); renderCart(); } }

// CHECKOUT — ขายหน้าร้าน เงินสด (1 Step เดียว)
function checkout() {
  if (!cart.length) { showToast("ยังไม่มีสินค้าในตะกร้า"); return; }
  if (!currentUser) { showToast("กรุณาเข้าสู่ระบบก่อน"); openModal("loginModal"); return; }

  const subtotal = cart.reduce((s, i) => s + (i.salePrice > 0 ? i.salePrice : i.price) * i.qty, 0);
  const minOrder = Number(storeConfig.minimumOrder || 0);
  if (minOrder > 0 && subtotal < minOrder) {
    showToast(`ยอดสั่งซื้อขั้นต่ำ ฿${minOrder.toLocaleString()}`);
    return;
  }

  const shipping = Number(storeConfig.shippingFee || 0);
  const total    = subtotal + shipping;

  setEl("checkoutSubtotal", `฿${subtotal.toLocaleString()}`);
  setEl("checkoutShipping", `฿${shipping.toLocaleString()}`);
  setEl("checkoutTotal",    `฿${total.toLocaleString()}`);

  // แสดง/ซ่อน ค่าส่ง row
  const shippingRow = document.getElementById("checkoutShippingRow");
  if (shippingRow) shippingRow.style.display = shipping > 0 ? "" : "none";

  // อัปเดต bank info summary
  const bankSummary = document.getElementById("bankInfoSummary");
  if (bankSummary) {
    const parts = [storeConfig.bankName, storeConfig.bankNumber].filter(Boolean);
    bankSummary.textContent = parts.length ? parts.join(" · ") : "ยังไม่ได้ตั้งค่าธนาคาร";
  }

  // อัปเดต bank detail box
  renderBankInfoBox();

  // อัปเดต promptpay summary & detail
  const ppSummary = document.getElementById("promptpaySummary");
  if (ppSummary) ppSummary.textContent = storeConfig.promptpay || "ยังไม่ได้ตั้งค่าพร้อมเพย์";
  const ppContent = document.getElementById("promptpayInfoContent");
  if (ppContent) ppContent.innerHTML = storeConfig.promptpay
    ? `📲 <b>พร้อมเพย์:</b> ${escHtml(storeConfig.promptpay)}`
    : '<span style="color:var(--soft)">ยังไม่ได้ตั้งค่าพร้อมเพย์</span>';

  // รีเซ็ต slip preview
  const sp = document.getElementById("slipPreview");
  if (sp) sp.innerHTML = "";
  const sppp = document.getElementById("slipPreviewPP");
  if (sppp) sppp.innerHTML = "";
  _slipBase64 = ""; _slipUploaded = ""; _slipFile = null;

  // เลือก payment method แรกที่เปิดอยู่โดยอัตโนมัติ
  const s = (typeof getModuleSettings === "function") ? getModuleSettings() : {};
  const firstAvailable =
    s.paymentCOD !== false ? "cod" :
    s.paymentBank ? "bank" :
    s.paymentPromptPay ? "promptpay" : "cod";

  const firstLabel = document.querySelector(`[data-payment="${firstAvailable}"]`);
  if (firstLabel) selectPayment(firstAvailable, firstLabel);

  openModal("checkoutModal");
}

// เลือกวิธีชำระเงิน — highlight border + แสดง/ซ่อน detail box
function selectPayment(method, labelEl) {
  // reset borders
  ["cod","bank","promptpay"].forEach(m => {
    const el = document.getElementById("payBlock_" + m);
    if (el) el.style.borderColor = "var(--border)";
    const radio = el ? el.querySelector("input[type=radio]") : null;
    if (radio) radio.checked = (m === method);
  });
  // highlight selected
  if (labelEl) labelEl.style.borderColor = "var(--orange)";

  // show/hide detail boxes
  const bankBox = document.getElementById("bankDetailBox");
  const ppBox   = document.getElementById("promptpayDetailBox");
  if (bankBox) bankBox.style.display   = method === "bank"       ? "" : "none";
  if (ppBox)   ppBox.style.display     = method === "promptpay"  ? "" : "none";
}

async function doSubmitOrder() {
  const subtotalCheck = cart.reduce((s, i) => s + (i.salePrice > 0 ? i.salePrice : i.price) * i.qty, 0);
  const minOrder = Number(storeConfig.minimumOrder || 0);
  if (minOrder > 0 && subtotalCheck < minOrder) {
    showToast(`ยอดสั่งซื้อขั้นต่ำ ฿${minOrder.toLocaleString()}`);
    return;
  }

  // อ่าน payment method จาก radio ที่เลือก
  const selectedRadio = document.querySelector('input[name="paymentMethod"]:checked');
  const payMethod     = selectedRadio ? selectedRadio.value : "cod";
  const paymentMethod = payMethod === "bank" ? "Bank" : payMethod === "promptpay" ? "PromptPay" : "Cash";

  // ค่าส่ง
  const shipping = Number(storeConfig.shippingFee || 0);
  const total    = subtotalCheck + shipping;

  // address — ถ้ามี addressBook ให้ใช้ที่อยู่ default หรือ "หน้าร้าน"
  let address = "หน้าร้าน";
  if (currentUser?.addresses?.length) {
    const def = currentUser.addresses.find(a => a.isDefault) || currentUser.addresses[0];
    if (def) address = def.detail || def.label || "หน้าร้าน";
  }

  // ✅ บังคับแนบสลิปถ้าเลือก bank หรือ promptpay (เช็คก่อน disable ปุ่ม)
  if ((payMethod === "bank" || payMethod === "promptpay") && !_slipFile && !_slipBase64 && !_slipUploaded) {
    showToast("กรุณาแนบสลิปโอนเงินก่อนยืนยัน 🧾");
    return;
  }

  const btn = document.querySelector(".btn-confirm");
  if (btn) { btn.textContent = "กำลังส่งคำสั่งซื้อ..."; btn.disabled = true; }

  try {
    // อัปโหลด slip ก่อน (ถ้ามี) สำหรับ bank/promptpay
    let slipUrl = "";
    if ((payMethod === "bank" || payMethod === "promptpay") && (_slipFile || _slipBase64)) {
      try { slipUrl = await uploadSlipToDrive() || ""; } catch(e) {}
    }

    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({
        action: "submitOrder",
        phone: currentUser.phone,
        address,
        paymentMethod,
        shippingFee: shipping,
        total,
        items: cart,
        slipUrl
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      closeAllModals();
      const payLabel = paymentMethod === "Cash" ? "💵 ชำระเงินสดหน้าร้าน"
                     : paymentMethod === "Bank" ? "🏦 โอนเงินธนาคาร"
                     : "📱 พร้อมเพย์ / QR Code";

      const overlay = document.getElementById("modalOverlay");
      overlay.classList.remove("hidden");
      const successDiv = document.createElement("div");
      successDiv.id = "orderSuccessModal";
      successDiv.className = "modal";
      successDiv.style.cssText = "text-align:center;max-width:320px";
      successDiv.innerHTML = `
        <div style="font-size:48px;margin-bottom:12px">🎉</div>
        <h3 style="margin-bottom:8px">สั่งซื้อสำเร็จ!</h3>
        <div style="font-size:13px;color:var(--mid);margin-bottom:12px">รหัสออเดอร์: <b style="color:var(--orange)">${escHtml(data.orderId)}</b></div>
        <div style="background:var(--bg);border-radius:var(--radius-sm);padding:10px;margin-bottom:16px;font-size:13px;color:var(--mid)">
          ${payLabel}
        </div>
        <button class="btn-primary" onclick="closeAllModals()">ตกลง</button>`;
      overlay.appendChild(successDiv);

      cart = []; saveCartToStorage(); updateCartBadge();
      cacheClear("myOrders_" + (currentUser?.phone || ""));
      switchPage("profile");
      await loadProducts();
    } else { showToast(data.message || "สั่งซื้อไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด: " + (err.message || "")); console.error("submitOrder error:", err); }
  finally {
    if (btn) { btn.textContent = "ยืนยันการสั่งซื้อ ✅"; btn.disabled = false; }
  }
}

// SLIP UPLOAD
let _slipBase64   = "";
let _slipUploaded = "";
let _slipFile     = null; // ✅ เก็บ file object ไว้ compress ตอนอัปโหลด

function previewSlip(file) {
  // รับ File object โดยตรง (จาก onchange="previewSlip(this.files[0])")
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) { showToast("ไฟล์ใหญ่เกินไป (สูงสุด 30MB)"); return; }
  _slipFile     = file;
  _slipUploaded = "";

  const reader = new FileReader();
  reader.onload = ev => {
    _slipBase64 = ev.target.result;
    const previewHTML = `
      <img src="${_slipBase64}" alt="slip"
        style="max-height:160px;border-radius:10px;object-fit:contain;display:block;margin:0 auto"/>
      <div style="margin-top:6px;text-align:center;font-size:12px;color:var(--mid)">
        ✅ เลือกสลิปแล้ว — จะอัปโหลดอัตโนมัติเมื่อยืนยัน
      </div>`;
    // แสดงใน preview box ที่ active (bank หรือ promptpay)
    const sp   = document.getElementById("slipPreview");
    const sppp = document.getElementById("slipPreviewPP");
    if (sp)   sp.innerHTML   = previewHTML;
    if (sppp) sppp.innerHTML = previewHTML;
  };
  reader.readAsDataURL(file);
}

async function uploadSlipToDrive() {
  if (!_slipBase64 && !_slipFile) { showToast("กรุณาเลือกรูปก่อน"); return; }
  const statusEl = document.getElementById("uploadStatus");
  if (statusEl) statusEl.innerHTML = `<div class="spinner" style="width:24px;height:24px;border-width:2px;margin:8px auto"></div><p style="font-size:12px;color:var(--soft);text-align:center">กำลังบีบอัดและอัปโหลด...</p>`;

  try {
    let base64ToUpload = _slipBase64;
    if (_slipFile && _slipFile.type.startsWith("image/")) {
      const compressed = await compressImage(_slipFile, 1200, 0.85);
      if (compressed) {
        base64ToUpload = await new Promise(r => { const rd = new FileReader(); rd.onload = e => r(e.target.result); rd.readAsDataURL(compressed); });
      }
    }

    const fileName = "slip_" + Date.now() + ".jpg";
    let uploaded = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (statusEl && attempt === 2) statusEl.innerHTML = `<p style="font-size:12px;color:var(--soft);text-align:center">🔄 ลองใหม่...</p>`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const res  = await fetch(GLOBAL_SCRIPT_URL, {
          method: "POST",
          redirect: "follow",
          headers: {"Content-Type": "text/plain;charset=utf-8"},
          body:   JSON.stringify({ action: "uploadFile", base64: base64ToUpload, fileName, mimeType: "image/jpeg", phone: currentUser?.phone || "" }),
          signal: controller.signal
        });
        clearTimeout(timer);
        const data = await res.json();
        if (data.status === "success") { uploaded = data.url; break; }
      } catch { if (attempt < 2) await new Promise(r => setTimeout(r, 2000)); }
    }

    if (uploaded) {
      _slipUploaded = uploaded;
      const slipUrlInputEl = document.getElementById("slipUrlInput");
      if (slipUrlInputEl) slipUrlInputEl.value = uploaded; // ✅ FIX: element นี้ไม่มีใน DOM เดิม ทำให้ throw error
                                                            // ก่อนถึง return uploaded -> slipUrl เป็น "" เสมอ
      if (statusEl) statusEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;justify-content:center;margin-top:8px">
          <span style="font-size:18px">✅</span>
          <span style="font-size:13px;color:var(--green);font-weight:600">อัปโหลดสำเร็จ!</span>
        </div>`;
      showToast("อัปโหลดสลิปสำเร็จ ✅");
      return uploaded; // ✅ FIX: คืนค่า URL ให้ doSubmitOrder ส่งไปชีต (เดิมไม่มี return ทำให้สลิปไม่บันทึก)
    } else {
      if (statusEl) statusEl.innerHTML = `<p style="color:var(--red);font-size:13px;text-align:center">อัปโหลดไม่สำเร็จ</p>
        <button onclick="uploadSlipToDrive()" style="display:block;margin:8px auto;background:var(--orange);color:#fff;border:none;padding:6px 16px;border-radius:8px;font-size:12px;cursor:pointer">ลองใหม่</button>`;
      showToast("อัปโหลดไม่สำเร็จ — ลองใหม่อีกครั้ง");
      return "";
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<p style="color:var(--red);font-size:13px;text-align:center">เกิดข้อผิดพลาด</p>
      <button onclick="uploadSlipToDrive()" style="display:block;margin:8px auto;background:var(--orange);color:#fff;border:none;padding:6px 16px;border-radius:8px;font-size:12px;cursor:pointer">ลองใหม่</button>`;
    showToast("เกิดข้อผิดพลาด");
    return "";
  }
}

function syncSlipUrl() {
  const url = document.getElementById("slipUrlInput").value.trim();
  if (!url) return;
  if (url.startsWith("http")) {
    _slipUploaded = url;
    const preview = document.getElementById("slipPreview");
    preview.innerHTML = `<img src="${url}" alt="slip"
      style="max-height:180px;border-radius:12px;object-fit:contain;display:block;margin:0 auto"
      onerror="this.parentElement.innerHTML='<p style=\\'font-size:13px;color:var(--soft);text-align:center\\'>ลิงก์รูปไม่ถูกต้อง</p>'"/>`;
  }
}

// อัปโหลดรูปสินค้า
function compressImage(file, maxWidth = 1200, quality = 0.82) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) { height = Math.round(height * maxWidth / width); width = maxWidth; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => resolve(blob), "image/jpeg", quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function uploadProductImageToDrive(file) {
  if (!file) return null;
  if (file.size > 30 * 1024 * 1024) { showToast("ไฟล์ใหญ่เกินไป (สูงสุด 30MB)"); return null; }

  const status = document.getElementById("productImgUploadStatus");
  if (status) status.textContent = "🗜️ กำลังบีบอัดรูป...";

  let uploadFile = file;
  if (file.type.startsWith("image/")) {
    const compressed = await compressImage(file);
    if (compressed) uploadFile = compressed;
  }

  const mimeType = "image/jpeg";
  const fileName = "product_" + Date.now() + ".jpg";

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (status) status.textContent = attempt === 1 ? "☁️ กำลังอัปโหลด..." : "🔄 ลองใหม่ครั้งที่ 2...";
    const result = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = async ev => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000); // 30s timeout
          const res  = await fetch(GLOBAL_SCRIPT_URL, {
            method: "POST",
            redirect: "follow",
            headers: {"Content-Type": "text/plain;charset=utf-8"},
            body:   JSON.stringify({ action: "uploadFile", base64: ev.target.result, fileName, mimeType, phone: currentUser?.phone || "" }),
            signal: controller.signal
          });
          clearTimeout(timer);
          const data = await res.json();
          resolve(data.status === "success" ? data.url : null);
        } catch { resolve(null); }
      };
      reader.readAsDataURL(uploadFile);
    });
    if (result) return result;
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000)); // รอ 2 วิ ก่อน retry
  }
  return null;
}

let _productImgFile = null;

function onProductImgSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) { showToast("ไฟล์ใหญ่เกินไป (สูงสุด 30MB)"); e.target.value = ""; return; }
  _productImgFile = file;

  const reader = new FileReader();
  reader.onload = ev => {
    const preview = document.getElementById("productImgPreview");
    const status  = document.getElementById("productImgUploadStatus");
    if (preview) {
      preview.src = ev.target.result;
      preview.style.display = "block";
    }
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    if (status)  status.textContent = `✅ เลือกรูปแล้ว (${sizeMB}MB) — กด ☁️ อัปโหลด`;
  };
  reader.readAsDataURL(file);
  const btn = document.getElementById("uploadProductImgBtn");
  if (btn) { btn.disabled = false; btn.textContent = "☁️ อัปโหลด"; }
}

async function uploadProductImage() {
  if (!_productImgFile) { showToast("กรุณาเลือกรูปก่อน"); return; }
  const btn    = document.getElementById("uploadProductImgBtn");
  const status = document.getElementById("productImgUploadStatus");
  if (btn)    { btn.disabled = true; btn.textContent = "⏳"; }
  if (status)   status.textContent = "กำลังอัปโหลด...";

  const url = await uploadProductImageToDrive(_productImgFile);
  if (url) {
    const input   = document.getElementById("productImage");
    const current = input.value.trim();
    input.value   = current ? current + "|" + url : url;
    if (status)   status.textContent = "✅ อัปโหลดสำเร็จ!";
    if (btn)    { btn.textContent = "☁️ อัปโหลด"; btn.disabled = true; }
    _productImgFile = null;
    document.getElementById("productImgFile").value = "";
    showToast("อัปโหลดรูปสินค้าสำเร็จ ✅ กด 💾 เพื่อบันทึก");
  } else {
    if (status)   status.textContent = "❌ อัปโหลดไม่สำเร็จ ลองใหม่";
    if (btn)    { btn.disabled = false; btn.textContent = "☁️ อัปโหลด"; }
  }
}

function renderBankInfoBox() {
  const el = document.getElementById("bankInfoContent");
  if (!el) return;
  const lines = [];
  if (storeConfig.bankName)        lines.push(`🏦 <b>${storeConfig.bankName}</b>`);
  if (storeConfig.bankAccountName) lines.push(`👤 ${storeConfig.bankAccountName}`);
  if (storeConfig.bankNumber)      lines.push(`💳 ${storeConfig.bankNumber}`);
  if (storeConfig.promptpay)       lines.push(`📲 PromptPay: ${storeConfig.promptpay}`);
  el.innerHTML = lines.length ? lines.join("<br>") : '<span style="color:var(--soft)">ยังไม่ได้ตั้งค่าข้อมูลธนาคาร</span>';
}

function copyBankInfo() {
  const lines = [];
  if (storeConfig.bankName)        lines.push(storeConfig.bankName);
  if (storeConfig.bankAccountName) lines.push(storeConfig.bankAccountName);
  if (storeConfig.bankNumber)      lines.push(storeConfig.bankNumber);
  if (storeConfig.promptpay)       lines.push("PromptPay: " + storeConfig.promptpay);
  navigator.clipboard?.writeText(lines.join("\n")).then(() => showToast("คัดลอกข้อมูลธนาคารแล้ว 📋"));
}

// LOGIN / REGISTER
function openLoginModal() {
  if (currentUser) { switchPage("profile"); return; }
  openModal("loginModal"); switchTab("login");
}

function switchTab(tab) {
  document.getElementById("tabLogin").classList.toggle("active",    tab==="login");
  document.getElementById("tabRegister").classList.toggle("active", tab==="register");
  document.getElementById("formLogin").classList.toggle("hidden",    tab!=="login");
  document.getElementById("formRegister").classList.toggle("hidden", tab!=="register");
}

async function doLogin() {
  const phone    = document.getElementById("loginPhone").value.trim();
  const password = document.getElementById("loginPassword").value.trim();
  if (!phone || !password) { showToast("กรุณากรอกเบอร์และรหัสผ่าน"); return; }
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, { method: "POST", redirect: "follow", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: JSON.stringify({action:"login",phone,password}) });
    const data = await res.json();
    if (data.status === "success") {
      currentUser = data.user;
      localStorage.setItem("pan_user", JSON.stringify(currentUser));
      setupUser(); closeAllModals();
      showToast(`ยินดีต้อนรับ ${currentUser.name} 🎉`);
      if (currentUser.role === "admin") document.getElementById("adminNav").classList.remove("hidden");
    } else { showToast(data.message || "เข้าสู่ระบบไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
}

async function doRegister() {
  const name     = document.getElementById("regName").value.trim();
  const phone    = document.getElementById("regPhone").value.trim();
  const password = document.getElementById("regPassword").value.trim();
  if (!name || !phone || !password) { showToast("กรุณากรอกข้อมูลให้ครบ"); return; }
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, { method: "POST", redirect: "follow", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: JSON.stringify({action:"register",name,phone,password,addresses:[]}) });
    const data = await res.json();
    if (data.status === "success") {
      currentUser = data.user;
      localStorage.setItem("pan_user", JSON.stringify(currentUser));
      setupUser(); closeAllModals();
      showToast(`สมัครสมาชิกสำเร็จ ยินดีต้อนรับ ${currentUser.name} 🎉`);
    } else { showToast(data.message || "สมัครสมาชิกไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
}

function logout() { localStorage.removeItem("pan_user"); currentUser = null; location.reload(); }

// PROFILE & ORDERS
function loadProfile() {
  const box = document.getElementById("profileBox");
  if (!box) return;
  if (!currentUser) {
    box.innerHTML = `<div class="no-login"><div class="no-login-icon">🔐</div><p>ยังไม่ได้เข้าสู่ระบบ</p><button class="btn-primary mt-12" onclick="openLoginModal()">เข้าสู่ระบบ / สมัครสมาชิก</button></div>`;
    document.getElementById("addressSection")?.classList.add("hidden"); return;
  }
  box.innerHTML = `
    <div class="profile-info">
      <div class="avatar">👤</div>
      <div>
        <div class="profile-name">${currentUser.name}</div>
        <div class="profile-phone">${currentUser.phone}</div>
      </div>
    </div>
    <button class="btn-logout" onclick="logout()">ออกจากระบบ</button>`;
  document.getElementById("addressSection")?.classList.remove("hidden");
  renderAddressList();
}

// ===== ADDRESS MANAGEMENT =====
function renderAddressList() {
  const container = document.getElementById("addressList");
  if (!container || !currentUser) return;
  const addresses = currentUser.addresses || [];
  if (!addresses.length) {
    container.innerHTML = `<div style="font-size:13px;color:var(--soft);padding:12px 0">ยังไม่มีที่อยู่ที่บันทึกไว้</div>`;
    return;
  }
  container.innerHTML = "";
  addresses.forEach((addr, i) => {
    const label = addr.label || `ที่อยู่ ${i+1}`;
    container.innerHTML += `
      <div class="address-item ${addr.isDefault?"default":""}">
        ${addr.isDefault ? `<div class="address-default-badge">ค่าเริ่มต้น</div>` : ""}
        <div class="address-label">📍 ${label}</div>
        <div class="address-detail">${escHtml(addr.detail)}</div>
        <div class="address-actions">
          ${!addr.isDefault ? `<button class="btn-small btn-orange" onclick="setDefaultAddress(${i})">ตั้งเป็นค่าเริ่มต้น</button>` : ""}
          <button class="btn-small btn-ghost" onclick="openEditAddressModal(${i})">แก้ไข</button>
          <button class="btn-small btn-red" onclick="deleteAddress(${i})">ลบ</button>
        </div>
      </div>`;
  });
}

function openAddAddressModal() {
  document.getElementById("editAddressIndex").value = "-1";
  setVal("addrLabel",  "");
  setVal("addrDetail", "");
  document.getElementById("addrDefault").checked = false;
  openModal("addAddressModal");
}

function openEditAddressModal(i) {
  const addr = (currentUser.addresses || [])[i];
  if (!addr) return;
  document.getElementById("editAddressIndex").value = i;
  setVal("addrLabel",   addr.label  || "");
  setVal("addrDetail",  addr.detail || "");
  document.getElementById("addrDefault").checked = !!addr.isDefault;
  openModal("addAddressModal");
}

function saveAddress() {
  const label     = document.getElementById("addrLabel").value.trim();
  const detail    = document.getElementById("addrDetail").value.trim();
  const isDefault = document.getElementById("addrDefault").checked;
  const idx       = parseInt(document.getElementById("editAddressIndex").value);
  if (!detail) { showToast("กรุณากรอกรายละเอียดที่อยู่"); return; }

  const addresses = [...(currentUser.addresses || [])];
  if (isDefault) addresses.forEach(a => a.isDefault = false);
  const newAddr = { label: label || "ที่อยู่", detail, isDefault };

  if (idx >= 0 && idx < addresses.length) {
    addresses[idx] = newAddr;
  } else {
    if (!addresses.length) newAddr.isDefault = true;
    addresses.push(newAddr);
  }

  currentUser.addresses = addresses;
  localStorage.setItem("pan_user", JSON.stringify(currentUser));
  renderAddressList();
  closeAllModals();
  showToast("บันทึกที่อยู่แล้ว 📍");
  syncAddressesToSheet();
}

function setDefaultAddress(i) {
  const addresses = [...(currentUser.addresses || [])];
  addresses.forEach(a => a.isDefault = false);
  addresses[i].isDefault = true;
  currentUser.addresses = addresses;
  localStorage.setItem("pan_user", JSON.stringify(currentUser));
  renderAddressList();
  syncAddressesToSheet();
  showToast("ตั้งที่อยู่ค่าเริ่มต้นแล้ว ⭐");
}

function deleteAddress(i) {
  if (!confirm("ลบที่อยู่นี้?")) return;
  const addresses = [...(currentUser.addresses || [])];
  addresses.splice(i, 1);
  if (addresses.length && !addresses.some(a => a.isDefault)) addresses[0].isDefault = true;
  currentUser.addresses = addresses;
  localStorage.setItem("pan_user", JSON.stringify(currentUser));
  renderAddressList();
  syncAddressesToSheet();
  showToast("ลบที่อยู่แล้ว");
}

async function syncAddressesToSheet() {
  if (!currentUser) return;
  try {
    await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action:"updateAddresses", phone: currentUser.phone, addresses: currentUser.addresses })
    });
  } catch (err) { console.error("syncAddresses:", err); }
}

// MY ORDERS — ✅ แก้ sync: ล้าง cache ก่อนโหลดเสมอ + retry
async function loadMyOrders(retryCount = 0) {
  if (!currentUser) return;
  const MAX_RETRY = 3;
  const container = document.getElementById("myOrders");
  if (!container) return;

  cacheClear("myOrders_" + currentUser.phone);

  if (retryCount === 0) {
    container.innerHTML = `
      <div style="padding:0 16px">
        ${Array(3).fill(`
          <div class="skeleton-card" style="margin-bottom:10px;padding:14px">
            <div style="display:flex;justify-content:space-between;margin-bottom:10px">
              <div><div class="skeleton-line" style="width:120px;margin-bottom:8px"></div><div class="skeleton-line short" style="width:80px"></div></div>
              <div><div class="skeleton-line" style="width:70px;margin-bottom:8px"></div><div class="skeleton-line short" style="width:60px"></div></div>
            </div>
            <div class="skeleton-line" style="width:90%"></div>
          </div>`).join("")}
      </div>`;
  } else {
    const msg = container.querySelector(".retry-msg");
    if (!msg) {
      const p = document.createElement("p");
      p.className = "retry-msg";
      p.style.cssText = "text-align:center;padding:8px;font-size:13px;color:var(--soft)";
      p.textContent = `🔄 กำลังเชื่อมต่อ... (${retryCount}/${MAX_RETRY})`;
      container.insertAdjacentElement("afterbegin", p);
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(
      `${GLOBAL_SCRIPT_URL}?action=getMyOrders&phone=${encodeURIComponent(currentUser.phone)}&_t=${Date.now()}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const data = await res.json();

    if (data.status !== "success") throw new Error(data.message || "error");

    const orders = data.orders || [];
    renderMyOrders(orders);
  } catch (err) {
    if (retryCount < MAX_RETRY) {
      setTimeout(() => loadMyOrders(retryCount + 1), (retryCount + 1) * 2000);
    } else {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <p>โหลดข้อมูลไม่สำเร็จ</p>
          <button class="btn-primary" style="width:auto;margin-top:10px;padding:8px 20px;font-size:13px"
            onclick="loadMyOrders()">ลองใหม่</button>
        </div>`;
    }
  }
}

function formatDate(val) {
  if (!val) return "—";
  try {
    const d = (val instanceof Date) ? val : new Date(val);
    if (isNaN(d.getTime())) return "—";
    const dd = String(d.getDate()).padStart(2,"0");
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const yy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2,"0");
    const min = String(d.getMinutes()).padStart(2,"0");
    return `${dd}/${mm}/${yy} ${hh}:${min}`;
  } catch(e) { return "—"; }
}

function getStatusClass(status) {
  const map = {
    pending:   "status-pending",
    confirmed: "status-confirmed",
    processing:"status-processing",
    shipped:   "status-shipped",
    completed: "status-completed",
    cancelled: "status-cancelled"
  };
  return map[status] || "status-pending";
}

function translateStatus(status) {
  const map = {
    pending:   "รอตรวจสอบ",
    confirmed: "ยืนยันแล้ว",
    processing:"กำลังเตรียม",
    shipped:   "จัดส่งแล้ว",
    completed: "สำเร็จ",
    cancelled: "ยกเลิก"
  };
  return map[status] || status || "—";
}

// เช็คว่าออเดอร์ "สำเร็จ" แล้วหรือไม่ (รองรับทั้งค่า completed และ สำเร็จ)
function isOrderCompleted(order) {
  return order?.status === "completed" || order?.status === "สำเร็จ";
}

// เช็คว่าออเดอร์ถูก "ยกเลิก" แล้วหรือไม่ (รองรับทั้งค่า cancelled และ ยกเลิก)
function isOrderCancelled(order) {
  return order?.status === "cancelled" || order?.status === "ยกเลิก";
}

// สร้าง HTML การ์ดออเดอร์ (ใช้ทั้งในรายการหลักและหัวข้อ สำเร็จแล้ว/ยกเลิกแล้ว)
function buildOrderCardV2(order) {
  const date      = formatDate(order.createdAt);
  const statusCls = getStatusClass(order.status);
  const itemTxt   = (order.items || []).map(i => `${i.name} x${i.qty}`).join(", ");
  const payLabel  = order.paymentMethod === "Cash" ? "💵 เงินสด" :
                    order.paymentMethod === "Bank" ? "🏦 โอนเงิน" :
                    order.paymentMethod || "—";

  const tl = buildTimeline(order.status);

  return `
    <div class="order-card-v2 ${statusCls}" id="ocard-${escHtml(order.id)}">
      <div class="order-card-v2-head" onclick="toggleOrderCard('${escHtml(order.id)}')">
        <div>
          <div class="order-v2-id">${escHtml(order.id)}</div>
          <div class="order-v2-date">${date} · ${payLabel}</div>
        </div>
        <div style="text-align:right">
          <div class="order-v2-total">฿${Number(order.total||0).toLocaleString()}</div>
          <span class="status-pill ${statusCls.replace("status-","pill-")}" style="margin-top:4px;display:inline-block">${translateStatus(order.status)}</span>
        </div>
      </div>
      ${itemTxt ? `<div class="order-v2-items">🛍️ ${escHtml(itemTxt)}</div>` : ""}
      <div class="order-timeline">
        <div class="timeline-steps">${tl}</div>
        <div class="order-v2-footer">
          <button class="btn-reorder" onclick="reorderItems('${escHtml(order.id)}')">🔄 สั่งซื้อซ้ำ</button>
          ${order.status === "pending" ? `
          <button onclick="cancelMyOrder('${escHtml(order.id)}')"
            style="margin-top:8px;font-size:12px;padding:6px 14px;
                   background:#fee2e2;color:#dc2626;border:1.5px solid #fca5a5;
                   border-radius:8px;cursor:pointer;font-family:'Sarabun',sans-serif">
            ❌ ยกเลิกออเดอร์
          </button>` : ""}
        </div>
      </div>
    </div>`;
}

// เปิด/ปิดหัวข้อ (สำเร็จแล้ว / ยกเลิกแล้ว)
function toggleOrderGroup(id) {
  document.getElementById(id)?.classList.toggle("open");
}

// ใส่ออเดอร์ลงในหัวข้อแยก (สำเร็จแล้ว / ยกเลิกแล้ว) — ซ่อนหัวข้อถ้าไม่มีรายการ
function fillOrderGroup(boxId, groupId, countId, orders, renderFn) {
  const box   = document.getElementById(boxId);
  const group = document.getElementById(groupId);
  const count = document.getElementById(countId);
  if (!box || !group) return;
  if (count) count.textContent = orders.length;
  if (!orders.length) {
    group.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  group.classList.remove("hidden");
  box.innerHTML = orders.map(renderFn).join("");
}

function renderMyOrders(orders) {
  const container = document.getElementById("myOrders");
  if (!container) return;
  orders = orders || [];

  // ออเดอร์ที่สำเร็จ/ยกเลิกแล้ว จะถูกย้ายไปอยู่ในหัวข้อแยกด้านล่างแทน
  const completed = orders.filter(isOrderCompleted);
  const cancelled = orders.filter(isOrderCancelled);
  const active    = orders.filter(o => !isOrderCompleted(o) && !isOrderCancelled(o));

  container.innerHTML = active.length
    ? active.map(buildOrderCardV2).join("")
    : `<div class="empty-state"><div class="empty-icon">📦</div><p>ยังไม่มีรายการสั่งซื้อ</p></div>`;

  fillOrderGroup("myOrdersCompleted", "myOrdersCompletedGroup", "myOrdersCompletedCount", completed, buildOrderCardV2);
  fillOrderGroup("myOrdersCancelled", "myOrdersCancelledGroup", "myOrdersCancelledCount", cancelled, buildOrderCardV2);
}

function toggleOrderCard(orderId) {
  const card = document.getElementById("ocard-" + orderId);
  if (!card) return;
  card.classList.toggle("expanded");
}

function buildTimeline(status) {
  const cancelled = status === "cancelled";
  const steps = cancelled ? [
    { key: "pending",   icon: "📋", label: "รอตรวจสอบ" },
    { key: "cancelled", icon: "❌", label: "ยกเลิก" }
  ] : [
    { key: "pending",   icon: "📋", label: "รอตรวจสอบ" },
    { key: "confirmed", icon: "✅", label: "ยืนยัน" },
    { key: "shipped",   icon: "🚚", label: "จัดส่ง" },
    { key: "completed", icon: "🎉", label: "สำเร็จ" }
  ];

  const order_map = ["pending","confirmed","processing","shipped","completed"];
  const curIdx = cancelled ? 1 : Math.max(order_map.indexOf(status), 0);

  return steps.map((step, i) => {
    let cls = "";
    if (cancelled && i === 1) cls = "cancelled";
    else if (i < curIdx || (!cancelled && status === "completed" && i === steps.length-1)) cls = "done";
    else if (!cancelled && order_map.indexOf(status) >= 0) {
      const mapped = step.key === "shipped" && (status === "processing" || status === "shipped") ? true
                   : step.key === status;
      cls = mapped ? "active" : (i < curIdx ? "done" : "");
    }
    return `<div class="tl-step ${cls}"><div class="tl-dot">${step.icon}</div><div class="tl-label">${step.label}</div></div>`;
  }).join("");
}

async function cancelMyOrder(orderId) {
  if (!currentUser) { showToast("กรุณาเข้าสู่ระบบก่อน"); return; }
  if (!confirm(`ยืนยันการยกเลิกออเดอร์ ${orderId}?`)) return;

  const reason = prompt("เหตุผลการยกเลิก (ถ้ามี):", "") || "";
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "cancelOrder",
        phone: currentUser.phone,
        orderId,
        reason
      })
    });
    const data = await res.json();
    if (data.status === "success") {
      showToast("ยกเลิกออเดอร์แล้ว ✅");
      cacheClear("myOrders_" + currentUser.phone);
      await loadMyOrders();
    } else {
      showToast(data.message || "ยกเลิกไม่สำเร็จ");
    }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
}

function reorderItems(orderId) {
  // ค้นหาออเดอร์จาก DOM หรือ state — ต้อง fetch fresh
  showToast("⏳ กำลังโหลดรายการ...");
  fetch(`${GLOBAL_SCRIPT_URL}?action=getMyOrders&phone=${encodeURIComponent(currentUser?.phone||"")}&_t=${Date.now()}`)
    .then(r => r.json())
    .then(data => {
      const orders = data.orders || [];
      const order  = orders.find(o => String(o.id) === String(orderId));
      if (!order || !order.items?.length) { showToast("ไม่พบรายการสินค้า"); return; }
      let added = 0;
      order.items.forEach(item => {
        const prod = products.find(p => String(p.id) === String(item.id) || p.name === item.name);
        if (prod && prod.stock > 0) {
          const found = cart.find(c => String(c.id) === String(prod.id));
          if (found) found.qty = Math.min(found.qty + (item.qty||1), prod.stock);
          else cart.push({ ...prod, qty: Math.min(item.qty||1, prod.stock) });
          added++;
        }
      });
      saveCartToStorage(); updateCartBadge();
      if (added) {
        showToast(`🛒 เพิ่ม ${added} รายการในตะกร้าแล้ว`);
        setTimeout(() => switchPage("cart"), 800);
      } else {
        showToast("สินค้าหมดทุกรายการแล้ว 😔");
      }
    })
    .catch(() => showToast("เกิดข้อผิดพลาด"));
}

// ADMIN — ANALYTICS + 7-DAY CHART + STOCK ALERT
let _adminSalesChart = null;
let _chartMode = "sales"; // "sales" | "orders"
let _chartData7 = { days: [], sales: [], orders: [] };
let _stockThreshold = parseInt(localStorage.getItem("pan_stockThreshold") || "5");

async function loadAnalytics() {
  if (!currentUser || currentUser.role !== "admin") return;
  try {
    const res  = await fetch(`${GLOBAL_SCRIPT_URL}?action=getAdminAnalytics&phone=${currentUser.phone}`);
    const data = await res.json();
    if (data.status === "success") {
      const a = data.analytics;
      setEl("todaySales",  `฿${(a.today?.sales  || 0).toLocaleString()}`);
      setEl("monthSales",  `฿${(a.month?.sales  || 0).toLocaleString()}`);
      setEl("totalSales",  `฿${(a.total?.sales  || 0).toLocaleString()}`);
      setEl("todayOrders", `${a.today?.orders || 0} ออเดอร์`);
      setEl("monthOrders", `${a.month?.orders || 0} ออเดอร์`);
      setEl("totalOrders", `${a.total?.orders || 0} ออเดอร์`);
      if (a.pending !== undefined) setEl("pendingOrders", `${a.pending} รายการ`);

      build7DayChart(adminOrders.length ? adminOrders : (a.recentOrders || []));
    }
  } catch (err) { console.error("loadAnalytics:", err); }

  renderStockAlert();
}

// ---------- 7-DAY CHART ----------
function build7DayChart(orders) {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    days.push(d);
  }

  const salesByDay  = days.map(() => 0);
  const ordersByDay = days.map(() => 0);

  orders.forEach(o => {
    if (!o.createdAt) return;
    // นับเข้ากราฟเฉพาะออเดอร์ที่ "สำเร็จ" แล้วเท่านั้น
    if (!isOrderCompleted(o)) return;
    const od = new Date(o.createdAt);
    days.forEach((d, idx) => {
      if (od.getFullYear() === d.getFullYear() &&
          od.getMonth()    === d.getMonth()    &&
          od.getDate()     === d.getDate()) {
        const total = Number(o.total || 0);
        if (!isNaN(total)) salesByDay[idx] += total;
        ordersByDay[idx]++;
      }
    });
  });

  _chartData7 = {
    days: days.map((d, i) => {
      const dd = d.getDate();
      const mm = d.getMonth() + 1;
      return { label: `${dd}/${mm}`, isToday: i === 6 };
    }),
    sales: salesByDay,
    orders: ordersByDay
  };

  const todaySales = salesByDay[6];
  const yestSales  = salesByDay[5];
  const trendEl    = document.getElementById("chartTrendLabel");
  if (trendEl) {
    if (yestSales > 0) {
      const diff = todaySales - yestSales;
      const pct  = Math.abs((diff / yestSales * 100)).toFixed(0);
      trendEl.textContent = diff >= 0
        ? `▲ +${pct}% จากเมื่อวาน`
        : `▼ -${pct}% จากเมื่อวาน`;
      trendEl.style.color = diff >= 0 ? "var(--green)" : "var(--red)";
    } else {
      trendEl.textContent = todaySales > 0 ? "วันแรกที่มียอดขาย 🎉" : "ยังไม่มียอดขายวันนี้";
      trendEl.style.color = "var(--soft)";
    }
  }

  renderAdminChart();
}

function setChartMode(mode, btn) {
  _chartMode = mode;
  document.querySelectorAll(".chart-mode-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  renderAdminChart();
}

function renderAdminChart() {
  const canvas = document.getElementById("adminSalesChart");
  if (!canvas) return;

  const isDark    = document.documentElement.getAttribute("data-theme") === "dark";
  const gridColor = isDark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)";
  const textColor = isDark ? "#78716c" : "#a8a29e";
  const isSales   = _chartMode === "sales";
  const values    = isSales ? _chartData7.sales : _chartData7.orders;
  const maxVal    = Math.max(...values, 1);

  const labelsEl = document.getElementById("chartDayLabels");
  if (labelsEl) {
    labelsEl.innerHTML = _chartData7.days.map(d =>
      `<div class="chart-day-label ${d.isToday ? "today" : ""}">${d.isToday ? "วันนี้" : d.label}</div>`
    ).join("");
  }

  if (_adminSalesChart) _adminSalesChart.destroy();

  const pointBg = _chartData7.days.map((d, i) =>
    d.isToday ? "#f97316" : (values[i] > 0 ? "#fed7aa" : "transparent")
  );
  const pointR = _chartData7.days.map(d => d.isToday ? 5 : 3);

  _adminSalesChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: _chartData7.days.map(d => d.isToday ? "วันนี้" : d.label),
      datasets: [
        {
          type: "bar",
          label: isSales ? "ยอดขาย (฿)" : "จำนวนออเดอร์",
          data: values,
          backgroundColor: _chartData7.days.map((d, i) =>
            d.isToday ? "rgba(249,115,22,.9)" :
            values[i] > 0 ? "rgba(249,115,22,.35)" : "rgba(0,0,0,.06)"
          ),
          borderRadius: 6,
          borderSkipped: false,
          order: 2
        },
        {
          type: "line",
          label: "เส้นแนวโน้ม",
          data: values,
          borderColor: "#f97316",
          borderWidth: 2,
          tension: 0.4,
          pointBackgroundColor: pointBg,
          pointRadius: pointR,
          pointHoverRadius: 6,
          fill: false,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ctx.datasetIndex === 0
              ? (isSales ? ` ฿${Number(ctx.raw).toLocaleString()}` : ` ${ctx.raw} ออเดอร์`)
              : null,
            title: ctx => ctx[0]?.label
          },
          filter: item => item.datasetIndex === 0
        }
      },
      scales: {
        x: {
          display: false,
          grid: { display: false }
        },
        y: {
          display: true,
          position: "right",
          min: 0,
          max: maxVal * 1.25,
          grid: { color: gridColor },
          ticks: {
            maxTicksLimit: 3,
            color: textColor,
            font: { size: 9, family: "IBM Plex Mono" },
            callback: v => isSales ? (v >= 1000 ? `฿${(v/1000).toFixed(0)}k` : `฿${v}`) : `${v}`
          },
          border: { display: false }
        }
      }
    }
  });
}

// ---------- STOCK ALERT ----------
function renderStockAlert() {
  const banner    = document.getElementById("stockAlertBanner");
  const listEl    = document.getElementById("stockAlertList");
  const countEl   = document.getElementById("stockAlertCount");
  if (!banner || !listEl || !countEl) return;

  const lowStock = products
    .filter(p => p.active !== false && p.active !== "FALSE" && Number(p.stock) <= _stockThreshold)
    .sort((a, b) => Number(a.stock) - Number(b.stock));

  if (!lowStock.length) {
    banner.classList.add("hidden");
    return;
  }

  banner.classList.remove("hidden");
  countEl.textContent = `${lowStock.length} รายการ`;

  listEl.innerHTML = `
    <div class="stock-alert-threshold">
      <span>แจ้งเตือนเมื่อสต็อก ≤</span>
      <input type="number" min="0" max="99" value="${_stockThreshold}"
        onchange="setStockThreshold(this.value)"/>
      <span>ชิ้น</span>
    </div>` +
    lowStock.map(p => {
      const qty = Number(p.stock);
      const cls = qty <= 0 ? "critical" : qty <= 2 ? "low" : "warn";
      const label = qty <= 0 ? "หมดแล้ว!" : `${qty} ${p.unit || "ชิ้น"}`;
      return `
        <div class="stock-alert-item">
          <div class="stock-alert-name">📦 ${escHtml(p.name)}</div>
          <span class="stock-alert-qty ${cls}">${label}</span>
        </div>`;
    }).join("");
}

function setStockThreshold(val) {
  _stockThreshold = Math.max(0, parseInt(val) || 5);
  localStorage.setItem("pan_stockThreshold", _stockThreshold);
  renderStockAlert();
}

function toggleStockAlert() {
  const banner = document.getElementById("stockAlertBanner");
  const list   = document.getElementById("stockAlertList");
  if (!banner || !list) return;
  const isOpen = banner.classList.contains("open");
  banner.classList.toggle("open", !isOpen);
  list.classList.toggle("hidden", isOpen);
}

// ADMIN — ORDERS + ✅ SEARCH
async function loadAdminOrders() {
  if (!currentUser || currentUser.role !== "admin") return;
  const container = document.getElementById("adminOrderListMain");
  if (!container) return;
  container.innerHTML = `<div class="loading-state" style="padding:24px 0"><div class="spinner"></div><p>กำลังโหลด...</p></div>`;

  try {
    // ✅ Fix 7: ส่ง search query ไปกับ server ด้วย เพื่อให้ครอบคลุมออเดอร์เก่าที่ยังไม่ได้โหลด
    const q   = encodeURIComponent(adminOrderSearchQuery || "");
    const res = await fetch(`${GLOBAL_SCRIPT_URL}?action=getAllOrders&phone=${currentUser.phone}&q=${q}`);
    const data = await res.json();
    if (data.status === "success") {
      adminOrders = data.orders || [];
      renderAdminOrders();
      build7DayChart(adminOrders);
    } else {
      container.innerHTML = `<div class="empty-state"><p style="color:var(--red)">${data.message||"โหลดไม่สำเร็จ"}</p></div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p style="color:var(--red)">เกิดข้อผิดพลาด</p></div>`;
  }
}

let _searchDebounceTimer = null;
function searchAdminOrders(q) {
  adminOrderSearchQuery = (q || "").toLowerCase().trim();
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    loadAdminOrders();
  }, 400);
}

function filterAdminOrders(filter, btn) {
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  currentAdminOrderFilter = filter;
  renderAdminOrders();
}

// สร้าง HTML การ์ดออเดอร์ (สำหรับฝั่งแอดมิน)
function buildAdminOrderCard(order) {
  const statusCls = getStatusClass(order.status);
  const statusTxt = translateStatus(order.status);
  const date      = formatDate(order.createdAt);
  const itemTxt   = (order.items || []).map(i => `${i.name||i.id} x${i.qty}`).join(", ") || "—";
  const slipNormalized = normalizeDriveUrl(order.slip);
  const slipCandidates = order.slip ? getSlipUrlCandidates(order.slip) : [];
  const slipHtml  = order.slip
    ? `<img class="slip-thumb" src="${escHtml(slipCandidates[0])}" alt="slip" referrerpolicy="no-referrer"
        data-slip-urls='${escHtml(JSON.stringify(slipCandidates))}' data-slip-idx="0" data-slip-open="${escHtml(slipNormalized)}"
        onclick="event.stopPropagation();viewSlip('${escHtml(slipNormalized)}')"
        onerror="slipImgError(this)">`
    : `<div class="no-slip" title="ไม่มีสลิป">—</div>`;

  return `
    <div class="admin-order-card ${statusCls}" onclick="openAdminOrderModal('${order.id}')">
      <div class="order-card-top">
        <div>
          <div class="order-card-id">${order.id}</div>
          <div class="order-card-meta">${order.customerName || order.phone} · ${date}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${slipHtml}
          <span class="status-pill ${statusCls.replace("status-","pill-")}">${statusTxt}</span>
        </div>
      </div>
      <div class="order-card-items">🛍️ ${itemTxt}</div>
      <div class="order-card-bottom">
        <span style="font-size:12px;color:var(--mid)">${order.paymentMethod||"COD"}</span>
        <span class="order-card-total">฿${Number(order.total||0).toLocaleString()}</span>
      </div>
    </div>`;
}

function renderAdminOrders() {
  const container = document.getElementById("adminOrderListMain");
  if (!container) return;

  let list = adminOrders;

  // filter สถานะ
  if (currentAdminOrderFilter !== "all") {
    list = list.filter(o => o.status === currentAdminOrderFilter);
  }

  if (adminOrderSearchQuery) {
    const q = adminOrderSearchQuery;
    list = list.filter(o => {
      const itemsText = (o.items || []).map(i => (i.name || "").toLowerCase()).join(" ");
      return (
        String(o.id).toLowerCase().includes(q) ||
        String(o.phone || "").toLowerCase().includes(q) ||
        String(o.customerName || "").toLowerCase().includes(q) ||
        String(o.address || "").toLowerCase().includes(q) ||
        itemsText.includes(q)
      );
    });
  }

  // เมื่อดูแท็บ "ทั้งหมด" — แยกออเดอร์ที่สำเร็จ/ยกเลิกแล้วไปไว้ในหัวข้อด้านล่างแทน
  let completed = [], cancelled = [];
  if (currentAdminOrderFilter === "all") {
    completed = list.filter(isOrderCompleted);
    cancelled = list.filter(isOrderCancelled);
    list = list.filter(o => !isOrderCompleted(o) && !isOrderCancelled(o));
  }

  container.innerHTML = list.length
    ? list.map(buildAdminOrderCard).join("")
    : `<div class="empty-state"><p>${adminOrderSearchQuery ? "ไม่พบผลลัพธ์" : "ไม่มีออเดอร์"}</p></div>`;

  fillOrderGroup("adminOrdersCompleted", "adminOrdersCompletedGroup", "adminOrdersCompletedCount", completed, buildAdminOrderCard);
  fillOrderGroup("adminOrdersCancelled", "adminOrdersCancelledGroup", "adminOrdersCancelledCount", cancelled, buildAdminOrderCard);
}

// เปิด modal ออเดอร์
function openAdminOrderModal(orderId) {
  const order = adminOrders.find(o => String(o.id) === String(orderId));
  if (!order) return;

  const itemsHtml = (order.items || []).map((item) => `
    <div class="order-item-row">
      <div class="order-item-name">${item.name || item.id}</div>
      <div style="font-size:11px;color:var(--soft)">x${item.qty}</div>
      <div class="order-item-price">฿${Number((item.salePrice||item.price||0) * item.qty).toLocaleString()}</div>
    </div>`).join("") || "<p style='color:var(--soft);font-size:13px'>ไม่มีรายการ</p>";

  const slipNorm = normalizeDriveUrl(order.slip);
  const slipCandidatesModal = order.slip ? getSlipUrlCandidates(order.slip) : [];
  const slipFallbackId = `slipOpenFallback_${escHtml(order.id)}`;
  const slipHtml = order.slip
    ? `<div style="margin:8px 0">
        <img src="${escHtml(slipCandidatesModal[0])}" alt="slip" referrerpolicy="no-referrer"
          style="max-width:100%;border-radius:12px;cursor:pointer;display:block"
          data-slip-urls='${escHtml(JSON.stringify(slipCandidatesModal))}' data-slip-idx="0" data-slip-mode="modal" data-slip-fallback="${slipFallbackId}"
          onclick="viewSlip('${escHtml(slipNorm)}')"
          onerror="slipImgError(this)"/>
        <div id="${slipFallbackId}" style="display:none;margin-top:6px;padding:10px;background:var(--bg2);border-radius:8px;text-align:center">
          <div style="font-size:13px;color:var(--soft);margin-bottom:6px">รูปโหลดไม่ได้จาก embed — กดลิงก์เพื่อดู</div>
        </div>
        <a href="${escHtml(slipNorm)}" target="_blank" style="display:inline-block;margin-top:8px;font-size:12px;color:var(--blue);font-weight:600">🔗 เปิดสลิปเต็มจอ</a>
      </div>`
    : `<div style="font-size:12px;color:var(--soft);margin:8px 0">ไม่มีสลิป</div>`;

  document.getElementById("adminOrderDetail").innerHTML = `
    <div style="font-size:12px;color:var(--soft);margin-bottom:12px">
      🆔 ${order.id} · ${formatDate(order.createdAt)}
    </div>
    <div class="order-detail-section">
      <h4>👤 ข้อมูลลูกค้า</h4>
      <div class="form-group">
        <label>ชื่อลูกค้า</label>
        <input id="oe_customerName" value="${escHtml(order.customerName||"")}"/>
      </div>
      <div class="form-group">
        <label>เบอร์โทร</label>
        <input id="oe_phone" value="${escHtml(order.phone||"")}" readonly style="opacity:.6"/>
      </div>
      <div class="form-group">
        <label>ที่อยู่จัดส่ง</label>
        <textarea id="oe_address" rows="3">${escHtml(order.address||"")}</textarea>
      </div>
    </div>
    <div class="order-detail-section">
      <h4>📦 รายการสินค้า</h4>
      ${itemsHtml}
      <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:8px;display:flex;justify-content:space-between;font-size:13px">
        <span>ค่าส่ง</span><span>฿${Number(order.shippingFee||0).toLocaleString()}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-family:'Mitr',sans-serif;font-weight:600">
        <span>รวม</span><span style="color:var(--orange)">฿${Number(order.total||0).toLocaleString()}</span>
      </div>
    </div>
    <div class="order-detail-section">
      <h4>💳 การชำระเงิน</h4>
      <div class="form-group">
        <label>วิธีชำระ</label>
        <select id="oe_paymentMethod">
          <option value="Cash" ${order.paymentMethod==="Cash"?"selected":""}>💵 เงินสดหน้าร้าน</option>
          <option value="COD" ${order.paymentMethod==="COD"?"selected":""}>🛵 เก็บเงินปลายทาง</option>
          <option value="Bank" ${order.paymentMethod==="Bank"?"selected":""}>🏦 โอนธนาคาร</option>
        </select>
      </div>
      <div style="font-size:12px;color:var(--mid);margin-bottom:6px">สลิปโอนเงิน:</div>
      ${slipHtml}
    </div>
    <div class="order-detail-section">
      <h4>📋 สถานะ & หมายเหตุ</h4>
      <div class="form-group">
        <label>สถานะ</label>
        <select id="oe_status">
          <option value="pending"    ${order.status==="pending"   ?"selected":""}>รอตรวจสอบ</option>
          <option value="confirmed"  ${order.status==="confirmed" ?"selected":""}>ยืนยันแล้ว</option>
          <option value="processing" ${order.status==="processing"?"selected":""}>กำลังเตรียม</option>
          <option value="shipped"    ${order.status==="shipped"   ?"selected":""}>จัดส่งแล้ว</option>
          <option value="completed"  ${order.status==="completed" ?"selected":""}>สำเร็จ</option>
          <option value="cancelled"  ${order.status==="cancelled" ?"selected":""}>ยกเลิก</option>
        </select>
      </div>
      <div class="form-group">
        <label>หมายเหตุ</label>
        <textarea id="oe_note" rows="2">${escHtml(order.note||"")}</textarea>
      </div>
      <div class="form-group">
        <label>เวลานัดส่ง</label>
        <input id="oe_deliveryTime" value="${escHtml(order.deliveryTime||"")}"/>
      </div>
    </div>
    <input type="hidden" id="oe_orderId" value="${order.id}"/>
  `;

  openModal("adminOrderModal");
}

async function saveOrderEditLocal() {
  const orderId = document.getElementById("oe_orderId").value;
  const order   = adminOrders.find(o => String(o.id) === String(orderId));
  if (!order) return;

  const update = {
    orderId,
    customerName:  document.getElementById("oe_customerName").value.trim(),
    address:       document.getElementById("oe_address").value.trim(),
    paymentMethod: document.getElementById("oe_paymentMethod").value,
    status:        document.getElementById("oe_status").value,
    note:          document.getElementById("oe_note").value.trim(),
    deliveryTime:  document.getElementById("oe_deliveryTime").value.trim(),
    items:         order.items,
    subtotal:      order.subtotal,
    shippingFee:   order.shippingFee,
    discount:      order.discount,
    total:         order.total
  };

  Object.assign(order, {
    customerName:  update.customerName,
    address:       update.address,
    paymentMethod: update.paymentMethod,
    status:        update.status,
    note:          update.note,
    deliveryTime:  update.deliveryTime
  });

  renderAdminOrders();

  const btn = document.querySelector("#adminOrderModal .btn-primary");
  if (btn) { btn.textContent = "กำลังบันทึก..."; btn.disabled = true; }
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action: "adminEditOrder", phone: currentUser?.phone || "", ...update })
    });
    const data = await res.json();
    if (data.status === "success") {
      closeAllModals();
      showToast("บันทึกออเดอร์แล้ว ✅");
    } else { showToast(data.message || "บันทึกไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
  finally { if (btn) { btn.textContent = "💾 บันทึก"; btn.disabled = false; } }
}

// ADMIN — CUSTOMERS
let adminCustomers  = [];

async function loadAdminCustomers() {
  if (!currentUser || currentUser.role !== "admin") return;
  const container = document.getElementById("adminCustomerList");
  if (!container) return;
  container.innerHTML = `<div class="loading-state" style="padding:24px 0"><div class="spinner"></div><p>กำลังโหลด...</p></div>`;

  try {
    const res  = await fetch(`${GLOBAL_SCRIPT_URL}?action=getCustomers&phone=${currentUser.phone}`);
    const data = await res.json();
    if (data.status === "success") {
      adminCustomers = data.customers || [];
      renderCustomerList(adminCustomers);
    } else {
      container.innerHTML = `<div class="empty-state"><p style="color:var(--red)">${data.message||"โหลดไม่สำเร็จ"}</p></div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p style="color:var(--red)">เกิดข้อผิดพลาด</p></div>`;
  }
}

function renderCustomerList(list) {
  const container = document.getElementById("adminCustomerList");
  if (!container) return;
  container.innerHTML = "";
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><p>ไม่มีลูกค้า</p></div>`;
    return;
  }
  list.forEach(cust => {
    const addrCount = (cust.addresses||[]).length;
    const role      = cust.role === "admin" ? "🔑 แอดมิน" : "👤 ลูกค้า";
    const status    = cust.status === "active" ? "✅" : "🚫";
    const lastLogin = formatDate(cust.lastLogin);
    container.innerHTML += `
      <div class="admin-order-card" onclick="openCustomerModal('${cust.phone}')">
        <div class="order-card-top">
          <div>
            <div class="order-card-id">${cust.name || "ไม่มีชื่อ"}</div>
            <div class="order-card-meta">📞 ${cust.phone}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:12px">${role} ${status}</div>
            <div style="font-size:11px;color:var(--soft)">เข้าล่าสุด: ${lastLogin}</div>
          </div>
        </div>
        <div style="display:flex;gap:12px;margin-top:8px;font-size:12px;color:var(--mid)">
          <span>📍 ${addrCount} ที่อยู่</span>
          <span>❤️ ${(cust.favorites||[]).length} รายการโปรด</span>
        </div>
      </div>`;
  });
}

function searchAdminCustomers(kw) {
  const q = (kw||"").toLowerCase().trim();
  if (!q) { renderCustomerList(adminCustomers); return; }
  renderCustomerList(adminCustomers.filter(c =>
    (c.name||"").toLowerCase().includes(q) || String(c.phone).includes(q)
  ));
}

function openCustomerModal(phone) {
  const cust = adminCustomers.find(c => String(c.phone) === String(phone));
  if (!cust) return;

  const addrsHtml = (cust.addresses||[]).map((a, i) =>
    `<div style="background:var(--bg);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:13px">
      <b>${a.label||`ที่อยู่ ${i+1}`}</b>${a.isDefault?" ⭐":""}<br>${escHtml(a.detail||"")}
    </div>`
  ).join("") || `<p style="font-size:13px;color:var(--soft)">ยังไม่มีที่อยู่</p>`;

  const favHtml = (cust.favorites||[]).length
    ? `<div style="font-size:13px;color:var(--mid)">${cust.favorites.join(", ")}</div>`
    : `<p style="font-size:13px;color:var(--soft)">ยังไม่มีรายการโปรด</p>`;

  document.getElementById("customerDetail").innerHTML = `
    <div class="order-detail-section">
      <h4>👤 ข้อมูลส่วนตัว</h4>
      <div class="form-group">
        <label>ชื่อ-นามสกุล</label>
        <input id="ce_name" value="${escHtml(cust.name||"")}"/>
      </div>
      <div class="form-group">
        <label>เบอร์โทร (ไม่สามารถเปลี่ยนได้)</label>
        <input id="ce_phone" value="${escHtml(cust.phone||"")}" readonly style="opacity:.6"/>
      </div>
      <div class="form-group">
        <label>รีเซ็ตรหัสผ่าน (เว้นว่างเพื่อไม่เปลี่ยน)</label>
        <input id="ce_password" type="password" placeholder="รหัสผ่านใหม่"/>
      </div>
      <div class="form-group">
        <label>สิทธิ์</label>
        <select id="ce_role">
          <option value="user"  ${cust.role==="user" ?"selected":""}>👤 ลูกค้า</option>
          <option value="admin" ${cust.role==="admin"?"selected":""}>🔑 แอดมิน</option>
        </select>
      </div>
      <div class="form-group">
        <label>สถานะ</label>
        <select id="ce_status">
          <option value="active"   ${cust.status==="active"  ?"selected":""}>✅ ใช้งาน</option>
          <option value="inactive" ${cust.status==="inactive"?"selected":""}>🚫 ระงับ</option>
        </select>
      </div>
    </div>
    <div class="order-detail-section">
      <h4>📍 ที่อยู่ที่บันทึกไว้</h4>
      ${addrsHtml}
    </div>
    <div class="order-detail-section">
      <h4>❤️ รายการโปรด</h4>
      ${favHtml}
    </div>
    <div class="order-detail-section">
      <h4>📊 สถิติ</h4>
      <div style="display:flex;gap:12px;font-size:13px;color:var(--mid)">
        <span>🕐 สมัคร: ${formatDate(cust.createdAt)}</span>
        <span>🔓 เข้าล่าสุด: ${formatDate(cust.lastLogin)}</span>
      </div>
    </div>
    <input type="hidden" id="ce_phone_key" value="${cust.phone}"/>
  `;
  openModal("customerModal");
}

async function saveCustomerEditLocal() {
  const phone    = document.getElementById("ce_phone_key").value;
  const cust     = adminCustomers.find(c => String(c.phone) === String(phone));
  if (!cust) return;

  const name     = document.getElementById("ce_name").value.trim();
  const password = document.getElementById("ce_password").value.trim();
  const role     = document.getElementById("ce_role").value;
  const status   = document.getElementById("ce_status").value;

  cust.name   = name;
  cust.role   = role;
  cust.status = status;

  const payload = { phone, name, role, status, adminPhone: currentUser.phone };
  if (password) payload.password = password;

  renderCustomerList(adminCustomers.filter(c => {
    const q = (document.getElementById("customerSearchInput")?.value||"").toLowerCase();
    return !q || (c.name||"").toLowerCase().includes(q) || String(c.phone).includes(q);
  }));

  const btn = document.querySelector("#customerModal .btn-primary");
  if (btn) { btn.textContent = "กำลังบันทึก..."; btn.disabled = true; }
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action: "updateCustomer", ...payload })
    });
    const data = await res.json();
    if (data.status === "success") {
      closeAllModals();
      showToast("บันทึกข้อมูลลูกค้าแล้ว ✅");
    } else { showToast(data.message || "บันทึกไม่สำเร็จ"); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
  finally { if (btn) { btn.textContent = "💾 บันทึก"; btn.disabled = false; } }
}

function viewSlip(url) {
  document.getElementById("slipViewImg").src   = url;
  document.getElementById("slipViewLink").href = url;
  openModal("slipViewModal");
}

// ADMIN — PRODUCTS + ✅ SORT
function switchAdminTab(tab, btn) {
  document.querySelectorAll(".admin-tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  const tabMap = {
    orders:    "adminTabOrders",
    products:  "adminTabProducts",
    customers: "adminTabCustomers",
    store:     "adminTabStore"
  };
  Object.keys(tabMap).forEach(key => {
    document.getElementById(tabMap[key])?.classList.toggle("hidden", key !== tab);
  });
  if (tab === "products")  { (async () => { await loadProducts(); renderAdminProducts(); populateCategorySelect(); })(); }
  if (tab === "store")     { fillStoreConfigForms(); loadAdminCategories(); injectAdminCardStylePicker(); }
  if (tab === "orders")    { loadAdminOrders(); }
  if (tab === "customers") { loadAdminCustomers(); }
}

function renderAdminProducts() {
  const container = document.getElementById("adminProductList");
  const count     = document.getElementById("adminProductCount");
  if (!container) return;
  container.innerHTML = "";
  if (count) count.textContent = products.length ? `${products.length} รายการ` : "";

  if (!products.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>ยังไม่มีสินค้า</p></div>`;
    return;
  }
  products.forEach(product => {
    const img = normalizeDriveUrl(product.image) || "";
    container.innerHTML += `
      <div class="product-card">
        <div class="p-img-wrap">
          <img src="${img || NO_IMG_PLACEHOLDER}" alt="${product.name}" loading="lazy" onerror="imgFallback(this)">
          ${product.recommended ? `<div class="p-badge">⭐</div>` : ""}
        </div>
        <div class="product-info">
          <div class="product-name">${product.name}</div>
          <div class="product-price" style="margin-bottom:2px">฿${Number(product.price).toLocaleString()}</div>
          <div style="font-size:11px;color:var(--soft);margin-bottom:2px">สต๊อก: ${product.stock} ${product.unit||""}</div>
          <div style="font-size:11px;color:var(--mid);margin-bottom:8px">ลำดับ:
            <input type="number" value="${product.sort||0}" min="0"
              style="width:50px;padding:2px 6px;border:1px solid var(--border);border-radius:6px;font-size:11px;text-align:center"
              onchange="updateLocalProductSort('${product.id}', this.value)"
              onclick="event.stopPropagation()"/>
          </div>
          <div style="display:flex;gap:6px">
            <button class="buy-btn" style="flex:1;border-radius:10px;font-size:12px;width:auto" onclick="editProductForm('${product.id}')">✏️</button>
            <button class="buy-btn" style="flex:1;border-radius:10px;font-size:12px;width:auto;background:var(--red)" onclick="deleteProductConfirm('${product.id}')">🗑️</button>
          </div>
        </div>
      </div>`;
  });
}

let _pendingSorts = {};

function updateLocalProductSort(id, val) {
  const p = products.find(p => String(p.id) === id);
  if (p) p.sort = Number(val) || 0;
  _pendingSorts[id] = Number(val) || 0;

  const btn = document.getElementById("saveSortBtn");
  if (btn) btn.disabled = false;
}

async function saveProductSort() {
  if (!Object.keys(_pendingSorts).length) return;
  const btn = document.getElementById("saveSortBtn");
  if (!btn) return;
  btn.disabled = true; btn.textContent = "⏳ กำลังบันทึก...";

  const sorts = Object.keys(_pendingSorts).map(id => ({ id, sort: _pendingSorts[id] }));

  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action: "updateProductSort", sorts, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") {
      _pendingSorts = {};
      products.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'th'));
      renderAdminProducts();
      renderProductList(products);
      showToast("บันทึกลำดับสินค้าแล้ว ✅");
    } else { showToast(data.message || "บันทึกไม่สำเร็จ"); btn.disabled = false; }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); btn.disabled = false; }
  finally { btn.textContent = "💾 บันทึกลำดับ"; }
}

function editProductForm(id) {
  const p = products.find(p => String(p.id) === String(id));
  if (!p) return;
  setVal("productName",       p.name);
  setVal("productDesc",       p.description  || "");
  setVal("productPrice",      p.price);
  setVal("productSalePrice",  p.salePrice    || "");
  setVal("productStock",      p.stock);
  setVal("productUnit",       p.unit         || "");
  setVal("productImage",      (p.images?.length) ? p.images.join("|") : p.image || ""); // ✅ Fix 5: check length
  setVal("productSort",       p.sort         || 0);
  setVal("editingProductId",  p.id);
  document.getElementById("productCategory").value     = p.category || "";
  document.getElementById("productRecommended").checked = !!p.recommended;
  document.getElementById("productActive").checked      = true;
  setEl("productFormTitle", "✏️ แก้ไขสินค้า");
  document.getElementById("adminTabProducts").scrollIntoView({ behavior:"smooth" });
  pendingProductSave = null;
  _productImgFile = null;
  const _prev = document.getElementById("productImgPreview");
  if (_prev) _prev.style.display = "none";
  const _pSt = document.getElementById("productImgUploadStatus");
  if (_pSt) _pSt.textContent = "";
  const _upB = document.getElementById("uploadProductImgBtn");
  if (_upB) { _upB.disabled = true; _upB.textContent = "☁️ อัปโหลด"; }
  document.getElementById("productImgFile").value = "";
  showToast("โหลดข้อมูลสินค้าแล้ว กด 💾 เพื่อบันทึก");
}

async function saveProductLocal() {
  const name        = document.getElementById("productName").value.trim();
  const description = document.getElementById("productDesc").value.trim();
  const price       = Number(document.getElementById("productPrice").value) || 0;
  const salePrice   = Number(document.getElementById("productSalePrice").value) || 0;
  const stock       = Number(document.getElementById("productStock").value) || 0;
  const unit        = document.getElementById("productUnit").value.trim();
  const category    = document.getElementById("productCategory").value;
  const sort        = Number(document.getElementById("productSort").value) || 0;
  const recommended = document.getElementById("productRecommended").checked;
  const active      = document.getElementById("productActive").checked;
  const id          = document.getElementById("editingProductId").value.trim();

  if (!name)  { showToast("กรุณากรอกชื่อสินค้า"); return; }
  if (!price) { showToast("กรุณากรอกราคา");       return; }

  const getSaveBtn = () => document.getElementById("saveProductBtn");
  const setBtnLoading = () => { const b = getSaveBtn(); if (b) { b.disabled = true;  b.textContent = "⏳ กำลังบันทึก..."; } };
  const setBtnReady   = () => { const b = getSaveBtn(); if (b) { b.disabled = false; b.textContent = "💾 บันทึก"; } };

  setBtnLoading();

  if (_productImgFile) {
    const statusEl = document.getElementById("productImgUploadStatus");
    if (statusEl) statusEl.textContent = "กำลังอัปโหลดรูป...";
    showToast("กำลังอัปโหลดรูปก่อนบันทึก...");

    const uploadedUrl = await uploadProductImageToDrive(_productImgFile);
    if (uploadedUrl) {
      const imgInput = document.getElementById("productImage");
      imgInput.value = (imgInput.value.trim() ? imgInput.value.trim() + "|" : "") + uploadedUrl;
      if (statusEl) statusEl.textContent = "✅ อัปโหลดสำเร็จ!";
      const upBtn = document.getElementById("uploadProductImgBtn");
      if (upBtn) { upBtn.textContent = "☁️ อัปโหลด"; upBtn.disabled = true; }
      _productImgFile = null;
      document.getElementById("productImgFile").value = "";
    } else {
      if (statusEl) statusEl.textContent = "❌ อัปโหลดไม่สำเร็จ";
      showToast("อัปโหลดรูปไม่สำเร็จ — ลองใหม่หรือวางลิงก์แทน");
      setBtnReady();
      return;
    }
  }

  const imagesRaw = document.getElementById("productImage").value.trim();
  const images = imagesRaw
    .split("|")
    .map(u => normalizeDriveUrl(u.trim()))
    .filter(Boolean)
    .join("|");

  document.getElementById("productImage").value = images;

  const productObj = {
    id: id || null, name, description, price, salePrice, stock, unit,
    category, images, sort, recommended, active,
    image: images.split("|")[0].trim()
  };

  if (id) {
    const idx = products.findIndex(p => String(p.id) === id);
    if (idx >= 0) products[idx] = { ...products[idx], ...productObj };
  } else {
    const tempId = "TEMP_" + Date.now();
    productObj.id = tempId;
    products.push(productObj);
  }
  renderAdminProducts();
  renderProductList(products);

  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action: "saveProduct", product: productObj, adminPhone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") {
      if (data.productId && productObj.id?.startsWith("TEMP_")) {
        const idx = products.findIndex(p => p.id === productObj.id);
        if (idx >= 0) products[idx].id = data.productId;
      }
      pendingProductSave = null;
      clearProductForm();
      renderAdminProducts();
      renderProductList(products);
      setBtnReady();
      showToast("บันทึกสินค้าสำเร็จ ✅");
    } else {
      showToast(data.message || "บันทึกไม่สำเร็จ");
      setBtnReady();
    }
  } catch (err) {
    showToast("เกิดข้อผิดพลาด: " + err.message);
    setBtnReady();
  }
}

async function deleteProductConfirm(productId) {
  if (!confirm("ลบสินค้านี้?")) return;
  products = products.filter(p => String(p.id) !== String(productId));
  renderAdminProducts(); renderProductList(products);
  showToast("ลบในเว็บแล้ว กำลังลบลงชีต...");
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST", redirect: "follow", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: JSON.stringify({ action:"deleteProduct", productId, adminPhone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") showToast("ลบสินค้าแล้ว ✅");
    else { showToast(data.message || "ลบไม่สำเร็จ"); await loadProducts(); renderAdminProducts(); }
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
}

function clearProductForm() {
  ["productName","productDesc","productPrice","productSalePrice","productStock",
   "productUnit","productImage","productSort","editingProductId"].forEach(id => setVal(id, ""));
  document.getElementById("productCategory").value = "";
  document.getElementById("productRecommended").checked = false;
  document.getElementById("productActive").checked      = true;
  setEl("productFormTitle", "➕ จัดการสินค้า");
  pendingProductSave = null;
  _productImgFile = null;
  const preview = document.getElementById("productImgPreview");
  if (preview) preview.style.display = "none";
  const status = document.getElementById("productImgUploadStatus");
  if (status) status.textContent = "";
  const upBtn = document.getElementById("uploadProductImgBtn");
  if (upBtn) { upBtn.disabled = true; upBtn.textContent = "☁️ อัปโหลด"; }
}

// ADMIN — STORE CONFIG
async function saveBannerLocal() {
  const cfg = {
    bannerTag:      document.getElementById("bannerTagInput").value.trim(),
    bannerTitle:    document.getElementById("bannerTitleInput").value.trim(),
    bannerSubtitle: document.getElementById("bannerSubtitleInput").value.trim(),
    bannerEmoji:    document.getElementById("bannerEmojiInput").value.trim()
  };
  Object.assign(storeConfig, cfg);
  applyStoreConfig();

  const btn = document.querySelector("[onclick='saveBannerLocal()']");
  if (btn) { btn.textContent = "กำลังบันทึก..."; btn.disabled = true; }
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action: "saveConfig", ...cfg, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") showToast("บันทึกแบนเนอร์แล้ว ✅");
    else showToast(data.message || "บันทึกไม่สำเร็จ");
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
  finally { if (btn) { btn.textContent = "💾 บันทึก"; btn.disabled = false; } }
}

async function saveStoreLocal() {
  const cfg = {
    shopName:     document.getElementById("storeNameInput").value.trim(),
    shopSubtitle: document.getElementById("storeSubtitleInput").value.trim(),
    shippingFee:  document.getElementById("shippingFeeInput").value.trim(),
    minimumOrder: document.getElementById("minimumOrderInput").value.trim()
  };
  if (!cfg.shopName) { showToast("กรุณากรอกชื่อร้าน"); return; }
  Object.assign(storeConfig, cfg);
  setEl("shopName",     cfg.shopName);
  setEl("shopSubtitle", cfg.shopSubtitle);

  const btn = document.querySelector("[onclick='saveStoreLocal()']");
  if (btn) { btn.textContent = "กำลังบันทึก..."; btn.disabled = true; }
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action: "saveConfig", ...cfg, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") showToast("บันทึกข้อมูลร้านแล้ว ✅");
    else showToast(data.message || "บันทึกไม่สำเร็จ");
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
  finally { if (btn) { btn.textContent = "💾 บันทึก"; btn.disabled = false; } }
}

async function savePaymentLocal() {
  const cfg = {
    bankName:        document.getElementById("bankNameInput").value.trim(),
    bankNumber:      document.getElementById("bankNumberInput").value.trim(),
    bankAccountName: document.getElementById("bankAccountNameInput").value.trim(),
    promptpay:       document.getElementById("promptpayInput").value.trim(),
    lineOA:          document.getElementById("lineOAInput").value.trim()
  };
  Object.assign(storeConfig, cfg);

  const btn = document.querySelector("[onclick='savePaymentLocal()']");
  if (btn) { btn.textContent = "กำลังบันทึก..."; btn.disabled = true; }
  try {
    const res  = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body:   JSON.stringify({ action: "saveConfig", ...cfg, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") showToast("บันทึกข้อมูลชำระเงินแล้ว ✅");
    else showToast(data.message || "บันทึกไม่สำเร็จ");
  } catch (err) { showToast("เกิดข้อผิดพลาด"); }
  finally { if (btn) { btn.textContent = "💾 บันทึก"; btn.disabled = false; } }
}

// MODAL HELPERS
function openModal(modalId) {
  document.getElementById("modalOverlay").classList.remove("hidden");
  document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden"));
  document.getElementById(modalId)?.classList.remove("hidden");
}
function closeAllModals() {
  const overlay = document.getElementById("modalOverlay");
  overlay.classList.add("hidden");
  document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden"));
  const successModal = document.getElementById("orderSuccessModal");
  if (successModal) successModal.remove();
}
function closeModal(e) {
  if (e.target === document.getElementById("modalOverlay")) closeAllModals();
}

// TOAST
let toastTimer = null;
function showToast(msg, duration = 2500) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
}

// HELPERS
function setEl(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }

function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

// ============================================================
//  UX PACK — Product Card Upgrade
// ============================================================

// ── 1. CARD STYLE SWITCHER (Admin-controlled) ──
const CARD_STYLE_KEY = "pan_card_style"; // ยังใช้ key เดิมใน storeConfig

function setCardStyle(style) {
  const grid = document.getElementById("productGrid");
  if (!grid) return;
  grid.classList.remove("style-bold","style-premium","style-playful");
  if (style !== "default") grid.classList.add(`style-${style}`);
  // sync preview highlight ใน admin panel
  document.querySelectorAll(".cst-preview-card").forEach(c => {
    c.classList.toggle("cst-active", c.dataset.style === style);
  });
  document.querySelectorAll(".card-style-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.style === style);
  });
}

// อ่านจาก storeConfig (ค่าที่แอดมินบันทึก)
function applyCardStyleFromConfig() {
  const style = (typeof storeConfig !== "undefined" && storeConfig[CARD_STYLE_KEY]) || "default";
  setCardStyle(style);
}

// บันทึกสไตล์ลง Google Sheets (เรียกจาก admin panel)
async function saveCardStyleAdmin(style) {
  storeConfig[CARD_STYLE_KEY] = style;
  setCardStyle(style);
  try {
    const res = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: {"Content-Type": "text/plain;charset=utf-8"},
      body: JSON.stringify({ action: "saveConfig", [CARD_STYLE_KEY]: style, phone: currentUser?.phone || "" })
    });
    const data = await res.json();
    if (data.status === "success") showToast("✅ บันทึกสไตล์การ์ดแล้ว");
    else showToast("❌ บันทึกไม่สำเร็จ");
  } catch (err) { showToast("❌ เกิดข้อผิดพลาด"); }
}

// inject UI เลือกสไตล์ในหน้าแอดมิน (tab ร้าน)
function injectAdminCardStylePicker() {
  if (document.getElementById("adminCardStylePicker")) return;
  const styles = [
    { key:"default", label:"🏠 Default",  desc:"มาตรฐาน", previewClass:"csp-default" },
    { key:"bold",    label:"🔥 Bold",      desc:"ขอบหนา ตัวหนา", previewClass:"csp-bold"    },
    { key:"premium", label:"💎 Premium",   desc:"มินิมอล หรูหรา", previewClass:"csp-premium"  },
    { key:"playful", label:"😊 Playful",   desc:"สีสด เงาเด้ง", previewClass:"csp-playful"  },
  ];
  const current = (typeof storeConfig !== "undefined" && storeConfig[CARD_STYLE_KEY]) || "default";

  const card = document.createElement("div");
  card.className = "admin-card";
  card.id = "adminCardStylePicker";
  card.style.margin = "0 16px 12px";
  card.innerHTML = `
    <h3>🎨 สไตล์การ์ดสินค้า</h3>
    <p style="font-size:12px;color:var(--soft);margin-bottom:12px">เลือกหน้าตาการ์ดสินค้าที่ลูกค้าทุกคนจะเห็น บันทึกแล้วมีผลทันที</p>
    <div class="cst-pill-row" id="adminCstPillRow" style="padding:0 0 10px"></div>
    <div class="cst-preview-row" id="adminCstPreviewRow" style="padding:0 0 4px"></div>
  `;

  const pillRow = card.querySelector("#adminCstPillRow");
  const previewRow = card.querySelector("#adminCstPreviewRow");

  styles.forEach(({ key, label, desc, previewClass }) => {
    const btn = document.createElement("button");
    btn.className = "card-style-btn" + (key === current ? " active" : "");
    btn.dataset.style = key;
    btn.textContent = label;
    btn.onclick = () => saveCardStyleAdmin(key);
    pillRow.appendChild(btn);

    const miniCard = document.createElement("div");
    miniCard.className = "cst-preview-card " + previewClass + (key === current ? " cst-active" : "");
    miniCard.dataset.style = key;
    miniCard.innerHTML = `
      <div class="cst-img"></div>
      <div class="cst-body">
        <div class="cst-name">ชื่อสินค้า</div>
        <div class="cst-price">฿199</div>
        <div class="cst-btn">+</div>
      </div>
      <div class="cst-label">${desc}</div>
    `;
    miniCard.onclick = () => saveCardStyleAdmin(key);
    previewRow.appendChild(miniCard);
  });

  // แทรกก่อน module-group UI & ธีม หรือต่อท้าย adminTabStore
  const storeTab = document.getElementById("adminTabStore");
  if (storeTab) storeTab.appendChild(card);
}

// ฟังก์ชันเดิม (ไม่ใช้แล้ว — ลูกค้าไม่เห็น toggle)
function injectCardStyleToggle() { /* disabled — admin-only now */ }
function applyCardStyleFromStorage() { applyCardStyleFromConfig(); }


// ── 2. WISHLIST ──
let _wishlist = JSON.parse(localStorage.getItem("pan_wishlist") || "[]");

function toggleWishlist(productId, btn) {
  const idx = _wishlist.indexOf(String(productId));
  if (idx >= 0) {
    _wishlist.splice(idx, 1);
    if (btn) { btn.classList.remove("active","pop"); btn.textContent = "🤍"; }
    showToast("นำออกจาก Wishlist");
  } else {
    _wishlist.push(String(productId));
    if (btn) {
      btn.classList.add("active");
      btn.textContent = "❤️";
      btn.classList.remove("pop");
      void btn.offsetWidth;
      btn.classList.add("pop");
    }
    showToast("เพิ่มใน Wishlist ❤️");
  }
  localStorage.setItem("pan_wishlist", JSON.stringify(_wishlist));
}

function isWishlisted(productId) {
  return _wishlist.includes(String(productId));
}

// ── 3. HELPERS ──
function getStockLevel(stock, maxStock) {
  const pct = maxStock > 0 ? stock / maxStock : 0;
  if (stock <= 0)  return { cls:"out",    pct:0 };
  if (pct <= 0.2)  return { cls:"low",    pct };
  if (pct <= 0.5)  return { cls:"medium", pct };
  return             { cls:"high",   pct };
}

function buildBadgesUX(product) {
  const badges = [];
  const out = product.stock <= 0;
  if (out) {
    badges.push(`<span class="p-badge-v2 out">หมดแล้ว</span>`);
  } else {
    if (product.salePrice > 0 && product.price > 0) {
      const disc = Math.round((1 - product.salePrice / product.price) * 100);
      badges.push(`<span class="p-badge-v2 sale">-${disc}%</span>`);
    }
    if (product.stock > 0 && product.stock <= 5) {
      badges.push(`<span class="p-badge-v2 low">เหลือน้อย!</span>`);
    }
    if (product.recommended) {
      badges.push(`<span class="p-badge-v2 star">⭐ แนะนำ</span>`);
    }
  }
  return badges.length ? `<div class="p-badge-wrap">${badges.join("")}</div>` : "";
}

function buildPriceUX(product) {
  if (product.salePrice > 0) {
    return `<div class="product-price-wrap">
      <span class="p-original-price">฿${Number(product.price).toLocaleString()}</span>
      <span class="product-price">฿${Number(product.salePrice).toLocaleString()}</span>
    </div>`;
  }
  return `<span class="product-price">฿${Number(product.price).toLocaleString()}</span>`;
}


// ── 4. OVERRIDE renderProductList ──
const _origRenderProductList = renderProductList;
renderProductList = function(list, kw) {
  const grid  = document.getElementById("productGrid");
  const count = document.getElementById("productCount");
  if (!grid) return;
  grid.innerHTML = "";
  if (count) count.textContent = list.length > 0 ? `${list.length} รายการ` : "";

  if (!list.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">${kw ? "🔍" : "📦"}</div>
      <p>${kw ? `ไม่พบ "${kw}"` : "ไม่พบสินค้า"}</p>
      ${kw ? `<button class="btn-clear" style="width:auto;margin-top:10px;padding:8px 20px;font-size:13px" onclick="clearSearch()">ล้างการค้นหา</button>` : ""}
    </div>`;
    return;
  }

  const maxStock = Math.max(...list.map(p => Number(p.stock) || 0), 1);

  list.forEach((product, i) => {
    const out    = product.stock <= 0;
    const imgSrc = normalizeDriveUrl(product.image) || "";
    const nameHl = hlText(product.name, kw);
    const descHl = hlText(product.description || "", kw);
    const stock  = Number(product.stock) || 0;
    const lvl    = getStockLevel(stock, maxStock);
    const wished = isWishlisted(product.id);

    const card = document.createElement("div");
    card.className = "product-card";
    card.style.animationDelay = `${i * 45}ms`;

    card.innerHTML = `
      <div class="p-img-wrap">
        <img src="${imgSrc || NO_IMG_PLACEHOLDER}" alt="${escHtml(product.name)}" loading="lazy" onerror="imgFallback(this)">
        ${buildBadgesUX(product)}
        <button class="p-wish-btn ${wished ? "active" : ""}"
          onclick="event.stopPropagation(); toggleWishlist('${product.id}', this)"
          title="${wished ? "นำออกจาก Wishlist" : "เพิ่มใน Wishlist"}"
        >${wished ? "❤️" : "🤍"}</button>
        <div class="p-quick-actions">
          <button class="p-quick-btn add ${out ? "out-stock" : ""}"
            onclick="event.stopPropagation(); ${out ? "" : `flyToCart('${product.id}', this)`}"
            ${out ? "disabled" : ""}
            title="${out ? "สินค้าหมด" : "เพิ่มลงตะกร้า"}"
          >+</button>
          <button class="p-quick-btn"
            onclick="event.stopPropagation(); openProductDetail('${product.id}')"
            title="ดูรายละเอียด"
          >👁️</button>
        </div>
      </div>
      ${!out ? `<div class="p-stock-bar">
        <div class="p-stock-fill ${lvl.cls}" style="width:${Math.round(lvl.pct*100)}%"></div>
      </div>` : ""}
      <div class="product-info">
        <div class="product-name">${nameHl}</div>
        ${descHl ? `<div class="product-desc">${descHl}</div>` : ""}
        <div class="product-footer">
          ${buildPriceUX(product)}
          <button class="buy-btn ${out ? "out-stock" : ""}"
            onclick="event.stopPropagation(); ${out ? "" : `flyToCart('${product.id}', this)`}"
            ${out ? "disabled" : ""}
          >+</button>
        </div>
      </div>`;

    card.addEventListener("click", () => openProductDetail(product.id));
    grid.appendChild(card);
  });

  applyCardStyleFromConfig();
};

// ── 5. FLY-TO-CART ──
function flyToCart(productId, triggerEl) {
  if (typeof addToCart === "function") addToCart(productId);
  const cartIcon = document.querySelector("#navCart .nav-icon") || document.querySelector("#navCart");
  const startRect = triggerEl?.getBoundingClientRect();
  const endRect   = cartIcon?.getBoundingClientRect();

  if (startRect && endRect) {
    const dx = endRect.left + endRect.width/2  - (startRect.left + startRect.width/2);
    const dy = endRect.top  + endRect.height/2 - (startRect.top  + startRect.height/2);
    const particle = document.createElement("div");
    particle.className = "fly-particle";
    particle.textContent = "🛒";
    particle.style.left = `${startRect.left + startRect.width/2  - 12}px`;
    particle.style.top  = `${startRect.top  + startRect.height/2 - 12}px`;
    particle.style.setProperty("--dx", `${dx}px`);
    particle.style.setProperty("--dy", `${dy}px`);
    document.body.appendChild(particle);
    particle.addEventListener("animationend", () => { particle.remove(); animateCartBadge(); });
  } else {
    animateCartBadge();
  }
}

function animateCartBadge() {
  ["cartBadge","cartBadgeSide"].forEach(id => {
    const badge = document.getElementById(id);
    if (badge && !badge.classList.contains("hidden")) {
      badge.classList.remove("bounce");
      void badge.offsetWidth;
      badge.classList.add("bounce");
      badge.addEventListener("animationend", () => badge.classList.remove("bounce"), { once:true });
    }
  });
}

// ── 6. SUCCESS OVERLAY + CONFETTI ──
function showOrderSuccess(orderNum) {
  document.querySelectorAll(".order-success-overlay").forEach(el => el.remove());
  const overlay = document.createElement("div");
  overlay.className = "order-success-overlay";
  overlay.innerHTML = `
    <div class="order-success-card">
      <div class="success-checkmark">✅</div>
      <div class="success-title">สั่งซื้อสำเร็จ! 🎉</div>
      <p class="success-sub">ขอบคุณที่ใช้บริการ Pan Market<br>เราจะเตรียมสินค้าให้คุณโดยเร็ว</p>
      ${orderNum ? `<div class="success-order-num">ออเดอร์: ${orderNum}</div>` : ""}
      <button style="margin-top:8px;width:100%;padding:12px;border-radius:12px;background:var(--orange);color:#fff;border:none;font-family:'Sarabun',sans-serif;font-size:15px;font-weight:700;cursor:pointer"
        onclick="this.closest('.order-success-overlay').remove(); switchPage('profile')"
      >ดูออเดอร์ของฉัน →</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  spawnConfetti(overlay.querySelector(".order-success-card"));
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 8000);
}

function spawnConfetti(container) {
  const colors = ["#f97316","#22c55e","#3b82f6","#a855f7","#ec4899","#eab308"];
  for (let i = 0; i < 28; i++) {
    const piece = document.createElement("div");
    piece.className = "success-confetti";
    piece.style.cssText = `left:${10+Math.random()*80}%;top:-10px;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      width:${6+Math.random()*6}px;height:${6+Math.random()*6}px;
      border-radius:${Math.random()>.5?"50%":"2px"};
      animation-duration:${.9+Math.random()*1.2}s;
      animation-delay:${Math.random()*.5}s;`;
    container.appendChild(piece);
  }
}

// ── 7. HOOK doSubmitOrder ── แสดง success overlay หลังสั่งซื้อ
// ✅ แก้บัค: ใช้วิธี patch GLOBAL_SCRIPT_URL fetch แทน ป้องกัน closeAllModals ถูกเรียกก่อน
const _origDoSubmitOrder = typeof doSubmitOrder === "function" ? doSubmitOrder : null;
if (_origDoSubmitOrder) {
  doSubmitOrder = async function() {
    let _capturedOrderId = null;

    // patch fetch ชั่วคราวเพื่อดักจับ orderId จาก response
    const _origFetch = window.fetch;
    window.fetch = async function(...args) {
      const res = await _origFetch.apply(this, args);
      try {
        const clone = res.clone();
        const data = await clone.json();
        if (data.status === "success" && data.orderId) {
          _capturedOrderId = data.orderId;
        }
      } catch(e) {}
      return res;
    };

    await _origDoSubmitOrder.call(this);

    // คืน fetch กลับ
    window.fetch = _origFetch;

    // แสดง overlay เฉพาะตอนที่ modal ถูกปิดไปแล้ว (success)
    if (_capturedOrderId) {
      setTimeout(() => {
        showOrderSuccess(_capturedOrderId);
      }, 400);
    }
  };
}

// ── INIT ──
document.addEventListener("DOMContentLoaded", () => {
  applyCardStyleFromConfig();
});