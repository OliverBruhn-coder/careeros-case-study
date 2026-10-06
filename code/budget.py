"""LLM budget helper - d18.

Rolling 7-day USD cap per user, computed from llm_usage.cost_usd (d17).
Stateless; the caller passes an open Session. Three modes via env:

  CAREEROS_BUDGET_MODE          off | warn | block   (default: warn)
  CAREEROS_DEFAULT_BUDGET_USD_PER_WEEK   Decimal, default 5

Per-user override lives in users.budget_usd_per_week (NULL => env default).
"""
from __future__ import annotations

import os
import uuid as _uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .db.models import LlmUsage, User


_WINDOW_DAYS = 7
_WARN_THRESHOLD_PERCENT = Decimal("80")
_BLOCK_THRESHOLD_PERCENT = Decimal("100")
_VALID_MODES = ("off", "warn", "block")


@dataclass
class BudgetStatus:
    status: str          # "ok" | "warn" | "block" | "off"
    mode: str            # "off" | "warn" | "block"
    used_usd: Decimal
    limit_usd: Decimal
    remaining_usd: Decimal
    percent: float
    reset_at: datetime | None


class BudgetExceeded(Exception):
    """Raised by preflight when status == 'block'. Carries the full status."""

    def __init__(self, status: BudgetStatus) -> None:
        super().__init__("budget_exceeded")
        self.status = status


def _read_mode() -> str:
    raw = (os.environ.get("CAREEROS_BUDGET_MODE") or "warn").strip().lower()
    return raw if raw in _VALID_MODES else "warn"


def _read_default_limit() -> Decimal:
    raw = os.environ.get("CAREEROS_DEFAULT_BUDGET_USD_PER_WEEK")
    if raw is None or not raw.strip():
        return Decimal("5")
    try:
        return Decimal(raw.strip())
    except (InvalidOperation, ValueError):
        return Decimal("5")


def _coerce_user_id(value: Any) -> _uuid.UUID | None:
    if isinstance(value, _uuid.UUID):
        return value
    if value is None:
        return None
    try:
        return _uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


def _percent(used: Decimal, limit: Decimal) -> Decimal:
    if limit <= 0:
        return Decimal("100") if used > 0 else Decimal("0")
    return (used / limit) * Decimal("100")


def check_budget(db: Session, user_id: Any) -> BudgetStatus:
    """Compute current 7-day budget status for one user.

    Returns status='off' when mode=off; query is still skipped to keep
    the hot path cheap when budgeting is disabled.
    """
    mode = _read_mode()
    default_limit = _read_default_limit()

    if mode == "off":
        return BudgetStatus(
            status="off",
            mode=mode,
            used_usd=Decimal("0"),
            limit_usd=default_limit,
            remaining_usd=default_limit,
            percent=0.0,
            reset_at=None,
        )

    uid = _coerce_user_id(user_id)
    if uid is None:
        # Anonymous/unresolved user - treat as off rather than blocking.
        return BudgetStatus(
            status="off",
            mode=mode,
            used_usd=Decimal("0"),
            limit_usd=default_limit,
            remaining_usd=default_limit,
            percent=0.0,
            reset_at=None,
        )

    # Per-user override; NULL => env default.
    override = db.scalars(
        select(User.budget_usd_per_week).where(User.id == uid)
    ).first()
    limit = Decimal(str(override)) if override is not None else default_limit

    window_start = datetime.now(tz=timezone.utc) - timedelta(days=_WINDOW_DAYS)
    row = db.execute(
        select(
            func.coalesce(func.sum(LlmUsage.cost_usd), 0),
            func.min(LlmUsage.created_at),
        ).where(
            LlmUsage.user_id == uid,
            LlmUsage.created_at >= window_start,
        )
    ).one()
    used = Decimal(str(row[0] or 0))
    oldest = row[1]

    percent = _percent(used, limit)
    remaining = limit - used
    if remaining < 0:
        remaining = Decimal("0")

    if percent >= _BLOCK_THRESHOLD_PERCENT and mode == "block":
        status = "block"
    elif percent >= _WARN_THRESHOLD_PERCENT:
        status = "warn"
    else:
        status = "ok"

    reset_at: datetime | None = None
    if oldest is not None:
        reset_at = oldest + timedelta(days=_WINDOW_DAYS)

    return BudgetStatus(
        status=status,
        mode=mode,
        used_usd=used,
        limit_usd=limit,
        remaining_usd=remaining,
        percent=float(percent),
        reset_at=reset_at,
    )


def serialize_budget_status(s: BudgetStatus) -> dict[str, Any]:
    """JSON-safe dict for API responses (warn payload + 402 body).

    USD values render with two decimals to match the column type
    (Numeric(10,2)) and the README contract; reset_at -> ISO 8601 or None.
    """
    return {
        "status": s.status,
        "mode": s.mode,
        "used_usd": f"{s.used_usd:.2f}",
        "limit_usd": f"{s.limit_usd:.2f}",
        "remaining_usd": f"{s.remaining_usd:.2f}",
        "percent": s.percent,
        "reset_at": s.reset_at.isoformat() if s.reset_at is not None else None,
    }
