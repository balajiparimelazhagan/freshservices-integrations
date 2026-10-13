import sqlite3
import threading
from typing import NamedTuple, Optional


class Link(NamedTuple):
    source_id: int
    target_id: int
    last_status: int


class LinkStore:
    def __init__(self, path: str = ":memory:"):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS links (
                source_id   INTEGER PRIMARY KEY,
                target_id   INTEGER NOT NULL UNIQUE,
                last_status INTEGER NOT NULL
            )"""
        )
        self._db.commit()

    def _one(self, where: str, value: int) -> Optional[Link]:
        with self._lock:
            row = self._db.execute(
                f"SELECT source_id, target_id, last_status FROM links WHERE {where} = ?", (value,)
            ).fetchone()
        return Link(*row) if row else None

    def by_source(self, source_id: int) -> Optional[Link]:
        return self._one("source_id", source_id)

    def by_target(self, target_id: int) -> Optional[Link]:
        return self._one("target_id", target_id)

    def link(self, source_id: int, target_id: int, status: int) -> None:
        with self._lock:
            self._db.execute("INSERT INTO links VALUES (?, ?, ?)", (source_id, target_id, status))
            self._db.commit()

    def set_status(self, source_id: int, status: int) -> None:
        with self._lock:
            self._db.execute("UPDATE links SET last_status = ? WHERE source_id = ?", (status, source_id))
            self._db.commit()
