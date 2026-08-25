/* video-narrator app — supabase email OTP + MediaRecorder narration */
(function () {
  "use strict";

  const SUPABASE_URL = "https://lbzcvnvucdqfyubipjxj.supabase.co";
  const SUPABASE_ANON_KEY = "ANON_KEY_PLACEHOLDER"; // injected at deploy time

  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---- state ----
  const state = {
    videos: [],        // all active videos
    doneIds: new Set(),// video ids already narrated by this user
    current: null,     // current video object
    recorder: null,
    chunks: [],
    recording: false,
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
      initWork();
    } catch (e) {
      setAuthMsg("Wrong or expired code: " + e.message, "error");
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
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
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

  function stopRecording() {
    if (!state.recorder || !state.recording) return;
    state.recording = false;
    clearInterval(state.timerInterval);
    state.recorder.stop();
    state.recorder.stream.getTracks().forEach((t) => t.stop());
  }

  async function onRecordingStopped() {
    const blob = new Blob(state.chunks, { type: state.recorder.mimeType || "audio/webm" });
    state.recorder = null;
    el.recordBtn.classList.add("hidden");
    el.stopBtn.classList.add("hidden");
    el.retryBtn.classList.add("hidden");
    el.recStatus.classList.remove("recording");
    el.recStatus.textContent = "Uploading…";
    state.submitting = true;
    el.submitState.classList.remove("hidden");
    try {
      await submitNarration(blob);
    } catch (e) {
      state.submitting = false;
      el.submitState.classList.add("hidden");
      resetRecorderUI();
      showToast("Upload failed: " + e.message + " — press record to try again.");
    }
  }

  async function submitNarration(blob) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("not signed in");
    const v = state.current;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = user.id + "/" + v.id + "-" + stamp + ".webm";

    const { error: upErr } = await supabase.storage
      .from("vn-narrations")
      .upload(path, blob, { contentType: "audio/webm", upsert: false });
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
    if (insErr) throw insErr;

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
  el.stopBtn.addEventListener("click", stopRecording);
  el.retryBtn.addEventListener("click", () => {
    stopRecording();
    resetRecorderUI();
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
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      initWork();
    } else {
      showAuth();
    }
  })();
})();
