"""Verified DeepSeek Harness headless NDJSON protocol versions."""

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path

import yaml

from app.core.errors import ServiceError
from app.tasks.contracts import CAPABILITIES
from app.tasks.process import JsonProcessExecutor, project_root, safe_text

BUNDLED_CLI = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
VERIFIED_VERSIONS = ("0.2.2-rc.3", "0.2.2-rc.5")
VERIFIED_VERSION_LABEL = " / ".join(VERIFIED_VERSIONS)


class DeepSeekExecutor(JsonProcessExecutor):
    id = "deepseek-harness"
    capabilities = frozenset(CAPABILITIES)
    limitations = [
        f"已核实 DeepSeek Harness {VERIFIED_VERSION_LABEL} 的 headless JSON 协议",
        "沿用 Harness 保存的模型与凭据；就绪检查不调用模型，不保证认证有效",
        "workspace-write 限制写入，不提供仅能读取项目的隔离",
        "无人值守审批策略为 never；不支持交互确认、暂停或自动恢复",
        "读取所选 profile 的模型选择，不加载该 profile 的 GUI 或第三方插件",
        "首版文件审计最多两万个文件、128 MiB；不审计大于 10 MiB 的文件内容",
    ]

    def __init__(self, settings):
        self.settings = settings
        self._overlay = None

    def binary(self):
        configured = self.settings.deepseek_binary
        binary = shutil.which(configured)
        if binary:
            return str(Path(binary).resolve())
        # An explicitly configured missing binary must not silently fall back.
        if configured == "dsh" and os.access(BUNDLED_CLI, os.X_OK):
            return BUNDLED_CLI
        return None

    def home(self):
        value = self.settings.deepseek_home or "~/.dsh"
        return Path(value).expanduser().resolve()

    def validate_project(self, value):
        root = project_root(value)
        try:
            git = subprocess.run(
                ["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                capture_output=True,
                timeout=5,
                env=self.environment(),
            )
            if git.returncode or Path(os.fsdecode(git.stdout).strip()).resolve() != root:
                raise ValueError("Not a Git project root")
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            raise ServiceError("deepseek_git_required", "请选择 Git 项目的根目录", 422) from exc
        return root

    def environment(self):
        allowed = {
            "HOME",
            "PATH",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "SYSTEMROOT",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "DSH_AGENTS_HOME",
        }
        env = {k: v for k, v in os.environ.items() if k in allowed}
        env["DSH_HOME"] = str(self.home())
        # Do not pass backend API/provider secrets or global permission overrides.
        return env

    def selection(self):
        """Read only public model identifiers; never import the desktop profile tree."""
        path = self.home() / "profiles" / self.settings.deepseek_model_profile / "cordis.patch.yml"
        try:
            if path.stat().st_size > 1024 * 1024:
                raise ValueError("Profile too large")
            patches = yaml.safe_load(path.read_text())
            rows = [
                p for p in patches if isinstance(p, dict) and p.get("id") == "agent-default-model"
            ]
            if len(rows) != 1 or rows[0].get("disabled"):
                raise ValueError("Select a model in the source profile first")
            config = rows[0]["config"]
            selection = {k: config[k] for k in ("provider", "model")}
            if "reasoningEffort" in config:
                selection["reasoningEffort"] = config["reasoningEffort"]
            if any(
                not isinstance(v, str) or not v.strip() or len(v) > 200 for v in selection.values()
            ):
                raise ValueError("Invalid model selection")
            # These are the shipped routes composed by the headless base.
            if selection["provider"] not in {"deepseek", "deepseek-account"}:
                raise ServiceError(
                    "deepseek_route_unsupported",
                    "当前适配器仅核实 Harness 内置 deepseek / deepseek-account 路由",
                    503,
                )
            return selection
        except (OSError, ValueError, TypeError, KeyError, yaml.YAMLError) as exc:
            raise ServiceError(
                "deepseek_model_not_configured",
                "请先在 DeepSeek Harness 所选 profile 中保存模型；检查 DEEPSEEK_HOME 和 "
                "DEEPSEEK_MODEL_PROFILE",
                503,
            ) from exc

    @contextmanager
    def overlay(self):
        patches = [
            {"id": name, "disabled": False}
            for name in ("credentials", "authorization", "deepseek-account")
        ]
        patches.append({"id": "agent-default-model", "config": self.selection()})
        # The file carries model identifiers only, and never modifies user profiles.
        with tempfile.TemporaryDirectory(prefix="caicai-dsh-") as directory:
            path = Path(directory) / "run.patch.yml"
            path.write_text(yaml.safe_dump(patches, allow_unicode=True))
            path.chmod(0o600)
            previous, self._overlay = self._overlay, path
            try:
                yield path
            finally:
                self._overlay = previous

    def check_availability(self):
        base = {
            "ready": False,
            "version": "unknown",
            "code": "deepseek_missing",
            "message": "找不到 DeepSeek Harness CLI，请配置 DEEPSEEK_BINARY",
        }
        binary = self.binary()
        if not binary:
            return base
        try:
            result = subprocess.run(
                [binary, "--version"], capture_output=True, timeout=5, env=self.environment()
            )
            version = result.stdout.decode(errors="replace").strip()
            if version:
                base["version"] = safe_text(version)[:200]
            if result.returncode or version not in VERIFIED_VERSIONS:
                return {
                    **base,
                    "code": "deepseek_version_unsupported",
                    "message": f"检测到 DeepSeek Harness {base['version']}；"
                    f"当前适配器已核实 {VERIFIED_VERSION_LABEL}，请更新菜菜适配器",
                }
            help_result = subprocess.run(
                [binary, "headless", "--help"],
                capture_output=True,
                timeout=5,
                env=self.environment(),
            )
            if help_result.returncode or not all(
                flag in help_result.stdout
                for flag in (b"--json", b"--permission-mode", b"--approval-policy")
            ):
                return {
                    **base,
                    "code": "deepseek_protocol_unsupported",
                    "message": "Harness CLI 缺少必要的 headless 参数",
                }
            selected = self.selection()
            return {
                **base,
                "ready": True,
                "code": "ready",
                "message": "Harness CLI 与模型选择已就绪；认证将在真实执行时验证",
                "model_selection": selected,
                "credential_source": "harness-managed",
            }
        except ServiceError as exc:
            return {**base, "code": exc.code, "message": exc.message}
        except (OSError, subprocess.TimeoutExpired):
            return {
                **base,
                "code": "deepseek_check_failed",
                "message": "Harness CLI 检查失败或超时",
            }

    def command(self, root):
        if self._overlay is None:
            raise RuntimeError("Missing per-run Harness overlay")
        return [
            self.binary(),
            "--profile",
            "headless",
            "--patch",
            str(self._overlay),
            "--json",
            "--permission-mode",
            "workspace-write",
            "--approval-policy",
            "never",
            "-",
        ]

    def projection(self, root, on_event):
        return DeepSeekProjection(root, on_event)

    def snapshot(self, root):
        """Record content hashes so pre-existing edits are not claimed as task changes."""
        files = subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
            ],
            capture_output=True,
            timeout=10,
            env=self.environment(),
        )
        if files.returncode or len(files.stdout) > 4 * 1024 * 1024:
            raise ServiceError("deepseek_git_required", "请选择可读取的 Git 项目根目录", 422)
        paths = set(os.fsdecode(p) for p in files.stdout.split(b"\0") if p)
        if len(paths) > 20000:
            raise ServiceError("deepseek_project_too_large", "首版验收项目最多支持两万个文件", 422)
        result = {}
        total = 0
        for name in sorted(paths):
            source = root / name
            path = source.resolve()
            if not path.is_relative_to(root) or source.is_symlink() or not path.is_file():
                continue
            size = path.stat().st_size
            if size > 10 * 1024 * 1024:
                continue
            total += size
            if total > 128 * 1024 * 1024:
                raise ServiceError("deepseek_project_too_large", "首版内容审计上限为 128 MiB", 422)
            result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        return result

    def run(self, task, on_started, on_event, should_stop):
        root = self.validate_project(task.project_root)
        if str(root) != task.project_root:
            raise ServiceError("project_changed", "登记项目目录已改变", 409)
        before = self.snapshot(root)
        on_event(
            "progress",
            {
                "kind": "executor_config",
                "model_selection": self.selection(),
                "message": "使用 Harness 已保存的模型与认证",
            },
        )
        with self.overlay():
            result = super().run(task, on_started, on_event, should_stop)
        after = self.snapshot(root)
        for name in sorted(before.keys() | after.keys()):
            if before.get(name) != after.get(name):
                on_event(
                    "artifact.created",
                    {
                        "path": name,
                        "kind": "add"
                        if name not in before
                        else "delete"
                        if name not in after
                        else "update",
                        "sha256": after.get(name),
                    },
                )
        return result


