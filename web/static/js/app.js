(() => {
  const toast = document.querySelector("#toast");
  const selectedTasks = new Map();
  let courseCatalog = [];
  let courseQuery = "";
  let courseFilter = "all";
  let queuedCourseIds = new Set();
  let executionStatus = "idle";
  let executionPoller = null;
  let timer;
  const show = (message) => {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove("show"), 2200);
  };

  let authenticatedState = false;

  const setConnection = (authenticated, session = {}) => {
    authenticatedState = authenticated;
    const connection = document.querySelector(".connection");
    connection.innerHTML = `<i></i>${authenticated ? "超星已连接" : "未登录"}`;
    connection.classList.toggle("offline", !authenticated);
    document.querySelector("#open-login").hidden = authenticated;
    document.querySelector("#user-info").hidden = !authenticated;
    if (!authenticated) {
      document.querySelector("#user-menu").hidden = true;
      document.querySelector("#user-info-toggle").setAttribute("aria-expanded", "false");
    }
    if (authenticated) {
      document.querySelector("#user-display").textContent = session.displayName || "超星用户";
      document.querySelector("#user-account").textContent = session.username || "已登录";
    }
  };

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  const formatSeconds = (value) => {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };

  const renderActivities = (activities) => {
    const list = document.querySelector("#activity-list");
    if (!activities.length) {
      list.innerHTML = '<div class="empty-state">暂无活动记录</div>';
      return;
    }
    list.innerHTML = activities.map((item) => `<div class="activity"><b class="activity-icon ${escapeHtml(item.level)}">${item.level === "error" ? "!" : (item.level === "warning" ? "!" : "✓")}</b><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div><time>${escapeHtml(item.time)}</time></div>`).join("");
  };

  const loadActivities = async () => {
    try {
      const response = await fetch("/api/activities");
      const result = await response.json();
      if (response.ok) renderActivities(result.activities);
    } catch {
      // 首页保留静态占位，不阻断其他模块。
    }
  };

  const renderCourseCards = (courses) => {
    const list = document.querySelector("#course-list");
    if (!courses.length) {
      list.innerHTML = '<div class="empty-state">暂未获取到匹配课程</div>';
      return;
    }
    list.innerHTML = courses.map((course) => `
      <article class="course live-course ${queuedCourseIds.has(String(course.courseId)) ? "course-queued" : ""}" data-course-id="${escapeHtml(course.courseId)}">
        <div class="course-head"><div><h3>${escapeHtml(course.name)}</h3><p>${escapeHtml(course.teacher || "本地 API 返回的课程")} · 课程 ID ${escapeHtml(course.courseId)}</p></div><div class="course-actions"><span class="badge ${queuedCourseIds.has(String(course.courseId)) ? "" : "success"}">${queuedCourseIds.has(String(course.courseId)) ? "已在队列" : "已同步"}</span><button class="course-queue-button" type="button" data-course-id="${escapeHtml(course.courseId)}" data-course-name="${escapeHtml(course.name)}" ${queuedCourseIds.has(String(course.courseId)) ? "disabled" : ""}>${queuedCourseIds.has(String(course.courseId)) ? "已加入队列" : "加入执行队列"}</button></div></div>
        <div class="progress-label"><span>课程状态</span><strong>已同步</strong></div>
        <div class="progress"><i style="width:100%"></i></div>
      </article>`).join("");
    list.querySelectorAll(".live-course").forEach((course) => course.addEventListener("click", () => {
      window.location.href = `/courses?course_id=${encodeURIComponent(course.dataset.courseId)}`;
    }));
    list.querySelectorAll(".course-queue-button").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      queueCourse(button);
    }));
  };

  const applyCourseFilters = () => {
    const query = courseQuery.trim().toLocaleLowerCase();
    const visible = courseCatalog.filter((course) => {
      const text = `${course.name || ""} ${course.teacher || ""} ${course.courseId || ""}`.toLocaleLowerCase();
      const matchesQuery = !query || text.includes(query);
      const queued = queuedCourseIds.has(String(course.courseId));
      const matchesFilter = courseFilter === "all" || (courseFilter === "queued" ? queued : !queued);
      return matchesQuery && matchesFilter;
    });
    document.querySelector("#course-count").textContent = `${visible.length} / ${courseCatalog.length} 门`;
    renderCourseCards(visible);
  };

  const renderCourses = (courses) => {
    courseCatalog = courses;
    document.querySelector("#metric-course-count").textContent = courses.length;
    document.querySelector("#metric-course-hint").textContent = `最近同步 ${new Date().toLocaleTimeString("zh-CN", {hour: "2-digit", minute: "2-digit"})}`;
    applyCourseFilters();
  };

  const queueCourse = async (button) => {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "加入中…";
    try {
      const response = await fetch("/api/tasks/queue", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({courses: [{courseId: button.dataset.courseId, name: button.dataset.courseName, mode: "course"}]})});
      const result = await response.json();
      show(response.ok ? `已将「${button.dataset.courseName}」加入执行队列` : (result.message || "加入队列失败"));
      if (response.ok) {
        queuedCourseIds.add(String(button.dataset.courseId));
        applyCourseFilters();
      }
    } catch {
      show("执行队列接口暂时不可用");
    } finally {
      button.disabled = false;
      if (button.textContent === "加入中…") button.textContent = originalText;
    }
  };

  const loadChapters = async (courseId) => {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/chapters`);
    const result = await response.json();
    if (!response.ok) {
      show(result.message || "章节读取失败");
      return;
    }
    document.querySelector("#chapter-panel").hidden = false;
    document.querySelector("#chapter-title").textContent = `${result.course.name} · 章节列表`;
    const list = document.querySelector("#chapter-list");
    list.innerHTML = result.chapters.length
      ? result.chapters.map((chapter, index) => {
        const status = chapter.needUnlock ? "未开放" : (chapter.hasFinished ? "已完成" : "未完成");
        const statusClass = chapter.needUnlock ? "locked" : (chapter.hasFinished ? "finished" : "pending");
        return `<button class="chapter-item" type="button" data-point-id="${escapeHtml(chapter.id)}" data-point-name="${escapeHtml(chapter.name)}"><span>${index + 1}</span><div class="chapter-copy"><strong>${escapeHtml(chapter.name)}</strong><small>${escapeHtml(chapter.jobCount)} 个任务点</small></div><em class="chapter-status ${statusClass}">${status}</em><b>查看任务 ›</b></button>`;
      }).join("")
      : '<div class="empty-state">暂未读取到章节</div>';
    list.querySelectorAll(".chapter-item").forEach((item) => item.addEventListener("click", () => loadTasks(courseId, item.dataset.pointId, item.dataset.pointName)));
    document.querySelector("#chapter-panel").scrollIntoView({behavior: "smooth", block: "nearest"});
  };

  const loadTasks = async (courseId, pointId, pointName) => {
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(pointId)}/tasks`);
    const result = await response.json();
    if (!response.ok) {
      show(result.message || "任务点读取失败");
      return;
    }
    document.querySelector("#chapter-title").textContent = `${pointName || "章节"} · 任务点`;
    const list = document.querySelector("#chapter-list");
    list.innerHTML = result.tasks.length
      ? result.tasks.map((task, index) => {
        const taskId = String(task.jobid || task.jobId || task.id || `${pointId}-${index}`);
        const label = task.name || task.title || "未命名任务";
        return `<label class="chapter-item task-item"><input class="task-check" type="checkbox" data-task-id="${escapeHtml(taskId)}" data-course-id="${escapeHtml(courseId)}" data-point-id="${escapeHtml(pointId)}" data-task-name="${escapeHtml(label)}" ${selectedTasks.has(taskId) ? "checked" : ""}><span>•</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(task.type || "任务点")}</small></div><b>待处理</b></label>`;
      }).join("")
      : '<div class="empty-state">该章节暂未读取到任务点</div>';
    list.querySelectorAll(".task-check").forEach((checkbox) => checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedTasks.set(checkbox.dataset.taskId, {id: checkbox.dataset.taskId, name: checkbox.dataset.taskName, courseId: checkbox.dataset.courseId, pointId: checkbox.dataset.pointId});
      else selectedTasks.delete(checkbox.dataset.taskId);
      updateSelectedCount();
    }));
    updateSelectedCount();
  };

  const updateSelectedCount = () => {
    document.querySelector("#selected-count").textContent = `已选 ${selectedTasks.size} 个`;
  };

  const loadSession = async () => {
    try {
      const response = await fetch("/api/session");
      const session = await response.json();
      setConnection(session.authenticated, session);
      if (!session.authenticated) {
        setTimeout(() => dialog.showModal(), 180);
      }
      if (session.authenticated) await loadCourses();
      await loadActivities();
    } catch {
      setConnection(false);
    }
  };

  const loadCourses = async () => {
    const refresh = document.querySelector("#refresh-courses");
    refresh.disabled = true;
    refresh.textContent = "同步中…";
    try {
      const response = await fetch("/api/courses");
      const result = await response.json();
      if (!response.ok) {
        show(result.message || "请先登录超星");
        return;
      }
      renderCourses(result.courses);
      await loadOverview();
      show(`已同步 ${result.courses.length} 门课程`);
      await loadActivities();
    } catch {
      show("课程接口暂时不可用");
    } finally {
      refresh.disabled = false;
      refresh.textContent = "刷新课程 ↻";
    }
  };

  const loadOverview = async () => {
    try {
      const response = await fetch("/api/overview");
      const result = await response.json();
      if (!response.ok) return;
      document.querySelector("#metric-course-count").textContent = result.courseCount;
      document.querySelector("#metric-task-count").textContent = result.pendingTasks;
      document.querySelector("#metric-task-count").nextElementSibling.textContent = `${result.chapterCount} 个章节已统计`;
    } catch {
      document.querySelector("#metric-task-count").textContent = "—";
    }
  };

  const dialog = document.querySelector("#login-dialog");
  document.querySelector("#open-login").addEventListener("click", () => dialog.showModal());
  document.querySelector("#user-info-toggle").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = document.querySelector("#user-menu");
    const expanded = menu.hidden;
    menu.hidden = !expanded;
    event.currentTarget.setAttribute("aria-expanded", String(expanded));
  });
  document.addEventListener("click", (event) => {
    const userInfo = document.querySelector("#user-info");
    if (!userInfo.contains(event.target)) {
      document.querySelector("#user-menu").hidden = true;
      document.querySelector("#user-info-toggle").setAttribute("aria-expanded", "false");
    }
  });
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({username: form.get("username"), password: form.get("password"), use_cookies: form.get("use_cookies") === "on"}),
    });
    const result = await response.json();
    if (!response.ok) {
      show(result.message || "登录失败");
      return;
    }
    dialog.close();
    setConnection(true, {displayName: result.displayName, username: result.username});
    show("登录成功，正在同步课程");
    await loadCourses();
    await loadActivities();
  });

  dialog.addEventListener("cancel", (event) => {
    if (!authenticatedState) event.preventDefault();
  });

  document.querySelector("#logout").addEventListener("click", async () => {
    await fetch("/api/auth/logout", {method: "POST"});
    document.querySelector("#user-menu").hidden = true;
    setConnection(false);
    show("已退出登录");
    setTimeout(() => dialog.showModal(), 180);
  });

  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((button) => button.classList.remove("active"));
      item.classList.add("active");
      document.querySelector("#current-section").textContent = item.dataset.section;
      if (item.dataset.section === "课程管理") {
        window.location.href = "/courses";
        return;
      } else if (item.dataset.section === "首页") {
        window.scrollTo({top: 0, behavior: "smooth"});
      }
      show(`已切换到「${item.dataset.section}」`);
    });
  });

  document.querySelector("#course-search").addEventListener("input", (event) => {
    courseQuery = event.target.value;
    applyCourseFilters();
  });
  document.querySelector("#course-filter").addEventListener("change", (event) => {
    courseFilter = event.target.value;
    applyCourseFilters();
  });

  const refreshExecutionStatus = async () => {
    try {
      const response = await fetch("/api/tasks/status");
      const result = await response.json();
      if (!response.ok) return;
      const progress = result.progress || {};
      executionStatus = result.status;
      queuedCourseIds = new Set((result.queue || []).map((item) => String(item.courseId)));
      if (courseCatalog.length) applyCourseFilters();
      const queueList = document.querySelector("#queue-list");
      const queue = result.queue || [];
      queueList.innerHTML = queue.length
        ? queue.map((item) => `<span class="queue-chip"><b>${escapeHtml(item.name)}</b><button type="button" data-course-id="${escapeHtml(item.courseId)}" aria-label="移除 ${escapeHtml(item.name)}">×</button></span>`).join("")
        : "<span>执行队列为空</span>";
      queueList.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => {
        const response = await fetch(`/api/tasks/queue/${encodeURIComponent(button.dataset.courseId)}`, {method: "DELETE"});
        const removed = await response.json();
        show(response.ok ? "已移出执行队列" : (removed.message || "无法移出队列"));
        refreshExecutionStatus();
      }));
      const labels = {idle: "队列空闲", queued: "等待启动", running: "执行中", paused: "已暂停", stopping: "停止中", stopped: "已停止", completed: "已完成", error: "执行异常"};
      document.querySelector("#execution-status").textContent = `${labels[result.status] || result.status} · ${progress.completed || 0}/${progress.total || 0}`;
      const total = Number(progress.total || 0);
      const completed = Number(progress.completed || 0);
      const failed = Number(progress.failed || 0);
      const percent = total ? Math.min(100, Math.round(((completed + failed) / total) * 100)) : 0;
      document.querySelector("#execution-progress-text").textContent = `${completed} / ${total} 个任务${failed ? `，失败 ${failed}` : ""}`;
      document.querySelector("#execution-percent").textContent = `${percent}%`;
      document.querySelector("#execution-progress-bar").style.width = `${percent}%`;
      const videoProgress = progress.duration ? ` · 播放 ${progress.playedText || formatSeconds(progress.played)} / ${progress.durationText || formatSeconds(progress.duration)}` : "";
      document.querySelector("#execution-current").textContent = `${progress.current || "等待开始"}${videoProgress}`;
      document.querySelector("#pause-tasks").disabled = !["running", "paused"].includes(result.status);
      document.querySelector("#pause-tasks").textContent = result.status === "paused" ? "恢复" : "暂停";
      document.querySelector("#stop-tasks").disabled = !["running", "paused"].includes(result.status);
      if (["idle", "stopped", "completed", "error"].includes(result.status)) {
        if (executionPoller) {
          clearInterval(executionPoller);
          executionPoller = null;
        }
      } else if (!executionPoller) {
        executionPoller = setInterval(refreshExecutionStatus, 2000);
      }
    } catch {
      document.querySelector("#execution-status").textContent = "状态不可用";
    }
  };

  document.querySelector("#start-tasks").addEventListener("click", async () => {
    const response = await fetch("/api/tasks/start", {method: "POST"});
    const result = await response.json();
    show(response.ok ? "执行队列已启动" : (result.message || "无法启动执行队列"));
    refreshExecutionStatus();
  });
  document.querySelector("#pause-tasks").addEventListener("click", async () => {
    const endpoint = executionStatus === "paused" ? "/api/tasks/start" : "/api/tasks/pause";
    const response = await fetch(endpoint, {method: "POST"});
    const result = await response.json();
    show(response.ok ? "执行队列已暂停" : (result.message || "无法暂停队列"));
    refreshExecutionStatus();
  });
  document.querySelector("#stop-tasks").addEventListener("click", async () => {
    const response = await fetch("/api/tasks/stop", {method: "POST"});
    const result = await response.json();
    show(response.ok ? "已请求停止执行队列" : (result.message || "无法停止队列"));
    refreshExecutionStatus();
  });
  document.querySelector("#refresh-courses").addEventListener("click", loadCourses);
  const logDialog = document.querySelector("#log-dialog");
  document.querySelector("#view-log").addEventListener("click", async () => {
    const response = await fetch("/api/logs");
    const result = await response.json();
    const list = document.querySelector("#log-list");
    list.textContent = result.lines && result.lines.length ? result.lines.join("\n") : "暂无后端日志";
    logDialog.showModal();
  });
  document.querySelector("#close-log").addEventListener("click", () => logDialog.close());
  document.querySelector("#close-chapters").addEventListener("click", () => { document.querySelector("#chapter-panel").hidden = true; });
  document.querySelector("#queue-selected").addEventListener("click", () => {
    if (!selectedTasks.size) {
      show("请先选择任务点");
      return;
    }
    fetch("/api/tasks/queue", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({tasks: Array.from(selectedTasks.values())})})
      .then((response) => response.json().then((result) => ({response, result})))
      .then(({response, result}) => show(response.ok ? `已将 ${result.count} 个任务加入执行队列` : (result.message || "加入队列失败")))
      .catch(() => show("执行队列接口暂时不可用"));
  });
  updateSelectedCount();
  refreshExecutionStatus();
  loadSession();
})();
