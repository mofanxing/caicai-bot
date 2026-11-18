import hashlib
import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from app.core.errors import ServiceError
from app.tasks.contracts import CAPABILITIES


def safe_text(value):
    """Persist selected fields only; redact common credential formats before storage."""
    text = str(value)[:16000]
    for name in ("OPENAI_API_KEY", "ADMIN_TOKEN", "PROVIDER_ENCRYPTION_KEY"):
        secret = os.environ.get(name)
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)Bearer\s+[^\s\"']+", "Bearer [REDACTED]", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]+", "[REDACTED]", text)
    return re.sub(
        r"(?i)((?:api[_-]?key|access[_-]?token|password|secret)[\"']?\s*[=:]\s*[\"']?)"
        r"[^\s,\"']+",
        r"\1[REDACTED]",
        text,
    )


def project_root(value):
    path = Path(value)
    if not path.is_absolute():
        raise ServiceError("invalid_project", "项目目录必须是绝对路径", 422)
    try:
        root = path.resolve(strict=True)
        if not root.is_dir() or root == Path(root.anchor) or root == Path.home():
            raise ValueError()
        # Local project config may introduce unsandboxed MCP servers or hooks.
        # First adapter supports a clean CLI configuration only.
        for ancestor in (root, *root.parents):
            if ancestor != Path.home() and (ancestor / ".codex/config.toml").exists():
                raise ServiceError(
                    "project_config_unsupported", "首版暂不支持带 .codex/config.toml 的项目", 422
                )
        return root
    except (OSError, ValueError) as exc:
        raise ServiceError(
            "invalid_project", "请选择存在的项目目录，不能使用磁盘根目录或主目录", 422
        ) from exc


def process_group_exists(pgid):
    if not pgid:
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


@dataclass
class ExecutionResult:
    status: str
    reason: str | None = None
    summary: str | None = None
    exit_code: int | None = None


