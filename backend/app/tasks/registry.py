from app.core.errors import ServiceError
from app.tasks.contracts import CAPABILITIES, PluginManifest

CODING_MANIFEST = {
    "contract_version": 1,
    "id": "caicai.coding",
    "version": "0.1.0",
    "name": "编程助手",
    "description": "在已登记项目中检查测试、修改代码和验证结果",
    "config_schema": {"type": "object", "additionalProperties": False, "properties": {}},
    "agents": [
        {
            "id": "coding",
            "name": "编程 Agent",
            "description": "使用 Codex 执行项目任务",
            "executor_id": "codex-cli",
            "input_schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["goal"],
                "properties": {"goal": {"type": "string", "minLength": 1}},
            },
            "required_capabilities": ["filesystem.read", "filesystem.write", "process.exec"],
            "permissions": ["project.read", "project.write", "project.execute"],
        }
    ],
}


class PluginRegistry:
    def __init__(self, executors):
        self.executors = executors
        self.plugins = {}
        self.agents = {}

    def register(self, declaration):
        manifest = PluginManifest.model_validate(declaration)
        if manifest.id in self.plugins or not manifest.agents:
            raise ValueError("Duplicate plugin or empty agent list")
        agents = {}
        for agent in manifest.agents:
            full_id = f"{manifest.id}/{agent.id}"
            executor = self.executors.get(agent.executor_id)
            # v1 deliberately supports only the typed goal input. Reject unknown schemas.
            if (
                full_id in agents
                or full_id in self.agents
                or not executor
                or not agent.required_capabilities <= CAPABILITIES
                or not agent.required_capabilities <= executor.capabilities
                or agent.permissions != {"project.read", "project.write", "project.execute"}
                or agent.input_schema != CODING_MANIFEST["agents"][0]["input_schema"]
                or manifest.config_schema != CODING_MANIFEST["config_schema"]
            ):
                raise ValueError("Unsupported agent schema, permissions or capabilities")
            agents[full_id] = (manifest, agent, executor)
        self.plugins[manifest.id] = manifest
        self.agents.update(agents)

    def resolve(self, agent_id):
        if agent_id not in self.agents:
            raise ServiceError("agent_not_found", "Agent 未注册", 404)
        return self.agents[agent_id]
