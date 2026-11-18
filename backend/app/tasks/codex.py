import os
import re
import shutil
import subprocess
from pathlib import Path

from app.core.errors import ServiceError
from app.tasks.contracts import CAPABILITIES
from app.tasks.process import ExecutionResult as ExecutionResult
from app.tasks.process import JsonProcessExecutor, project_root, safe_text
from app.tasks.process import process_group_exists as process_group_exists


class CodexExecutor(JsonProcessExecutor):
    id = "codex-cli"
    capabilities = frozenset(CAPABILITIES)
    limitations = [
        "workspace-write 限制写入，不提供仅能读取项目的隔离",
        "不支持交互确认、恢复执行及自定义 MCP / hooks",
        "可用性检查不代替认证后的真实任务与沙箱验收",
    ]

    @staticmethod
    def validate_project(value):
        root = project_root(value)
        for ancestor in (root, *root.parents):
            if ancestor != Path.home() and (ancestor / ".codex/config.toml").exists():
                raise ServiceError(
                    "project_config_unsupported", "首版暂不支持带 .codex/config.toml 的项目", 422
                )
        return root

    def projection(self, root, on_event):
        return CodexProjection(self, root, on_event)

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


class CodexProjection:
    completed = False
    failure = False
    summary = None

    def __init__(self, executor, root, on_event):
        self.executor, self.root, self.on_event = executor, root, on_event

    def accept(self, raw):
        kind = raw.get("type")
        if kind == "thread.started":
            ref = raw.get("thread_id", "")
            if re.fullmatch(r"[A-Za-z0-9_-]{1,200}", ref):
                self.on_event("run_reference", {"run_ref": ref})
        elif kind == "turn.completed":
            self.completed = True
        elif kind in {"turn.failed", "error"}:
            self.failure = True
            self.on_event("progress", {"message": "执行器报告失败", "kind": kind})
        elif kind in {"item.started", "item.completed"}:
            item = raw.get("item", {})
            item_type = item.get("type")
            if item_type == "agent_message" and kind == "item.completed":
                self.summary = safe_text(item.get("text", ""))
                self.on_event("progress", {"message": self.summary, "kind": "agent_message"})
            elif item_type == "command_execution":
                self.on_event(
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
                    self.executor._artifact(self.root, change, self.on_event)
