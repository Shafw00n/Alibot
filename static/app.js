const modeButtons = [...document.querySelectorAll("[data-mode]")];
const welcome = document.querySelector("#welcome");
const welcomeTitle = document.querySelector("#welcome-title");
const welcomeCopy = document.querySelector("#welcome-copy");
const practicumLabel = document.querySelector("#practicum-label");
const messages = document.querySelector("#messages");
const composerWrap = document.querySelector("#composer-wrap");
const voicePanel = document.querySelector("#voice-panel");
const chatForm = document.querySelector("#chat-form");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const errorBanner = document.querySelector("#error-banner");
const clearButton = document.querySelector("#clear-button");
const recordButton = document.querySelector("#record-button");
const recordLabel = document.querySelector("#record-label");
const recordHint = document.querySelector("#record-hint");
const voiceOrb = document.querySelector("#voice-orb");
const voiceTitle = document.querySelector("#voice-title");
const voiceDescription = document.querySelector("#voice-description");
const voiceResult = document.querySelector("#voice-result");
const transcriptElement = document.querySelector("#transcript");
const voiceReply = document.querySelector("#voice-reply");
const speakButton = document.querySelector("#speak-button");

let activeMode = "text";
let busy = false;
let recorder;
let recordingStream;
let recordingTimer;
let silenceMonitorFrame;
let audioContext;
const recordingDurationSeconds = 30;
const silenceDurationMs = 2000;
const speechThreshold = 0.035;

