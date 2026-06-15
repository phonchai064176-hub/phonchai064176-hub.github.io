// ============================================================
// PAN MARKET — modules.js  (แก้ไข V2.1)
// ระบบเปิด/ปิดฟีเจอร์โดยแอดมิน (sync กับ Google Sheets)
// โหลดหลัง script.js เสมอ
// ============================================================

const MODULE_DEFAULTS = {
  searchBar:        true,
  categoryFilter:   true,
  heroBanner:       true,
  wishlist:         true,
  quickView:        true,
  stockBar:         true,
  cardStyleToggle:  false, // deprecated — admin controls style via storeConfig now
  loginSystem:      true,
  addressBook:      true,
  orderHistory:     true,
  cart:             true,
  shippingFee:      true,
  paymentCOD:       true,
  paymentBank:      false,
  paymentPromptPay: false,
  orderSuccessAnim: true,
  darkMode:         true,
  flyToCart:        true,
};

// ── อ่านค่าจาก storeConfig ──
function getModuleSettings() {
  const settings = {};
  Object.keys(MODULE_DEFAULTS).forEach(key => {
    const cfgKey = "mod_" + key;
    if (typeof storeConfig !== "undefined" && storeConfig[cfgKey] !== undefined) {
      settings[key] = String(storeConfig[cfgKey]) === "true";
    } else {
      settings[key] = MODULE_DEFAULTS[key];
    }
  });
  return settings;
}

// ── บันทึกค่าลง Google Sheets ──
async function saveModuleSetting(key, value) {
  const cfgKey = "mod_" + key;

  // 1. อัปเดต storeConfig ใน memory ทันที
  if (typeof storeConfig !== "undefined") storeConfig[cfgKey] = String(value);

  // 2. apply UI ทันทีก่อน fetch (ไม่รอ server)
  applyModuleSettings();

  // 3. sync กับ checkbox ใน admin panel
  const el = document.getElementById("mod_" + key);
  if (el) el.checked = value;

  // 4. บันทึกลง Google Sheets
  try {
    const res = await fetch(GLOBAL_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "saveConfig", [cfgKey]: String(value), phone: (typeof currentUser !== "undefined" && currentUser?.phone) || "" })
    });
    const data = await res.json();
    if (data.status === "success") {
      showToast(value ? "✅ เปิดฟีเจอร์แล้ว" : "🔕 ปิดฟีเจอร์แล้ว");
    } else {
      // rollback ถ้า server error
      if (typeof storeConfig !== "undefined") storeConfig[cfgKey] = String(!value);
      if (el) el.checked = !value;
      applyModuleSettings();
      showToast("❌ บันทึกไม่สำเร็จ: " + (data.message || ""));
    }
  } catch (err) {
    // rollback ถ้า network error
    if (typeof storeConfig !== "undefined") storeConfig[cfgKey] = String(!value);
    if (el) el.checked = !value;
    applyModuleSettings();
    showToast("❌ เกิดข้อผิดพลาด: " + err.message);
  }
}

// ── เซ็ต checkbox ใน admin panel ──
function fillModuleToggles() {
  const s = getModuleSettings();
  Object.keys(s).forEach(key => {
    const el = document.getElementById("mod_" + key);
    if (el) el.checked = s[key];
  });
}

// ── inject/remove CSS helper ──
function _injectModuleCSS(id, shouldInject, css) {
  const existing = document.getElementById("modcss_" + id);
  if (shouldInject) {
    if (!existing) {
      const style = document.createElement("style");
      style.id = "modcss_" + id;
      style.textContent = css;
      document.head.appendChild(style);
    }
  } else {
    if (existing) existing.remove();
  }
}

