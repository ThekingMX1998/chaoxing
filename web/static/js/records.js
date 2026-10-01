(() => {
  let records = [];
  let filter = "all";
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));

  const render = () => {
    const visible = filter === "all" ? records : records.filter((record) => record.level === filter);
    $("#record-total").textContent = records.length;
    $("#record-latest").textContent = records[0]?.time || "暂无";
    $("#record-errors").textContent = records.filter((record) => record.level === "error").length;
    $("#record-list").innerHTML = visible.length ? visible.map((record) => `<article class="record-item"><time class="record-time">${escapeHtml(record.time)}<br>${escapeHtml(record.timestamp || "")}</time><i class="record-dot ${escapeHtml(record.level || "info")}"></i><div class="record-copy"><strong>${escapeHtml(record.title)}</strong><span>${escapeHtml(record.detail)}</span></div><small class="record-level">${escapeHtml(record.level || "info").toUpperCase()}</small><button class="record-delete" type="button" data-record-id="${escapeHtml(record.id)}">删除</button></article>`).join("") : '<div class="empty-state">暂无运行记录</div>';
    $("#record-list").querySelectorAll(".record-delete").forEach((button) => button.addEventListener("click", async () => {
      if (!window.confirm("确定删除这条运行记录吗？")) return;
      const response = await fetch(`/api/records/${encodeURIComponent(button.dataset.recordId)}`, {method: "DELETE"});
      const result = await response.json();
      if (!response.ok) { window.alert(result.message || "删除失败"); return; }
      records = records.filter((record) => String(record.id) !== String(button.dataset.recordId));
      render();
    }));
  };

  const loadRecords = async () => {
    const button = $("#refresh-records");
    button.disabled = true;
    try {
      const response = await fetch("/api/records");
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "读取失败");
      records = result.records || [];
      render();
    } catch {
      $("#record-list").innerHTML = '<div class="empty-state">运行记录暂时无法读取</div>';
    } finally { button.disabled = false; }
  };

  $("#record-filter").addEventListener("change", (event) => { filter = event.target.value; render(); });
  $("#refresh-records").addEventListener("click", loadRecords);
  $("#clear-records").addEventListener("click", async () => {
    if (!records.length) return;
    if (!window.confirm("确定删除全部运行记录吗？此操作不可恢复。")) return;
    const button = $("#clear-records");
    button.disabled = true;
    try {
      const response = await fetch("/api/records", {method: "DELETE"});
      const result = await response.json();
      if (!response.ok) { window.alert(result.message || "删除失败"); return; }
      records = [];
      render();
    } finally { button.disabled = false; }
  });
  loadRecords();
})();
