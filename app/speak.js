// app/speak.js
// Simple Web Speech "Speak" button for chat page.
// Fills the #q input with dictated text. It does NOT auto-send.

(() => {
  const btn = document.getElementById("btn-speak");
  const input = document.getElementById("q");
  if (!btn || !input) return;

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition || null;

  // If the browser doesn't support Web Speech, disable the button gracefully.
  if (!SpeechRecognition) {
    console.warn("[SOW] Web Speech API not available; Speak button disabled.");
    btn.disabled = true;
    btn.title =
      "Voice input isn’t supported in this browser. Please type instead, or try Chrome on desktop.";
    return;
  }

  let recognizer = null;
  let listening = false;

  function setUI(active) {
    listening = active;
    btn.classList.toggle("recording", active);
    btn.textContent = active ? "Listening…" : "Speak";
  }

  btn.addEventListener("click", () => {
    if (listening) {
      try {
        recognizer?.stop();
      } catch (e) {
        // ignore
      }
      return;
    }

    recognizer = new SpeechRecognition();
    recognizer.lang = "en-US";
    recognizer.continuous = false;
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;

    recognizer.onstart = () => {
      setUI(true);
    };

    recognizer.onerror = (e) => {
      console.warn("[SOW] Speak error", e);
      setUI(false);
      alert(
        "I couldn’t start voice input on this device. Please type your message instead."
      );
    };

    recognizer.onend = () => {
      setUI(false);
    };

    recognizer.onresult = (event) => {
      const res = event.results?.[0]?.[0];
      const text = (res?.transcript || "").trim();
      if (!text) return;

      const existing = input.value.trim();
      input.value = existing
        ? `${existing} ${text}`.replace(/\s+/g, " ")
        : text;

      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };

    try {
      recognizer.start();
    } catch (err) {
      console.error("[SOW] Speak start failed", err);
      setUI(false);
      alert(
        "Voice input isn’t supported in this browser. Please type your message instead."
      );
    }
  });
})();
