from datetime import datetime, timedelta, timezone
import json
import multiprocessing as mp
import os
from pathlib import Path
from queue import Empty
import tempfile
from threading import Event, RLock, Thread
import time
from tqdm import tqdm as TqdmClass
from uuid import uuid4

from flask import Flask, jsonify, render_template, request

from api.base import Account, Chaoxing, StudyResult
from api.answer import DummyTiku
from api.logger import logger as api_logger, tqdm_sink
from executor import build_study_client, process_job


# Web 端只保留终端/内存日志，不再创建或追加 chaoxing.log 文件。
# api.logger 的默认文件 sink 来自旧 CLI，这里在生产入口侧替换掉它，避免修改 api/。
api_logger.remove()
api_logger.add(tqdm_sink, colorize=True, enqueue=True)


def format_duration(value) -> str:
    seconds = max(0, int(float(value or 0)))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def queue_item_key(item: dict) -> tuple:
    """返回队列项的稳定键，课程和任务使用不同的去重粒度。"""
    course_id = str(item.get("courseId") or item.get("id") or "")
    if item.get("mode") == "task" or item.get("taskId"):
        task_id = str(item.get("taskId") or item.get("jobid") or item.get("jobId") or item.get("id") or "")
        point_id = str(item.get("pointId") or item.get("knowledgeId") or "")
        return "task", course_id, point_id, task_id
    return "course", course_id


RECORDS_FILE = Path(__file__).resolve().parent / "data" / "records.json"
SETTINGS_FILE = Path(__file__).resolve().parent / "data" / "settings.json"

DEFAULT_SETTINGS = {
    "common": {"speed": 1, "jobs": 4, "notopen_action": "retry", "retry_interval": 1.0, "work_redo_enabled": False, "work_max_retries": 3, "add_learning_count": False, "target_count": 100},
    "tiku": {"provider": "TikuYanxi", "check_llm_connection": True, "submit": False, "cover_rate": 0.9, "delay": 1.0, "tokens": "", "likeapi_search": False, "likeapi_vision": True, "likeapi_model": "glm-4.5-air", "likeapi_retry": True, "likeapi_retry_times": 3, "url": "", "go_authorization": "", "go_min_interval": 1.0, "go_retry_times": 3, "go_retry_backoff": 1.2, "endpoint": "", "key": "", "model": "", "min_interval_seconds": 3, "http_proxy": "", "siliconflow_key": "", "siliconflow_model": "deepseek-ai/DeepSeek-R1", "siliconflow_endpoint": "https://api.siliconflow.cn/v1/chat/completions", "manual_mode_default": "batch", "manual_mode_separator": ";", "true_list": "正确,对,√,是", "false_list": "错误,错,×,否,不对,不正确"},
    "notification": {"provider": "ServerChan", "url": "", "tg_chat_id": "XXXXXX"},
}


def load_settings() -> dict:
    try:
        with SETTINGS_FILE.open("r", encoding="utf-8") as stream:
            saved = json.load(stream)
        settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        for section, values in saved.items():
            if section in settings and isinstance(values, dict):
                settings[section].update({key: value for key, value in values.items() if key in settings[section]})
        return settings
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return json.loads(json.dumps(DEFAULT_SETTINGS))


def save_settings(settings: dict) -> None:
    try:
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix="settings-", suffix=".json", dir=SETTINGS_FILE.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(settings, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, SETTINGS_FILE)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
    except (OSError, TypeError, ValueError):
        return


def load_records() -> list[dict]:
    try:
        with RECORDS_FILE.open("r", encoding="utf-8") as stream:
            records = json.load(stream)
        if not isinstance(records, list):
            return []
        normalized = []
        for index, record in enumerate(records):
            if isinstance(record, dict):
                record = dict(record)
                record.setdefault("id", f"legacy-{index}")
                normalized.append(record)
        return normalized
    except (FileNotFoundError, OSError, ValueError, TypeError):
        return []


