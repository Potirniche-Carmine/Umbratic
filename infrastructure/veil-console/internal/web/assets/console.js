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

  // Ticking a team applies it, rather than arming a Move button that sat
  // beside every row doing nothing until it was noticed.
  for (const control of document.querySelectorAll("[data-autosubmit]")) {
    control.addEventListener("change", () => control.form?.requestSubmit());
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
    const servedField = addModel.querySelector("[data-served-field]");
    const servedReadout = addModel.querySelector("[data-served-readout]");
    const customFields = addModel.querySelector("[data-custom-fields]");
    const commandBox = addModel.querySelector("[data-command-box]");
    const commandDisclosure = addModel.querySelector("[data-command-disclosure]");

    // The precision and context menus are built from the chosen model, so they
    // are empty in the markup and the generic [data-choice] wiring skips them.
    // Each one owns its trigger, its rows and its outside-click here.
    const menu = (selector, render) => {
      const root = addModel.querySelector(selector);
      if (!root) return null;
      const input = root.querySelector("[data-choice-input]");
      const label = root.querySelector("[data-choice-label]");
      const list = root.querySelector("[data-choice-menu]");
      const trigger = root.querySelector("[data-choice-trigger]");
      const close = () => {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      };
      trigger.addEventListener("click", () => {
        const opening = list.hidden;
        list.hidden = !opening;
        trigger.setAttribute("aria-expanded", String(opening));
      });
      document.addEventListener("pointerdown", (event) => {
        if (!root.contains(event.target)) close();
      });
      return { root, input, label, list, trigger, close, render };
    };

    const variant = menu("[data-variant-choice]");
    const context = menu("[data-context-choice]");
    const variantField = addModel.querySelector("[data-variant-field]");
    const contextField = addModel.querySelector("[data-context-field]");

    // A menu with one option is not a choice. It is hidden rather than
    // rendered as a control that cannot change anything.
    const fill = (control, options, selected, onPick, field) => {
      if (!control) return null;
      if (field) field.hidden = options.length < 2;
      const chosen = options.find((item) => String(item.value) === String(selected)) || options[0];
      control.list.replaceChildren();
      for (const option of options) {
        const row = document.createElement("button");
        row.type = "button";
        row.setAttribute("role", "option");
        row.dataset.choiceValue = String(option.value);
        row.setAttribute("aria-selected", String(option.value === chosen.value));
        const head = document.createElement("span");
        head.className = "option-row";
        const title = document.createElement("span");
        title.className = "option-title";
        title.textContent = option.label;
        head.append(title);
        if (option.aside) {
          const aside = document.createElement("span");
          aside.className = "option-size";
          aside.textContent = option.aside;
          head.append(aside);
        }
        row.append(head);
        if (option.detail) {
          const detail = document.createElement("span");
          detail.className = "option-detail";
          detail.textContent = option.detail;
          row.append(detail);
        }
        row.addEventListener("click", () => {
          control.input.value = String(option.value);
          control.close();
          onPick();
        });
        control.list.append(row);
      }
      control.input.value = String(chosen.value);
      control.label.textContent = chosen.label;
      return chosen;
    };

    const entryFor = (key) => catalog.find((model) => model.Key === key) || null;

    const buildCommand = (entry, repo, tokens) => [
      `serve ${repo}`,
      "--host 127.0.0.1",
      `--port ${port}`,
      `--served-model-name ${entry.ServedID}`,
      `--max-model-len ${tokens}`,
      `--gpu-memory-utilization ${entry.GPUMemoryUtilization}`,
      "--kv-cache-dtype fp8",
    ].join("\n");

    const apply = () => {
      const entry = entryFor(keyInput?.value);
      const custom = !entry;
      if (customFields) customFields.hidden = !custom;
      if (custom) {
        if (variantField) variantField.hidden = true;
        if (contextField) contextField.hidden = true;
      }
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

      const chosenVariant = fill(
        variant,
        entry.Variants.map((item) => ({
          value: item.Key,
          label: item.Label,
          aside: `${item.VRAMGiB} GB`,
          detail: item.Repo,
        })),
        variant?.input.value,
        apply,
        variantField,
      );
      const chosenContext = fill(
        context,
        entry.Contexts.map((item) => ({ value: item.Tokens, label: `${item.Label} tokens` })),
        context?.input.value,
        apply,
        contextField,
      );
      if (servedReadout) servedReadout.textContent = entry.ServedID;
      if (commandBox && chosenVariant && chosenContext) {
        const repo = entry.Variants.find((item) => item.Key === chosenVariant.value).Repo;
        commandBox.value = buildCommand(entry, repo, chosenContext.value);
      }
    };

    keyInput?.addEventListener("change", apply);
    apply();
  }

})();
