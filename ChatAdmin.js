// ============================================================
// PAN MARKET — chat.js  v1.0
// ระบบแชต Real-time + แจ้งเตือนแอดมิน (Firebase Firestore)
// โหลดหลัง script.js และ modules.js เสมอ
// ============================================================

// ── Firebase Config ──
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBfkQy3HQVxh7dxxDBXwu93PgFPnK14gGs",
  authDomain:        "continue-c2aed.firebaseapp.com",
  projectId:         "continue-c2aed",
  storageBucket:     "continue-c2aed.firebasestorage.app",
  messagingSenderId: "1064685050877",
  appId:             "1:1064685050877:web:694082da3b43968005d794"
};

// ── Firebase SDK (CDN) ──
let _db = null;
let _fbReady = false;
const _fbReadyCallbacks = [];

function onFirebaseReady(fn) {
  if (_fbReady) { fn(_db); return; }
  _fbReadyCallbacks.push(fn);
}

(async function initFirebase() {
  try {
    const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    const { getFirestore, collection, doc, addDoc, onSnapshot, query, orderBy,
            serverTimestamp, updateDoc, getDocs, where, limit, Timestamp }
          = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

    const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
    _db = getFirestore(app);

    // expose FS helpers globally
    window._FS = { collection, doc, addDoc, onSnapshot, query, orderBy,
                   serverTimestamp, updateDoc, getDocs, where, limit, Timestamp };

    _fbReady = true;
    _fbReadyCallbacks.forEach(fn => fn(_db));

    // start listeners
    initChatSystem();
    initAdminNotifListener();

  } catch (err) {
    console.error("Firebase init error:", err);
  }
})();

// ============================================================
// CHAT SESSION
// ============================================================
let _chatSessionId  = null;  // Firestore doc id
let _chatUnsubMsg   = null;  // unsubscribe message listener
let _chatUnsubConvs = null;  // unsubscribe admin convs listener
let _unreadNotifCount = 0;

function getChatSessionId() {
  // ผูก session กับ user account (phone/uid) ถ้ามี — ป้องกันเห็นแชตคนอื่น
  const uid = currentUser?.uid || currentUser?.phone || currentUser?.id || null;
  if (uid) {
    // ใช้ uid เป็น session key ตรงๆ — ทุก device ของ user คนเดียวกันจะเห็น session เดียวกัน
    return "chat_user_" + String(uid).replace(/[^a-zA-Z0-9_-]/g, "_");
  }
  // fallback: ถ้าไม่มี user (guest) ใช้ localStorage แต่ clear เมื่อ login ใหม่
  let sid = localStorage.getItem("pan_chat_sid");
  if (!sid) {
    sid = "chat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem("pan_chat_sid", sid);
  }
  return sid;
}

function getChatDisplayName() {
  if (currentUser?.name) return currentUser.name;
  if (currentUser?.phone) return currentUser.phone;
  return "ลูกค้า";
}

// ============================================================
// INIT
// ============================================================
function isAdminUser() {
  return typeof currentUser !== "undefined" && currentUser?.role === "admin";
}

function initChatSystem() {
  if (!isAdminUser()) {
    injectFloatBtn();
    injectChatWidget();
  }
}

// ============================================================
// FLOATING BUTTON (ฝั่งลูกค้า)
// ============================================================
function injectFloatBtn() {
  if (document.getElementById("chatFloatBtn")) return;

  const btn = document.createElement("div");
  btn.id = "chatFloatBtn";
  btn.innerHTML = `
    <div class="cfb-ring"></div>
    <div class="cfb-icon">💬</div>
    <div class="cfb-badge hidden" id="cfbBadge">0</div>
    <div class="cfb-tooltip">ติดต่อเรา</div>
  `;
  btn.onclick = toggleChatWidget;
  document.body.appendChild(btn);
}

function updateFloatBtnBadge(count) {
  const badge = document.getElementById("cfbBadge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : count;
    badge.classList.remove("hidden");
    badge.classList.add("pop");
    setTimeout(() => badge.classList.remove("pop"), 400);
  } else {
    badge.classList.add("hidden");
  }
}

// ============================================================
// CHAT WIDGET POPUP
// ============================================================
function injectChatWidget() {
  if (document.getElementById("chatWidget")) return;

  const w = document.createElement("div");
  w.id = "chatWidget";
  w.className = "chat-widget hidden";
  w.innerHTML = `
    <div class="cw-header">
      <div class="cw-header-left">
        <div class="cw-avatar">🛍️</div>
        <div>
          <div class="cw-title" id="cwShopName">Pan Market</div>
          <div class="cw-status"><span class="cw-dot"></span>ออนไลน์</div>
        </div>
      </div>
      <button class="cw-close" id="cwCloseBtn" type="button" aria-label="ปิด">✕</button>
    </div>
    <div class="cw-msgs" id="cwMsgs">
      <div class="cw-welcome">
        <div class="cw-welcome-icon">👋</div>
        <div class="cw-welcome-text">สวัสดีครับ! มีอะไรให้ช่วยไหม?</div>
      </div>
    </div>
    <div class="cw-footer">
      <input class="cw-input" id="cwInput" placeholder="พิมพ์ข้อความ..." maxlength="500" autocomplete="off"/>
      <button class="cw-send" id="cwSendBtn" type="button" aria-label="ส่ง">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
      </button>
    </div>
  `;
  document.body.appendChild(w);

  // ผูก event ด้วย addEventListener (แก้ปัญหากดส่ง/ปิดไม่ได้)
  document.getElementById("cwCloseBtn").addEventListener("click", function(e) {
    e.stopPropagation();
    if (_chatOpen) toggleChatWidget();
  });

  document.getElementById("cwSendBtn").addEventListener("click", function(e) {
    e.stopPropagation();
    sendChatMsg();
  });

  document.getElementById("cwInput").addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMsg();
    }
  });

  // update shop name
  const cwName = document.getElementById("cwShopName");
  if (cwName && typeof storeConfig !== "undefined" && storeConfig.shopName) {
    cwName.textContent = storeConfig.shopName;
  }
}

