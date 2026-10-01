(() => {
  const state = {courses: [], query: "", filter: "all", queuedCourses: new Set(), queuedTasks: new Set(), courseVisible: 3, chapters: [], chapterVisible: 10, tasks: [], taskVisible: 10};
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
    $("#queue-status").textContent = `${status || "idle"} · ${queue.length} 项`;
    const list = $("#queue-list");
    list.innerHTML = queue.length ? queue.map((item) => `<div class="queue-item"><span>${item.mode === "task" ? "任务 · " : "课程 · "}${escapeHtml(item.name || item.title || "未命名课程")}</span><button class="remove-queue" type="button" data-course-id="${escapeHtml(item.courseId)}" data-task-id="${escapeHtml(item.taskId || "")}" data-point-id="${escapeHtml(item.pointId || "")}">移除</button></div>`).join("") : '<div class="empty-state">执行队列为空</div>';
    list.querySelectorAll(".remove-queue").forEach((button) => button.addEventListener("click", async () => {
      const query = button.dataset.taskId ? `?task_id=${encodeURIComponent(button.dataset.taskId)}&point_id=${encodeURIComponent(button.dataset.pointId)}` : "";
      const response = await fetch(`/api/tasks/queue/${encodeURIComponent(button.dataset.courseId)}${query}`, {method: "DELETE"});
      const result = await response.json();
      toast(response.ok ? "已移出执行队列" : (result.message || "移除失败"));
      if (response.ok) await loadQueue();
    }));
  };

  const renderTaskList = (tasks, courseId, pointId, pointName, preserveScroll = false) => {
    $("#chapter-title").textContent = `${pointName || "章节"} · 任务点`;
    $("#chapter-hint").textContent = `${tasks.length} 个任务点`;
    const list = $("#chapter-list");
    const toggle = $("#toggle-task-list");
    const previousScroll = preserveScroll ? list.scrollTop : 0;
    list.classList.add("task-list-mode");
    list.classList.remove("collapsed");
    list.hidden = false;
    toggle.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = "收起任务⌃";
    const visibleTasks = tasks.slice(0, state.taskVisible);
    list.innerHTML = visibleTasks.length ? visibleTasks.map((task, index) => {
      const name = task.name || task.title || "未命名任务";
      const type = task.type || "任务点";
      const taskId = task.jobid || task.jobId || task.id || `${pointId}-${index}`;
      const taskKey = `${courseId}:${pointId}:${taskId}`;
      const queued = state.queuedTasks.has(taskKey);
      return `<button class="chapter-item task-queue-item ${queued ? "queued" : ""}" type="button" aria-pressed="${queued}" data-course-id="${escapeHtml(courseId)}" data-point-id="${escapeHtml(pointId)}" data-task-id="${escapeHtml(taskId)}" data-task-name="${escapeHtml(name)}" data-task-type="${escapeHtml(type)}"><span>${index + 1}</span><div class="chapter-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(type)} · 任务 ID ${escapeHtml(taskId)}</small></div><em class="chapter-status ${queued ? "finished" : "pending"}">${queued ? "已加入队列" : "点击加入队列"}</em></button>`;
    }).join("") : '<div class="empty-state">该章节没有可读取的任务点</div>';
    if (state.taskVisible < tasks.length) list.insertAdjacentHTML("beforeend", '<div class="list-more">继续下拉加载更多任务…</div>');
    list.querySelectorAll(".task-queue-item").forEach((item) => item.addEventListener("click", () => toggleTaskQueue(item)));
    list.scrollTop = previousScroll;
    list.onscroll = () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40 && state.taskVisible < state.tasks.length) {
        state.taskVisible += 10;
        renderTaskList(state.tasks, courseId, pointId, pointName, true);
      }
    };
  };

  const toggleTaskQueue = async (item) => {
    const courseId = item.dataset.courseId;
    const pointId = item.dataset.pointId;
    const taskId = item.dataset.taskId;
    const taskKey = `${courseId}:${pointId}:${taskId}`;
    const queued = state.queuedTasks.has(taskKey);
    item.disabled = true;
    try {
      const endpoint = `/api/tasks/queue/${encodeURIComponent(courseId)}`;
      const request = queued
        ? fetch(`${endpoint}?task_id=${encodeURIComponent(taskId)}&point_id=${encodeURIComponent(pointId)}`, {method: "DELETE"})
        : fetch("/api/tasks/queue", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({tasks: [{mode: "task", courseId, pointId, taskId, name: item.dataset.taskName, type: item.dataset.taskType}]})});
      const response = await request;
      const result = await response.json();
      if (!response.ok) {
        toast(result.message || (queued ? "移出队列失败" : "加入队列失败"));
        return;
      }
      if (queued) state.queuedTasks.delete(taskKey); else state.queuedTasks.add(taskKey);
      item.classList.toggle("queued", !queued);
      item.setAttribute("aria-pressed", String(!queued));
      const status = item.querySelector(".chapter-status");
      status.className = `chapter-status ${!queued ? "finished" : "pending"}`;
      status.textContent = !queued ? "已加入队列" : "点击加入队列";
      toast(!queued ? "任务已加入执行队列" : "任务已取消排队");
      await loadQueue();
    } catch {
      toast("执行队列接口暂时不可用");
    } finally {
      item.disabled = false;
    }
  };

  const loadTasks = async (courseId, pointId, pointName) => {
    $("#chapter-title").textContent = `${pointName || "章节"} · 正在读取任务`;
    $("#chapter-hint").textContent = "加载中";
    $("#toggle-task-list").hidden = true;
    $("#chapter-list").innerHTML = '<div class="empty-state">正在读取任务点…</div>';
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/chapters/${encodeURIComponent(pointId)}/tasks`);
    const result = await response.json();
    if (!response.ok) { $("#chapter-list").innerHTML = `<div class="empty-state">${escapeHtml(result.message || "任务点读取失败")}</div>`; return; }
    state.tasks = result.tasks || [];
    state.taskVisible = 10;
    renderTaskList(state.tasks, courseId, pointId, pointName);
  };

  const renderChapters = (chapters, courseName, courseId, preserveScroll = false) => {
    $("#chapter-title").textContent = courseName || "章节详情";
    $("#chapter-hint").textContent = `${chapters.length} 个章节`;
    const list = $("#chapter-list");
    const previousScroll = preserveScroll ? list.scrollTop : 0;
    list.classList.remove("task-list-mode", "collapsed");
    list.hidden = false;
    $("#toggle-task-list").hidden = true;
    const visibleChapters = chapters.slice(0, state.chapterVisible);
    list.innerHTML = visibleChapters.length ? visibleChapters.map((chapter, index) => {
      const status = chapter.needUnlock ? "未开放" : (chapter.hasFinished ? "已完成" : "未完成");
      const statusClass = chapter.needUnlock ? "locked" : (chapter.hasFinished ? "finished" : "pending");
      return `<button class="chapter-item" type="button" data-point-id="${escapeHtml(chapter.id)}" data-point-name="${escapeHtml(chapter.name)}"><span>${index + 1}</span><div class="chapter-copy"><strong>${escapeHtml(chapter.name)}</strong><small>${escapeHtml(chapter.jobCount)} 个任务点</small></div><em class="chapter-status ${statusClass}">${status}</em></button>`;
    }).join("") : '<div class="empty-state">未读取到章节</div>';
    if (state.chapterVisible < chapters.length) list.insertAdjacentHTML("beforeend", '<div class="list-more">继续下拉加载更多章节…</div>');
    list.querySelectorAll(".chapter-item").forEach((item) => item.addEventListener("click", () => loadTasks(courseId, item.dataset.pointId, item.dataset.pointName)));
    list.scrollTop = previousScroll;
    list.onscroll = () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40 && state.chapterVisible < state.chapters.length) {
        state.chapterVisible += 10;
        renderChapters(state.chapters, courseName, courseId, true);
      }
    };
  };

  const loadChapters = async (course) => {
    const response = await fetch(`/api/courses/${encodeURIComponent(course.courseId)}/chapters`);
    const result = await response.json();
    if (!response.ok) { toast(result.message || "章节读取失败"); return; }
    document.querySelectorAll(".course-row").forEach((row) => row.classList.toggle("selected", row.dataset.courseId === String(course.courseId)));
    state.chapters = result.chapters || [];
    state.chapterVisible = 10;
    state.tasks = [];
    renderChapters(state.chapters, result.course?.name || course.name, course.courseId);
  };

  const renderCourses = (preserveScroll = false) => {
    const query = state.query.trim().toLocaleLowerCase();
    const visible = state.courses.filter((course) => {
      const text = `${course.name || ""} ${course.teacher || ""} ${course.courseId || ""}`.toLocaleLowerCase();
      const queued = state.queuedCourses.has(String(course.courseId));
      return (!query || text.includes(query)) && (state.filter === "all" || (state.filter === "queued" ? queued : !queued));
    });
    const list = $("#course-list");
    const previousScroll = preserveScroll ? list.scrollTop : 0;
    $("#course-count").textContent = `${visible.length} / ${state.courses.length} 门课程`;
    const visibleCourses = visible.slice(0, state.courseVisible);
    list.innerHTML = visibleCourses.length ? visibleCourses.map((course) => {
      const queued = state.queuedCourses.has(String(course.courseId));
      return `<article class="course live-course course-row ${queued ? "course-queued" : ""}" data-course-id="${escapeHtml(course.courseId)}"><div class="course-head"><div><h3>${escapeHtml(course.name)}</h3><p>${escapeHtml(course.teacher || "未返回教师信息")} · 课程 ID ${escapeHtml(course.courseId)}</p></div><div class="course-actions"><span class="badge ${queued ? "" : "success"}">${queued ? "已在队列" : "已同步"}</span><button class="course-queue-button queue-button" type="button" data-course-id="${escapeHtml(course.courseId)}" data-course-name="${escapeHtml(course.name)}" ${queued ? "disabled" : ""}>${queued ? "已加入队列" : "加入执行队列"}</button></div></div><div class="progress-label"><span>课程信息</span><strong>已同步</strong></div><div class="progress"><i style="width:100%"></i></div></article>`;
    }).join("") : '<div class="empty-state">没有匹配的课程</div>';
    if (state.courseVisible < visible.length) list.insertAdjacentHTML("beforeend", '<div class="list-more">继续下拉加载更多课程…</div>');
    list.querySelectorAll(".course-row").forEach((row) => row.addEventListener("click", () => {
      const course = state.courses.find((item) => String(item.courseId) === row.dataset.courseId);
      if (course) loadChapters(course);
    }));
    list.querySelectorAll(".queue-button").forEach((button) => button.addEventListener("click", async (event) => {
      event.stopPropagation();
      button.disabled = true;
      const response = await fetch("/api/tasks/queue", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({courses: [{courseId: button.dataset.courseId, name: button.dataset.courseName, mode: "course"}]})});
      const result = await response.json();
      toast(response.ok ? `已将「${button.dataset.courseName}」加入执行队列` : (result.message || "加入队列失败"));
      if (response.ok) await loadQueue(); else button.disabled = false;
    }));
    list.scrollTop = previousScroll;
    list.onscroll = () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40 && state.courseVisible < visible.length) {
        state.courseVisible += 3;
        renderCourses(true);
      }
    };
    if (state.courseVisible < visible.length && list.scrollHeight <= list.clientHeight + 1) {
      state.courseVisible += 3;
      renderCourses(true);
    }
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
      state.courseVisible = 3;
      renderCourses();
      toast(`已同步 ${state.courses.length} 门课程`);
    } finally { button.disabled = false; }
  };

  const loadQueue = async () => {
    const response = await fetch("/api/tasks/status");
    const result = await response.json();
    const queue = result.queue || [];
    state.queuedCourses = new Set(queue.filter((item) => item.mode !== "task").map((item) => String(item.courseId)));
    state.queuedTasks = new Set(queue.filter((item) => item.mode === "task").map((item) => `${item.courseId}:${item.pointId}:${item.taskId}`));
    renderQueue(queue, result.status);
    if (state.courses.length) renderCourses();
  };

  $("#course-search").addEventListener("input", (event) => { state.query = event.target.value; state.courseVisible = 3; renderCourses(); });
  $("#course-filter").addEventListener("change", (event) => { state.filter = event.target.value; state.courseVisible = 3; renderCourses(); });
  $("#refresh-courses").addEventListener("click", loadCourses);
  $("#toggle-task-list").addEventListener("click", () => {
    const list = $("#chapter-list");
    const expanded = !list.classList.contains("collapsed");
    list.classList.toggle("collapsed", expanded);
    $("#toggle-task-list").setAttribute("aria-expanded", String(!expanded));
    $("#toggle-task-list").textContent = expanded ? "展开任务⌄" : "收起任务⌃";
  });
  const requestedCourseId = new URLSearchParams(window.location.search).get("course_id");
  fetch("/api/session").then((response) => response.json()).then(async (session) => {
    if (!session.authenticated) $("#login-notice").hidden = false;
    await loadQueue();
    if (session.authenticated) {
      await loadCourses();
      const requestedCourse = state.courses.find((course) => String(course.courseId) === String(requestedCourseId));
      if (requestedCourse) await loadChapters(requestedCourse);
    }
  }).catch(() => { $("#login-notice").hidden = false; });
})();
