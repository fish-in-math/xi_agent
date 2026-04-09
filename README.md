# 硒产业智能体（Se Industry Agent）

一个简单的一体化应用：上传数据 → 自动生成可视化图表（Plotly） → 用 DeepSeek 做洞察建议 → 用 Coze 智能体生成行业报告。

说明：图表工作台中的“自定义改图”能力通过硅基流动 OpenAI 兼容接口调用多模态模型，默认使用 Qwen3.5-35B-A3B，可结合当前图像快照 + 用户指令生成新图。

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
- `VL_API_KEY` (可选): 可视化改图模型密钥
- `VL_API_BASE` (可选): 可视化改图模型接口 Base（默认 `https://api.siliconflow.cn/v1`）
- `VL_MODEL` (可选): 可视化改图模型名（默认 `Qwen/Qwen3.5-35B-A3B`）
- `VL_ENABLE_THINKING` (可选): 是否启用思考模式（默认 `false`，即即时模式）
- `VOLC_WEBSEARCH_API_KEY`: 火山联网搜索 API Key（Bearer）
- `VOLC_WEBSEARCH_API_URL` (可选): 联网搜索接口地址（默认 `https://open.feedcoopapi.com/search_api/web_search`）
- `VOLC_WEBSEARCH_SEARCH_TYPE` (可选): 搜索类型（默认 `web_summary`）
- `VOLC_WEBSEARCH_COUNT` (可选): 每次联网搜索条数（默认 `5`）
- `VOLC_WEBSEARCH_TIMEOUT` (可选): 联网搜索超时秒数（默认 `25`）

`.env` 示例：

```
COZE_API_TOKEN=xxxxxxxx
COZE_BOT_ID=xxxxxxxx
COZE_USER_ID=local_user
DEEPSEEK_API_KEY=ds_xxxxxxxx
DEEPSEEK_API_BASE=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-chat
VL_API_KEY=your_siliconflow_api_key
VL_API_BASE=https://api.siliconflow.cn/v1
VL_MODEL=Qwen/Qwen3.5-35B-A3B
VL_ENABLE_THINKING=false
VOLC_WEBSEARCH_API_KEY=your_api_key
VOLC_WEBSEARCH_API_URL=https://open.feedcoopapi.com/search_api/web_search
VOLC_WEBSEARCH_SEARCH_TYPE=web_summary
VOLC_WEBSEARCH_COUNT=your_number
VOLC_WEBSEARCH_TIMEOUT=25
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