def save_records(records: list[dict]) -> None:
    """原子保存结构化运行记录，不保存账号凭据或终端日志。"""
    try:
        RECORDS_FILE.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix="records-", suffix=".json", dir=RECORDS_FILE.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(records[-500:], stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, RECORDS_FILE)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)
    except (OSError, TypeError, ValueError):
        # 记录保存失败不影响课程同步或任务执行。
        return


class TimeDisplayTqdm(TqdmClass):
    @property
    def format_dict(self):
        values = super().format_dict
        values["n_fmt"] = format_duration(self.n)
        values["total_fmt"] = format_duration(self.total) if self.total is not None else "--:--"
        return values


class ProgressProxy:
    def __init__(self, result_queue, factory, *args, **kwargs):
        self.result_queue = result_queue
        raw_initial = int(kwargs.get("initial", 0) or 0)
        raw_total = int(kwargs.get("total", 0) or 0)
        self.total = raw_total
        self._display_from_elapsed = self.total > 0 and raw_initial >= self.total
        self._display_started = time.monotonic()
        display_kwargs = dict(kwargs)
        if self._display_from_elapsed:
            # initial 仅代表服务端记录的续播位置，不应让 tqdm 在任务刚开始
            # 就显示为 total/total。
            display_kwargs["initial"] = 0
        self.inner = factory(*args, **display_kwargs)
        self.total = int(kwargs.get("total", getattr(self.inner, "total", 0)) or 0)
        self._ready = False
        self._raw_n = raw_initial
        self._n = 0 if self._display_from_elapsed else raw_initial
        self.desc = getattr(self.inner, "desc", None) or "当前任务"
        self.leave = getattr(self.inner, "leave", False)
        self._ready = True
        self._closed = Event()
        self._send()
        self._heartbeat_thread = Thread(target=self._heartbeat, daemon=True)
        self._heartbeat_thread.start()

    @property
    def n(self):
        return self._n

    @n.setter
    def n(self, value):
        self._raw_n = int(float(value or 0))
        if self._display_from_elapsed:
            value = min(self.total, max(0, int(time.monotonic() - self._display_started)))
        self._n = int(float(value or 0))
        if hasattr(self, "inner"):
            self.inner.n = self._n
        if getattr(self, "_ready", False):
            self._send()

    def _send(self):
        played = self.n
        if self._display_from_elapsed:
            played = min(self.total, max(0, int(time.monotonic() - self._display_started)))
            self._n = played
            self.inner.n = played
        self.result_queue.put({"type": "progress", "current": self.desc, "played": played, "duration": self.total})

    def _heartbeat(self):
        while not self._closed.wait(1.0):
            self._send()

    def refresh(self, *_args, **_kwargs):
        self.inner.refresh(*_args, **_kwargs)
        self._send()

    def close(self):
        self._closed.set()
        self.inner.close()
        self._send()


def run_job_process(result_queue, username, password, use_cookies, settings, course, job, job_info):
    """在独立进程中运行 api/ 的任务方法，便于 Web 层安全终止当前任务。"""
    try:
        log_sink_id = api_logger.add(lambda message: result_queue.put({"type": "log", "line": str(message).rstrip()}), level="TRACE", enqueue=False)
        client = build_study_client(Account(username, password), settings)
        login_result = client.login(login_with_cookies=use_cookies)
        if not login_result.get("status"):
            result_queue.put({"ok": False, "message": login_result.get("msg", "子进程登录失败")})
            return
        import api.base as base_module
        base_module.tqdm = lambda *args, **kwargs: ProgressProxy(result_queue, TimeDisplayTqdm, *args, **kwargs)
        result = process_job(client, course, job, job_info, 1.0)
        result_queue.put({"ok": result.is_success(), "message": "success" if result.is_success() else "failed"})
    except Exception as exc:
        result_queue.put({"ok": False, "message": str(exc)})
    finally:
        try:
            api_logger.remove(log_sink_id)
        except (UnboundLocalError, ValueError):
            pass


