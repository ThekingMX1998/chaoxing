(() => {
  const $ = (selector) => document.querySelector(selector);
  const stateLabels = {idle: "队列空闲", queued: "等待启动", running: "执行中", paused: "已暂停", stopping: "停止中", stopped: "已停止", completed: "已完成", error: "执行异常"};
  const activeStates = new Set(["running", "paused", "stopping"]);
  let status = "idle";
  let statusBusy = false;
  let logBusy = false;
  let toastTimer;

  const show = (message) => {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2400);
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;"}[char]));
  const formatSeconds = (value) => {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const setText = (selector, value) => { $(selector).textContent = value; };

  const renderQueue = (queue) => {
    setText("#metric-queue", queue.length);
    setText("#metric-queue-hint", queue.length ? "按顺序等待执行" : "等待加入课程");
    setText("#queue-hint", `${queue.length} 门课程`);
    const list = $("#queue-list");
    if (!queue.length) {
      list.innerHTML = '<div class="empty-state">执行队列为空，请先在课程管理中加入课程。</div>';
      return;
    }
    list.innerHTML = queue.map((item, index) => `<div class="queue-row"><span class="queue-index">${index + 1}</span><div class="queue-row-copy"><strong>${escapeHtml(item.name || "未命名课程")}</strong><small>课程 ID：${escapeHtml(item.courseId || "-")}</small></div><button class="queue-remove" type="button" data-course-id="${escapeHtml(item.courseId)}" ${activeStates.has(status) ? "disabled" : ""}>移除</button></div>`).join("");
    list.querySelectorAll(".queue-remove").forEach((button) => button.addEventListener("click", () => removeCourse(button)));
  };

  const renderStatus = (result) => {
    status = result.status || "idle";
    const progress = result.progress || {};
    const total = Number(progress.total || 0);
    const completed = Number(progress.completed || 0);
    const failed = Number(progress.failed || 0);
    const percent = total ? Math.min(100, Math.round(((completed + failed) / total) * 100)) : 0;
    const label = stateLabels[status] || status;
    const pill = $("#execution-state");
    pill.textContent = label;
    pill.className = `state-pill ${status}`;
    setText("#current-status", label);
    setText("#task-progress", `${completed} / ${total} 个任务`);
    setText("#current-task", progress.current || "等待开始");
    $("#main-progress-bar").style.width = `${percent}%`;
    setText("#metric-progress", `${percent}%`);
    setText("#metric-progress-hint", `${completed} / ${total} 个任务`);
    setText("#metric-completed", completed);
    setText("#metric-failed", failed);
    setText("#metric-failed-hint", failed ? `有 ${failed} 个任务失败` : "当前没有失败任务");
    const played = progress.duration ? (progress.playedText || formatSeconds(progress.played)) : "--:--";
    const duration = progress.duration ? (progress.durationText || formatSeconds(progress.duration)) : "--:--";
    setText("#video-progress", `${played} / ${duration}`);
    $("#start-tasks").disabled = status === "running" || status === "stopping" || !result.queue?.length;
    $("#pause-tasks").disabled = !["running", "paused"].includes(status);
    $("#pause-tasks").textContent = status === "paused" ? "恢复执行" : "暂停";
    $("#stop-tasks").disabled = !["running", "paused"].includes(status);
    renderQueue(result.queue || []);
  };

  const loadStatus = async () => {
    if (statusBusy) return;
    statusBusy = true;
    try {
      const response = await fetch("/api/tasks/status", {cache: "no-store"});
      const result = await response.json();
      if (response.ok) renderStatus(result);
    } catch {
      setText("#current-status", "状态暂时不可用");
    } finally {
      statusBusy = false;
    }
  };

  const renderLogs = (lines) => {
    const consoleNode = $("#console");
    if (!lines.length) {
      consoleNode.innerHTML = '<div class="console-empty">暂无终端日志</div>';
      setText("#log-hint", "INFO · 0 条");
      return;
    }
    const shouldStick = consoleNode.scrollTop + consoleNode.clientHeight >= consoleNode.scrollHeight - 30;
    consoleNode.innerHTML = lines.map((line) => `<div class="console-line">${escapeHtml(line)}</div>`).join("");
    if (shouldStick) consoleNode.scrollTop = consoleNode.scrollHeight;
    setText("#log-hint", `INFO · ${lines.length} 条`);
  };

  const loadLogs = async () => {
    if (logBusy) return;
    logBusy = true;
    try {
      const response = await fetch("/api/logs", {cache: "no-store"});
      const result = await response.json();
      if (response.ok) renderLogs(result.lines || []);
    } catch {
      setText("#log-hint", "日志暂时不可用");
    } finally {
      logBusy = false;
    }
  };

  const action = async (endpoint, successMessage) => {
    try {
      const response = await fetch(endpoint, {method: "POST"});
      const result = await response.json();
      show(response.ok ? successMessage : (result.message || "操作失败"));
      await loadStatus();
      await loadLogs();
    } catch {
      show("执行中心接口暂时不可用");
    }
  };

  const removeCourse = async (button) => {
    button.disabled = true;
    try {
      const response = await fetch(`/api/tasks/queue/${encodeURIComponent(button.dataset.courseId)}`, {method: "DELETE"});
      const result = await response.json();
      show(response.ok ? "已移出执行队列" : (result.message || "无法移出队列"));
      await loadStatus();
    } catch {
      show("执行队列接口暂时不可用");
      button.disabled = false;
    }
  };

  $("#start-tasks").addEventListener("click", () => action("/api/tasks/start", "执行队列已启动"));
  $("#pause-tasks").addEventListener("click", () => action(status === "paused" ? "/api/tasks/start" : "/api/tasks/pause", status === "paused" ? "已恢复执行队列" : "执行队列已暂停"));
  $("#stop-tasks").addEventListener("click", () => {
    if (window.confirm("确定停止当前执行队列吗？当前任务会被终止。")) action("/api/tasks/stop", "已请求停止执行队列");
  });
  $("#refresh-execution").addEventListener("click", async () => { await loadStatus(); await loadLogs(); show("执行中心已刷新"); });
  $("#refresh-logs").addEventListener("click", loadLogs);

  loadStatus();
  loadLogs();
  setInterval(loadStatus, 1500);
  setInterval(loadLogs, 2500);
})();