// ── apply ทุกโมดูลกับ UI จริง ──
function applyModuleSettings() {
  const s = getModuleSettings();

  // 🔍 ช่องค้นหา
  const searchWrap = document.querySelector(".search-wrap");
  if (searchWrap) searchWrap.style.display = s.searchBar ? "" : "none";

  // 🏷️ หมวดหมู่
  const catContainer = document.getElementById("categoryContainer");
  if (catContainer) catContainer.style.display = s.categoryFilter ? "" : "none";

  // 🖼️ Hero Banner
  const hero = document.getElementById("heroBanner");
  if (hero) hero.style.display = s.heroBanner ? "" : "none";

  // 🌙 Dark Mode button
  const darkBtn = document.getElementById("darkToggle");
  if (darkBtn) darkBtn.style.display = s.darkMode ? "" : "none";

  // 🔐 Login button
  const loginBtn = document.getElementById("loginBtn");
  if (loginBtn) loginBtn.style.display = s.loginSystem ? "" : "none";

  // ❤️ Wishlist
  _injectModuleCSS("wish-hide", !s.wishlist, ".p-wish-btn { display: none !important; }");

  // 👁️ Quick View
  _injectModuleCSS("quickview-hide", !s.quickView, ".p-quick-actions { display: none !important; }");

  // 📊 Stock bar
  _injectModuleCSS("stockbar-hide", !s.stockBar, ".p-stock-bar { display: none !important; }");

  // 🎨 Card style toggle — removed from customer view (admin-controlled via storeConfig)

  // 📍 Address book
  const addrSection = document.getElementById("addressSection");
  if (addrSection) {
    if (!s.addressBook) addrSection.style.setProperty("display", "none", "important");
    else addrSection.style.removeProperty("display");
  }

  // 📦 Order history
  const ordersSection = document.querySelector(".orders-section");
  if (ordersSection) ordersSection.style.display = s.orderHistory ? "" : "none";

  // 🛒 ตะกร้า - ซ่อน nav ถ้าปิด cart
  const cartNav    = document.getElementById("navCart");
  const cartNavSide = document.getElementById("sideNavCart");
  if (cartNav)    cartNav.style.display    = s.cart ? "" : "none";
  if (cartNavSide) cartNavSide.style.display = s.cart ? "" : "none";

  // 🚚 ค่าส่ง
  _injectModuleCSS("shipping-hide", !s.shippingFee,
    `#checkoutShipping, [data-checkout="shipping"] { display: none !important; }`);

  // 💵 COD payment block
  _injectModuleCSS("cod-hide", !s.paymentCOD,
    `[data-payment="cod"] { display: none !important; }`);

  // 🏦 Bank payment block
  _injectModuleCSS("bank-hide", !s.paymentBank,
    `[data-payment="bank"], #bankDetailBox { display: none !important; }`);

  // 📱 PromptPay payment block
  _injectModuleCSS("promptpay-hide", !s.paymentPromptPay,
    `[data-payment="promptpay"], #promptpayDetailBox { display: none !important; }`);

  // flags สำหรับ override functions
  window._modNoFlyToCart   = !s.flyToCart;
  window._modNoSuccessAnim = !s.orderSuccessAnim;
}

// ── patch loadStoreConfig เพื่อให้ apply modules หลังโหลด config จริง ──
// (รันก่อน DOMContentLoaded เพื่อ patch ก่อน script.js เรียก loadStoreConfig)
(function patchStoreConfigLoader() {
  // รอให้ script.js โหลดและสร้าง loadStoreConfig ก่อน
  function tryPatch() {
    if (typeof loadStoreConfig === "undefined") {
      // ยัง load ไม่เสร็จ รอ
      setTimeout(tryPatch, 10);
      return;
    }

    // patch loadStoreConfig
    const _origLoad = loadStoreConfig;
    loadStoreConfig = async function() {
      await _origLoad();
      // หลัง storeConfig โหลดจาก server แล้ว apply ทันที
      applyModuleSettings();
      fillModuleToggles();
    };

    // patch applyStoreConfig (ถูกเรียกเมื่อมีการ set config ใหม่)
    if (typeof applyStoreConfig !== "undefined") {
      const _origApply = applyStoreConfig;
      applyStoreConfig = function(cfg) {
        _origApply(cfg);
        applyModuleSettings();
      };
    }

    // patch fillStoreConfigForms (ถูกเรียกเมื่อเปิด admin tab)
    if (typeof fillStoreConfigForms !== "undefined") {
      const _origFill = fillStoreConfigForms;
      fillStoreConfigForms = function() {
        _origFill();
        fillModuleToggles();
      };
    }
  }
  tryPatch();
})();

// ── override flyToCart และ showOrderSuccess หลัง DOM พร้อม ──
document.addEventListener("DOMContentLoaded", () => {

  // patch flyToCart
  if (typeof flyToCart !== "undefined") {
    const _origFlyToCart = flyToCart;
    flyToCart = function(productId, triggerEl) {
      if (window._modNoFlyToCart) {
        if (typeof addToCart === "function") addToCart(productId);
        if (typeof animateCartBadge === "function") animateCartBadge();
      } else {
        _origFlyToCart(productId, triggerEl);
      }
    };
  }

  // patch showOrderSuccess
  if (typeof showOrderSuccess !== "undefined") {
    const _origShowOrderSuccess = showOrderSuccess;
    showOrderSuccess = function(orderNum) {
      if (window._modNoSuccessAnim) return;
      _origShowOrderSuccess(orderNum);
    };
  }

  // patch fillStoreConfigForms (fallback ถ้า patch ข้างบนยังไม่ได้ทำงาน)
  if (typeof fillStoreConfigForms !== "undefined") {
    const _origFill = fillStoreConfigForms;
    fillStoreConfigForms = function() {
      _origFill();
      fillModuleToggles();
    };
  }

  // patch applyStoreConfig (fallback)
  if (typeof applyStoreConfig !== "undefined") {
    const _origApply = applyStoreConfig;
    applyStoreConfig = function(cfg) {
      _origApply(cfg);
      applyModuleSettings();
    };
  }

  // apply ครั้งแรกทันที (ใช้ MODULE_DEFAULTS ก่อน storeConfig โหลด)
  applyModuleSettings();
});
