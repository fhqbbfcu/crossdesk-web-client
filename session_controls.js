// Floating controls follow the shared Android/iOS session interaction.
(function () {
  const control = window.CrossDeskControl;
  const session = window.CrossDeskSession;
  const byId = (id) => document.getElementById(id);
  const orb = byId("panel-collapsed-bar");
  const panel = byId("connected-panel");
  const shield = byId("session-menu-shield");
  if (!orb || !panel || !shield || !control || !session) return;
  const clamp = (n, min, max) => Math.max(min, Math.min(n, Math.max(min, max)));
  const pageTitles = { main: "远程控制", video: "画面设置", network: "网络状态",
    display: "显示器", disconnect: "断开连接" };
  const preferenceDetails = [
    "优先保持画面流畅，带宽或编码压力较大时会更积极地降低分辨率。",
    "优先保持较高分辨率，带宽不足时先降低帧率，保持画面清晰。",
    "兼顾清晰度和流畅度，在持续压力下逐步降低分辨率。",
  ];

  class SessionControls {
    constructor() {
      this.active = false;
      this.connected = false;
      this.videoReady = false;
      this.page = "main";
      this.orbPosition = null;
      this.keyboardPosition = null;
      this.mouseVisible = false;
      this.drag = null;
      this.suppressClick = false;
      this.bindEvents();
      this.renderSettings(null);
      this.setConnected(false);
    }

    // Fixed overlays use the visual viewport so browser chrome, zoom and safe
    // areas cannot leave their close buttons outside the usable screen.
    bounds() {
      const viewport = window.visualViewport;
      const style = getComputedStyle(byId("connected-overlay"));
      const inset = (side) => parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0;
      const left = (viewport?.offsetLeft || 0) + inset("left") + 8;
      const top = (viewport?.offsetTop || 0) + inset("top") + 8;
      return { left, top,
        right: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - inset("right") - 8,
        bottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - inset("bottom") - 8 };
    }

    place(element, x, y, bounds = this.bounds()) {
      const position = { x: clamp(x, bounds.left, bounds.right - element.offsetWidth),
        y: clamp(y, bounds.top, bounds.bottom - element.offsetHeight) };
      Object.assign(element.style, { left: `${position.x}px`, top: `${position.y}px`,
        right: "auto", bottom: "auto", transform: "none" });
      return position;
    }

    layout() {
      if (!this.active) return;
      const b = this.bounds(), width = b.right - b.left, height = b.bottom - b.top;
      const pos = this.orbPosition || { x: b.right - 58, y: b.top + 9 };
      this.orbPosition = this.place(orb, pos.x, pos.y, b);
      const rect = orb.getBoundingClientRect();
      const landscape = height < 400 && width >= 400;
      panel.classList.toggle("session-landscape", landscape);
      panel.style.width = `${Math.min(width, landscape ? 380 : Math.max(280, Math.min(340, width - 144)))}px`;
      panel.style.maxHeight = `${height}px`;
      if (!panel.hidden) {
        const leftSide = rect.left + rect.width / 2 > (b.left + b.right) / 2;
        this.place(panel, leftSide ? rect.left - panel.offsetWidth - 12 : rect.right + 12,
          rect.top + rect.height / 2 - panel.offsetHeight / 2, b);
      }
      const mouse = byId("virtual-mouse");
      if (mouse.style.display !== "none") {
        let x = rect.left - mouse.offsetWidth - 6, y = rect.top + 3;
        if (x < b.left) x = rect.right + 6;
        if (x + mouse.offsetWidth > b.right) {
          x = rect.left;
          y = rect.bottom + 6 + mouse.offsetHeight <= b.bottom
            ? rect.bottom + 6 : rect.top - mouse.offsetHeight - 6;
        }
        this.place(mouse, x, y, b);
      }
      const keyboard = byId("virtual-keyboard");
      keyboard.style.width = `${Math.min(800, width)}px`;
      keyboard.style.maxHeight = `${height}px`;
      keyboard.style.setProperty("--keyboard-height", `${height}px`);
      if (keyboard.style.display !== "none") {
        const kp = this.keyboardPosition || { x: b.left + (width - keyboard.offsetWidth) / 2,
          y: b.bottom - keyboard.offsetHeight };
        this.keyboardPosition = this.place(keyboard, kp.x, kp.y, b);
      }
    }

    start() {
      this.active = true;
      this.videoReady = false;
      this.mouseVisible = false;
      this.orbPosition = null;
      this.keyboardPosition = null;
      control.setMouseMode("relative");
      control.hideVirtualKeyboard();
      this.close();
    }

    stop() {
      this.endDrag(null, true);
      this.close();
      this.active = false;
      this.videoReady = false;
      this.mouseVisible = false;
      this.setConnected(false);
      control.hideVirtualKeyboard();
      control.cancelLocalInput();
      this.updateMouse();
    }

    setConnected(connected) {
      this.connected = connected;
      panel.querySelectorAll("[data-needs-connection]").forEach(button => button.disabled = !connected);
      if (!connected) {
        control.cancelLocalInput();
        control.hideVirtualKeyboard();
      }
      this.updateMouse();
    }

    setVideoReady() {
      if (!this.active) return;
      this.videoReady = true;
      this.updateMouse();
    }

    showPage(page) {
      if (!pageTitles[page]) return;
      control.cancelLocalInput();
      control.lockedPanel.closeMenu();
      this.page = page;
      panel.hidden = false;
      shield.hidden = false;
      orb.setAttribute("aria-expanded", "true");
      byId("session-menu-title").textContent = pageTitles[page];
      byId("session-menu-back").hidden = page === "main";
      byId("disconnect-connected").hidden = page === "disconnect";
      panel.querySelectorAll("[data-session-page]").forEach(el => el.hidden = el.dataset.sessionPage !== page);
      if (page === "disconnect") control.hideVirtualKeyboard();
      this.updateMouse();
      this.renderSettings(window.CrossDeskVideoSettings);
      this.renderNetwork(window.CrossDeskStats);
      (page === "disconnect" ? byId("session-disconnect-cancel") : byId("session-menu-close")).focus({ preventScroll: true });
    }

    close() {
      control.lockedPanel.closeMenu();
      panel.hidden = true;
      shield.hidden = true;
      orb.setAttribute("aria-expanded", "false");
      this.page = "main";
      this.updateMouse();
      if (panel.contains(document.activeElement)) orb.focus({ preventScroll: true });
    }

    updateMouse() {
      const visible = this.active && this.connected && this.videoReady && this.mouseVisible && panel.hidden;
      byId("virtual-mouse").style.display = visible ? "flex" : "none";
      byId("session-mouse-label").textContent = this.mouseVisible ? "收起鼠标" : "虚拟鼠标";
      byId("session-mouse").setAttribute("aria-pressed", String(this.mouseVisible));
      byId("session-mouse-mode-label").textContent = control.state.mobileControlMode === "relative" ? "相对鼠标" : "绝对鼠标";
      this.layout();
    }

    renderSettings(state) {
      const selection = state?.selection || session.defaultVideoSettings;
      panel.querySelectorAll("[data-setting]").forEach(button => {
        button.disabled = !state?.supported;
        button.setAttribute("aria-pressed", String(selection[button.dataset.setting] === Number(button.dataset.value)));
      });
      byId("video-preference-detail").textContent = preferenceDetails[selection.preference];
      const failed = ["failed", "rejected", "timeout"].includes(state?.status);
      byId("video-settings-feedback").textContent = !state?.supported
        ? "连接建立后可调整，需被控端支持。"
        : failed ? "调整失败，请重试。" : state.status === "pending" ? "正在应用…" : "";
      byId("video-settings-retry").hidden = !failed || !state?.supported;
      this.layout();
    }

    renderNetwork(stats) {
      if (panel.hidden || this.page !== "network") return;
      const finite = (value, suffix) => Number.isFinite(value) ? `${Math.round(value)}${suffix}` : "—";
      const values = {
        resolution: stats?.width && stats.height ? `${stats.width} × ${stats.height}` : "—",
        fps: finite(stats?.fps, " fps"),
        bitrate: Number.isFinite(stats?.received_bps) ? `${(stats.received_bps / 1000000).toFixed(2)} Mbps` : "—",
        loss: stats?.packets > 0 ? `${(stats.lost / stats.packets * 100).toFixed(1)}%` : "—",
        rtt: finite(stats?.rtt_ms, " ms"), buffer: finite(stats?.jitter_ms, " ms"),
        decode: finite(stats?.decode_ms, " ms"),
        route: stats?.route === "relay" ? `中继${stats.protocol ? " / " + stats.protocol.toUpperCase() : ""}`
          : stats?.route === "direct" ? "直连" : "—",
      };
      for (const [key, value] of Object.entries(values)) byId(`network-${key}`).textContent = value;
      this.layout();
    }

    beginDrag(event, target) {
      if (event.target.closest("#keyboard-close") || (event.button !== undefined && event.button !== 0) || this.drag) return;
      const touch = event.touches?.[0];
      if (event.touches && event.touches.length !== 1) return;
      const point = touch || event, rect = target.getBoundingClientRect();
      if (touch) event.preventDefault();
      control.cancelLocalInput();
      this.drag = { target, touchId: touch?.identifier, x: point.clientX, y: point.clientY,
        left: rect.left, top: rect.top, moved: false };
      this.suppressClick = false;
    }

    moveDrag(event) {
      const drag = this.drag;
      if (!drag) return;
      const point = drag.touchId === undefined ? event : Array.from(event.touches || []).find(t => t.identifier === drag.touchId);
      if (!point || !Number.isFinite(point.clientX)) return;
      const dx = point.clientX - drag.x, dy = point.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      event.preventDefault();
      drag.moved = true;
      control.setDraggingPanel(true);
      if (drag.target === orb) this.close();
      const position = this.place(drag.target, drag.left + dx, drag.top + dy);
      if (drag.target === orb) this.orbPosition = position;
      else this.keyboardPosition = position;
      this.layout();
    }

    endDrag(event, cancelled = false) {
      const drag = this.drag;
      if (!drag) return;
      if (event?.changedTouches && !Array.from(event.changedTouches).some(t => t.identifier === drag.touchId)) return;
      this.drag = null;
      control.setDraggingPanel(false);
      this.suppressClick = drag.moved || cancelled;
      if (drag.touchId !== undefined && !drag.moved && !cancelled && drag.target === orb) {
        this.toggle();
        this.suppressClick = true;
      }
    }

    toggle() {
      if (panel.hidden) this.showPage("main");
      else this.close();
    }

    bindEvents() {
      orb.addEventListener("click", () => {
        if (this.suppressClick) { this.suppressClick = false; return; }
        this.toggle();
      });
      for (const target of [orb, byId("keyboard-header")]) {
        const draggable = target === orb ? orb : byId("virtual-keyboard");
        target.addEventListener("mousedown", event => this.beginDrag(event, draggable));
        target.addEventListener("touchstart", event => this.beginDrag(event, draggable), { passive: false });
      }
      document.addEventListener("mousemove", event => this.moveDrag(event));
      document.addEventListener("touchmove", event => this.moveDrag(event), { passive: false });
      document.addEventListener("mouseup", event => this.endDrag(event, event.crossdeskPointerCancelled));
      document.addEventListener("touchend", event => this.endDrag(event));
      document.addEventListener("touchcancel", event => this.endDrag(event, true));
      window.addEventListener("blur", () => { this.endDrag(null, true); control.cancelLocalInput(); });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) { this.endDrag(null, true); control.cancelLocalInput(); }
      });
      window.addEventListener("resize", () => this.layout());
      window.visualViewport?.addEventListener("resize", () => this.layout());
      window.visualViewport?.addEventListener("scroll", () => this.layout());
      shield.addEventListener("click", () => this.close());
      byId("session-menu-close").addEventListener("click", () => this.close());
      byId("session-menu-back").addEventListener("click", () => this.showPage("main"));
      panel.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => this.showPage(button.dataset.page)));
      panel.querySelectorAll("[data-setting]").forEach(button => button.addEventListener("click", () => {
        const settings = window.CrossDeskVideoSettings;
        if (!settings?.supported) return;
        session.requestVideoSettings({ ...settings.selection, [button.dataset.setting]: Number(button.dataset.value) });
      }));
      byId("video-settings-retry").addEventListener("click", () => {
        const values = window.CrossDeskVideoSettings?.requested;
        if (values) session.requestVideoSettings(values);
      });
      byId("session-keyboard").addEventListener("click", () => {
        this.close(); control.toggleVirtualKeyboard(); this.layout();
      });
      byId("session-mouse").addEventListener("click", () => {
        control.cancelLocalInput(); this.mouseVisible = !this.mouseVisible; this.close();
      });
      byId("session-mouse-mode").addEventListener("click", () => {
        const mode = control.state.mobileControlMode === "relative" ? "absolute" : "relative";
        control.setMouseMode(mode);
        this.updateMouse();
      });
      byId("session-disconnect-cancel").addEventListener("click", () => this.showPage("main"));
      byId("session-disconnect-confirm").addEventListener("click", () => session.disconnect());
      document.addEventListener("keydown", event => {
        if (panel.hidden || !this.active) return;
        if (event.key === "Escape") {
          event.preventDefault();
          this.page === "main" ? this.close() : this.showPage("main");
        } else if (event.key === "Tab") {
          const buttons = [...panel.querySelectorAll("button:not(:disabled), select:not(:disabled)")].filter(el => el.getClientRects().length);
          const i = buttons.indexOf(document.activeElement), next = (i + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
          event.preventDefault(); buttons[next]?.focus();
        }
      });
    }
  }
  window.CrossDeskSessionControls = new SessionControls();
})();
