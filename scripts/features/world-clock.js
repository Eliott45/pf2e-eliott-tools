(function () {
  const tools = globalThis.pf2eEliottTools;
  const { id: moduleId, logPrefix, settings } = tools.module;
  const runningSetting = "worldClockRunning";
  const controlsClass = "eliott-world-clock-controls";
  let timer = null;
  let lastTick = 0;
  let advancing = false;
  let toggling = false;
  let generation = 0;

  tools.features ??= {};
  tools.features.worldClock = { onInit, onReady };

  function onInit() {
    game.settings.register(moduleId, settings.worldClockEnabled, {
      name: "Включить автоматический ход времени",
      hint: "Добавляет кнопку запуска и паузы в окно «Время мира». При отключении скрывает кнопку и приостанавливает отсчёт; при включении восстанавливает прежнее состояние запуска.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: reconcile,
    });

    game.settings.register(moduleId, runningSetting, {
      scope: "world",
      config: false,
      type: Boolean,
      default: false,
      onChange: reconcile,
    });

    Hooks.on("renderWorldClock", onRenderWorldClock);
    for (const hook of ["pauseGame", "createCombat", "updateCombat", "deleteCombat", "userConnected", "updateUser"]) {
      Hooks.on(hook, reconcile);
    }
  }

  function onReady() {
    reconcile();
  }

  function isRunning() {
    return game.settings.get(moduleId, runningSetting) === true;
  }

  function isEnabled() {
    return game.settings.get(moduleId, settings.worldClockEnabled) !== false;
  }

  function suspensionReason() {
    if (game.paused) return "Пауза игры";
    if (game.combats.some((combat) => combat.started)) return "Приостановлено на время боя";
    return "";
  }

  function canAdvance() {
    // Only the elected GM advances shared time, regardless of who clicked Play.
    return game.ready && game.user.isGM && game.users.activeGM?.id === game.user.id
      && isEnabled() && isRunning() && !suspensionReason();
  }

  function reconcile() {
    if (!game.ready) return;

    if (canAdvance()) {
      if (timer === null) {
        lastTick = performance.now();
        generation += 1;
        timer = setInterval(() => void tick(), 1000);
      }
    } else {
      stopTimer();
    }

    // Update only our controls; PF2e already renders the date on time changes.
    onRenderWorldClock(game.pf2e.worldClock, game.pf2e.worldClock?.element);
  }

  function stopTimer() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    generation += 1;
  }

  async function tick() {
    if (!canAdvance()) {
      reconcile();
      return;
    }
    if (advancing) return;

    // Retain fractional seconds and account for delayed callbacks without
    // issuing overlapping writes or replaying time spent paused/offline.
    const seconds = Math.floor((performance.now() - lastTick) / 1000);
    if (seconds < 1) return;
    lastTick += seconds * 1000;
    const tickGeneration = generation;
    advancing = true;
    try {
      await game.time.advance(seconds);
    } catch (error) {
      console.error(`${logPrefix} | World clock advance failed`, error);
      if (generation === tickGeneration) {
        stopTimer();
        ui.notifications.error("Не удалось продвинуть время мира. Автоматический ход остановлен.");
        try {
          await game.settings.set(moduleId, runningSetting, false);
        } catch (settingError) {
          console.error(`${logPrefix} | Could not stop world clock setting`, settingError);
        }
      }
    } finally {
      advancing = false;
    }
  }

  function onRenderWorldClock(_app, html) {
    const root = getElement(html);
    if (!root) return;
    const existing = root.querySelector(`.${controlsClass}`);
    if (!game.user.isGM || !isEnabled()) {
      existing?.remove();
      return;
    }
    if (existing) {
      updateControls(existing);
      return;
    }

    // Match the date header, not ApplicationV2's window title bar.
    const header = root.querySelector("header:not(.window-header)");
    if (!header) return;
    const controls = document.createElement("div");
    controls.className = `${controlsClass} form-group flexrow`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "eliott-world-clock-toggle";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggle();
    });
    const status = document.createElement("span");
    status.className = "eliott-world-clock-status";
    controls.append(button, status);
    header.after(controls);
    updateControls(controls);
  }

  async function toggle() {
    if (!game.user.isGM || !isEnabled() || toggling) return;
    toggling = true;
    reconcile();
    try {
      await game.settings.set(moduleId, runningSetting, !isRunning());
    } catch (error) {
      console.error(`${logPrefix} | World clock toggle failed`, error);
      ui.notifications.error("Не удалось переключить автоматический ход времени.");
    } finally {
      toggling = false;
      reconcile();
    }
  }

  function updateControls(controls) {
    const running = isRunning();
    const status = running ? suspensionReason() || "Время идёт · ×1" : "Время остановлено";
    const state = `${running}:${toggling}:${status}`;
    if (controls.dataset.state === state) return;
    controls.dataset.state = state;
    const button = controls.querySelector("button");
    const icon = document.createElement("i");
    icon.className = running ? "fa-solid fa-pause" : "fa-solid fa-play";
    icon.setAttribute("aria-hidden", "true");
    button.replaceChildren(icon, document.createTextNode(running ? " Пауза" : " Запустить время"));
    button.disabled = toggling;
    button.setAttribute("aria-pressed", String(running));
    button.title = running ? "Остановить автоматический ход времени" : "1 игровая секунда за 1 реальную секунду";
    controls.querySelector(".eliott-world-clock-status").textContent = status;
  }

  function getElement(html) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    return null;
  }
})();
