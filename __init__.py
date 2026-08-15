"""CPA Quota — native plugin entry point.

This module exists so the plugin registry can discover and enable
``cpa-quota`` (``hermes plugins enable cpa-quota``). The actual widget is a
dashboard plugin: the Python backend in ``dashboard/plugin_api.py`` and the
web bundle in ``dashboard/dist/index.js``. Nothing is registered in the
agent core — this is intentionally a no-op.
"""

from __future__ import annotations

from typing import Any

__all__ = ["register"]


def register(ctx: Any) -> None:
    """No-op registration. The widget lives in the dashboard layer."""
    return
