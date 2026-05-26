"""
Simple JSON-backed object store for POC persistence.

Used by the SavedChart and Dashboard endpoints. Intentionally lightweight —
this is a POC; swap for a real DB (or the existing SQLAlchemy session) when
we promote saved-chart storage out of prototype.
"""

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, List, Optional


class JsonStore:
    """Thread-safe append/update/delete over a JSON file of dict records.

    Each record gets `id`, `created_at`, `updated_at` injected automatically.
    """

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            with open(path, "w") as f:
                json.dump([], f)

    def _read(self) -> List[Dict[str, Any]]:
        with open(self.path, "r") as f:
            return json.load(f)

    def _write(self, items: List[Dict[str, Any]]) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(items, f, indent=2, default=str)
        os.replace(tmp, self.path)

    def list(self, **filters: Any) -> List[Dict[str, Any]]:
        with self._lock:
            items = self._read()
        if not filters:
            return items
        return [
            it for it in items
            if all(it.get(k) == v for k, v in filters.items())
        ]

    def get(self, item_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            for it in self._read():
                if it.get("id") == item_id:
                    return it
        return None

    def create(self, item: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            items = self._read()
            now = time.time()
            item.setdefault("id", str(uuid.uuid4()))
            item.setdefault("created_at", now)
            item["updated_at"] = now
            items.append(item)
            self._write(items)
        return item

    def update(self, item_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            items = self._read()
            for i, it in enumerate(items):
                if it.get("id") == item_id:
                    it.update(patch)
                    it["updated_at"] = time.time()
                    items[i] = it
                    self._write(items)
                    return it
        return None

    def delete(self, item_id: str) -> bool:
        with self._lock:
            items = self._read()
            new = [it for it in items if it.get("id") != item_id]
            if len(new) == len(items):
                return False
            self._write(new)
        return True


_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
charts_store = JsonStore(os.path.join(_DATA_DIR, "charts.json"))
dashboards_store = JsonStore(os.path.join(_DATA_DIR, "dashboards.json"))
