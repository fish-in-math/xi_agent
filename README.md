# 硒产业智能体（Se Industry Agent）

一个简单的一体化应用：上传数据 → 自动生成可视化图表（Plotly） → 用 DeepSeek 做洞察建议 → 用 Coze 智能体生成行业报告。

## 安装依赖

```bash
pip install -r requirements.txt
```

## 环境变量

在同目录创建 `.env` 文件（可参考下面示例）。

- `COZE_API_TOKEN`: Coze API Token
- `COZE_BOT_ID`: 你的 Coze 机器人 ID（适合硒产业分析）
- `COZE_API_BASE` (可选): Coze API Base（默认中国站）
- `DEEPSEEK_API_KEY`: DeepSeek API Key
- `DEEPSEEK_API_BASE` (可选): DeepSeek API Base（默认 `https://api.deepseek.com/v1`）
- `DEEPSEEK_MODEL` (可选): 模型名（默认 `deepseek-chat`）

`.env` 示例：

```
COZE_API_TOKEN=xxxxxxxx
COZE_BOT_ID=xxxxxxxx
COZE_USER_ID=local_user
DEEPSEEK_API_KEY=ds_xxxxxxxx
DEEPSEEK_API_BASE=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
```

## 本地运行（Windows）

```bash
# 启动 API 服务（FastAPI）
python -m uvicorn src.server:app --reload --port 8000
```

打开浏览器访问 `http://localhost:8000/`，上传 CSV 或 Excel 文件，即可看到图表与两段分析文本（DeepSeek、Coze）。

## 目录结构

- `src/server.py`: FastAPI 服务，汇总各项能力
- `src/charting.py`: 数据读取与基础图表生成（Plotly）
- `src/deepseek_client.py`: 调用 DeepSeek（OpenAI 兼容 API）
- `src/coze_service.py`: 调用 Coze 生成行业报告
- `src/frontend/`: 简单前端（Plotly.js + 原生 JS）
- `src/chat_cli.py`: 现有 Coze CLI 示例（可单独运行）

## 说明

- 若 DeepSeek 或 Coze 环境变量未配置，返回中会包含相应的不可用提示。
- 图表为自动生成的基础视图；可根据领域特征扩展成更专业的可视化与指标体系。
- 如果需要 React/Next.js 前端，也可以把接口保持不变，前端另建工程对接即可。
