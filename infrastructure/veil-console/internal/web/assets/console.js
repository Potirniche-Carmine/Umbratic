(() => {
  const copyButton = document.querySelector("[data-copy-token]");
  const token = document.querySelector("[data-token]");
  copyButton?.addEventListener("click", async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token.textContent.trim());
    copyButton.textContent = "Copied";
  });

  for (const opener of document.querySelectorAll("[data-dialog-open]")) {
    opener.addEventListener("click", () => {
      const dialog = document.getElementById(opener.dataset.dialogOpen);
      if (dialog instanceof HTMLDialogElement) dialog.showModal();
    });
  }
  for (const closer of document.querySelectorAll("[data-dialog-close]")) {
    closer.addEventListener("click", () => closer.closest("dialog")?.close());
  }
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => {
      const box = dialog.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right
        || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) dialog.close();
    });
  }

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
        if (response.redirected || response.status === 401) window.location.assign("/login");
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

  const loginForm = document.querySelector("[data-login-form]");
  const loginButton = loginForm?.querySelector("[data-login-submit]");
  const loginError = document.querySelector(".auth-error");
  const retryAfter = Number(loginForm?.dataset.retryAfter || 0);
  if (loginButton instanceof HTMLButtonElement && Number.isFinite(retryAfter) && retryAfter > 0) {
    loginButton.disabled = true;
    window.setTimeout(() => {
      loginButton.disabled = false;
      if (loginError instanceof HTMLElement) {
        loginError.textContent = "";
        loginError.classList.add("is-empty");
      }
    }, Math.ceil(retryAfter * 1000));
  }

  for (const choice of document.querySelectorAll("[data-choice]")) {
    const trigger = choice.querySelector("[data-choice-trigger]");
    const menu = choice.querySelector("[data-choice-menu]");
    const input = choice.querySelector("[data-choice-input]");
    const label = choice.querySelector("[data-choice-label]");
    const options = [...choice.querySelectorAll("[data-choice-value]")];
    if (!trigger || !menu || !input || !label || options.length === 0) continue;
    const close = () => {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    };
    const open = () => {
      document.querySelectorAll("[data-choice-menu]").forEach((item) => {
        if (item !== menu) item.hidden = true;
      });
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    };
    const select = (option) => {
      input.value = option.dataset.choiceValue;
      label.textContent = option.textContent.trim();
      options.forEach((item) => item.setAttribute("aria-selected", String(item === option)));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      close();
      trigger.focus();
    };
    trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      open();
      (options.find((item) => item.getAttribute("aria-selected") === "true") || options[0]).focus();
    });
    menu.addEventListener("keydown", (event) => {
      const current = options.indexOf(document.activeElement);
      if (event.key === "Escape") {
        close();
        trigger.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        options[(current + step + options.length) % options.length].focus();
      }
    });
    options.forEach((option) => option.addEventListener("click", () => select(option)));
    document.addEventListener("pointerdown", (event) => {
      if (!choice.contains(event.target)) close();
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
  const contextOptions = [...form.querySelectorAll("[data-context-option]")];
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
    contextValue.value = String(contexts[index].value);
    contextLabel.textContent = contexts[index].label;
    contextSlider.closest(".range-control")?.style.setProperty("--range-progress", `${(index / (contexts.length - 1)) * 100}%`);
    contextOptions.forEach((item) => item.toggleAttribute("aria-current", Number(item.dataset.index) === index));
  };
  contextSlider?.addEventListener("input", updateContext);
  contextOptions.forEach((item) => item.addEventListener("click", () => {
    contextSlider.value = item.dataset.index;
    updateContext();
  }));
  updateContext();

  const bodySlider = form.querySelector("[data-body-slider]");
  const bodyBytes = form.querySelector("[data-body-bytes]");
  const bodyLabel = form.querySelector("[data-body-label]");
  const bodyOptions = [...form.querySelectorAll("[data-body-option]")];
  const sizes = [
    { bytes: 16 * 1024 * 1024, label: "16 MiB" },
    { bytes: 32 * 1024 * 1024, label: "32 MiB" },
    { bytes: 64 * 1024 * 1024, label: "64 MiB" },
    { bytes: 128 * 1024 * 1024, label: "128 MiB" },
    { bytes: 256 * 1024 * 1024, label: "256 MiB" },
  ];
  const updateBodySize = () => {
    if (!bodySlider || !bodyBytes || !bodyLabel) return;
    const index = Math.max(0, Math.min(sizes.length - 1, Number(bodySlider.value)));
    bodyBytes.value = String(sizes[index].bytes);
    bodyLabel.textContent = sizes[index].label;
    bodySlider.closest(".range-control")?.style.setProperty("--range-progress", `${(index / (sizes.length - 1)) * 100}%`);
    bodyOptions.forEach((item) => item.toggleAttribute("aria-current", Number(item.dataset.index) === index));
  };
  bodySlider?.addEventListener("input", updateBodySize);
  bodyOptions.forEach((item) => item.addEventListener("click", () => {
    bodySlider.value = item.dataset.index;
    updateBodySize();
  }));
  updateBodySize();
})();
