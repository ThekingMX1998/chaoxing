(() => {
  const state = {courses: [], query: "", filter: "all", queued: new Set()};
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  const toast = (message) => {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), 2200);
  };

  const renderQueue = (queue, status) => {
    $("#queue-status").textContent = `${status || "idle"} · ${queue.length} 门课程`;
    const list = $("#queue-list");
    list.innerHTML = queue.length ? queue.map((item) => `<div class="queue-item"><span>${escapeHtml(item.name || item.title || "未命名课程")}</span><button class="remove-queue" type="button" data-course-id="${escapeHtml(item.courseId)}">移除</button></div>`).join("") : '<div class="empty-state">执行队列为空</div>';
    list.querySelectorAll(".remove-queue").forEach((button) => button.addEventListener("click", async () => {
      const response = await fetch(`/api/tasks/queue/${encodeURIComponent(button.dataset.courseId)}`, {method: "DELETE"});
      const result = await response.json();
      toast(response.ok ? "已移出执行队列" : (result.message || "移除失败"));
      if (response.ok) await loadQueue();
    }));
  };

  const renderTaskList = (tasks, courseId, pointId, pointName) => {
    $("#chapter-title").textContent = `${pointName || "章节"} · 任务点`;
    $("#chapter-hint").textContent = `${tasks.length} 个任务点`;
    const list = $("#chapter-list");
    list.innerHTML = tasks.length ? tasks.map((task, index) => {
      const name = task.name || task.title || "未命名任务";
      const type = task.type || "任务点";
      const taskId = task.jobid || task.jobId || task.id || `${pointId}-${index}`;
      return `<div class="chapter-item" role="listitem"><span>${index + 1}</span><div class="chapter-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(type)} · 任务 ID ${escapeHtml(taskId)}</small></div><em class="chapter-status pending">待处理</em></div>`;
    }).join("") : '<div class="empty-state">该章节没有可读取的任务点</div>';
  };

  const loadTasks = async (courseId, pointId, pointName) => {
    $("#chapter-title").textContent = `${pointName || "章节"} · 正在读取任务`;
    $("#chapter-hint").textContent = "加载中";
    $("#chapter-list").innerHTML = '<div class="empty-state">正在读取任务点…</div>';
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(pointId)}/tasks`);
    const result = await response.json();
    if (!response.ok) { $("#chapter-list").innerHTML = `<div class="empty-state">${escapeHtml(result.message || "任务点读取失败")}</div>`; return; }
    renderTaskList(result.tasks || [], courseId, pointId, pointName);
  };

  const renderChapters = (chapters, courseName, courseId) => {
    $("#chapter-title").textContent = courseName || "章节详情";
    $("#chapter-hint").textContent = `${chapters.length} 个章节`;
    const list = $("#chapter-list");
    list.innerHTML = chapters.length ? chapters.map((chapter, index) => {
      const status = chapter.needUnlock ? "未开放" : (chapter.hasFinished ? "已完成" : "未完成");
      const statusClass = chapter.needUnlock ? "locked" : (chapter.hasFinished ? "finished" : "pending");
      return `<button class="chapter-item" type="button" data-point-id="${escapeHtml(chapter.id)}" data-point-name="${escapeHtml(chapter.name)}"><span>${index + 1}</span><div class="chapter-copy"><strong>${escapeHtml(chapter.name)}</strong><small>${escapeHtml(chapter.jobCount)} 个任务点</small></div><em class="chapter-status ${statusClass}">${status}</em></button>`;
    }).join("") : '<div class="empty-state">未读取到章节</div>';
    list.querySelectorAll(".chapter-item").forEach((item) => item.addEventListener("click", () => loadTasks(courseId, item.dataset.pointId, item.dataset.pointName)));
  };

  const loadChapters = async (course) => {
    const response = await fetch(`/api/courses/${encodeURIComponent(course.courseId)}/chapters`);
    const result = await response.json();
    if (!response.ok) { toast(result.message || "章节读取失败"); return; }
    document.querySelectorAll(".course-row").forEach((row) => row.classList.toggle("selected", row.dataset.courseId === String(course.courseId)));
    renderChapters(result.chapters || [], result.course?.name || course.name, course.courseId);
  };

  const renderCourses = () => {
    const query = state.query.trim().toLocaleLowerCase();
    const visible = state.courses.filter((course) => {
      const text = `${course.name || ""} ${course.teacher || ""} ${course.courseId || ""}`.toLocaleLowerCase();
      const queued = state.queued.has(String(course.courseId));
      return (!query || text.includes(query)) && (state.filter === "all" || (state.filter === "queued" ? queued : !queued));
    });
    $("#course-count").textContent = `${visible.length} / ${state.courses.length} 门课程`;
    $("#course-list").innerHTML = visible.length ? visible.map((course) => {
      const queued = state.queued.has(String(course.courseId));
      return `<article class="course live-course course-row ${queued ? "course-queued" : ""}" data-course-id="${escapeHtml(course.courseId)}"><div class="course-head"><div><h3>${escapeHtml(course.name)}</h3><p>${escapeHtml(course.teacher || "未返回教师信息")} · 课程 ID ${escapeHtml(course.courseId)}</p></div><div class="course-actions"><span class="badge ${queued ? "" : "success"}">${queued ? "已在队列" : "已同步"}</span><button class="course-queue-button queue-button" type="button" data-course-id="${escapeHtml(course.courseId)}" data-course-name="${escapeHtml(course.name)}" ${queued ? "disabled" : ""}>${queued ? "已加入队列" : "加入执行队列"}</button></div></div><div class="progress-label"><span>课程信息</span><strong>已同步</strong></div><div class="progress"><i style="width:100%"></i></div></article>`;
    }).join("") : '<div class="empty-state">没有匹配的课程</div>';
    $("#course-list").querySelectorAll(".course-row").forEach((row) => row.addEventListener("click", () => {
      const course = state.courses.find((item) => String(item.courseId) === row.dataset.courseId);
      if (course) loadChapters(course);
    }));
    $("#course-list").querySelectorAll(".queue-button").forEach((button) => button.addEventListener("click", async (event) => {
      event.stopPropagation();
      button.disabled = true;
      const response = await fetch("/api/tasks/queue", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({courses: [{courseId: button.dataset.courseId, name: button.dataset.courseName, mode: "course"}]})});
      const result = await response.json();
      toast(response.ok ? `已将「${button.dataset.courseName}」加入执行队列` : (result.message || "加入队列失败"));
      if (response.ok) await loadQueue(); else button.disabled = false;
    }));
  };

  const loadCourses = async () => {
    const button = $("#refresh-courses");
    button.disabled = true;
    try {
      const response = await fetch("/api/courses");
      const result = await response.json();
      if (!response.ok) { $("#login-notice").hidden = false; toast(result.message || "请先登录"); return; }
      $("#login-notice").hidden = true;
      state.courses = result.courses || [];
      renderCourses();
      toast(`已同步 ${state.courses.length} 门课程`);
    } finally { button.disabled = false; }
  };

  const loadQueue = async () => {
    const response = await fetch("/api/tasks/status");
    const result = await response.json();
    const queue = result.queue || [];
    state.queued = new Set(queue.map((item) => String(item.courseId)));
    renderQueue(queue, result.status);
    if (state.courses.length) renderCourses();
  };

  $("#course-search").addEventListener("input", (event) => { state.query = event.target.value; renderCourses(); });
  $("#course-filter").addEventListener("change", (event) => { state.filter = event.target.value; renderCourses(); });
  $("#refresh-courses").addEventListener("click", loadCourses);
  const requestedCourseId = new URLSearchParams(window.location.search).get("course_id");
  fetch("/api/session").then((response) => response.json()).then(async (session) => {
    $("#connection").innerHTML = `<i></i>${session.authenticated ? "超星已连接" : "未登录"}`;
    if (!session.authenticated) $("#login-notice").hidden = false;
    await loadQueue();
    if (session.authenticated) {
      await loadCourses();
      const requestedCourse = state.courses.find((course) => String(course.courseId) === String(requestedCourseId));
      if (requestedCourse) await loadChapters(requestedCourse);
    }
  }).catch(() => { $("#login-notice").hidden = false; });
})();