let _chatOpen = false;
let _unreadCustomer = 0;

function toggleChatWidget() {
  const w = document.getElementById("chatWidget");
  if (!w) return;
  _chatOpen = !_chatOpen;
  w.classList.toggle("hidden", !_chatOpen);
  const btn = document.getElementById("chatFloatBtn");
  if (btn) btn.classList.toggle("active", _chatOpen);

  if (_chatOpen) {
    // ยังไม่ login → แสดงข้อความให้เข้าสู่ระบบก่อน ห้ามแชต
    if (!currentUser) {
      renderGuestChatPrompt();
      return;
    }
    enableChatInput();
    _unreadCustomer = 0;
    updateFloatBtnBadge(0);
    startChatSession();
    setTimeout(() => document.getElementById("cwInput")?.focus(), 300);
  }
}

// แสดง prompt ให้เข้าสู่ระบบก่อนแชต (ฝั่งลูกค้าที่ยังไม่ login)
function renderGuestChatPrompt() {
  const box = document.getElementById("cwMsgs");
  if (box) {
    box.innerHTML = `
      <div class="cw-welcome">
        <div class="cw-welcome-icon">🔐</div>
        <div class="cw-welcome-text">กรุณาเข้าสู่ระบบก่อนส่งข้อความแชต</div>
        <button class="btn-primary" style="margin-top:10px;width:auto;padding:8px 20px;font-size:13px" onclick="goLoginFromChat()">เข้าสู่ระบบ</button>
      </div>`;
  }
  const input = document.getElementById("cwInput");
  if (input) { input.disabled = true; input.placeholder = "เข้าสู่ระบบเพื่อส่งข้อความ"; }
}

// เปิดใช้งานช่องพิมพ์ข้อความตามปกติ (สำหรับผู้ที่ login แล้ว)
function enableChatInput() {
  const input = document.getElementById("cwInput");
  if (input) { input.disabled = false; input.placeholder = "พิมพ์ข้อความ..."; }
}

// ปิดวิดเจ็ตแชตแล้วเปิดหน้าเข้าสู่ระบบ
function goLoginFromChat() {
  if (_chatOpen) toggleChatWidget();
  if (typeof openLoginModal === "function") openLoginModal();
}

async function startChatSession() {
  if (!_fbReady || !_db) return;
  const { collection, doc, addDoc, onSnapshot, query, orderBy, serverTimestamp, getDocs, where, limit } = window._FS;

  // ถ้ามี user จริง → ล้าง guest session ID ออกจาก localStorage
  // ป้องกันสลับไอดีแล้วยังใช้ session เดิม
  const uid = currentUser?.uid || currentUser?.phone || currentUser?.id || null;
  if (uid) {
    localStorage.removeItem("pan_chat_sid");
  }

  _chatSessionId = getChatSessionId();
  const msgsRef = collection(_db, "chats", _chatSessionId, "messages");

  // สร้าง/อัปเดต session doc
  const sessionRef = doc(_db, "chats", _chatSessionId);
  const { setDoc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  const snap = await getDoc(sessionRef);
  if (!snap.exists()) {
    await setDoc(sessionRef, {
      customerName: getChatDisplayName(),
      customerPhone: currentUser?.phone || "",
      lastMessage: "",
      lastAt: serverTimestamp(),
      unreadAdmin: 0,
      createdAt: serverTimestamp()
    });
    // ส่ง notification ออเดอร์ใหม่
    sendAdminNotif("chat", `💬 ลูกค้าใหม่เริ่มแชต: ${getChatDisplayName()}`);
  }

  // listen messages
  if (_chatUnsubMsg) _chatUnsubMsg();
  const q = query(msgsRef, orderBy("createdAt", "asc"));
  _chatUnsubMsg = onSnapshot(q, snap => {
    renderChatMessages(snap.docs);
  });
}

// Store customer msg docs for actions
let _customerMsgDocs = [];

function renderChatMessages(docs) {
  const box = document.getElementById("cwMsgs");
  if (!box) return;
  _customerMsgDocs = docs;

  // เก็บ welcome ไว้
  const welcome = box.querySelector(".cw-welcome");
  box.innerHTML = "";
  if (welcome && docs.length === 0) { box.appendChild(welcome); return; }

  let lastDate = "";
  docs.forEach((d, idx) => {
    const data = d.data();
    const isAdmin = data.sender === "admin";
    const ts = data.createdAt?.toDate?.() || new Date();
    const dateStr = ts.toLocaleDateString("th-TH");
    const timeStr = ts.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });

    if (dateStr !== lastDate) {
      const dateDivider = document.createElement("div");
      dateDivider.className = "cw-date";
      dateDivider.textContent = dateStr;
      box.appendChild(dateDivider);
      lastDate = dateStr;
    }

    const row = document.createElement("div");
    // ลูกค้าพิมพ์เอง=ขวา(row-self), แอดมินตอบ=ซ้าย(row-other)
    row.className = "cw-msg-row " + (isAdmin ? "row-other" : "row-self");

    const replyHtml = data.replyTo
      ? `<div class="cw-reply-quote"><span class="cw-reply-name">${escHtml(data.replyTo.senderName||"")}</span><span class="cw-reply-text">${escHtml((data.replyTo.text||"").slice(0,60))}</span></div>`
      : "";

    row.innerHTML = `
      ${isAdmin ? `<div class="cw-msg-avatar">🛍️</div>` : ""}
      <div class="cw-bubble ${isAdmin ? "bubble-other" : "bubble-self"}" data-msg-idx="${idx}" data-sender="${data.sender}">
        ${replyHtml}
        <div class="cw-bubble-text ${data.deleted ? "deleted-msg" : ""}">${data.deleted ? '<i style="opacity:.55;font-size:11px">ยกเลิกข้อความนี้แล้ว</i>' : escHtml(data.text || "")}</div>
        <div class="cw-bubble-time">${timeStr}</div>
      </div>
    `;
    box.appendChild(row);

    // นับ unread ของลูกค้า
    if (isAdmin && !data.readByCustomer && !_chatOpen) {
      _unreadCustomer++;
    }
  });

  box.scrollTop = box.scrollHeight;
  if (!_chatOpen) updateFloatBtnBadge(_unreadCustomer);

  // Setup long-press / right-click on customer widget
  setupCustomerMsgActions(box);
}

