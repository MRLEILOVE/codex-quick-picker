(() => {
  // 预加载时先于宿主监听。普通渲染入口也会加载，热重载时避免重复注册。
  const installed = Symbol.for("mcp-picker.escape-guard");
  if (window[installed]) {
    return;
  }
  window[installed] = true;

  let heldByPicker = false;
  const isEscape = (event) => event.key === "Escape" || event.key === "Esc" || event.code === "Escape";
  const capture = { capture: true, passive: false };

  window.addEventListener("keydown", (event) => {
    if (!isEscape(event)) {
      return;
    }
    const picker = document.querySelector("dialog[data-mcp-picker-dialog][open]");
    if (!picker && !heldByPicker) {
      return;
    }
    heldByPicker = true;
    event.stopImmediatePropagation();
    // 中文输入法可先退出候选状态，按键仍由弹窗隔离。
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    picker?.dispatchEvent(new Event("cancel", { cancelable: true }));
  }, capture);

  // 用户松开按键前，重复的 Esc 仍属于同一次关闭操作。
  window.addEventListener("keyup", (event) => {
    if (isEscape(event) && heldByPicker) {
      heldByPicker = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, capture);

  window.addEventListener("blur", () => {
    heldByPicker = false;
  });
})();
