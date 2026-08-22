(() => {
  const copyButton = document.querySelector("[data-copy-token]");
  const token = document.querySelector("[data-token]");
  copyButton?.addEventListener("click", async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token.textContent.trim());
    if (copyButton.dataset.copyExit) {
      window.location.assign(copyButton.dataset.copyExit);
      return;
    }
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
      label.textContent = (option.querySelector(".option-title") || option).textContent.trim();
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

  /*
    Errors clear themselves after five seconds. Nothing else reaches the banner
    stack any more, so this is only ever an error being retired — a click
    retires it sooner.
  */
  for (const banner of document.querySelectorAll("[data-dismiss-after]")) {
    const dismiss = () => {
      banner.classList.add("is-dismissed");
      banner.addEventListener("transitionend", () => banner.remove(), { once: true });
    };
    const timer = window.setTimeout(dismiss, Number(banner.dataset.dismissAfter) || 5000);
    banner.addEventListener("click", () => {
      window.clearTimeout(timer);
      dismiss();
    });
  }

  /*
    The segmented control. It writes into a hidden input rather than being one,
    because "on" and "off" as two buttons is the readable version of a checkbox
    and a form still needs a value to post.
  */
  for (const group of document.querySelectorAll("[data-segmented]")) {
    const input = group.querySelector("[data-segmented-input]");
    const options = [...group.querySelectorAll("[data-segmented-value]")];
    if (!input || options.length === 0) continue;
    for (const option of options) {
      option.addEventListener("click", () => {
        input.value = option.dataset.segmentedValue;
        for (const item of options) {
          item.setAttribute("aria-pressed", String(item === option));
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }

  // Changing a document's route applies it, rather than arming a Move button
  // that sat beside every row doing nothing until it was noticed.
  for (const select of document.querySelectorAll("[data-autosubmit]")) {
    select.addEventListener("change", () => select.form?.requestSubmit());
  }

  /*
    What a chosen file looks like before it is uploaded. The native control
    reported "no file selected" and then a bare name; this reports the name, the
    size and the type, and only then enables Upload — so the button is never
    live with nothing behind it.
  */
  const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  };

  for (const zone of document.querySelectorAll("[data-dropzone]")) {
    const input = zone.querySelector("[data-dropzone-input]");
    const empty = zone.querySelector("[data-dropzone-empty]");
    const chosen = zone.querySelector("[data-dropzone-file]");
    const name = zone.querySelector("[data-dropzone-name]");
    const size = zone.querySelector("[data-dropzone-size]");
    const kind = zone.querySelector("[data-dropzone-kind]");
    const clear = zone.querySelector("[data-dropzone-clear]");
    const submit = zone.closest("form")?.querySelector("[data-dropzone-submit]");
    if (!input || !empty || !chosen) continue;

    const render = () => {
      const file = input.files?.[0];
      empty.hidden = Boolean(file);
      chosen.hidden = !file;
      if (submit) submit.disabled = !file;
      if (!file) return;
      if (name) name.textContent = file.name;
      if (size) size.textContent = formatBytes(file.size);
      if (kind) kind.textContent = file.name.split(".").pop()?.slice(0, 4) || "file";
    };

    input.addEventListener("change", render);
    clear?.addEventListener("click", (event) => {
      // The button is inside the label, so a click would otherwise reopen the
      // file picker it just cleared.
      event.preventDefault();
      event.stopPropagation();
      input.value = "";
      render();
    });
    for (const eventName of ["dragenter", "dragover"]) {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        zone.classList.add("is-dragging");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      zone.addEventListener(eventName, () => zone.classList.remove("is-dragging"));
    }
    zone.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      render();
    });
    render();
  }

  /*
    The add-model form, driven by the catalog rendered into the page.

    Choosing a model fills the precision menu, the served id and the command.
    None of it is trusted: the server rebuilds the command from the same
    reviewed row before anything is executed. This is here so the box shows what
    is about to be registered rather than making someone imagine it.
  */
  const addModel = document.querySelector("[data-add-model]");
  const catalogSource = document.querySelector("[data-model-catalog]");
  if (addModel && catalogSource) {
    const catalog = JSON.parse(catalogSource.textContent);
    const port = Number(addModel.querySelector('[name="port"]')?.value) || 8001;
    const keyInput = addModel.querySelector("[data-catalog-choice] [data-choice-input]");
    const keyLabel = addModel.querySelector("[data-catalog-choice] [data-choice-label]");
    const variantField = addModel.querySelector("[data-variant-field]");
    const variantChoice = addModel.querySelector("[data-variant-choice]");
    const variantInput = variantChoice?.querySelector("[data-choice-input]");
    const variantLabel = variantChoice?.querySelector("[data-choice-label]");
    const variantMenu = variantChoice?.querySelector("[data-choice-menu]");
    const variantTrigger = variantChoice?.querySelector("[data-choice-trigger]");
    const servedField = addModel.querySelector("[data-served-field]");
    const servedReadout = addModel.querySelector("[data-served-readout]");
    const customFields = addModel.querySelector("[data-custom-fields]");
    const commandBox = addModel.querySelector("[data-command-box]");
    const commandDisclosure = addModel.querySelector("[data-command-disclosure]");

    const entryFor = (key) => catalog.find((model) => model.Key === key) || null;

    const buildCommand = (entry, variant) => [
      `serve ${variant.Repo}`,
      "--host 127.0.0.1",
      `--port ${port}`,
      `--served-model-name ${entry.ServedID}`,
      `--max-model-len ${entry.MaxModelLen}`,
      `--gpu-memory-utilization ${entry.GPUMemoryUtilization}`,
      "--kv-cache-dtype fp8",
    ].join("\n");

    const renderVariants = (entry, selected) => {
      if (!variantMenu || !variantInput || !variantLabel) return entry.Variants[0];
      const chosen = entry.Variants.find((item) => item.Key === selected) || entry.Variants[0];
      variantMenu.replaceChildren();
      for (const variant of entry.Variants) {
        const option = document.createElement("button");
        option.type = "button";
        option.setAttribute("role", "option");
        option.dataset.choiceValue = variant.Key;
        option.setAttribute("aria-selected", String(variant.Key === chosen.Key));
        const title = document.createElement("span");
        title.className = "option-title";
        title.textContent = variant.Label;
        const detail = document.createElement("span");
        detail.className = "option-detail";
        detail.textContent = `About ${variant.VRAMGiB} GB of VRAM · ${variant.Repo}`;
        option.append(title, detail);
        option.addEventListener("click", () => {
          variantInput.value = variant.Key;
          variantMenu.hidden = true;
          variantTrigger?.setAttribute("aria-expanded", "false");
          apply();
        });
        variantMenu.append(option);
      }
      variantInput.value = chosen.Key;
      variantLabel.textContent = chosen.Label;
      return chosen;
    };

    const apply = () => {
      const entry = entryFor(keyInput?.value);
      const custom = !entry;
      if (customFields) customFields.hidden = !custom;
      if (variantField) variantField.hidden = custom;
      if (servedField) servedField.hidden = custom;
      // A hidden required field blocks submission with a validation message
      // nobody can see, so Custom's fields are only required while shown.
      for (const field of addModel.querySelectorAll("[data-custom-required]")) {
        field.toggleAttribute("required", custom);
      }
      if (commandDisclosure) commandDisclosure.open = custom;
      if (custom) {
        if (keyLabel) keyLabel.textContent = "Custom";
        return;
      }
      if (keyLabel) keyLabel.textContent = entry.DisplayName;
      const variant = renderVariants(entry, variantInput?.value);
      if (servedReadout) servedReadout.textContent = entry.ServedID;
      if (commandBox) commandBox.value = buildCommand(entry, variant);
    };

    // The generic [data-choice] wiring skips this menu: it is empty when the
    // page loads, because which precisions exist depends on which model is
    // chosen. Without this the trigger would be a button that does nothing.
    if (variantTrigger && variantMenu) {
      variantTrigger.addEventListener("click", () => {
        const opening = variantMenu.hidden;
        variantMenu.hidden = !opening;
        variantTrigger.setAttribute("aria-expanded", String(opening));
      });
      document.addEventListener("pointerdown", (event) => {
        if (variantChoice.contains(event.target)) return;
        variantMenu.hidden = true;
        variantTrigger.setAttribute("aria-expanded", "false");
      });
    }

    keyInput?.addEventListener("change", apply);
    apply();
  }

  const form = document.querySelector("[data-settings-form]");
  if (!form) return;

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
