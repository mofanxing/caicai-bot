from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

TERMINAL = {"succeeded", "failed", "cancelled", "interrupted"}
ACTIVE = {"running", "waiting_confirmation", "cancelling"}
CAPABILITIES = {"filesystem.read", "filesystem.write", "process.exec", "progress", "cancel"}


class AgentDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: str
    name: str
    description: str
    executor_id: str
    input_schema: dict
    required_capabilities: frozenset[str]
    permissions: frozenset[str]


class PluginManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    contract_version: Literal[1]
    id: str
    version: str
    name: str
    description: str
    config_schema: dict
    agents: tuple[AgentDefinition, ...]


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    root: str = Field(min_length=1, max_length=4096)

    @field_validator("name", "root")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("不能为空")
        return value.strip()


class PluginUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=32)
    project_id: str = Field(min_length=1, max_length=32)
    agent_id: str = "caicai.coding/coding"
    goal: str = Field(min_length=1, max_length=16000)
    idempotency_key: str = Field(min_length=1, max_length=200)
    timeout_seconds: int = Field(default=600, ge=10, le=3600)

    @field_validator("goal", "idempotency_key")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("不能为空")
        return value.strip()


class InterruptionReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm_no_running_process: Literal[True]


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    root: str
    created_at: datetime


class TaskRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    conversation_id: str | None
    project_id: str
    project_root: str
    goal: str
    agent_id: str
    plugin_version: str
    status: str
    timeout_seconds: int
    result: str | None
    reason: str | None
    event_seq: int
    created_at: datetime
    updated_at: datetime


class AttemptRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    task_id: str
    number: int
    executor_id: str
    executor_version: str
    run_ref: str | None
    status: str
    exit_code: int | None
    reason: str | None
    started_at: datetime
    finished_at: datetime | None


class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    task_id: str
    attempt_id: str | None
    seq: int
    type: str
    payload: dict
    occurred_at: datetime


class ArtifactRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    attempt_id: str
    path: str
    kind: str
    sha256: str | None