// ── Customer message actions ──
let _cwLpTimer = null;
let _cwReplyingTo = null;

function setupCustomerMsgActions(box) {
  box.oncontextmenu = function(e) {
    const bubble = e.target.closest(".cw-bubble[data-msg-idx]");
    if (!bubble) return;
    e.preventDefault();
    showCustomerMsgMenu(bubble, parseInt(bubble.dataset.msgIdx));
  };
  box.ontouchstart = function(e) {
    const bubble = e.target.closest(".cw-bubble[data-msg-idx]");
    if (!bubble) return;
    clearTimeout(_cwLpTimer);
    _cwLpTimer = setTimeout(() => {
      showCustomerMsgMenu(bubble, parseInt(bubble.dataset.msgIdx));
    }, 500);
  };
  box.ontouchend  = () => clearTimeout(_cwLpTimer);
  box.ontouchmove = () => clearTimeout(_cwLpTimer);
}

function showCustomerMsgMenu(bubble, idx) {
  closeCustomerMsgMenu();
  const doc = _customerMsgDocs[idx];
  if (!doc) return;
  const data = doc.data();
  const isOwn = data.sender === "customer";

  const menu = document.createElement("div");
  menu.id = "cwMsgMenu";
  menu.className = "msg-action-menu";
  menu.style.position = "fixed"; // ใช้ fixed แทน absolute — ไม่ขึ้นกับ scroll
  menu.style.zIndex = "99999";

  let html = `<button class="msg-action-btn" data-action="reply" data-idx="${idx}">↩️ ตอบกลับ</button>`;
  if (isOwn && !data.deleted) {
    html += `<button class="msg-action-btn danger" data-action="delete" data-idx="${idx}">🗑️ ยกเลิกข้อความ</button>`;
  }
  menu.innerHTML = html;

  document.body.appendChild(menu);

  // คำนวณตำแหน่งหลัง append (รู้ขนาดจริง)
  requestAnimationFrame(() => {
    const rect = bubble.getBoundingClientRect();
    const mw = menu.offsetWidth  || 180;
    const mh = menu.offsetHeight || 80;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // วางเหนือ bubble ก่อน ถ้าไม่พอวางใต้
    let top = rect.top - mh - 8;
    if (top < 8) top = rect.bottom + 8;
    top = Math.min(top, vh - mh - 8);

    // ถ้าข้อความของตัวเอง (ขวา) → เมนูชิดขวา; ถ้าแอดมิน (ซ้าย) → เมนูชิดซ้าย
    let left = isOwn ? rect.right - mw : rect.left;
    left = Math.max(8, Math.min(left, vw - mw - 8));

    menu.style.top  = top  + "px";
    menu.style.left = left + "px";
  });

  menu.addEventListener("click", function(e) {
    const btn = e.target.closest(".msg-action-btn");
    if (!btn) return;
    const action = btn.dataset.action;
    const i = parseInt(btn.dataset.idx);
    closeCustomerMsgMenu();
    if (action === "reply") startCustomerReply(i);
    if (action === "delete") deleteCustomerMsg(i);
  });

  // ปิดเมื่อแตะนอก — skip touchstart แรก (คือนิ้วที่ปล่อยจาก long-press)
  let _cwSkip = true;
  function _cwOutside(e) {
    if (_cwSkip) { _cwSkip = false; return; }
    if (e.target.closest("#cwMsgMenu")) return;
    closeCustomerMsgMenu();
    document.removeEventListener("touchstart", _cwOutside, true);
    document.removeEventListener("click",      _cwOutside);
  }
  document.addEventListener("touchstart", _cwOutside, true);
  setTimeout(() => document.addEventListener("click", _cwOutside), 0);
}

function closeCustomerMsgMenu() {
  document.getElementById("cwMsgMenu")?.remove();
}

function startCustomerReply(idx) {
  const doc = _customerMsgDocs[idx];
  if (!doc) return;
  const data = doc.data();
  _cwReplyingTo = {
    text: data.text,
    senderName: data.sender === "admin" ? "ร้านค้า" : (data.senderName || "ลูกค้า")
  };

  let bar = document.getElementById("cwReplyBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "cwReplyBar";
    bar.className = "reply-bar";
    const footer = document.getElementById("chatWidget")?.querySelector(".cw-footer");
    if (footer) footer.parentNode.insertBefore(bar, footer);
  }
  bar.innerHTML = `
    <div class="reply-bar-content">
      <span class="reply-bar-name">${escHtml(_cwReplyingTo.senderName)}</span>
      <span class="reply-bar-text">${escHtml((_cwReplyingTo.text||"").slice(0,60))}</span>
    </div>
    <button class="reply-bar-close" id="cwReplyClose" type="button">✕</button>
  `;
  bar.classList.remove("hidden");
  document.getElementById("cwReplyClose")?.addEventListener("click", cancelCustomerReply);
  document.getElementById("cwInput")?.focus();
}

function cancelCustomerReply() {
  _cwReplyingTo = null;
  document.getElementById("cwReplyBar")?.remove();
}

async function deleteCustomerMsg(idx) {
  const doc = _customerMsgDocs[idx];
  if (!doc || !_fbReady || !_chatSessionId) return;
  try {
    const { doc: fsDoc, updateDoc } = window._FS;
    await updateDoc(fsDoc(_db, "chats", _chatSessionId, "messages", doc.id), {
      text: "", deleted: true
    });
  } catch(e) { console.warn("delete customer msg error", e); }
}

