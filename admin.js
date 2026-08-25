/* video-narrator admin — email OTP + read-only tracking dashboard */
(function () {
  "use strict";

  const SUPABASE_URL = "https://lbzcvnvucdqfyubipjxj.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxiemN2bnZ1Y2RxZnl1YmlwanhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNDI1ODYsImV4cCI6MjEwMjcxODU4Nn0.zbBQVXteV-AXsWgHpf0xmU_40q6nsb9Vznx0EQ0fW7k"; // public anon key (injected at build)

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const el = {
    authView: $("auth-view"), emailForm: $("email-form"), email: $("email"),
    codeForm: $("code-form"), code: $("code"),
    sendCodeBtn: $("send-code-btn"), verifyBtn: $("verify-btn"), backBtn: $("back-btn"),
    authMsg: $("auth-msg"),
    deniedView: $("denied-view"), deniedLogoutBtn: $("denied-logout-btn"),
    dashView: $("dash-view"), userEmail: $("user-email"),
    logoutBtn: $("logout-btn"), refreshBtn: $("refresh-btn"),
    statTotal: $("stat-total"), statNarrators: $("stat-narrators"),
    statVideos: $("stat-videos"), statLatest: $("stat-latest"),
    loadingState: $("loading-state"), emptyState: $("empty-state"),
    errorState: $("error-state"), errorMsg: $("error-msg"), retryBtn: $("retry-btn"),
    tableWrap: $("table-wrap"), tableBody: $("table-body"),
    toast: $("error-toast"),
  };

  // ---- helpers ----
  function showToast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.add("hidden"), ms || 4000);
  }
  function setAuthMsg(text, kind) {
    el.authMsg.textContent = text || "";
    el.authMsg.className = "msg" + (kind ? " " + kind : "");
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtDuration(sec) {
    if (sec == null || sec === "" || isNaN(Number(sec))) return null;
    const s = Math.round(Number(sec));
    return Math.floor(s / 60) + ":" + pad(s % 60);
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }
  function cell(text, muted) {
    const c = document.createElement("td");
    c.textContent = (text == null || text === "") ? "—" : String(text);
    if (muted) c.className = "muted";
    return c;
  }

  // ---- views ----
  function showAuth() {
    el.authView.classList.remove("hidden");
    el.deniedView.classList.add("hidden");
    el.dashView.classList.add("hidden");
    el.emailForm.classList.remove("hidden");
    el.codeForm.classList.add("hidden");
    setAuthMsg("");
  }
  function showDenied() {
    el.authView.classList.add("hidden");
    el.dashView.classList.add("hidden");
    el.deniedView.classList.remove("hidden");
  }
  function showDash() {
    el.authView.classList.add("hidden");
    el.deniedView.classList.add("hidden");
    el.dashView.classList.remove("hidden");
  }

  // ---- auth flow (same pattern as index.html/app.js) ----
  async function sendCode(email) {
    setAuthMsg("Sending code…");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: true },
      });
      if (error) throw error;
      el.emailForm.classList.add("hidden");
      el.codeForm.classList.remove("hidden");
      setAuthMsg("Code sent to " + email + ". Check your inbox.", "ok");
      el.code.focus();
    } catch (e) {
      setAuthMsg("Failed to send code: " + e.message, "error");
    }
  }

  async function verifyCode(email, code) {
    setAuthMsg("Verifying…");
    try {
      const { error } = await supabase.auth.verifyOtp({
        email, token: code, type: "email",
      });
      if (error) throw error;
      setAuthMsg("");
      initDashboard();
    } catch (e) {
      setAuthMsg("Wrong or expired code: " + e.message, "error");
    }
  }

  // ---- dashboard ----
  function showLoading() {
    el.loadingState.classList.remove("hidden");
    el.emptyState.classList.add("hidden");
    el.errorState.classList.add("hidden");
    el.tableWrap.classList.add("hidden");
  }
  function showEmpty() {
    el.loadingState.classList.add("hidden");
    el.errorState.classList.add("hidden");
    el.tableWrap.classList.add("hidden");
    el.emptyState.classList.remove("hidden");
  }
  function showError(msg) {
    el.loadingState.classList.add("hidden");
    el.emptyState.classList.add("hidden");
    el.tableWrap.classList.add("hidden");
    el.errorMsg.textContent = msg;
    el.errorState.classList.remove("hidden");
  }
  function showTable() {
    el.loadingState.classList.add("hidden");
    el.emptyState.classList.add("hidden");
    el.errorState.classList.add("hidden");
    el.tableWrap.classList.remove("hidden");
  }

  async function initDashboard() {
    showDash();
    const { data: { user } } = await supabase.auth.getUser();
    el.userEmail.textContent = user ? user.email : "";
    // admin gate: vn_is_admin RPC
    try {
      const { data: isAdmin, error } = await supabase.rpc("vn_is_admin");
      if (error) throw error;
      if (isAdmin !== true) { showDenied(); return; }
      await loadNarrations();
    } catch (e) {
      showError("Admin check failed: " + e.message);
    }
  }

  async function loadNarrations() {
    showLoading();
    try {
      const { data, error } = await supabase.rpc("vn_admin_list_narrations");
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (rows.length === 0) { showEmpty(); return; }
      renderStats(rows);
      renderTable(rows);
      showTable();
    } catch (e) {
      showError("Could not load narrations: " + e.message);
    }
  }

  function renderStats(rows) {
    el.statTotal.textContent = rows.length;
    const narrators = new Set(rows.map((r) => r.user_email).filter(Boolean));
    const videos = new Set(rows.map((r) => r.video_id).filter(Boolean));
    el.statNarrators.textContent = narrators.size;
    el.statVideos.textContent = videos.size;
    el.statLatest.textContent = fmtDate(rows[0] && rows[0].created_at);
  }

  function renderTable(rows) {
    el.tableBody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      const title = r.video_title ? r.video_title : r.video_id;
      const dur = fmtDuration(r.duration_sec);

      tr.appendChild(cell(fmtDate(r.created_at)));
      tr.appendChild(cell(r.user_email));
      tr.appendChild(cell(title));
      tr.appendChild(cell(dur == null ? "—" : dur));

      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = r.status || "—";
      statusCell.appendChild(badge);
      tr.appendChild(statusCell);

      const audioCell = document.createElement("td");
      if (r.audio_url) {
        const a = document.createElement("audio");
        a.controls = true;
        a.preload = "none";
        a.src = r.audio_url;
        audioCell.appendChild(a);
      } else {
        audioCell.textContent = "—";
      }
      tr.appendChild(audioCell);

      el.tableBody.appendChild(tr);
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    showAuth();
  }

  // ---- events ----
  el.emailForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendCode(el.email.value.trim().toLowerCase());
  });
  el.codeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    verifyCode(el.email.value.trim().toLowerCase(), el.code.value.trim());
  });
  el.backBtn.addEventListener("click", () => {
    el.codeForm.classList.add("hidden");
    el.emailForm.classList.remove("hidden");
    setAuthMsg("");
  });
  el.logoutBtn.addEventListener("click", logout);
  el.deniedLogoutBtn.addEventListener("click", logout);
  el.refreshBtn.addEventListener("click", loadNarrations);
  el.retryBtn.addEventListener("click", initDashboard);

  // ---- boot ----
  (async function boot() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      initDashboard();
    } else {
      showAuth();
    }
  })();
})();