def create_app() -> Flask:
    app = Flask(__name__)
    saved_records = load_records()
    app.extensions["chaoxing"] = {"client": None, "username": None, "password": None, "use_cookies": False, "display_name": None, "courses": [], "queue": [], "queue_status": "idle", "activities": list(reversed(saved_records[-20:])), "logs": [], "terminal_logs": [], "progress": {"total": 0, "completed": 0, "failed": 0, "current": "", "played": 0, "duration": 0}, "stop_event": Event(), "pause_event": Event(), "worker": None, "lock": RLock(), "records": saved_records, "settings": load_settings()}

    def terminal_log_sink(message):
        line = str(message).rstrip()
        if line:
            with state()["lock"]:
                state()["terminal_logs"].append(line)
                state()["terminal_logs"] = state()["terminal_logs"][-300:]

    api_logger.add(terminal_log_sink, level="TRACE", enqueue=False)

    def state():
        return app.extensions["chaoxing"]

    def record_event(title: str, detail: str, level: str = "info"):
        now = datetime.now(timezone(timedelta(hours=8)))
        event = {"id": uuid4().hex, "title": title, "detail": detail, "level": level, "time": now.strftime("%H:%M:%S"), "timestamp": now.isoformat()}
        current = state()
        with current["lock"]:
            current["activities"].insert(0, event)
            current["logs"].insert(0, event)
            current["activities"] = current["activities"][:20]
            current["logs"] = current["logs"][:100]
            current["records"].append(event)
            current["records"] = current["records"][-500:]
            save_records(current["records"])

    def run_job_interruptible(current, course, job, job_info):
        context = mp.get_context("spawn")
        result_queue = context.Queue()
        process = context.Process(
            target=run_job_process,
            args=(result_queue, current["username"], current["password"], current["use_cookies"], current["settings"], course, job, job_info),
            daemon=True,
        )
        process.start()
        pending_final = None
        try:
            while process.is_alive():
                pending_final = drain_progress(result_queue, current) or pending_final
                if current["stop_event"].is_set():
                    process.terminate()
                    process.join(timeout=3)
                    return None
                time.sleep(0.2)
            process.join(timeout=1)
            final_message = pending_final or drain_progress(result_queue, current)
            if final_message is not None:
                return final_message.get("ok", False)
            return False
        finally:
            if process.is_alive():
                process.terminate()
                process.join(timeout=1)

    def drain_progress(result_queue, current):
        final_message = None
        while True:
            try:
                message = result_queue.get_nowait()
            except Empty:
                return final_message
            if message.get("type") == "progress":
                with current["lock"]:
                    current["progress"]["current"] = message.get("current", current["progress"].get("current", ""))
                    current["progress"]["played"] = message.get("played", 0)
                    current["progress"]["duration"] = message.get("duration", 0)
            elif message.get("type") == "log":
                line = message.get("line", "")
                if line:
                    with current["lock"]:
                        current["terminal_logs"].append(line)
                        current["terminal_logs"] = current["terminal_logs"][-300:]
            else:
                final_message = message

    def execute_queue():
        current = state()
        client = current["client"]
        try:
            with current["lock"]:
                queue = list(current["queue"])
                current["queue_status"] = "running"
                current["progress"] = {"total": 0, "completed": 0, "failed": 0, "current": "准备读取课程任务"}
            for item in queue:
                if current["stop_event"].is_set():
                    break
                course_id = str(item.get("courseId"))
                item_mode = item.get("mode", "course")
                selected_task_id = str(item.get("taskId") or "")
                selected_point_id = str(item.get("pointId") or "")
                course = next((c for c in current["courses"] if str(c.get("courseId")) == course_id), None)
                if course is None:
                    course = next((c for c in client.get_course_list() if str(c.get("courseId")) == course_id), None)
                if course is None:
                    record_event("课程执行失败", f"找不到课程：{item.get('name', course_id)}", "error")
                    current["progress"]["failed"] += 1
                    continue
                point_data = client.get_course_point(course["courseId"], course["clazzId"], course.get("cpi"))
                points = point_data.get("points", []) if isinstance(point_data, dict) else point_data
                if item_mode == "task":
                    runnable_points = [point for point in points if str(point.get("id") or point.get("knowledgeId")) == selected_point_id]
                else:
                    runnable_points = [point for point in points if not point.get("has_finished", False)]
                for point in runnable_points:
                    if current["stop_event"].is_set():
                        break
                    while current["pause_event"].is_set() and not current["stop_event"].is_set():
                        with current["lock"]:
                            current["queue_status"] = "paused"
                        time.sleep(0.25)
                    with current["lock"]:
                        current["queue_status"] = "running"
                        current["progress"]["current"] = f"{course.get('title', course_id)} / {point.get('title', point.get('id', '章节'))}"
                    jobs, job_info = client.get_job_list(course, point)
                    if item_mode == "task":
                        jobs = [job for job in jobs if str(job.get("jobid") or job.get("jobId") or job.get("id")) == selected_task_id]
                    with current["lock"]:
                        current["progress"]["total"] += len(jobs) if jobs else (1 if item_mode == "task" else int(point.get("jobCount", 0) or 0))
                    for job in jobs:
                        if current["stop_event"].is_set():
                            break
                        # 每个任务独立显示播放进度；若 API 直接返回“已完成”，
                        # 子进程不会创建 tqdm，此处必须清除上一条视频留下的进度。
                        with current["lock"]:
                            current["progress"]["played"] = 0
                            current["progress"]["duration"] = 0
                            current["progress"]["current"] = job.get("name", "当前任务")
                        try:
                            result = run_job_interruptible(current, course, job, job_info)
                            if result is None:
                                break
                            if result:
                                current["progress"]["completed"] += 1
                            else:
                                current["progress"]["failed"] += 1
                        except Exception as exc:
                            current["progress"]["failed"] += 1
                            record_event("任务执行失败", f"{job.get('name', '未命名任务')}：{exc}", "error")
            with current["lock"]:
                current["queue_status"] = "stopped" if current["stop_event"].is_set() else "completed"
                current["progress"]["current"] = "已停止" if current["stop_event"].is_set() else "执行完成"
            record_event("执行队列结束", current["progress"]["current"])
        except Exception as exc:
            with current["lock"]:
                current["queue_status"] = "error"
                current["progress"]["current"] = "执行异常"
            record_event("执行器异常", str(exc), "error")

    def normalized_course(course: dict) -> dict:
        return {
            "courseId": course.get("courseId") or course.get("id"),
            "clazzId": course.get("clazzId") or course.get("classId"),
            "cpi": course.get("cpi"),
            "name": course.get("title") or course.get("courseName") or course.get("name") or "未命名课程",
            "teacher": course.get("teacher") or course.get("teacherName") or "",
            "raw": course,
        }

    def find_course(client: Chaoxing, course_id: str) -> dict | None:
        courses = client.get_course_list()
        for course in courses:
            if str(course.get("courseId") or course.get("id")) == str(course_id):
                return course
        return None

    def normalized_point(point: dict) -> dict:
        return {
            "id": point.get("id") or point.get("knowledgeId"),
            "name": point.get("title") or point.get("name") or point.get("knowledgeName") or "未命名章节",
            "jobCount": point.get("jobCount", 0),
            "hasFinished": bool(point.get("has_finished", False)),
            "needUnlock": bool(point.get("need_unlock", False)),
            "raw": point,
        }

    @app.get("/")
    def dashboard():
        return render_template("index.html")

    @app.get("/execution")
    def execution_center():
        return render_template("execution.html")

    @app.get("/courses")
    def course_management():
        return render_template("courses.html")

    @app.get("/records")
    def run_records():
        return render_template("records.html")

    @app.get("/settings")
    def system_settings():
        return render_template("settings.html")

    @app.get("/api/session")
    def session_status():
        current = state()
        return jsonify({"authenticated": current["client"] is not None, "username": current["username"], "displayName": current["display_name"]})

    @app.post("/api/auth/login")
    def login():
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", ""))
        use_cookies = bool(payload.get("use_cookies", False))
        if not use_cookies and (not username or not password):
            return jsonify({"ok": False, "message": "请输入账号和密码"}), 400

        current = state()
        with current["lock"]:
            client = Chaoxing(Account(username, password))
            result = client.login(login_with_cookies=use_cookies)
            if not result.get("status"):
                return jsonify({"ok": False, "message": result.get("msg", "登录失败")}), 401
            current["client"] = client
            client.tiku = DummyTiku()
            current["username"] = username or "Cookie 登录"
            current["password"] = password
            current["use_cookies"] = use_cookies
            current["stop_event"].clear()
            current["pause_event"].clear()
            try:
                current["display_name"] = client.get_name() or current["username"]
            except Exception:
                current["display_name"] = current["username"]
            current["courses"] = []
            current["queue"] = []
            current["queue_status"] = "idle"
            record_event("登录成功", f"已登录账号：{current['display_name']}")
        return jsonify({"ok": True, "message": result.get("msg", "登录成功"), "username": current["username"], "displayName": current["display_name"]})

    @app.post("/api/auth/logout")
    def logout():
        current = state()
        # 退出登录不能留下仍在使用旧会话的后台任务。
        current["stop_event"].set()
        current["pause_event"].clear()
        with current["lock"]:
            current["client"] = None
            current["username"] = None
            current["password"] = None
            current["use_cookies"] = False
            current["display_name"] = None
            current["queue_status"] = "stopping" if current["worker"] and current["worker"].is_alive() else ("queued" if current["queue"] else "idle")
            record_event("退出登录", "当前会话已清除")
        return jsonify({"ok": True})

    @app.get("/api/courses")
    def courses():
        client = state()["client"]
        if client is None:
            return jsonify({"ok": False, "message": "请先登录"}), 401
        try:
            result = client.get_course_list()
            state()["courses"] = result
            record_event("课程同步完成", f"获取到 {len(result)} 门课程")
            return jsonify({"ok": True, "courses": [normalized_course(course) for course in result]})
        except Exception as exc:
            return jsonify({"ok": False, "message": f"获取课程失败：{exc}"}), 502

    @app.get("/api/overview")
    def overview():
        client = state()["client"]
        if client is None:
            return jsonify({"ok": False, "message": "请先登录"}), 401
        try:
            course_list = state()["courses"] or client.get_course_list()
            if not state()["courses"]:
                state()["courses"] = course_list
            pending_tasks = 0
            total_tasks = 0
            chapters = 0
            for course in course_list:
                point_data = client.get_course_point(course["courseId"], course["clazzId"], course.get("cpi"))
                points = point_data.get("points", []) if isinstance(point_data, dict) else point_data
                chapters += len(points)
                for point in points:
                    try:
                        count = int(point.get("jobCount", 0))
                    except (TypeError, ValueError):
                        count = 0
                    total_tasks += count
                    if not point.get("has_finished", False):
                        pending_tasks += count
            return jsonify({"ok": True, "courseCount": len(course_list), "chapterCount": chapters, "totalTasks": total_tasks, "pendingTasks": pending_tasks})
        except Exception as exc:
            return jsonify({"ok": False, "message": f"统计任务失败：{exc}"}), 502

    @app.post("/api/tasks/queue")
    def queue_tasks():
        if state()["client"] is None:
            return jsonify({"ok": False, "message": "请先登录"}), 401
        payload = request.get_json(silent=True) or {}
        tasks = payload.get("tasks") or []
        courses = payload.get("courses") or []
        if (not isinstance(tasks, list) or not tasks) and (not isinstance(courses, list) or not courses):
            return jsonify({"ok": False, "message": "请选择至少一个任务或课程"}), 400
        current = state()
        with current["lock"]:
            incoming = courses if courses else tasks
            normalized = []
            for raw_item in incoming:
                if not isinstance(raw_item, dict):
                    continue
                item = dict(raw_item)
                if courses:
                    item["mode"] = "course"
                else:
                    item["mode"] = "task"
                    item["taskId"] = str(item.get("taskId") or item.get("jobid") or item.get("jobId") or item.get("id") or "")
                    item["pointId"] = str(item.get("pointId") or item.get("knowledgeId") or "")
                normalized.append(item)
            existing_keys = {queue_item_key(item) for item in current["queue"]}
            added = 0
            for item in normalized:
                item_key = queue_item_key(item)
                if item_key[1] and item_key not in existing_keys:
                    current["queue"].append(item)
                    existing_keys.add(item_key)
                    added += 1
            if not added:
                return jsonify({"ok": False, "message": "所选任务已经在执行队列中"}), 409
            current["queue_status"] = "queued"
            record_event("任务加入队列", f"新增 {added} 项，当前队列 {len(current['queue'])} 项")
        return jsonify({"ok": True, "added": added, "count": len(current["queue"]), "status": "queued", "mode": "course" if courses else "task"})

    @app.get("/api/tasks/status")
    def task_status():
        current = state()
        progress = dict(current["progress"])
        progress["playedText"] = format_duration(progress.get("played", 0))
        progress["durationText"] = format_duration(progress.get("duration", 0))
        queue = [{
            "courseId": item.get("courseId") or item.get("id"),
            "name": item.get("name") or item.get("title") or "未命名课程",
            "mode": item.get("mode", "course"),
            "taskId": item.get("taskId"),
            "pointId": item.get("pointId"),
            "type": item.get("type"),
        } for item in current["queue"]]
        return jsonify({"ok": True, "status": current["queue_status"], "count": len(queue), "queue": queue, "progress": progress})

    @app.delete("/api/tasks/queue/<course_id>")
    def remove_queued_course(course_id: str):
        current = state()
        if current["queue_status"] in {"running", "paused", "stopping"}:
            return jsonify({"ok": False, "message": "执行期间不能修改队列"}), 409
        task_id = request.args.get("task_id")
        point_id = request.args.get("point_id")
        with current["lock"]:
            before = len(current["queue"])
            if task_id is not None:
                current["queue"] = [item for item in current["queue"] if queue_item_key(item) != ("task", str(course_id), str(point_id or ""), str(task_id))]
            else:
                current["queue"] = [item for item in current["queue"] if str(item.get("courseId") or item.get("id")) != str(course_id)]
            removed = before != len(current["queue"])
            if not current["queue"]:
                current["queue_status"] = "idle"
        if not removed:
            return jsonify({"ok": False, "message": "队列中没有该课程"}), 404
        record_event("移出执行队列", f"课程 {course_id} 已移出队列")
        return jsonify({"ok": True, "count": len(current["queue"]), "status": current["queue_status"]})

    @app.post("/api/tasks/start")
    def start_tasks():
        current = state()
        if current["client"] is None:
            return jsonify({"ok": False, "message": "请先登录"}), 401
        if not current["queue"]:
            return jsonify({"ok": False, "message": "执行队列为空"}), 400
        if current["queue_status"] == "paused":
            current["pause_event"].clear()
            current["queue_status"] = "running"
            record_event("恢复执行队列", "继续处理剩余任务")
            return jsonify({"ok": True, "status": "running", "resumed": True})
        if current["queue_status"] in {"running", "stopping"}:
            return jsonify({"ok": False, "message": "执行队列当前正在运行或停止中"}), 409
        current["stop_event"].clear()
        current["pause_event"].clear()
        current["worker"] = Thread(target=execute_queue, daemon=True)
        current["worker"].start()
        record_event("开始执行队列", f"共 {len(current['queue'])} 门课程")
        return jsonify({"ok": True, "status": "running"})

    @app.post("/api/tasks/pause")
    def pause_tasks():
        current = state()
        if current["queue_status"] != "running":
            return jsonify({"ok": False, "message": "当前没有正在执行的队列"}), 409
        current["pause_event"].set()
        with current["lock"]:
            current["queue_status"] = "paused"
        record_event("暂停执行队列", "等待用户恢复")
        return jsonify({"ok": True, "status": "paused"})

    @app.post("/api/tasks/stop")
    def stop_tasks():
        current = state()
        if current["queue_status"] not in {"running", "paused"}:
            return jsonify({"ok": False, "message": "当前没有正在执行的队列"}), 409
        current["stop_event"].set()
        current["pause_event"].clear()
        with current["lock"]:
            current["queue_status"] = "stopping"
        record_event("停止执行队列", "已请求停止当前执行")
        return jsonify({"ok": True, "status": "stopping"})

    @app.get("/api/activities")
    def activities():
        return jsonify({"ok": True, "activities": state()["activities"][:10]})

    @app.get("/api/records")
    def records():
        current = state()
        with current["lock"]:
            records = list(reversed(current["records"][-500:]))
        return jsonify({"ok": True, "records": records})

    @app.delete("/api/records")
    def clear_records():
        current = state()
        with current["lock"]:
            current["records"] = []
            current["activities"] = []
            current["logs"] = []
            save_records([])
        return jsonify({"ok": True, "message": "运行记录已全部删除"})

    @app.delete("/api/records/<record_id>")
    def delete_record(record_id: str):
        current = state()
        with current["lock"]:
            before = len(current["records"])
            current["records"] = [record for record in current["records"] if str(record.get("id")) != str(record_id)]
            if len(current["records"]) == before:
                return jsonify({"ok": False, "message": "记录不存在"}), 404
            current["activities"] = [record for record in current["activities"] if str(record.get("id")) != str(record_id)]
            current["logs"] = [record for record in current["logs"] if str(record.get("id")) != str(record_id)]
            save_records(current["records"])
        return jsonify({"ok": True})

    @app.get("/api/settings")
    def get_settings():
        return jsonify({"ok": True, "settings": state()["settings"]})

    @app.get("/api/settings/defaults")
    def get_default_settings():
        return jsonify({"ok": True, "settings": json.loads(json.dumps(DEFAULT_SETTINGS))})

    @app.put("/api/settings")
    def update_settings():
        payload = request.get_json(silent=True) or {}
        incoming = payload.get("settings", payload)
        if not isinstance(incoming, dict):
            return jsonify({"ok": False, "message": "配置格式不正确"}), 400
        current = state()
        with current["lock"]:
            for section, values in incoming.items():
                if section in current["settings"] and isinstance(values, dict):
                    for key, value in values.items():
                        if key in current["settings"][section]:
                            current["settings"][section][key] = value
            save_settings(current["settings"])
            record_event("系统设置已保存", "配置已写入本地设置文件")
        return jsonify({"ok": True, "settings": current["settings"]})

    @app.get("/api/logs")
    def logs():
        info_lines = [line for line in state()["terminal_logs"] if "| INFO" in line or " INFO    " in line]
        return jsonify({"ok": True, "lines": info_lines[-300:]})

    @app.get("/api/courses/<course_id>/chapters")
    def chapters(course_id: str):
        client = state()["client"]
        if client is None:
            return jsonify({"ok": False, "message": "请先登录"}), 401
        try:
            course = find_course(client, course_id)
            if course is None:
                return jsonify({"ok": False, "message": "课程不存在"}), 404
            point_data = client.get_course_point(course["courseId"], course["clazzId"], course.get("cpi"))
            points = point_data.get("points", []) if isinstance(point_data, dict) else point_data
            record_event("章节读取完成", f"{normalized_course(course)['name']}：读取到 {len(points)} 个章节")
            return jsonify({"ok": True, "course": normalized_course(course), "locked": bool(point_data.get("hasLocked")) if isinstance(point_data, dict) else False, "chapters": [normalized_point(point) for point in points]})
        except Exception as exc:
            return jsonify({"ok": False, "message": f"获取章节失败：{exc}"}), 502

    @app.get("/api/courses/<course_id>/chapters/<point_id>/tasks")
    def tasks(course_id: str, point_id: str):
        client = state()["client"]
        if client is None:
            return jsonify({"ok": False, "message": "请先登录"}), 401
        try:
            course = find_course(client, course_id)
            if course is None:
                return jsonify({"ok": False, "message": "课程不存在"}), 404
            point = {"id": point_id}
            jobs, job_info = client.get_job_list(course, point)
            record_event("任务点读取完成", f"课程 {normalized_course(course)['name']}：读取到 {len(jobs)} 个任务点")
            return jsonify({"ok": True, "tasks": jobs, "info": job_info})
        except Exception as exc:
            return jsonify({"ok": False, "message": f"获取任务点失败：{exc}"}), 502

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
