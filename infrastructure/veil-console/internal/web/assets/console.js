(() => {
  const copyButton = document.querySelector("[data-copy-token]");
  const token = document.querySelector("[data-token]");
  copyButton?.addEventListener("click", async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token.textContent.trim());
    copyButton.textContent = "Copied";
  });

  const logoutForm = document.querySelector("[data-session-logout]");
  if (logoutForm) {
    const idleTimeout = 10 * 60 * 1000;
    const heartbeatInterval = 60 * 1000;
    let idleTimer;
    let lastHeartbeat = Date.now();
    const activityStorageKey = "veil-console-last-activity";
    const activityChannel = "BroadcastChannel" in window
      ? new BroadcastChannel("veil-console-session")
      : null;

    const signOut = () => logoutForm.requestSubmit();
    const resetIdleTimer = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(signOut, idleTimeout);
    };
    const touchSession = async () => {
      const now = Date.now();
      if (now - lastHeartbeat < heartbeatInterval) return;
      lastHeartbeat = now;
      try {
        const response = await fetch("/session/touch", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.redirected || response.status === 401) {
          window.location.assign("/login");
        }
      } catch {
        // The server-side timeout remains authoritative when a heartbeat fails.
      }
    };
    const registerActivity = () => {
      resetIdleTimer();
      if (activityChannel) {
        activityChannel.postMessage("active");
      } else {
        try {
          localStorage.setItem(activityStorageKey, String(Date.now()));
        } catch {
          // The server timeout remains authoritative when storage is unavailable.
        }
      }
      void touchSession();
    };

    activityChannel?.addEventListener("message", resetIdleTimer);
    window.addEventListener("storage", (event) => {
      if (event.key === activityStorageKey) resetIdleTimer();
    });
    for (const eventName of ["pointerdown", "keydown", "input"]) {
      document.addEventListener(eventName, registerActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") registerActivity();
    });
    registerActivity();
  }

  for (const actionForm of document.querySelectorAll("[data-service-action]")) {
    actionForm.addEventListener("submit", (event) => {
      const button = event.submitter;
      if (!(button instanceof HTMLButtonElement)) return;
      button.disabled = true;
      button.textContent = button.textContent === "Restart" ? "Restarting…" : "Starting…";
    });
  }

  const form = document.querySelector("[data-settings-form]");
  if (!form) return;

  const provider = form.querySelector("[data-provider]");
  const providerURL = form.querySelector("[data-provider-url]");
  const defaults = {
    ollama: "http://127.0.0.1:11434",
    vllm: "http://127.0.0.1:8000/v1",
  };
  let previousProvider = provider?.value || "ollama";

  const updateProvider = () => {
    if (!provider || !providerURL) return;
    const next = provider.value;
    if (!providerURL.value || providerURL.value === defaults[previousProvider]) {
      providerURL.value = defaults[next];
    }
    previousProvider = next;
  };

  provider?.addEventListener("change", updateProvider);
  updateProvider();

  const contextSlider = form.querySelector("[data-context-slider]");
  const contextValue = form.querySelector("[data-context-value]");
  const contextLabel = form.querySelector("[data-context-label]");
  const contexts = [
    { value: 8192, label: "8K tokens" },
    { value: 16384, label: "16K tokens" },
    { value: 32768, label: "32K tokens" },
    { value: 65536, label: "64K tokens" },
    { value: 131072, label: "128K tokens" },
    { value: 262144, label: "256K tokens" },
    { value: 524288, label: "512K tokens" },
    { value: 1048576, label: "1M tokens" },
  ];

  const updateContext = () => {
    if (!contextSlider || !contextValue || !contextLabel) return;
    const index = Math.max(0, Math.min(contexts.length - 1, Number(contextSlider.value)));
    const progress = (index / (contexts.length - 1)) * 100;
    contextValue.value = String(contexts[index].value);
    contextLabel.textContent = contexts[index].label;
    contextSlider.closest(".range-control")?.style.setProperty("--range-progress", `${progress}%`);
  };

  contextSlider?.addEventListener("input", updateContext);
  updateContext();

  const slider = form.querySelector("[data-body-slider]");
  const bodyBytes = form.querySelector("[data-body-bytes]");
  const bodyLabel = form.querySelector("[data-body-label]");
  const sizes = [
    { bytes: 16 * 1024 * 1024, label: "16 MiB" },
    { bytes: 32 * 1024 * 1024, label: "32 MiB" },
    { bytes: 64 * 1024 * 1024, label: "64 MiB" },
    { bytes: 128 * 1024 * 1024, label: "128 MiB" },
    { bytes: 256 * 1024 * 1024, label: "256 MiB" },
  ];

  const updateBodySize = () => {
    if (!slider || !bodyBytes || !bodyLabel) return;
    const index = Math.max(0, Math.min(sizes.length - 1, Number(slider.value)));
    const progress = (index / (sizes.length - 1)) * 100;
    bodyBytes.value = String(sizes[index].bytes);
    bodyLabel.textContent = sizes[index].label;
    slider.closest(".range-control")?.style.setProperty("--range-progress", `${progress}%`);
  };

  slider?.addEventListener("input", updateBodySize);
  updateBodySize();
})();
