"""Web 端 SQLite 持久化。

数据表预留 owner_id，当前默认使用 local，后续接入多用户时可直接按用户隔离。
"""

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path


DATA_DIR = Path(__file__).resolve().parent / "data"
DATABASE_FILE = DATA_DIR / "app.db"
LEGACY_RECORDS_FILE = DATA_DIR / "records.json"
LEGACY_SETTINGS_FILE = DATA_DIR / "settings.json"
DEFAULT_OWNER_ID = "local"


@contextmanager
def _connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_FILE, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _create_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS settings (
            owner_id TEXT NOT NULL,
            section TEXT NOT NULL,
            setting_key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (owner_id, section, setting_key)
        );

        CREATE TABLE IF NOT EXISTS run_records (
            owner_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (owner_id, record_id)
        );

        CREATE INDEX IF NOT EXISTS idx_run_records_owner_position
            ON run_records (owner_id, position);

        CREATE TABLE IF NOT EXISTS storage_meta (
            meta_key TEXT PRIMARY KEY,
            meta_value TEXT NOT NULL
        );
        """
    )


def _read_json(path: Path, fallback):
    try:
        with path.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    except (FileNotFoundError, OSError, TypeError, ValueError):
        return fallback


def _normalize_records(records) -> list[dict]:
    if not isinstance(records, list):
        return []
    normalized = []
    for index, record in enumerate(records):
        if isinstance(record, dict):
            item = dict(record)
            item.setdefault("id", f"legacy-{index}")
            normalized.append(item)
    return normalized[-500:]


def _replace_records(connection, records: list[dict], owner_id: str) -> None:
    connection.execute("DELETE FROM run_records WHERE owner_id = ?", (owner_id,))
    connection.executemany(
        """
        INSERT OR REPLACE INTO run_records
            (owner_id, record_id, position, payload_json)
        VALUES (?, ?, ?, ?)
        """,
        [
            (owner_id, str(record["id"]), index, json.dumps(record, ensure_ascii=False))
            for index, record in enumerate(records[-500:])
        ],
    )


def init_storage(default_settings: dict) -> None:
    """创建数据库，并把旧 JSON 数据迁移一次。"""
    with _connect() as connection:
        _create_schema(connection)
        migrated = connection.execute(
            "SELECT meta_value FROM storage_meta WHERE meta_key = 'legacy_json_migrated'"
        ).fetchone()
        if migrated is not None:
            return

        if LEGACY_RECORDS_FILE.exists():
            has_records = connection.execute(
                "SELECT 1 FROM run_records WHERE owner_id = ? LIMIT 1", (DEFAULT_OWNER_ID,)
            ).fetchone()
            if has_records is None:
                _replace_records(connection, _normalize_records(_read_json(LEGACY_RECORDS_FILE, [])), DEFAULT_OWNER_ID)

        if LEGACY_SETTINGS_FILE.exists():
            has_settings = connection.execute(
                "SELECT 1 FROM settings WHERE owner_id = ? LIMIT 1", (DEFAULT_OWNER_ID,)
            ).fetchone()
            saved = _read_json(LEGACY_SETTINGS_FILE, {})
            if has_settings is None and isinstance(saved, dict):
                for section, values in saved.items():
                    if section not in default_settings or not isinstance(values, dict):
                        continue
                    for key, value in values.items():
                        if key not in default_settings[section]:
                            continue
                        connection.execute(
                            """
                            INSERT OR REPLACE INTO settings
                                (owner_id, section, setting_key, value_json)
                            VALUES (?, ?, ?, ?)
                            """,
                            (DEFAULT_OWNER_ID, section, key, json.dumps(value, ensure_ascii=False)),
                        )

        connection.execute(
            "INSERT OR REPLACE INTO storage_meta (meta_key, meta_value) VALUES ('legacy_json_migrated', '1')"
        )


def load_records(owner_id: str = DEFAULT_OWNER_ID) -> list[dict]:
    with _connect() as connection:
        _create_schema(connection)
        rows = connection.execute(
            "SELECT payload_json FROM run_records WHERE owner_id = ? ORDER BY position ASC",
            (owner_id,),
        ).fetchall()
    records = []
    for row in rows:
        try:
            record = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            continue
        if isinstance(record, dict):
            records.append(record)
    return records[-500:]


def save_records(records: list[dict], owner_id: str = DEFAULT_OWNER_ID) -> None:
    try:
        with _connect() as connection:
            _create_schema(connection)
            _replace_records(connection, records, owner_id)
    except (OSError, sqlite3.Error, TypeError, ValueError):
        return


def load_settings(default_settings: dict, owner_id: str = DEFAULT_OWNER_ID) -> dict:
    settings = json.loads(json.dumps(default_settings))
    with _connect() as connection:
        _create_schema(connection)
        rows = connection.execute(
            "SELECT section, setting_key, value_json FROM settings WHERE owner_id = ?",
            (owner_id,),
        ).fetchall()
    for row in rows:
        section = row["section"]
        key = row["setting_key"]
        if section not in settings or key not in settings[section]:
            continue
        try:
            settings[section][key] = json.loads(row["value_json"])
        except (TypeError, ValueError):
            continue
    return settings


def save_settings(settings: dict, owner_id: str = DEFAULT_OWNER_ID) -> None:
    try:
        with _connect() as connection:
            _create_schema(connection)
            connection.execute("DELETE FROM settings WHERE owner_id = ?", (owner_id,))
            rows = []
            for section, values in settings.items():
                if not isinstance(values, dict):
                    continue
                rows.extend(
                    (owner_id, section, key, json.dumps(value, ensure_ascii=False))
                    for key, value in values.items()
                )
            connection.executemany(
                """
                INSERT INTO settings (owner_id, section, setting_key, value_json)
                VALUES (?, ?, ?, ?)
                """,
                rows,
            )
    except (OSError, sqlite3.Error, TypeError, ValueError):
        return