const welcomeCopyByMode = {
  text: ["PRAKTIKUM 9.1", "Chatbot Gemini API", "Ketik pesan untuk memulai percakapan dengan Alibot."],
  voice: ["PRAKTIKUM 9.2", "Voice Chatbot Gemini API", "Ucapkan pertanyaan Anda. Alibot akan menjawab dalam bentuk teks."],
  voice_out: ["PRAKTIKUM 9.3", "Voice-in & Voice-out Chatbot", "Alibot akan mendengarkan, menjawab, lalu membacakan jawabannya dalam Bahasa Indonesia."]
};

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function clearError() {
  errorBanner.textContent = "";
  errorBanner.hidden = true;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Permintaan gagal (${response.status}).`);
  return data;
}

function addMessage(role, text, pending = false) {
  const row = document.createElement("article");
  row.className = `message ${role}${pending ? " pending" : ""}`;
  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "AK" : "✦";
  const content = document.createElement("div");
  content.className = "message-content";
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = role === "user" ? "ANDA" : "ALIBOT";
  const body = document.createElement("span");
  body.textContent = text;
  content.append(label, body);
  row.append(avatar, content);
  messages.append(row);
  welcome.hidden = true;
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return { row, body };
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  recordButton.disabled = value;
  messageInput.disabled = value;
}

function setMode(mode) {
  activeMode = mode;
  clearError();
  modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  composerWrap.hidden = mode !== "text";
  voicePanel.hidden = mode === "text";
  welcome.hidden = mode !== "text" || messages.childElementCount > 0;
  const [practicum, title, copy] = welcomeCopyByMode[mode];
  practicumLabel.textContent = practicum;
  welcomeTitle.textContent = title;
  welcomeCopy.textContent = copy;
  voiceTitle.textContent = mode === "voice_out" ? "Praktikum 9.3" : "Praktikum 9.2";
  voiceDescription.textContent = `Ucapkan pertanyaan Anda. Rekaman maksimal ${recordingDurationSeconds} detik dan diproses setelah ${silenceDurationMs / 1000} detik hening.`;
  recordHint.textContent = "Pastikan browser mengizinkan akses mikrofon.";
  voiceResult.hidden = true;
}

function chooseAudioType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function stopTracks() {
  if (recordingStream) {
    recordingStream.getTracks().forEach((track) => track.stop());
    recordingStream = undefined;
  }
}

function stopSilenceMonitor() {
  if (silenceMonitorFrame !== undefined) {
    cancelAnimationFrame(silenceMonitorFrame);
    silenceMonitorFrame = undefined;
  }
  if (audioContext) {
    const context = audioContext;
    audioContext = undefined;
    void context.close().catch((error) => console.warn("Gagal menutup pemantau mikrofon.", error));
  }
}

function monitorSilence(analyser, activeRecorder) {
  const samples = new Uint8Array(analyser.fftSize);
  let speechDetected = false;
  let silenceStartedAt = 0;
  const startedAt = performance.now();

  const checkLevel = () => {
    if (activeRecorder.state !== "recording") return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const amplitude = (sample - 128) / 128;
      sum += amplitude * amplitude;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();

    if (rms >= speechThreshold) {
      speechDetected = true;
      silenceStartedAt = 0;
      recordHint.textContent = `Suara terdeteksi. Rekaman berhenti otomatis setelah ${silenceDurationMs / 1000} detik hening atau ${recordingDurationSeconds} detik.`;
    } else if (speechDetected) {
      if (!silenceStartedAt) silenceStartedAt = now;
      if (now - silenceStartedAt >= silenceDurationMs && now - startedAt >= silenceDurationMs) {
        recordHint.textContent = "Hening terdeteksi. Memproses rekaman...";
        activeRecorder.stop();
        return;
      }
    }
    silenceMonitorFrame = requestAnimationFrame(checkLevel);
  };

  silenceMonitorFrame = requestAnimationFrame(checkLevel);
}

function speakReply(text) {
  if (!("speechSynthesis" in window)) {
    recordHint.textContent = "Browser ini tidak mendukung pembacaan suara. Jawaban tetap tersedia sebagai teks.";
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "id-ID";
  window.speechSynthesis.speak(utterance);
}

async function recordAndSend() {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  if (busy) return;
  clearError();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError("Browser ini belum mendukung perekaman audio. Gunakan versi terbaru Chrome, Edge, atau Firefox melalui localhost/HTTPS.");
    return;
  }

  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = chooseAudioType();
    recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : undefined);
    const activeRecorder = recorder;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Browser tidak mendukung deteksi keheningan audio.");
    audioContext = new AudioContextClass();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(recordingStream).connect(analyser);
    await audioContext.resume();
    const chunks = [];
    activeRecorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    activeRecorder.onerror = () => showError("Perekaman gagal. Periksa mikrofon dan izin browser Anda.");
    activeRecorder.onstop = async () => {
      clearTimeout(recordingTimer);
      stopSilenceMonitor();
      stopTracks();
      recordButton.classList.remove("recording");
      recordLabel.textContent = "Mulai merekam";
      recordHint.textContent = "Memproses rekaman...";
      setBusy(true);
      try {
        const type = activeRecorder.mimeType || "audio/webm";
        const extension = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm";
        const formData = new FormData();
        formData.append("audio", new Blob(chunks, { type }), `recording.${extension}`);
        formData.append("mode", activeMode);
        const data = await requestJson("/api/voice", { method: "POST", body: formData });
        voiceResult.hidden = false;
        transcriptElement.textContent = data.transcript;
        voiceReply.textContent = data.reply || "Suara tidak terdeteksi atau terlalu pelan.";
        speakButton.hidden = !data.reply || activeMode !== "voice_out";
        if (data.reply && activeMode === "voice_out") {
          speakReply(data.reply);
        }
        recordHint.textContent = "Selesai. Tekan tombol untuk berbicara lagi.";
      } catch (error) {
        showError(error.message);
        recordHint.textContent = "Perekaman tidak berhasil diproses.";
      } finally {
        setBusy(false);
      }
    };
    activeRecorder.start();
    monitorSilence(analyser, activeRecorder);
    recordButton.classList.add("recording");
    recordLabel.textContent = "Hentikan rekaman";
    recordHint.textContent = `Bicara sekarang. Rekaman berhenti setelah ${silenceDurationMs / 1000} detik hening, maksimal ${recordingDurationSeconds} detik.`;
    recordingTimer = window.setTimeout(() => {
      if (activeRecorder.state === "recording") {
        recordHint.textContent = "Batas 30 detik tercapai. Memproses rekaman...";
        activeRecorder.stop();
      }
    }, recordingDurationSeconds * 1000);
  } catch (error) {
    stopSilenceMonitor();
    stopTracks();
    showError(error.name === "NotAllowedError"
      ? "Akses mikrofon ditolak. Izinkan penggunaan mikrofon pada pengaturan browser."
      : `Tidak dapat mengakses mikrofon: ${error.message}`);
  }
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || busy) return;
  clearError();
  addMessage("user", message);
  messageInput.value = "";
  messageInput.style.height = "auto";
  const pending = addMessage("assistant", "Alibot sedang berpikir...");
  pending.row.classList.add("pending");
  setBusy(true);
  try {
    const data = await requestJson("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    pending.body.textContent = data.reply;
    pending.row.classList.remove("pending");
  } catch (error) {
    pending.row.remove();
    showError(error.message);
  } finally {
    setBusy(false);
    messageInput.focus();
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 150)}px`;
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
recordButton.addEventListener("click", recordAndSend);
speakButton.addEventListener("click", () => speakReply(voiceReply.textContent));

clearButton.addEventListener("click", async () => {
  clearError();
  try {
    await requestJson("/api/clear", { method: "POST" });
    messages.replaceChildren();
    welcome.hidden = activeMode !== "text";
    voiceResult.hidden = true;
  } catch (error) {
    showError(error.message);
  }
});

requestJson("/api/config")
  .then(({ api_key_configured: configured }) => {
    document.querySelector("#status-dot").classList.add(configured ? "ready" : "missing");
    document.querySelector("#api-status-text").textContent = configured ? "API key siap digunakan" : "API key belum diatur";
  })
  .catch((error) => {
    document.querySelector("#api-status-text").textContent = "Status API key tidak diketahui";
    showError(error.message);
  });
