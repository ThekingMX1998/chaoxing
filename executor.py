"""Production task executor extracted from the legacy CLI flow.

This module intentionally depends only on api/.
The actual video progress remains implemented by api.base.Chaoxing.study_video,
so the existing tqdm progress lifecycle is preserved for the Web adapter.
"""

import threading

from api.base import Chaoxing, StudyResult
from api.answer import DummyTiku, Tiku
from api.live import Live
from api.live_process import LiveProcessor


def _config_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def build_study_client(account, settings: dict | None = None) -> Chaoxing:
    """根据 Web 系统设置构造与旧 CLI 相同的题库和学习参数。"""
    settings = settings or {}
    common = settings.get("common", {})
    tiku_config = {
        key: _config_value(value)
        for key, value in (settings.get("tiku", {}) or {}).items()
    }
    tiku_config["provider"] = ",".join(
        provider.strip() for provider in tiku_config.get("provider", "").split(",") if provider.strip()
    )
    tiku_config["tokens"] = ",".join(
        token.strip() for token in tiku_config.get("tokens", "").split(",") if token.strip()
    )
    tiku = DummyTiku()
    if tiku_config.get("provider", "").strip():
        if "TikuYanxi" in tiku_config["provider"] and not tiku_config["tokens"]:
            raise ValueError("言溪题库未配置有效 TOKEN，请在系统设置中填写 tokens")
        tiku = Tiku.get_tiku_from_config(tiku_config)
        tiku.init_tiku()
    return Chaoxing(
        account=account,
        tiku=tiku,
        query_delay=float(tiku_config.get("delay", 0) or 0),
        work_max_retries=int(common.get("work_max_retries", 3) or 3),
        work_redo_enabled=bool(common.get("work_redo_enabled", False)),
    )


def process_job(chaoxing: Chaoxing, course: dict, job: dict, job_info: dict, speed: float = 1.0) -> StudyResult:
    job_type = job.get("type")
    if job_type == "video":
        result = chaoxing.study_video(course, job, job_info, _speed=speed, _type="Video")
        if result.is_failure():
            result = chaoxing.study_video(course, job, job_info, _speed=speed, _type="Audio")
        return result
    if job_type == "document":
        return chaoxing.study_document(course, job)
    if job_type == "workid":
        return chaoxing.study_work(course, job, job_info)
    if job_type == "read":
        return chaoxing.study_read(course, job, job_info)
    if job_type == "live":
        live = Live(
            attachment=job,
            defaults={
                "userid": chaoxing.get_uid(),
                "clazzId": course.get("clazzId"),
                "knowledgeid": job_info.get("knowledgeid"),
            },
            course_id=course.get("courseId"),
        )
        thread = threading.Thread(target=LiveProcessor.run_live, args=(live, speed), daemon=True)
        thread.start()
        thread.join()
        return StudyResult.SUCCESS
    return StudyResult.ERROR


def process_chapter(chaoxing: Chaoxing, course: dict, point: dict, speed: float = 1.0) -> tuple[bool, int, int]:
    """Process one chapter and return (success, completed_jobs, failed_jobs)."""
    if point.get("has_finished", False):
        return True, 0, 0

    jobs, job_info = chaoxing.get_job_list(course, point)
    if job_info.get("notOpen", False):
        return False, 0, 0

    completed = 0
    failed = 0
    for job in jobs:
        result = process_job(chaoxing, course, job, job_info, speed)
        if result.is_success():
            completed += 1
        else:
            failed += 1
    return failed == 0, completed, failed


def process_course(chaoxing: Chaoxing, course: dict, speed: float = 1.0) -> dict:
    """Process every unfinished chapter in one course."""
    point_data = chaoxing.get_course_point(course["courseId"], course["clazzId"], course.get("cpi"))
    points = point_data.get("points", []) if isinstance(point_data, dict) else point_data
    result = {"chapters": len(points), "completed": 0, "failed": 0}
    for point in points:
        ok, completed, failed = process_chapter(chaoxing, course, point, speed)
        result["completed"] += completed
        result["failed"] += failed
        if not ok and not failed:
            result["failed"] += 1
    return result
