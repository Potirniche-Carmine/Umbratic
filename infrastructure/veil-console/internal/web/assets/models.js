(() => {
  const cards = [...document.querySelectorAll("[data-model-id]")];
  if (!cards.length) return;
  let timer;
  let stopped = false;
  const refresh = async () => {
    try {
      if (document.visibilityState !== "visible") return;
      const response = await fetch("/models/status", {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5000),
      });
      if (response.redirected || response.status === 401) {
        stopped = true;
        window.location.assign("/login");
        return;
      }
      if (!response.ok) throw new Error("Status unavailable");
      const models = await response.json();
      for (const card of cards) {
        const model = models.find((entry) => entry.id === card.dataset.modelId);
        if (!model) continue;
        card.querySelector(".model-state-text").textContent = model.text;
        card.querySelector(".model-dot").className = `model-dot model-dot-${model.state}`;
        const notice = card.querySelector(".model-notice");
        notice.textContent = model.notice;
        notice.classList.toggle("is-empty", !model.notice);
        const log = card.querySelector("[data-model-log]");
        log.hidden = !model.logs;
        log.querySelector("pre").textContent = model.logs;
        for (const button of card.querySelectorAll("[data-when-running]")) button.hidden = !model.running;
        for (const button of card.querySelectorAll("[data-when-stopped]")) button.hidden = model.running;
      }
    } catch {
      for (const card of cards) card.querySelector(".model-state-text").textContent = "Status unavailable; reconnecting…";
    } finally {
      if (!stopped) timer = window.setTimeout(refresh, 2000);
    }
  };
  window.addEventListener("pagehide", () => { stopped = true; window.clearTimeout(timer); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) { stopped = false; void refresh(); } });
  void refresh();
})();
