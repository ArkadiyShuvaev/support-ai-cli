"""Shared logging configuration for the data-pipeline.

Usage in entry-point scripts:
    from shared.logger import get_logger, make_subprocess_errlog
    logger = get_logger(__name__, log_file="scrape_notion")

    This sets up:
      - Console output (HH:MM:SS timestamps)
      - logs/pipeline.log  — combined log across all scripts
      - logs/scrape_notion.log — log for this script only

    To capture MCP subprocess stderr in the log files:
        errlog = make_subprocess_errlog(logger)
        async with stdio_client(server_params, errlog=errlog) as (read, write):
            errlog.close_write_end()  # release parent's copy once subprocess is running
            ...

Usage in library code (shared/):
    import logging
    logger = logging.getLogger(__name__)

    Library code must never call setup_logging() or add handlers directly.
    Its messages propagate to root and appear in all active log files.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from logging.handlers import RotatingFileHandler

_LOGS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "logs")
_PIPELINE_LOG = os.path.join(_LOGS_DIR, "pipeline.log")

_base_configured = False
_configured_files: set[str] = set()

_FILE_FMT = logging.Formatter(
    "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
_CONSOLE_FMT = logging.Formatter(
    "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)


def _make_rotating_handler(path: str) -> RotatingFileHandler:
    handler = RotatingFileHandler(
        path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(_FILE_FMT)
    return handler


def setup_logging(level: int = logging.INFO, log_file: str | None = None) -> None:
    """Configure the root logger with console + pipeline.log, and optionally a per-script file.

    Args:
        level:    Log level (default INFO).
        log_file: Optional stem name for a per-script log file (e.g. "scrape_notion"
                  produces logs/scrape_notion.log). Safe to call multiple times.
    """
    global _base_configured

    os.makedirs(_LOGS_DIR, exist_ok=True)

    if not _base_configured:
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(_CONSOLE_FMT)

        logging.root.setLevel(level)
        logging.root.addHandler(console)
        logging.root.addHandler(_make_rotating_handler(_PIPELINE_LOG))
        _base_configured = True

    if log_file and log_file not in _configured_files:
        path = os.path.join(_LOGS_DIR, f"{log_file}.log")
        logging.root.addHandler(_make_rotating_handler(path))
        _configured_files.add(log_file)


def get_logger(name: str, log_file: str | None = None) -> logging.Logger:
    """Return a named logger, triggering logging setup on first call.

    Args:
        name:     Pass __name__ from the caller.
        log_file: Optional stem for a per-script log file (e.g. "scrape_notion").
                  Only entry-point scripts should pass this.
    """
    setup_logging(log_file=log_file)
    return logging.getLogger(name)


class SubprocessErrlog:
    """Routes MCP subprocess stderr to both the terminal and Python logging (→ log files).

    How it works:
      - Creates an OS pipe (read_fd, write_fd).
      - Passes write_fd to the subprocess via fileno() — so the subprocess's stderr
        fd is the write end of our pipe, not the terminal.
      - A daemon thread reads from read_fd line-by-line and:
          a) Writes each line to sys.stderr so it still appears in the terminal.
          b) Logs each non-empty line as WARNING through Python logging, which
             routes it to all configured handlers (console + log files).

    Usage:
        errlog = make_subprocess_errlog(logger)
        async with stdio_client(server_params, errlog=errlog) as (read, write):
            errlog.close_write_end()   # subprocess now holds the only write end;
                                       # reader thread exits cleanly when it does.
            ...
    """

    def __init__(self, logger: logging.Logger) -> None:
        self._logger = logger
        r_fd, self._w_fd = os.pipe()

        def _pump() -> None:
            try:
                with os.fdopen(r_fd, encoding="utf-8", errors="replace") as pipe:
                    for line in pipe:
                        sys.stderr.write(line)
                        sys.stderr.flush()
                        stripped = line.rstrip()
                        if stripped:
                            self._logger.warning("[subprocess] %s", stripped)
            except Exception:
                pass

        threading.Thread(target=_pump, daemon=True).start()

    def fileno(self) -> int:
        """Return the pipe write-end fd. anyio/subprocess uses this as the stderr fd."""
        return self._w_fd

    def write(self, data: str) -> int:
        os.write(self._w_fd, data.encode("utf-8", errors="replace"))
        return len(data)

    def flush(self) -> None:
        pass

    def close_write_end(self) -> None:
        """Close the parent's copy of the write end.

        Call this immediately after stdio_client has started the subprocess.
        The subprocess still holds its own dup'd copy, so the pipe stays open
        until the subprocess exits — at which point the reader thread sees EOF
        and exits cleanly.
        """
        if self._w_fd >= 0:
            os.close(self._w_fd)
            self._w_fd = -1


def make_subprocess_errlog(logger: logging.Logger) -> SubprocessErrlog:
    """Create a SubprocessErrlog that routes stderr to the terminal and log files."""
    return SubprocessErrlog(logger)