async function sendChatMsg() {
  const input = document.getElementById("cwInput");
  const text = input?.value?.trim();
  if (!text || !_fbReady) return;

  // ต้อง login ก่อนถึงจะส่งแชตได้
  if (!currentUser) {
    renderGuestChatPrompt();
    showToast?.("กรุณาเข้าสู่ระบบก่อนส่งข้อความ");
    return;
  }
  if (!_chatSessionId) return;
  input.value = "";

  const { collection, addDoc, serverTimestamp, doc } = window._FS;
  const msgsRef = collection(_db, "chats", _chatSessionId, "messages");
  const msgData = {
    text,
    sender: "customer",
    senderName: getChatDisplayName(),
    createdAt: serverTimestamp(),
    readByAdmin: false
  };
  if (_cwReplyingTo) {
    msgData.replyTo = { text: _cwReplyingTo.text, senderName: _cwReplyingTo.senderName };
    cancelCustomerReply();
  }
  await addDoc(msgsRef, msgData);

  // อัปเดต/สร้าง session doc ใหม่ (เผื่อแอดมินลบการสนทนานี้ไปแล้ว ให้เด้งกลับมาใหม่)
  const sessionRef = doc(_db, "chats", _chatSessionId);
  const { increment, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
  await setDoc(sessionRef, {
    lastMessage: text,
    lastAt: serverTimestamp(),
    customerName: getChatDisplayName(),
    customerPhone: currentUser?.phone || "",
    unreadAdmin: increment(1)
  }, { merge: true });

  sendAdminNotif("chat", `💬 ${getChatDisplayName()}: ${text.slice(0, 60)}`);
}

// ============================================================
// ADMIN NOTIFICATION (Firestore)
// ============================================================
async function sendAdminNotif(type, message, extra = {}) {
  if (!_fbReady || !_db) return;
  const { collection, addDoc, serverTimestamp } = window._FS;
  try {
    await addDoc(collection(_db, "notifications"), {
      type, message, extra,
      read: false,
      createdAt: serverTimestamp()
    });
  } catch (e) { console.warn("notif error", e); }
}

// Hook ออเดอร์ใหม่ → ส่ง notification
(function hookOrderNotif() {
  function tryHook() {
    if (typeof doSubmitOrder === "undefined") { setTimeout(tryHook, 500); return; }
    const _orig = doSubmitOrder;
    doSubmitOrder = async function() {
      await _orig.apply(this, arguments);
      // ดึงข้อมูลออเดอร์ล่าสุด
      const name  = currentUser?.name  || currentUser?.phone || "ลูกค้า";
      const total = cart.reduce((s, i) => s + (i.salePrice > 0 ? i.salePrice : i.price) * i.qty, 0);
      sendAdminNotif("order", `🛒 ออเดอร์ใหม่จาก ${name} — ฿${total.toLocaleString()}`);
    };
  }
  tryHook();
})();

// ============================================================
// ADMIN NOTIFICATION LISTENER
// ============================================================
function initAdminNotifListener() {
  // เริ่ม listen เมื่อเป็นแอดมิน
  const checkAdmin = setInterval(() => {
    if (typeof currentUser !== "undefined" && currentUser?.role === "admin") {
      clearInterval(checkAdmin);
      startAdminListeners();
    }
  }, 1000);
}

function startAdminListeners() {
  if (!_fbReady || !_db) return;
  const { collection, onSnapshot, query, orderBy, where } = window._FS;

  // ลบแชตเก่าเกิน 1 วันทุกครั้งที่แอดมิน login
  autoDeleteOldChats();

  // listen notifications
  const nq = query(
    collection(_db, "notifications"),
    where("read", "==", false),
    orderBy("createdAt", "desc")
  );
  onSnapshot(nq, snap => {
    const notifs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _unreadNotifCount = notifs.length;
    updateAdminNotifBadge(notifs.length);
    renderAdminNotifList(notifs);
  });

  // listen chats (unread)
  const cq = query(
    collection(_db, "chats"),
    orderBy("lastAt", "desc")
  );
  if (_chatUnsubConvs) _chatUnsubConvs();
  _chatUnsubConvs = onSnapshot(cq, snap => {
    const convs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAdminChatList(convs);
    const totalUnread = convs.reduce((s, c) => s + (c.unreadAdmin || 0), 0);
    updateAdminChatBadge(totalUnread);
  });
}

// ============================================================
// ADMIN CHAT TAB (inject ใน admin page)
// ============================================================
function injectAdminChatTab() {
  if (document.getElementById("adminTabChat")) return;

  // เพิ่มปุ่มใน admin tabs
  const tabBar = document.querySelector(".admin-tabs");
  if (tabBar) {
    const btn = document.createElement("button");
    btn.className = "admin-tab";
    btn.id = "adminChatTabBtn";
    btn.innerHTML = `💬 แชต <span class="admin-chat-badge hidden" id="adminChatBadge">0</span>`;
    btn.onclick = function() { switchAdminTab("chat", this); };
    tabBar.appendChild(btn);
  }

  // สร้าง tab content
  const main = document.getElementById("app");
  const adminPage = document.getElementById("adminPage");
  if (!adminPage) return;

  const tabDiv = document.createElement("div");
  tabDiv.id = "adminTabChat";
  tabDiv.className = "hidden";
  tabDiv.innerHTML = `
    <div class="admin-chat-wrap">
      <!-- LEFT: conversation list + notifications -->
      <div class="admin-chat-left">

        <!-- Notifications -->
        <div class="admin-notif-header">
          <span>🔔 แจ้งเตือน</span>
          <button class="admin-notif-clear" onclick="markAllNotifsRead()">ล้างทั้งหมด</button>
        </div>
        <div id="adminNotifList" class="admin-notif-list">
          <div class="admin-notif-empty">ยังไม่มีการแจ้งเตือน</div>
        </div>

        <!-- Conversations -->
        <div class="admin-notif-header" style="margin-top:8px">
          <span>💬 การสนทนา</span>
          <span id="adminChatCount" style="font-size:11px;color:var(--soft)"></span>
        </div>
        <div id="adminConvList" class="admin-conv-list">
          <div class="admin-notif-empty">ยังไม่มีการสนทนา</div>
        </div>
      </div>

      <!-- RIGHT: chat window -->
      <div class="admin-chat-right" id="adminChatRight">
        <div class="admin-chat-empty">
          <div style="font-size:48px;margin-bottom:12px">💬</div>
          <div>เลือกการสนทนาเพื่อตอบกลับ</div>
        </div>
      </div>
    </div>
  `;

  // แทรกก่อน /section
  const storeTab = document.getElementById("adminTabStore");
  if (storeTab) storeTab.insertAdjacentElement("afterend", tabDiv);
  else adminPage.appendChild(tabDiv);

  // เริ่ม listen ถ้า firebase พร้อม
  onFirebaseReady(() => startAdminListeners());
}

// ============================================================
// ลบ UI แชตลูกค้า (ปุ่มลอย + หน้าต่างแชต) — ใช้เมื่อเปลี่ยนเป็นแอดมิน
// ============================================================
function removeCustomerChatUI() {
  if (_chatUnsubMsg) { _chatUnsubMsg(); _chatUnsubMsg = null; }
  document.getElementById("chatFloatBtn")?.remove();
  document.getElementById("chatWidget")?.remove();
  _chatOpen = false;
}

// patch setupUser (เรียกหลัง login/register) — ถ้ากลายเป็นแอดมิน ให้ซ่อนปุ่ม/หน้าต่างแชตลูกค้าทันที
// แก้บัค: หน้าต่างแชตลอยไม่หายตอนเข้าสู่ระบบเป็นแอดมิน (เพราะถูก inject ไว้ตั้งแต่ก่อน login เป็น guest)
(function patchSetupUserForChat() {
  function tryPatch() {
    if (typeof setupUser === "undefined") { setTimeout(tryPatch, 200); return; }
    const _orig = setupUser;
    setupUser = function() {
      _orig.apply(this, arguments);
      if (isAdminUser()) removeCustomerChatUI();
    };
  }
  tryPatch();
})();

// patch switchAdminTab ให้รู้จัก tab "chat"
(function patchSwitchAdminTab() {
  function tryPatch() {
    if (typeof switchAdminTab === "undefined") { setTimeout(tryPatch, 200); return; }
    const _orig = switchAdminTab;
    switchAdminTab = function(tab, btn) {
      if (tab === "chat") {
        // hide all other tabs
        ["adminTabOrders","adminTabProducts","adminTabCustomers","adminTabStore","adminTabChat"]
          .forEach(id => document.getElementById(id)?.classList.toggle("hidden", id !== "adminTabChat"));
        document.querySelectorAll(".admin-tab").forEach(b => b.classList.remove("active"));
        btn?.classList.add("active");
        return;
      }
      document.getElementById("adminTabChat")?.classList.add("hidden");
      _orig(tab, btn);
    };
  }
  tryPatch();
})();

// inject admin tab เมื่อแอดมินเปิดหน้า admin
(function watchAdminPage() {
  let _lastAdminVisible = null;
  let _debounce = null;

  function updateVisibility() {
    const adminPage = document.getElementById("adminPage");
    const isAdminVisible = !!(adminPage && !adminPage.classList.contains("hidden"));
    if (isAdminVisible === _lastAdminVisible) return;
    _lastAdminVisible = isAdminVisible;
    if (isAdminVisible && !document.getElementById("adminTabChat")) {
      injectAdminChatTab();
    }
  }

  function startObserving() {
    const adminPage = document.getElementById("adminPage");
    if (adminPage) {
      new MutationObserver(() => {
        clearTimeout(_debounce);
        _debounce = setTimeout(updateVisibility, 50);
      }).observe(adminPage, { attributes: true, attributeFilter: ["class"] });
      updateVisibility();
    } else {
      setTimeout(startObserving, 300);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserving);
  } else {
    startObserving();
  }
})();

// ============================================================
// RENDER ADMIN NOTIFICATION LIST
// ============================================================
function renderAdminNotifList(notifs) {
  const list = document.getElementById("adminNotifList");
  if (!list) return;
  if (!notifs.length) {
    list.innerHTML = `<div class="admin-notif-empty">ยังไม่มีการแจ้งเตือน</div>`;
    return;
  }
  list.innerHTML = notifs.map(n => {
    const ts = n.createdAt?.toDate?.() || new Date();
    const timeStr = ts.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    const icon = n.type === "order" ? "🛒" : n.type === "chat" ? "💬" : n.type === "stock" ? "⚠️" : "🔔";
    return `
      <div class="admin-notif-item ${n.read ? "" : "unread"}" onclick="markNotifRead('${n.id}')">
        <div class="admin-notif-icon">${icon}</div>
        <div class="admin-notif-body">
          <div class="admin-notif-msg">${escHtml(n.message)}</div>
          <div class="admin-notif-time">${timeStr}</div>
        </div>
      </div>
    `;
  }).join("");
}

async function markNotifRead(id) {
  if (!_fbReady || !_db) return;
  const { doc, updateDoc } = window._FS;
  await updateDoc(doc(_db, "notifications", id), { read: true });
}

async function markAllNotifsRead() {
  if (!_fbReady || !_db) return;
  const { collection, getDocs, where, query, doc, updateDoc } = window._FS;
  const q = query(collection(_db, "notifications"), where("read", "==", false));
  const snap = await getDocs(q);
  snap.docs.forEach(d => updateDoc(d.ref, { read: true }));
}

function updateAdminNotifBadge(count) {
  // แสดงใน title tab ถ้ามี
  const orig = document.title.replace(/^\(\d+\) /, "");
  document.title = count > 0 ? `(${count}) ${orig}` : orig;
}

function updateAdminChatBadge(count) {
  const badge = document.getElementById("adminChatBadge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : count;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// ============================================================
// RENDER ADMIN CONVERSATION LIST
// ============================================================
// Store convs globally for event delegation
let _adminConvData = [];

function renderAdminChatList(convs) {
  const list = document.getElementById("adminConvList");
  const count = document.getElementById("adminChatCount");
  if (!list) return;

  // กรองแชตของแอดมินเองออก (เผื่อบัญชีนี้เคยคุยผ่านวิดเจ็ตแชตในฐานะลูกค้ามาก่อนตอนเป็นบัค)
  const myChatId = getChatSessionId();
  const myPhone  = currentUser?.phone ? String(currentUser.phone) : null;
  // เบอร์ของแอดมินคนอื่นๆ (ถ้าหน้าลูกค้าถูกโหลดมาแล้ว)
  const adminPhones = (typeof adminCustomers !== "undefined" ? adminCustomers : [])
    .filter(c => c.role === "admin")
    .map(c => String(c.phone));

  const filteredConvs = convs.filter(cv => {
    if (cv.id === myChatId) return false;
    if (myPhone && cv.customerPhone && String(cv.customerPhone) === myPhone) return false;
    if (cv.customerPhone && adminPhones.includes(String(cv.customerPhone))) return false;
    return true;
  });

  _adminConvData = filteredConvs;
  if (count) count.textContent = `${filteredConvs.length} การสนทนา`;
  if (!filteredConvs.length) {
    list.innerHTML = `<div class="admin-notif-empty">ยังไม่มีการสนทนา</div>`;
    return;
  }

  list.innerHTML = filteredConvs.map((cv, idx) => {
    const ts = cv.lastAt?.toDate?.() || new Date();
    const timeStr = ts.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    const unread = cv.unreadAdmin || 0;
    return `
      <div class="admin-conv-item" data-conv-idx="${idx}" data-conv-id="${cv.id}">
        <div class="admin-conv-avatar">${(cv.customerName||"ล")[0]}</div>
        <div class="admin-conv-body">
          <div class="admin-conv-name">${escHtml(cv.customerName||"ลูกค้า")}
            ${cv.customerPhone ? `<span style="font-size:10px;color:var(--soft);margin-left:4px">${escHtml(cv.customerPhone)}</span>` : ""}
          </div>
          <div class="admin-conv-last">${escHtml((cv.lastMessage||"").slice(0,40))}</div>
        </div>
        <div class="admin-conv-meta">
          <div class="admin-conv-time">${timeStr}</div>
          ${unread > 0 ? `<div class="admin-conv-unread">${unread}</div>` : ""}
        </div>
        <button class="admin-conv-delete" data-conv-id="${escHtml(cv.id)}" title="ลบการสนทนา" aria-label="ลบการสนทนา">🗑️</button>
      </div>
    `;
  }).join("");

  // Event delegation — ผูกครั้งเดียวที่ parent
  list.onclick = function(e) {
    const delBtn = e.target.closest(".admin-conv-delete");
    if (delBtn) {
      e.stopPropagation();
      deleteAdminConv(delBtn.dataset.convId);
      return;
    }
    const item = e.target.closest(".admin-conv-item");
    if (!item) return;
    const idx = parseInt(item.dataset.convIdx);
    const conv = _adminConvData[idx];
    if (conv) openAdminChat(conv.id, conv.customerName || "ลูกค้า");
  };
}

// ลบการสนทนา (ทั้งข้อความและ session doc) — ถ้าลูกค้าทักมาใหม่จะถูกสร้างขึ้นมาใหม่และเด้งกลับมาในรายการ
async function deleteAdminConv(convId) {
  if (!convId || !_fbReady || !_db) return;
  if (!confirm("ลบการสนทนานี้? ข้อความทั้งหมดในแชตนี้จะถูกลบ")) return;

  try {
    const { collection, doc, getDocs } = window._FS;
    const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

    // ลบข้อความทั้งหมดในแชตนี้ก่อน
    const msgsSnap = await getDocs(collection(_db, "chats", convId, "messages"));
    await Promise.all(msgsSnap.docs.map(d => deleteDoc(d.ref)));

    // ลบ session doc ของแชตนี้
    await deleteDoc(doc(_db, "chats", convId));

    // ถ้ากำลังเปิดแชตนี้อยู่ ให้ปิดหน้าต่างไปด้วย
    if (_adminActiveChatId === convId) closeAdminChatModal();

    showToast?.("ลบการสนทนาแล้ว");
  } catch (e) {
    console.warn("deleteAdminConv error", e);
    showToast?.("ลบการสนทนาไม่สำเร็จ");
  }
}

// ============================================================
// ADMIN CHAT WINDOW — Modal Popup
// ============================================================
let _adminActiveChatId = null;
let _adminChatUnsub    = null;

function closeAdminChatModal() {
  const m = document.getElementById("adminChatModal");
  if (m) { m.classList.add("acm-closing"); setTimeout(() => m.remove(), 240); }
  if (_adminChatUnsub) { _adminChatUnsub(); _adminChatUnsub = null; }
  _adminActiveChatId = null;
  _replyingTo = null;
}

async function openAdminChat(sessionId, customerName) {
  _adminActiveChatId = sessionId;
  document.getElementById("adminChatModal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "adminChatModal";
  overlay.className = "acm-overlay";
  overlay.innerHTML = `
    <div class="acm-box">
      <div class="admin-cw-header">
        <div style="display:flex;align-items:center;gap:11px;flex:1;min-width:0">
          <div class="admin-cw-avatar">${escHtml(customerName[0])}</div>
          <div style="min-width:0">
            <div class="admin-cw-name">${escHtml(customerName)}</div>
            <div class="admin-cw-status">ออนไลน์</div>
          </div>
        </div>
        <button class="acm-close-btn" id="acmCloseBtn" type="button">✕</button>
      </div>
      <div class="admin-cw-msgs" id="adminCwMsgs"></div>
      <div class="admin-cw-footer" id="adminCwFooter">
        <input class="cw-input" id="adminCwInput" placeholder="ตอบกลับลูกค้า..." autocomplete="off"/>
        <button class="cw-send" id="adminCwSendBtn" type="button" aria-label="ส่ง">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", e => { if (e.target === overlay) closeAdminChatModal(); });
  document.getElementById("acmCloseBtn").addEventListener("click", e => { e.stopPropagation(); closeAdminChatModal(); });

  const inp = document.getElementById("adminCwInput");
  const snd = document.getElementById("adminCwSendBtn");
  snd?.addEventListener("click", e => { e.stopPropagation(); adminSendMsg(); });
  inp?.addEventListener("keydown", e => { if (e.key==="Enter"&&!e.shiftKey){e.preventDefault();adminSendMsg();} });

  const _esc = e => { if(e.key==="Escape"){closeAdminChatModal();document.removeEventListener("keydown",_esc);} };
  document.addEventListener("keydown", _esc);

  const { collection, onSnapshot, query, orderBy, doc, updateDoc } = window._FS;
  await updateDoc(doc(_db, "chats", sessionId), { unreadAdmin: 0 });

  if (_adminChatUnsub) _adminChatUnsub();
  const q = query(collection(_db, "chats", sessionId, "messages"), orderBy("createdAt","asc"));
  _adminChatUnsub = onSnapshot(q, snap => renderAdminChatMsgs(snap.docs));

  setTimeout(() => inp?.focus(), 200);
}

// Store msg docs for actions
let _adminMsgDocs = [];

function renderAdminChatMsgs(docs) {
  const box = document.getElementById("adminCwMsgs");
  if (!box) return;
  _adminMsgDocs = docs;
  let lastDate = "";
  box.innerHTML = "";

  docs.forEach((d, idx) => {
    const data = d.data();
    const isAdmin = data.sender === "admin";
    const ts = data.createdAt?.toDate?.() || new Date();
    const dateStr = ts.toLocaleDateString("th-TH");
    const timeStr = ts.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });

    if (dateStr !== lastDate) {
      const div = document.createElement("div");
      div.className = "cw-date";
      div.textContent = dateStr;
      box.appendChild(div);
      lastDate = dateStr;
    }

    const row = document.createElement("div");
    // แอดมินส่งเอง=ขวา(row-self/ส้ม), ลูกค้าส่ง=ซ้าย(row-other/ขาว)
    row.className = "cw-msg-row " + (isAdmin ? "row-self" : "row-other");
    row.dataset.msgIdx = idx;
    row.dataset.msgId = d.id;

    const replyHtml = data.replyTo
      ? `<div class="cw-reply-quote"><span class="cw-reply-name">${escHtml(data.replyTo.senderName||"")}</span><span class="cw-reply-text">${escHtml((data.replyTo.text||"").slice(0,60))}</span></div>`
      : "";

    row.innerHTML = `
      ${!isAdmin ? `<div class="cw-msg-avatar">👤</div>` : ""}
      <div class="cw-bubble ${isAdmin ? "bubble-self" : "bubble-other"}" data-msg-idx="${idx}">
        ${!isAdmin ? `<div style="font-size:10px;font-weight:600;color:var(--orange);margin-bottom:2px">${escHtml(data.senderName||"ลูกค้า")}</div>` : ""}
        ${replyHtml}
        <div class="cw-bubble-text ${data.deleted ? 'deleted-msg' : ''}">${data.deleted ? '<i style="opacity:.55;font-size:11px">ยกเลิกข้อความนี้แล้ว</i>' : escHtml(data.text || "")}</div>
        <div class="cw-bubble-time">${timeStr}</div>
      </div>
    `;
    box.appendChild(row);
  });

  box.scrollTop = box.scrollHeight;

  // Long-press / context menu on bubbles
  setupAdminMsgActions(box);
}

// Long-press context menu
let _lpTimer = null;
let _msgMenuOpen = false;

function setupAdminMsgActions(box) {
  box.oncontextmenu = function(e) {
    const bubble = e.target.closest(".cw-bubble[data-msg-idx]");
    if (!bubble) return;
    e.preventDefault();
    showMsgActionMenu(bubble, parseInt(bubble.dataset.msgIdx));
  };
  box.ontouchstart = function(e) {
    const bubble = e.target.closest(".cw-bubble[data-msg-idx]");
    if (!bubble) return;
    clearTimeout(_lpTimer);
    _lpTimer = setTimeout(() => {
      showMsgActionMenu(bubble, parseInt(bubble.dataset.msgIdx));
    }, 500);
  };
  box.ontouchend  = () => clearTimeout(_lpTimer);
  box.ontouchmove = () => clearTimeout(_lpTimer);
}

function showMsgActionMenu(bubble, idx) {
  closeMsgActionMenu();
  const doc = _adminMsgDocs[idx];
  if (!doc) return;
  const data = doc.data();
  const isMsgAdmin = data.sender === "admin";

  const menu = document.createElement("div");
  menu.id = "msgActionMenu";
  menu.className = "msg-action-menu";
  menu.style.position = "fixed";
  menu.style.zIndex = "99999";

  let html = `<button class="msg-action-btn" data-action="reply" data-idx="${idx}">↩️ ตอบกลับ</button>`;
  if (!data.deleted) {
    html += `<button class="msg-action-btn danger" data-action="delete" data-idx="${idx}">🗑️ ยกเลิกข้อความ</button>`;
  }
  menu.innerHTML = html;
  document.body.appendChild(menu);
  _msgMenuOpen = true;

  requestAnimationFrame(() => {
    const rect = bubble.getBoundingClientRect();
    const mw = menu.offsetWidth  || 180;
    const mh = menu.offsetHeight || 80;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.top - mh - 8;
    if (top < 8) top = rect.bottom + 8;
    top = Math.min(top, vh - mh - 8);

    // แอดมิน = ขวา, ลูกค้า = ซ้าย
    let left = isMsgAdmin ? rect.right - mw : rect.left;
    left = Math.max(8, Math.min(left, vw - mw - 8));

    menu.style.top  = top  + "px";
    menu.style.left = left + "px";
  });

  menu.addEventListener("click", function(e) {
    const btn = e.target.closest(".msg-action-btn");
    if (!btn) return;
    const action = btn.dataset.action;
    const i = parseInt(btn.dataset.idx);
    closeMsgActionMenu();
    if (action === "reply") startReplyMsg(i);
    if (action === "delete") deleteAdminMsg(i);
  });

  // ปิดเมื่อแตะนอก — skip touchstart แรก (คือนิ้วที่ปล่อยจาก long-press)
  let _adSkip = true;
  function _adOutside(e) {
    if (_adSkip) { _adSkip = false; return; }
    if (e.target.closest("#msgActionMenu")) return;
    closeMsgActionMenu();
    document.removeEventListener("touchstart", _adOutside, true);
    document.removeEventListener("click",      _adOutside);
  }
  document.addEventListener("touchstart", _adOutside, true);
  setTimeout(() => document.addEventListener("click", _adOutside), 0);
}

function closeMsgActionMenu() {
  document.getElementById("msgActionMenu")?.remove();
  _msgMenuOpen = false;
}

// ── Reply ──
let _replyingTo = null;

function startReplyMsg(idx) {
  const doc = _adminMsgDocs[idx];
  if (!doc) return;
  const data = doc.data();
  _replyingTo = { text: data.text, senderName: data.senderName || (data.sender === "admin" ? "ร้านค้า" : "ลูกค้า") };

  // ลบ bar เก่าก่อนเสมอ แล้วสร้างใหม่ (ป้องกัน footer ย้ายหลัง re-render)
  document.getElementById("adminReplyBar")?.remove();
  const bar = document.createElement("div");
  bar.id = "adminReplyBar";
  bar.className = "reply-bar";
  bar.innerHTML = `
    <div class="reply-bar-content">
      <span class="reply-bar-name">${escHtml(_replyingTo.senderName)}</span>
      <span class="reply-bar-text">${escHtml((_replyingTo.text||"").slice(0,60))}</span>
    </div>
    <button class="reply-bar-close" id="replyBarClose" type="button">✕</button>
  `;
  const footer = document.getElementById("adminCwFooter") || document.querySelector(".admin-cw-footer");
  if (footer) footer.parentNode.insertBefore(bar, footer);
  bar.classList.remove("hidden");
  document.getElementById("replyBarClose")?.addEventListener("click", cancelReply);
  document.getElementById("adminCwInput")?.focus();
}

function cancelReply() {
  _replyingTo = null;
  const bar = document.getElementById("adminReplyBar");
  if (bar) bar.remove();
}

// ── Delete (ยกเลิก) ──
async function deleteAdminMsg(idx) {
  const doc = _adminMsgDocs[idx];
  if (!doc || !_fbReady) return;
  const { doc: fsDoc, updateDoc } = window._FS;

  // Soft delete: แทนที่ข้อความด้วย "ยกเลิกข้อความนี้แล้ว"
  try {
    const { deleteField } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    await updateDoc(fsDoc(_db, "chats", _adminActiveChatId, "messages", doc.id), {
      text: "",
      deleted: true
    });
  } catch(e) { console.warn("delete msg error", e); }
}

async function adminSendMsg() {
  const input = document.getElementById("adminCwInput");
  const text = input?.value?.trim();
  if (!text || !_adminActiveChatId || !_fbReady) return;
  input.value = "";

  const { collection, addDoc, serverTimestamp, doc, updateDoc } = window._FS;
  const msgData = {
    text,
    sender: "admin",
    senderName: "ร้านค้า",
    createdAt: serverTimestamp(),
    readByCustomer: false
  };
  if (_replyingTo) {
    msgData.replyTo = { text: _replyingTo.text, senderName: _replyingTo.senderName };
    cancelReply();
  }
  await addDoc(collection(_db, "chats", _adminActiveChatId, "messages"), msgData);
  await updateDoc(doc(_db, "chats", _adminActiveChatId), {
    lastMessage: `[ร้านค้า] ${text}`,
    lastAt: serverTimestamp()
  });
}

// ============================================================
// AUTO-DELETE CHATS OLDER THAN 1 DAY
// ============================================================
async function autoDeleteOldChats() {
  if (!_fbReady || !_db) return;
  const { collection, getDocs, query, where, Timestamp, doc, deleteDoc } = window._FS;
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cutoffTs = Timestamp.fromDate(cutoff);
    const chatsSnap = await getDocs(collection(_db, "chats"));
    for (const chatDoc of chatsSnap.docs) {
      const data = chatDoc.data();
      const lastAt = data.lastAt;
      if (lastAt && lastAt.toDate() < cutoff) {
        // ลบ messages ทั้งหมดในห้องนี้ก่อน
        const msgsSnap = await getDocs(collection(_db, "chats", chatDoc.id, "messages"));
        for (const msgDoc of msgsSnap.docs) {
          await deleteDoc(doc(_db, "chats", chatDoc.id, "messages", msgDoc.id));
        }
        // แล้วลบห้องแชต
        await deleteDoc(doc(_db, "chats", chatDoc.id));
      }
    }
    console.log("[Chat] Auto-delete old chats done");
  } catch(e) { console.warn("autoDeleteOldChats error", e); }
}

// ============================================================
// STOCK ALERT → Notification
// ============================================================
(function hookStockAlert() {
  function tryHook() {
    if (typeof products === "undefined") { setTimeout(tryHook, 800); return; }
    const _origLoad = typeof loadProducts !== "undefined" ? loadProducts : null;
    if (!_origLoad) { setTimeout(tryHook, 500); return; }
    loadProducts = async function() {
      await _origLoad.apply(this, arguments);
      checkStockNotifs();
    };
  }
  tryHook();
})();

function checkStockNotifs() {
  if (!Array.isArray(products)) return;
  products.forEach(p => {
    if (p.stock > 0 && p.stock <= 3) {
      sendAdminNotif("stock", `⚠️ สต็อกใกล้หมด: ${p.name} เหลือ ${p.stock} ชิ้น`);
    }
  });
}

// ============================================================
// SLIP UPLOADED → Notification
// ============================================================
(function hookSlipNotif() {
  function tryHook() {
    if (typeof uploadSlipToDrive === "undefined") { setTimeout(tryHook, 600); return; }
    const _orig = uploadSlipToDrive;
    uploadSlipToDrive = async function() {
      const result = await _orig.apply(this, arguments);
      if (result) {
        const name = currentUser?.name || currentUser?.phone || "ลูกค้า";
        sendAdminNotif("slip", `🧾 สลิปใหม่รอตรวจ จาก ${name}`);
      }
      return result;
    };
  }
  tryHook();
})();

// ── escHtml fallback (ถ้า script.js ยังไม่โหลด) ──
if (typeof escHtml === "undefined") {
  window.escHtml = function(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  };
}