class CodexExecutor:
    id = "codex-cli"
    capabilities = frozenset(CAPABILITIES)

    def __init__(self, settings):
        self.settings = settings

    def environment(self):
        # Never inherit the API admin token, provider secrets or arbitrary application env.
        allowed = {
            "HOME",
            "PATH",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "CODEX_HOME",
            "SYSTEMROOT",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "OPENAI_API_KEY",
        }
        return {key: value for key, value in os.environ.items() if key in allowed}

    def check_availability(self):
        binary = shutil.which(self.settings.codex_binary)
        base = {
            "ready": False,
            "version": "unknown",
            "code": "codex_missing",
            "message": "找不到 Codex CLI，请安装并配置 CODEX_BINARY",
        }
        if not binary:
            return base
        try:
            version = subprocess.run(
                [binary, "--version"], capture_output=True, timeout=5, env=self.environment()
            )
            match = re.fullmatch(rb"codex-cli (0\.169\.[A-Za-z0-9.+-]+)\s*", version.stdout)
            if version.returncode or not match:
                return {
                    **base,
                    "code": "codex_version_unsupported",
                    "message": "当前适配器仅核实过 Codex CLI 0.169.x，请核实协议后升级适配器",
                }
            base["version"] = match[1].decode()
            help_result = subprocess.run(
                [binary, "exec", "--help"], capture_output=True, timeout=5, env=self.environment()
            )
            if help_result.returncode or not all(
                flag in help_result.stdout
                for flag in (b"--json", b"--sandbox", b"--ignore-user-config", b"--ephemeral")
            ):
                return {
                    **base,
                    "code": "codex_protocol_unsupported",
                    "message": "CLI 缺少必要执行参数",
                }
            auth = subprocess.run(
                [binary, "login", "status"], capture_output=True, timeout=5, env=self.environment()
            )
            if auth.returncode:
                return {
                    **base,
                    "code": "codex_not_authenticated",
                    "message": "Codex CLI 尚未认证，请在运行 worker 的账号下完成 codex login",
                }
        except (OSError, subprocess.TimeoutExpired):
            return {**base, "code": "codex_check_failed", "message": "Codex CLI 检查失败或超时"}
        return {**base, "ready": True, "code": "ready", "message": "Codex CLI 可用"}

    def command(self, root):
        return [
            self.settings.codex_binary,
            "exec",
            "--json",
            "--ephemeral",
            "--ignore-user-config",
            "--sandbox",
            "workspace-write",
            "-c",
            'approval_policy="never"',
            "-c",
            "sandbox_workspace_write.network_access=false",
            "-c",
            'shell_environment_policy.inherit="core"',
            "--color",
            "never",
            "--cd",
            str(root),
            "-",
        ]

    def run(self, task, on_started, on_event, should_stop):
        root = project_root(task.project_root)
        if str(root) != task.project_root:
            raise ServiceError("project_changed", "登记项目目录已改变", 409)
        prompt = (
            "在当前项目中完成以下任务。遵守项目指令和沙箱权限；不请求或绕过审批。"
            "最后说明修改、实际检查命令及结果，无法完成时明确说明。\n\n" + task.goal
        )
        # File-backed stdin cannot block shutdown if the child never reads a large prompt.
        with tempfile.TemporaryFile() as prompt_input:
            prompt_input.write(prompt.encode())
            prompt_input.seek(0)
            process = subprocess.Popen(
                self.command(root),
                stdin=prompt_input,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env=self.environment(),
            )
        terminal = None
        summary = None
        failure = False
        reason = None
        started = time.monotonic()
        pending = b""
        selector = selectors.DefaultSelector()
        try:
            on_started(process.pid)
            selector.register(process.stdout, selectors.EVENT_READ)
            eof = False
            exited_at = None
            while not eof:
                reason = should_stop()
                if process.poll() is not None:
                    exited_at = exited_at or time.monotonic()
                    # Drain a completed process before applying a late cancellation.
                    # A descendant holding stdout open must not stall this indefinitely.
                    if reason == "cancelled" and time.monotonic() - exited_at < 1:
                        reason = None
                if not reason and time.monotonic() - started > task.timeout_seconds:
                    reason = "timeout"
                if reason:
                    break
                ready = selector.select(timeout=0.1)
                if not ready:
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    eof = True
                pending += chunk
                # Limit line size; never persist malformed/raw CLI output.
                if len(pending) > 1024 * 1024:
                    raise ValueError("Event too large")
                lines = pending.split(b"\n")
                pending = lines.pop()
                if eof and pending:
                    lines.append(pending)
                    pending = b""
                for line in lines:
                    if not line.strip():
                        continue
                    raw = json.loads(line)
                    kind = raw.get("type")
                    if kind == "thread.started":
                        ref = raw.get("thread_id", "")
                        if re.fullmatch(r"[A-Za-z0-9_-]{1,200}", ref):
                            on_event("run_reference", {"run_ref": ref})
                    elif kind == "turn.completed":
                        terminal = "completed"
                    elif kind in {"turn.failed", "error"}:
                        failure = True
                        on_event("progress", {"message": "执行器报告失败", "kind": kind})
                    elif kind in {"item.started", "item.completed"}:
                        item = raw.get("item", {})
                        item_type = item.get("type")
                        if item_type == "agent_message" and kind == "item.completed":
                            summary = safe_text(item.get("text", ""))
                            on_event("progress", {"message": summary, "kind": "agent_message"})
                        elif item_type == "command_execution":
                            on_event(
                                "progress",
                                {
                                    "kind": "command_execution",
                                    "phase": kind,
                                    "command": safe_text(item.get("command", "")),
                                    "exit_code": item.get("exit_code"),
                                    "output": safe_text(item.get("aggregated_output", "")),
                                },
                            )
                        elif item_type == "file_change" and kind == "item.completed":
                            for change in item.get("changes", []):
                                self._artifact(root, change, on_event)
            if not reason:
                # stdout EOF alone is not a terminal result; bound a hung parent as well.
                while process.poll() is None:
                    reason = should_stop()
                    if not reason and time.monotonic() - started > task.timeout_seconds:
                        reason = "timeout"
                    if reason:
                        break
                    time.sleep(0.05)
            if reason:
                return ExecutionResult(
                    "cancelled"
                    if reason == "cancelled"
                    else "interrupted"
                    if reason == "shutdown"
                    else "failed",
                    reason,
                )
            code = process.wait(timeout=2)
            if code == 0 and terminal == "completed" and not failure:
                return ExecutionResult("succeeded", summary=summary, exit_code=code)
            return ExecutionResult(
                "failed",
                "executor_failed" if failure or code else "missing_terminal_event",
                summary,
                code,
            )
        finally:
            selector.close()
            # Also terminate owned descendants after a normally exiting parent.
            try:
                self._stop(process)
            finally:
                process.stdout.close()

    def _stop(self, process):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        if process_group_exists(process.pid):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=2)
        deadline = time.monotonic() + 2
        while process_group_exists(process.pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        if process_group_exists(process.pid):
            raise RuntimeError("Cannot confirm owned process group stopped")

    def _artifact(self, root, change, on_event):
        path = (root / str(change.get("path", ""))).resolve()
        if not path.is_relative_to(root) or path == root:
            on_event("progress", {"message": "执行器返回的产物路径越出项目，已拒绝记录"})
            return
        digest = None
        if path.is_file() and path.stat().st_size <= 10 * 1024 * 1024:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        on_event(
            "artifact.created",
            {
                "path": str(path.relative_to(root)),
                "kind": str(change.get("kind", "update"))[:40],
                "sha256": digest,
            },
        )
