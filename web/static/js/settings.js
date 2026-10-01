(() => {
  const $ = (selector) => document.querySelector(selector);
  const fields = () => document.querySelectorAll("[data-section][data-key]");
  const hint = (message, error = false) => { const node = $("#save-hint"); node.textContent = message; node.style.color = error ? "var(--red)" : "var(--muted)"; };

  const fill = (settings) => fields().forEach((field) => {
    const value = settings?.[field.dataset.section]?.[field.dataset.key];
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value ?? "";
  });

  const collect = () => {
    const settings = {};
    fields().forEach((field) => {
      settings[field.dataset.section] ||= {};
      let value = field.type === "checkbox" ? field.checked : field.value;
      if (field.type === "number" && value !== "") value = Number(value);
      settings[field.dataset.section][field.dataset.key] = value;
    });
    return settings;
  };

  const loadSettings = async () => {
    try {
      const response = await fetch("/api/settings");
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "读取失败");
      fill(result.settings);
      hint("配置已加载");
    } catch { hint("配置读取失败", true); }
  };

  $("#save-settings").addEventListener("click", async () => {
    const button = $("#save-settings");
    button.disabled = true;
    try {
      const response = await fetch("/api/settings", {method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({settings: collect()})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "保存失败");
      fill(result.settings);
      hint(`已保存 · ${new Date().toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit", second: "2-digit"})}`);
    } catch (error) { hint(error.message || "保存失败", true); }
    finally { button.disabled = false; }
  });

  $("#reset-settings").addEventListener("click", async () => {
    if (!window.confirm("确定恢复默认配置吗？点击保存设置后才会写入文件。")) return;
    const response = await fetch("/api/settings/defaults");
    const result = await response.json();
    if (response.ok) hint("已恢复默认值，请点击保存设置");
    if (response.ok) fill(result.settings);
  });
  loadSettings();
})();