class DeepSeekProjection:
    def __init__(self, root, on_event):
        self.root, self.on_event = root, on_event
        self.session_id = None
        self.completed = False
        self.failure = False
        self.summary = None
        self.final_seen = False
        self.calls = {}

    def accept(self, raw):
        kind = raw.get("type")
        if self.final_seen:
            raise ValueError("Event after final")
        if kind == "session":
            ref = raw.get("sessionId")
            if (
                self.session_id is not None
                or not isinstance(ref, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", ref)
                or raw.get("cwd") != str(self.root)
            ):
                raise ValueError("Invalid Harness session identity")
            self.session_id = ref
            self.on_event("run_reference", {"run_ref": ref})
        elif kind == "error":
            self.failure = True
            # Raw errors can contain credentials, request bodies or remote URLs.
            self.on_event("progress", {"kind": "error", "message": "Harness 报告执行错误"})
        elif self.session_id is None:
            raise ValueError("Harness event before session")
        elif kind == "final":
            if raw.get("sessionId") != self.session_id or not isinstance(raw.get("text"), str):
                raise ValueError("Invalid Harness final identity")
            self.final_seen = True
            self.completed = isinstance(raw.get("reason"), dict) and (
                raw["reason"].get("kind") == "completed"
            )
            self.summary = safe_text(raw["text"])
            self.on_event("progress", {"kind": "agent_message", "message": self.summary})
        elif kind == "status":
            self.on_event("progress", {"kind": "status", "phase": safe_text(raw.get("phase", ""))})
        elif kind == "text":
            self.on_event(
                "progress", {"kind": "agent_message", "message": safe_text(raw.get("text", ""))}
            )
        elif kind == "tool_call":
            call_id, tool, args = raw.get("callId"), raw.get("tool"), raw.get("input")
            if not isinstance(call_id, str) or not isinstance(tool, str):
                raise ValueError("Invalid Harness tool call")
            if len(self.calls) >= 10000:
                raise ValueError("Too many tool calls")
            command = args.get("command") if isinstance(args, dict) else None
            payload = {
                "kind": "tool_call",
                "tool": safe_text(tool),
                "call_id": safe_text(call_id),
                "phase": "started",
            }
            if isinstance(command, str):
                payload["command"] = safe_text(command)
            self.calls[call_id] = payload
            self.on_event("progress", payload)
        elif kind == "tool_result":
            call_id = raw.get("callId")
            if not isinstance(call_id, str):
                raise ValueError("Invalid Harness tool result")
            payload = {
                **self.calls.pop(call_id, {}),
                "kind": "tool_result",
                "call_id": safe_text(call_id),
                "phase": safe_text(raw.get("status", "")),
                "output": safe_text(raw.get("result", "")),
            }
            # Shell exit codes are evidence only when the tool actually reports one.
            match = (
                re.search(r"(?:^|\n)\[exit code: (-?\d+)\]\s*$", str(raw.get("result", "")))
                if payload.get("tool") == "bash"
                else None
            )
            if match:
                payload["exit_code"] = int(match[1])
            error = raw.get("error")
            if isinstance(error, dict) and isinstance(error.get("code"), str):
                payload["error_code"] = safe_text(error["code"])
            self.on_event("progress", payload)
        # Deliberately omit thinking and unknown future event fields from storage.
