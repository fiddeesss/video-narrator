/* video-narrator app — supabase email OTP + MediaRecorder narration */
(function () {
  "use strict";

  const SUPABASE_URL = "https://lbzcvnvucdqfyubipjxj.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxiemN2bnZ1Y2RxZnl1YmlwanhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNDI1ODYsImV4cCI6MjEwMjcxODU4Nn0.zbBQVXteV-AXsWgHpf0xmU_40q6nsb9Vznx0EQ0fW7k"; // injected at deploy time

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---- state ----
  const state = {
    videos: [],        // all active videos
    doneIds: new Set(),// video ids already narrated by this user
    current: null,     // current video object
    recorder: null,
    chunks: [],
    recording: false,
    discarding: false, // true while a stop() is a discard, not a submit
    timerInterval: null,
    timerSec: 0,
    submitting: false,
  };

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const el = {
    authView: $("auth-view"), workView: $("work-view"),
    emailForm: $("email-form"), email: $("email"),
    codeForm: $("code-form"), code: $("code"),
    sendCodeBtn: $("send-code-btn"), verifyBtn: $("verify-btn"), backBtn: $("back-btn"),
    authMsg: $("auth-msg"),
    videoStage: $("video-stage"),
    userEmail: $("user-email"), logoutBtn: $("logout-btn"),
    queueFill: $("queue-fill"), queueLabel: $("queue-label"),
    videoTitle: $("video-title"), player: $("player"),
    recStatus: $("rec-status"), recTimer: $("rec-timer"),
    recordBtn: $("record-btn"), stopBtn: $("stop-btn"), retryBtn: $("retry-btn"),
    submitState: $("submit-state"), doneState: $("done-state"), nextBtn: $("next-btn"),
    emptyState: $("empty-state"), refreshBtn: $("refresh-btn"),
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
  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return m + ":" + pad(s % 60);
  }
  function storagePublicUrl(path) {
    return SUPABASE_URL + "/storage/v1/object/public/vn-narrations/" + path;
  }
  function extForMime(mime) {
    if (!mime) return "webm";
    if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
    if (mime.includes("ogg")) return "ogg";
    if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
    return "webm";
  }

  // ---- views ----
  function showAuth() {
    el.authView.classList.remove("hidden");
    el.workView.classList.add("hidden");
    el.emailForm.classList.remove("hidden");
    el.codeForm.classList.add("hidden");
    setAuthMsg("");
  }
  function showWork() {
    el.authView.classList.add("hidden");
    el.workView.classList.remove("hidden");
  }

  // ---- auth flow ----
  async function sendCode(email) {
    setAuthMsg("Sending sign-in link…");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) throw error;
      el.emailForm.classList.add("hidden");
      el.codeForm.classList.remove("hidden");
      setAuthMsg(
        "Check your inbox for an email from Supabase and click the link in it — " +
        "it'll bring you right back here signed in. (If your email also shows a 6-digit code, you can enter it below instead.)",
        "ok"
      );
    } catch (e) {
      setAuthMsg("Failed to send link: " + e.message, "error");
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
      initWork();
    } catch (e) {
      setAuthMsg("Wrong or expired code — or just click the link in the email instead: " + e.message, "error");
    }
  }

  // Handle the redirect back from the magic-link email (PKCE: ?code=... in the URL).
  async function tryMagicLinkLogin() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return false;
    try {
      const { error } = await supabase.auth.exchangeCodeForSession(window.location.href);
      // Clean the ?code= off the URL either way so a refresh doesn't retry it.
      window.history.replaceState({}, "", window.location.pathname);
      if (error) throw error;
      return true;
    } catch (e) {
      showToast("Sign-in link failed: " + e.message);
      return false;
    }
  }

  // ---- work flow ----
  async function initWork() {
    showWork();
    const { data: { user } } = await supabase.auth.getUser();
    el.userEmail.textContent = user ? user.email : "";
    await loadQueue();
  }

  async function loadQueue() {
    try {
      const [vRes, nRes] = await Promise.all([
        supabase.from("vn_videos").select("id,title,url").eq("active", true).order("sort_order"),
        supabase.from("vn_narrations").select("video_id"),
      ]);
      if (vRes.error) throw vRes.error;
      if (nRes.error) throw nRes.error;
      state.videos = vRes.data;
      state.doneIds = new Set((nRes.data || []).map((r) => r.video_id));
      renderQueue();
    } catch (e) {
      showToast("Could not load videos: " + e.message);
    }
  }

  function renderQueue() {
    const total = state.videos.length;
    const done = state.videos.filter((v) => state.doneIds.has(v.id)).length;
    el.queueFill.style.width = total ? (done / total) * 100 + "%" : "0%";
    el.queueLabel.textContent = done + " / " + total + " done";

    const next = state.videos.find((v) => !state.doneIds.has(v.id));
    if (!next) {
      el.videoStage.classList.add("hidden");
      el.emptyState.classList.remove("hidden");
      return;
    }
    el.videoStage.classList.remove("hidden");
    el.emptyState.classList.add("hidden");
    loadVideo(next);
  }

  function loadVideo(video) {
    state.current = video;
    el.videoTitle.textContent = video.title;
    el.player.src = video.url;
    resetRecorderUI();
  }

  function resetRecorderUI() {
    state.recording = false;
    state.chunks = [];
    state.timerSec = 0;
    clearInterval(state.timerInterval);
    el.recTimer.classList.add("hidden");
    el.recTimer.textContent = "0:00";
    el.recordBtn.classList.remove("hidden");
    el.stopBtn.classList.add("hidden");
    el.retryBtn.classList.add("hidden");
    el.recStatus.classList.remove("recording");
    el.recStatus.textContent = "Watch the video, then press record and describe what's happening.";
    el.submitState.classList.add("hidden");
    el.doneState.classList.add("hidden");
    el.recordBtn.disabled = false;
  }

  // ---- recording ----
  async function startRecording() {
    if (state.recording || state.submitting) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      showToast("Your browser doesn't support voice recording. Use a recent Chrome or Safari.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const candidates = [
        "audio/webm;codecs=opus", "audio/webm",
        "audio/mp4;codecs=mp4a.40.2", "audio/mp4",
        "audio/ogg;codecs=opus", "audio/ogg",
      ];
      const mime = candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
      state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      state.chunks = [];
      state.recorder.ondataavailable = (e) => { if (e.data.size) state.chunks.push(e.data); };
      state.recorder.onstop = onRecordingStopped;
      state.recorder.start();
      state.recording = true;

      // UI
      el.recordBtn.classList.add("hidden");
      el.stopBtn.classList.remove("hidden");
      el.retryBtn.classList.remove("hidden");
      el.recStatus.classList.add("recording");
      el.recStatus.textContent = "Recording… narrate what's happening right now.";
      el.recTimer.classList.remove("hidden");
      state.timerSec = 0;
      state.timerInterval = setInterval(() => {
        state.timerSec++;
        el.recTimer.textContent = fmtTime(state.timerSec);
      }, 1000);

      // keep playing the video so they can narrate while watching
      el.player.play().catch(() => {});
    } catch (e) {
      showToast("Microphone blocked. Allow mic access and try again.");
    }
  }

  function stopRecording(discard) {
    if (!state.recorder || !state.recording) return;
    state.recording = false;
    state.discarding = !!discard;
    clearInterval(state.timerInterval);
    state.recorder.stop();
    state.recorder.stream.getTracks().forEach((t) => t.stop());
  }

  async function onRecordingStopped() {
    const wasDiscarding = state.discarding;
    const mimeType = state.recorder.mimeType || "audio/webm";
    const chunks = state.chunks;
    state.recorder = null;
    state.discarding = false;

    if (wasDiscarding) {
      // Discard: drop the audio, do NOT upload or submit anything.
      resetRecorderUI();
      return;
    }

    const blob = new Blob(chunks, { type: mimeType });
    el.recordBtn.classList.add("hidden");
    el.stopBtn.classList.add("hidden");
    el.retryBtn.classList.add("hidden");
    el.recStatus.classList.remove("recording");
    el.recStatus.textContent = "Uploading…";
    state.submitting = true;
    el.submitState.classList.remove("hidden");
    try {
      await submitNarration(blob, mimeType);
    } catch (e) {
      state.submitting = false;
      el.submitState.classList.add("hidden");
      resetRecorderUI();
      showToast("Upload failed: " + e.message + " — press record to try again.");
    }
  }

  async function submitNarration(blob, mimeType) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("not signed in");
    const v = state.current;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = extForMime(mimeType);
    const path = user.id + "/" + v.id + "-" + stamp + "." + ext;

    const { error: upErr } = await supabase.storage
      .from("vn-narrations")
      .upload(path, blob, { contentType: mimeType || "audio/webm", upsert: false });
    if (upErr) throw upErr;

    const { error: insErr } = await supabase
      .from("vn_narrations")
      .insert({
        user_id: user.id,
        video_id: v.id,
        audio_path: path,
        audio_url: storagePublicUrl(path),
        duration_sec: state.timerSec,
        status: "submitted",
      });
    if (insErr) {
      // Unique violation (23505) = this video was already narrated by this user
      // (e.g. a second tab, a double-submit race). Not an error worth alarming
      // over — just treat it as already-done and move on.
      if (insErr.code === "23505") {
        state.doneIds.add(v.id);
        el.submitState.classList.add("hidden");
        el.doneState.classList.remove("hidden");
        state.submitting = false;
        renderQueue();
        return;
      }
      throw insErr;
    }

    state.doneIds.add(v.id);
    el.submitState.classList.add("hidden");
    el.doneState.classList.remove("hidden");
    state.submitting = false;
    renderQueue();
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
  el.recordBtn.addEventListener("click", startRecording);
  el.stopBtn.addEventListener("click", () => stopRecording(false));
  el.retryBtn.addEventListener("click", () => {
    stopRecording(/* discard */ true);
  });
  el.nextBtn.addEventListener("click", () => {
    el.doneState.classList.add("hidden");
    renderQueue();
  });
  el.refreshBtn.addEventListener("click", loadQueue);
  el.logoutBtn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    showAuth();
  });

  // ---- boot ----
  (async function boot() {
    await tryMagicLinkLogin();
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      initWork();
    } else {
      showAuth();
    }
  })();
})();
