const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "xi_agent_chat_sessions_v1";
const WEB_SEARCH_TOGGLE_KEY = "xi_agent_web_search_toggle_v1";
const DEFAULT_ASSISTANT_GREETING = "你好，我是硒产业智能助手。你可以直接开始自由提问。";
const WORKBENCH_EXPORT_FILENAME = "xi-agent-chart";

// 全局拦截所有 A 标签点击事件，强制在新标签页打开（防止覆盖当前系统）
document.addEventListener('click', function(e) {
    const link = e.target.closest('a');
    if (link && link.href) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
    }
});

if (window.marked) {
    window.marked.use({
        renderer: {
            link(href, title, text) {
                const targetText = ' target="_blank" rel="noopener noreferrer"';
                let out = '<a href="' + href + '"' + targetText;
                if (title) out += ' title="' + title + '"';
                out += '>' + text + '</a>';
                return out;
            }
        }
    });
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load: ${src}`));
        document.head.appendChild(s);
    });
}

async function ensurePlotly() {
    if (window.Plotly) return;
    try {
        await loadScript("https://cdn.plot.ly/plotly-2.29.1.min.js");
    } catch {
        await loadScript("https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.29.1/plotly.min.js");
    }
    if (!window.Plotly) throw new Error("Plotly 加载失败，请检查网络或 CDN 访问");
}

const API_BASE = "";

const BASE_LAYOUT = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#334155", family: "Noto Sans SC, PingFang SC, Microsoft YaHei" },
    margin: { l: 40, r: 20, t: 50, b: 40, pad: 4 },
    xaxis: { gridcolor: "#f1f5f9", zeroline: false, linecolor: "#cbd5e1" },
    yaxis: { gridcolor: "#f1f5f9", zeroline: false, linecolor: "#cbd5e1" },
    legend: { bgcolor: "rgba(255,255,255,0.8)", bordercolor: "#e2e8f0", borderwidth: 1 },
    hoverlabel: { bgcolor: "#ffffff", bordercolor: "#2dd4bf", font: { color: "#1e293b" } },
};

const BASE_CONFIG = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["select2d", "lasso2d", "zoomIn2d", "zoomOut2d", "resetScale2d"],
};

function getChartViewportSize(chartEl) {
    const rect = chartEl ? chartEl.getBoundingClientRect() : { width: 0, height: 0 };
    const width = Math.max(640, Math.floor(chartEl?.clientWidth || rect.width || 900));
    const height = Math.max(420, Math.floor(chartEl?.clientHeight || rect.height || 520));
    return { width, height };
}

function buildWorkbenchPlotConfig(chartEl) {
    const { width, height } = getChartViewportSize(chartEl);
    return {
        ...BASE_CONFIG,
        toImageButtonOptions: {
            format: "png",
            filename: WORKBENCH_EXPORT_FILENAME,
            width,
            height,
            scale: 2,
        },
    };
}

function isTransparentColor(color) {
    if (!color) return true;
    const normalized = String(color).trim().toLowerCase().replace(/\s+/g, "");
    if (normalized === "transparent") return true;
    if (normalized === "rgba(0,0,0,0)") return true;
    const rgbaMatch = normalized.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
    if (!rgbaMatch) return false;
    const alpha = Number(rgbaMatch[4]);
    return !Number.isNaN(alpha) && alpha <= 0.01;
}

function pickOpaqueExportBackground(chartEl) {
    // 强制导出背景为纯白，防止有些查看器对透明背景PNG默认填充黑色底
    return "#ffffff";
}

function getExportBackgroundPatch(chartEl) {
    const layout = chartEl?.layout || {};
    const patch = {};
    if (isTransparentColor(layout.paper_bgcolor)) {
        patch.paper_bgcolor = pickOpaqueExportBackground(chartEl);
    }
    if (isTransparentColor(layout.plot_bgcolor)) {
        patch.plot_bgcolor = pickOpaqueExportBackground(chartEl);
    }
    return patch;
}

async function exportPlotWithOpaqueBackground(chartEl, options) {
    const patch = getExportBackgroundPatch(chartEl);
    const needsPatch = Object.keys(patch).length > 0;
    const prevLayout = {
        paper_bgcolor: chartEl?.layout?.paper_bgcolor,
        plot_bgcolor: chartEl?.layout?.plot_bgcolor,
    };

    try {
        if (needsPatch) {
            await Plotly.relayout(chartEl, patch);
        }
        await Plotly.downloadImage(chartEl, options);
    } finally {
        if (needsPatch) {
            await Plotly.relayout(chartEl, {
                paper_bgcolor: prevLayout.paper_bgcolor ?? "rgba(0,0,0,0)",
                plot_bgcolor: prevLayout.plot_bgcolor ?? "rgba(0,0,0,0)",
            });
        }
    }
}

function normalizeFigureLayout(rawLayout = {}, figData = []) {
    const annotations = Array.isArray(rawLayout.annotations) ? rawLayout.annotations : [];
    const baseMargin = { ...BASE_LAYOUT.margin, ...(rawLayout.margin || {}) };
    const extraTopMargin = annotations.length > 1 ? Math.min(40, annotations.length * 6) : 0;

    const margin = {
        ...baseMargin,
        l: Math.max(56, baseMargin.l || 0),
        r: Math.max(28, baseMargin.r || 0),
        b: Math.max(58, baseMargin.b || 0),
        t: Math.max(72 + extraTopMargin, baseMargin.t || 0),
    };

    const legend = { ...BASE_LAYOUT.legend, ...(rawLayout.legend || {}) };
    if (Array.isArray(figData) && figData.length > 8 && !legend.orientation) {
        legend.orientation = "h";
        legend.x = 0;
        legend.y = 1.16;
    }

    const layout = {
        ...BASE_LAYOUT,
        ...(rawLayout || {}),
        autosize: true,
        margin,
        legend,
    };

    Object.keys(layout).forEach((key) => {
        if (!/^xaxis\d*$/.test(key) && !/^yaxis\d*$/.test(key)) return;
        const axis = layout[key] || {};
        const axisTitle = axis.title;
        layout[key] = {
            ...axis,
            automargin: axis.automargin !== false,
            title:
                axisTitle && typeof axisTitle === "object"
                    ? { ...axisTitle, standoff: axisTitle.standoff ?? 8 }
                    : axisTitle,
        };
    });

    return layout;
}

function estimateSubplotGrid(rawLayout = {}) {
    const yAxisKeys = Object.keys(rawLayout).filter((key) => /^yaxis\d*$/.test(key));
    const xAxisKeys = Object.keys(rawLayout).filter((key) => /^xaxis\d*$/.test(key));
    const yAxisCount = Math.max(1, yAxisKeys.length);
    const xAxisCount = Math.max(1, xAxisKeys.length);
    const subplotsCount = Math.max(yAxisCount, xAxisCount, 1);

    const domainRowKeys = new Set();
    yAxisKeys.forEach((key) => {
        const axis = rawLayout[key] || {};
        if (!Array.isArray(axis.domain) || axis.domain.length !== 2) return;
        const rowKey = axis.domain.map((v) => Number(v).toFixed(4)).join("-");
        domainRowKeys.add(rowKey);
    });

    let rows = domainRowKeys.size;
    if (!rows && rawLayout.grid && Number.isFinite(rawLayout.grid.rows)) {
        rows = Math.max(1, Math.floor(rawLayout.grid.rows));
    }
    if (!rows) {
        rows = subplotsCount > 1 ? Math.ceil(subplotsCount / 2) : 1;
    }

    let cols = rawLayout.grid && Number.isFinite(rawLayout.grid.columns)
        ? Math.max(1, Math.floor(rawLayout.grid.columns))
        : Math.max(1, Math.ceil(subplotsCount / rows));

    return { rows, cols, subplotsCount };
}

async function renderFigureToWorkbench(chartEl, fig) {
    if (!chartEl) throw new Error("工作台图表容器不存在");
    const safeFig = fig || {};
    const rawLayout = safeFig.layout || {};
    const viewportEl = $("workbenchViewport");
    const { rows, cols, subplotsCount } = estimateSubplotGrid(rawLayout);

    const rowBasedHeight = rows > 1 ? rows * 360 + 140 : 520;
    const providedHeight = Number(rawLayout.height) || 0;
    const chartHeight = Math.max(520, rowBasedHeight, providedHeight);
    const chartMinWidth = cols >= 3 ? 1100 : cols === 2 ? 860 : 640;

    chartEl.style.height = `${chartHeight}px`;
    chartEl.style.minWidth = `${chartMinWidth}px`;

    const layout = normalizeFigureLayout(rawLayout, safeFig.data || []);
    layout.height = chartHeight;
    const config = buildWorkbenchPlotConfig(chartEl);
    await Plotly.newPlot(chartEl, safeFig.data || [], layout, config);
    if (!chartEl.__exportBackgroundHandlersBound) {
        chartEl.on("plotly_beforeexport", () => {
            const patch = getExportBackgroundPatch(chartEl);
            if (Object.keys(patch).length === 0) {
                chartEl.__exportBackgroundRestore = null;
                return undefined;
            }
            chartEl.__exportBackgroundRestore = {
                paper_bgcolor: chartEl.layout?.paper_bgcolor,
                plot_bgcolor: chartEl.layout?.plot_bgcolor,
            };
            return Plotly.relayout(chartEl, patch);
        });

        chartEl.on("plotly_afterexport", () => {
            const restore = chartEl.__exportBackgroundRestore;
            if (!restore) return undefined;
            chartEl.__exportBackgroundRestore = null;
            return Plotly.relayout(chartEl, {
                paper_bgcolor: restore.paper_bgcolor ?? "rgba(0,0,0,0)",
                plot_bgcolor: restore.plot_bgcolor ?? "rgba(0,0,0,0)",
            });
        });

        chartEl.__exportBackgroundHandlersBound = true;
    }

    if (viewportEl) {
        viewportEl.scrollTop = 0;
        viewportEl.scrollLeft = 0;
    }

    await Plotly.Plots.resize(chartEl);
}

function resizeWorkbenchChart() {
    const chartEl = $("workbenchChart");
    if (!chartEl || !window.Plotly || !Array.isArray(chartEl.data) || chartEl.data.length === 0) return;
    Plotly.Plots.resize(chartEl);
}

function setChartExportButtonVisible(visible) {
    const btn = $("exportChartBtn");
    if (!btn) return;
    btn.style.display = visible ? "inline-flex" : "none";
}

function exportWorkbenchChartImage() {
    const chartEl = $("workbenchChart");
    const statusEl = $("vizStatus");
    if (!chartEl || !window.Plotly || !Array.isArray(chartEl.data) || chartEl.data.length === 0) {
        if (statusEl) statusEl.textContent = "请先生成图表，再导出图片。";
        return;
    }

    const { width, height } = getChartViewportSize(chartEl);
    exportPlotWithOpaqueBackground(chartEl, {
        format: "png",
        filename: `${WORKBENCH_EXPORT_FILENAME}-${Date.now()}`,
        width,
        height,
        scale: 2,
    })
        .then(() => {
            if (statusEl) statusEl.textContent = "已按当前显示比例导出 PNG 图表。";
        })
        .catch((err) => {
            if (statusEl) statusEl.textContent = `导出失败：${err?.message || err}`;
        });
}

let analysisContextHint = "";
let sessions = [];
let activeSessionId = "";
let latestAnalysisResult = null;
let currentCenterView = "report";

const PRESET_LABELS = {
    bar: "柱状图",
    line: "折线图",
    scatter: "散点图",
    histogram: "直方图",
    box: "箱线图",
    pie: "饼图",
};

function uid() {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function makeSession(title = "新对话") {
    return {
        id: uid(),
        title,
        createdAt: Date.now(),
        messages: [
            {
                role: "assistant",
                content: DEFAULT_ASSISTANT_GREETING,
            },
        ],
    };
}

function loadSessions() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            sessions = [makeSession()];
            activeSessionId = sessions[0].id;
            return;
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) {
            sessions = [makeSession()];
            activeSessionId = sessions[0].id;
            return;
        }
        sessions = parsed;
        activeSessionId = sessions[0].id;
    } catch {
        sessions = [makeSession()];
        activeSessionId = sessions[0].id;
    }
}

function saveSessions() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

function getActiveSession() {
    return sessions.find((s) => s.id === activeSessionId) || sessions[0];
}

function shorten(text, n = 20) {
    if (!text) return "新对话";
    return text.length <= n ? text : `${text.slice(0, n)}...`;
}

function renderHistoryList() {
    const list = $("historyList");
    if (!list) return;
    list.innerHTML = "";
    sessions.forEach((s) => {
        const li = document.createElement("li");
        li.className = `history-item${s.id === activeSessionId ? " active" : ""}`;
        li.title = s.title || "新对话";

        const titleSpan = document.createElement("span");
        titleSpan.className = "session-title";
        titleSpan.textContent = s.title || "新对话";
        li.appendChild(titleSpan);

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "delete-btn";
        deleteBtn.innerHTML = "×";
        deleteBtn.title = "删除";
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deleteSession(s.id);
        });
        li.appendChild(deleteBtn);

        li.addEventListener("click", () => {
            activeSessionId = s.id;
            renderHistoryList();
            renderMessages();
        });
        list.appendChild(li);
    });
}

function deleteSession(id) {
    if (sessions.length === 1) {
        sessions[0] = makeSession();
        activeSessionId = sessions[0].id;
    } else {
        sessions = sessions.filter(s => s.id !== id);
        if (activeSessionId === id) {
            activeSessionId = sessions[0].id;
        }
    }
    saveSessions();
    renderHistoryList();
    renderMessages();
}

function renderMessages() {
    const box = $("chatMessages");
    const active = getActiveSession();
    if (!box || !active) return;
    box.innerHTML = "";
    active.messages.forEach((m) => {
        const row = document.createElement("div");
        row.className = `msg-wrapper ${m.role}`;
        
        const avatar = document.createElement("div");
        avatar.className = "avatar";
        avatar.textContent = m.role === "assistant" ? "🤖" : "👤";
        
        const contentWrapper = document.createElement("div");
        contentWrapper.className = "msg-content-wrapper";

        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";

        if (m.role === "assistant") {
            bubble.innerHTML = window.marked ? marked.parse(m.content || "") : m.content;
        } else {
            bubble.textContent = m.content || "";
        }

        contentWrapper.appendChild(bubble);

        const actionsArea = document.createElement("div");
        actionsArea.className = "msg-actions-area";

        const copyMsgBtn = document.createElement("button");
        copyMsgBtn.className = "msg-action-btn copy-btn";
        copyMsgBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>复制</span>
        `;
        copyMsgBtn.title = "复制此记录";
        copyMsgBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(m.content || "").then(() => {
                const span = copyMsgBtn.querySelector("span");
                if (span) span.textContent = "已复制";
                setTimeout(() => { if (span) span.textContent = "复制"; }, 2000);
            });
        });

        const deleteMsgBtn = document.createElement("button");
        deleteMsgBtn.className = "msg-action-btn delete-btn";
        deleteMsgBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            <span>删除</span>
        `;
        deleteMsgBtn.title = "删除此记录";
        deleteMsgBtn.addEventListener("click", () => {
            active.messages = active.messages.filter(msg => msg !== m);
            saveSessions();
            renderMessages();
        });

        actionsArea.appendChild(copyMsgBtn);
        actionsArea.appendChild(deleteMsgBtn);
        contentWrapper.appendChild(actionsArea);

        row.appendChild(avatar);
        row.appendChild(contentWrapper);
        box.appendChild(row);
    });
    box.scrollTo({
        top: box.scrollHeight,
        behavior: 'smooth'
    });
}

function appendMessage(role, content) {
    const active = getActiveSession();
    if (!active) return;
    active.messages.push({ role, content });
    if (role === "user" && active.title === "新对话") {
        active.title = shorten(content);
    }
    saveSessions();
    renderHistoryList();
    renderMessages();
}

function createNewChat() {
    const s = makeSession();
    sessions.unshift(s);
    activeSessionId = s.id;
    saveSessions();
    renderHistoryList();
    renderMessages();
}

function clearCurrentChatMessages() {
    const active = getActiveSession();
    if (!active) return;

    const shouldClear = window.confirm("确认清空当前会话窗口中的对话内容吗？");
    if (!shouldClear) return;

    if (currentChatAbortController) {
        currentChatAbortController.abort();
    }

    active.messages = [{ role: "assistant", content: DEFAULT_ASSISTANT_GREETING }];
    active.title = "新对话";
    saveSessions();
    renderHistoryList();
    renderMessages();

    if ($("chatStatus")) {
        $("chatStatus").textContent = "当前对话已清空";
    }
}

let currentChatAbortController = null;

function getWebSearchEnabled() {
    return $("webSearchToggleBtn")?.dataset.enabled === "1";
}

function renderWebSearchToggle(enabled) {
    const btn = $("webSearchToggleBtn");
    if (!btn) return;
    btn.dataset.enabled = enabled ? "1" : "0";
    btn.classList.toggle("is-active", enabled);
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
}

function initWebSearchToggle() {
    const toggleBtn = $("webSearchToggleBtn");
    if (!toggleBtn) return;

    let enabled = false;

    try {
        enabled = localStorage.getItem(WEB_SEARCH_TOGGLE_KEY) === "1";
    } catch {
        enabled = false;
    }
    renderWebSearchToggle(enabled);

    toggleBtn.addEventListener("click", () => {
        const next = !getWebSearchEnabled();
        renderWebSearchToggle(next);
        try {
            localStorage.setItem(WEB_SEARCH_TOGGLE_KEY, next ? "1" : "0");
        } catch {
            // ignore localStorage failure
        }
        if ($("chatStatus")) {
            $("chatStatus").textContent = next ? "已开启联网搜索" : "已关闭联网搜索";
        }
    });
}

async function sendChatMessage() {
    const input = $("chatInput");
    const chatStatus = $("chatStatus");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    appendMessage("user", text);
    input.value = "";
    const webSearchEnabled = getWebSearchEnabled();
    chatStatus.textContent = webSearchEnabled
        ? "正在联网检索并思考..."
        : "正在思考...";

    if ($("stopChatBtn")) {
        $("stopChatBtn").style.display = "inline-block";
        $("stopChatBtn").onclick = () => {
            if (currentChatAbortController) {
                currentChatAbortController.abort();
            }
        };
    }
    if ($("sendChatBtn")) $("sendChatBtn").style.display = "none";

    const active = getActiveSession();
    const history = (active.messages || []).filter((m) => m.role === "user" || m.role === "assistant");
    if (history.length > 0) {
        const last = history[history.length - 1];
        if (last.role === "user" && String(last.content || "").trim() === text) {
            history.pop();
        }
    }

    const msgIndex = active.messages.length;
    active.messages.push({ role: "assistant", content: "" });
    renderMessages();
    const box = $("chatMessages");
    const lastWrapper = box.lastElementChild;
    const bubble = lastWrapper ? lastWrapper.querySelector(".msg-bubble") : null;

    try {
        currentChatAbortController = new AbortController();
        const res = await fetch(`${API_BASE}/chat_stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: currentChatAbortController.signal,
            body: JSON.stringify({
                message: text,
                history,
                context_hint: analysisContextHint || undefined,
                web_search_enabled: webSearchEnabled,
            }),
        });
        if (!res.ok) throw new Error(await res.text());

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) {
                fullText += chunk;
                const targetMessage = active.messages[msgIndex];
                if (!targetMessage) break;
                targetMessage.content = fullText;
                const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 50;
                if (bubble) {
                    bubble.innerHTML = window.marked ? marked.parse(fullText) : fullText;
                }
                if (box && isNearBottom) box.scrollTop = box.scrollHeight;
            }
        }

        saveSessions();
        chatStatus.textContent = "";
    } catch (err) {
        if (err.name === 'AbortError') {
            chatStatus.textContent = "已停止输出";
        } else {
            const targetMessage = active.messages[msgIndex];
            if (targetMessage) {
                targetMessage.content += `\n[请求失败：${err}]`;
                if (bubble) bubble.textContent = targetMessage.content;
            } else {
                appendMessage("assistant", `[请求失败：${err}]`);
            }
            chatStatus.textContent = "发送失败";
        }
        saveSessions();
    } finally {
        currentChatAbortController = null;
        if ($("stopChatBtn")) $("stopChatBtn").style.display = "none";
        if ($("sendChatBtn")) $("sendChatBtn").style.display = "inline-block";
    }
}

function bindChatEvents() {
    if ($("sendChatBtn")) {
        $("sendChatBtn").addEventListener("click", sendChatMessage);
    }
    if ($("chatInput")) {
        $("chatInput").addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }
    if ($("newChatBtn")) {
        $("newChatBtn").addEventListener("click", createNewChat);
    }
    if ($("historyToggle")) {
        $("historyToggle").addEventListener("click", () => {
            const layout = $("appLayout");
            if (!layout) return;
            layout.classList.toggle("history-collapsed");
            $("historyToggle").textContent = layout.classList.contains("history-collapsed") ? "展开记录栏" : "折叠记录栏";
            setTimeout(resizeWorkbenchChart, 220);
        });
    }
    if ($("clearCurrentChatBtn")) {
        $("clearCurrentChatBtn").addEventListener("click", clearCurrentChatMessages);
    }
}

function setCenterView(view) {
    const report = $("reportContainer");
    const workbench = $("workbenchContainer");
    const startVizBtn = $("startVizBtn");
    const backToReportTopBtn = $("backToReportTopBtn");
    const exportBtn = $("exportPdfBtn");
    if (!report || !workbench) return;

    currentCenterView = view;
    const onWorkbench = view === "workbench";

    report.classList.toggle("hidden", onWorkbench);
    workbench.classList.toggle("hidden", !onWorkbench);

    if (onWorkbench) {
        setTimeout(resizeWorkbenchChart, 100);
    }

    if (startVizBtn) {
        startVizBtn.style.display = onWorkbench ? "none" : "inline-flex";
    }
    if (backToReportTopBtn) {
        backToReportTopBtn.style.display = onWorkbench ? "inline-flex" : "none";
    }
    if (exportBtn) {
        const shouldShowExport = !onWorkbench && !!latestAnalysisResult;
        exportBtn.style.display = shouldShowExport ? "inline-flex" : "none";
    }
}

function bindCenterViewEvents() {
    if ($("startVizBtn")) {
        $("startVizBtn").addEventListener("click", () => {
            setCenterView("workbench");
            if ($("vizStatus") && !$("fileInput")?.files?.[0]) {
                $("vizStatus").textContent = "提示：请先选择数据文件，再点击图表模板生成图。";
            }
        });
    }

    if ($("backToReportTopBtn")) {
        $("backToReportTopBtn").addEventListener("click", () => setCenterView("report"));
    }
}

function getLatestChatStyleHint() {
    const active = getActiveSession();
    if (!active || !Array.isArray(active.messages)) return "";

    const stylePattern = /样式|风格|配色|颜色|深色|浅色|极简|简约|冷色|暖色|线条|透明|高对比/i;
    for (let i = active.messages.length - 1; i >= 0; i--) {
        const msg = active.messages[i];
        if (msg.role !== "user") continue;
        const content = (msg.content || "").trim();
        if (!content) continue;
        if (stylePattern.test(content)) {
            return content;
        }
    }
    return "";
}

function bindWorkbenchEvents() {
    const presetButtons = document.querySelectorAll(".preset-btn");
    presetButtons.forEach((btn) => {
        btn.addEventListener("click", async () => {
            const preset = btn.getAttribute("data-preset") || "";
            await generatePresetChart(preset);
        });
    });

    const vizChatInput = $("vizChatInput");
    const btnVizChatSend = $("btnVizChatSend");

    if (btnVizChatSend && vizChatInput) {
        btnVizChatSend.addEventListener("click", () => {
            handleVizChatInput(vizChatInput.value.trim());
        });
        
        vizChatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleVizChatInput(vizChatInput.value.trim());
            }
        });
    }

    if ($("exportChartBtn")) {
        $("exportChartBtn").addEventListener("click", exportWorkbenchChartImage);
    }
}

async function handleVizChatInput(chatText) {
    if (!chatText) return;
    const file = $("fileInput")?.files?.[0];
    const statusEl = $("vizStatus");
    const chartEl = $("workbenchChart");
    const metaEl = $("vizMeta");
    
    if (!file) {
        alert("请先在最上方选择要分析的本地数据文件！");
        if (statusEl) statusEl.textContent = "请先在上方选择数据文件。";
        return;
    }
    if (statusEl) statusEl.textContent = "正由大模型动态推断和编写代码...";
    
    // UI state update
    const btnVizChatSend = $("btnVizChatSend");
    if (btnVizChatSend) {
        btnVizChatSend.textContent = "生成中...";
        btnVizChatSend.disabled = true;
    }

    try {
        await ensurePlotly();
        const form = new FormData();
        form.append("file", file);
        form.append("prompt", chatText);

        const res = await fetch(`${API_BASE}/visualize_custom`, {
            method: "POST",
            body: form,
        });
        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        const fig = data.figure || {};

        await renderFigureToWorkbench(chartEl, fig);
        setChartExportButtonVisible(true);

        const meta = data.meta || {};
        if (metaEl) {
            metaEl.style.display = "block";
            metaEl.innerHTML = [
                `模式：AI动态代码生成图表`,
                `类型：自定义 (${chatText.slice(0, 15)}...)`,
                `后台生成代码：<details><summary>点击查看</summary><pre style="font-size:12px;margin:4px 0;background:#f8fafc;padding:8px;border-radius:4px;overflow-x:auto;">${data.code || ""}</pre></details>`
            ].join("<br>");
        }

        if (statusEl) statusEl.textContent = "已根据提示词通过 AI 构图成功。";
    } catch (e) {
        if (statusEl) statusEl.textContent = `AI 动态生成失败：${e.message || e}`;
    } finally {
        if (btnVizChatSend) {
            btnVizChatSend.textContent = "生成";
            btnVizChatSend.disabled = false;
        }
    }
}

async function generatePresetChart(preset) {
    const file = $("fileInput")?.files?.[0];
    const statusEl = $("vizStatus");
    const chartEl = $("workbenchChart");
    const metaEl = $("vizMeta");

    if (!file) {
        if (statusEl) statusEl.textContent = "请先在上方选择数据文件。";
        return;
    }

    try {
        await ensurePlotly();
    } catch (e) {
        if (statusEl) statusEl.textContent = `出错：${e.message}`;
        return;
    }

    const manualStyle = $("vizStyleInput") ? $("vizStyleInput").value.trim() : "";
    const chatStyle = getLatestChatStyleHint();
    const styleHint = manualStyle || chatStyle;
    const styleSource = manualStyle ? "输入框" : (chatStyle ? "最近对话" : "默认主题");

    const form = new FormData();
    form.append("file", file);
    form.append("preset", preset);
    if (styleHint) form.append("style_hint", styleHint);

    if (statusEl) statusEl.textContent = `正在生成${PRESET_LABELS[preset] || preset}...`;

    try {
        const res = await fetch(`${API_BASE}/visualize_preset`, {
            method: "POST",
            body: form,
        });
        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        const fig = data.figure || {};

        await renderFigureToWorkbench(chartEl, fig);
        setChartExportButtonVisible(true);

        const meta = data.meta || {};
        const appliedStyle = Array.isArray(meta.applied_style) ? meta.applied_style.join("、") : "默认主题";
        if (metaEl) {
            metaEl.style.display = "block";
            metaEl.innerHTML = [
                `模板：${meta.preset || PRESET_LABELS[preset] || preset}`,
                `字段：X=${meta.x || "-"}，Y=${meta.y || "-"}`,
                `样式来源：${styleSource}`,
                `已应用样式：${appliedStyle}`,
            ].join("<br>");
        }

        if (statusEl) statusEl.textContent = "图表已生成，可继续在对话中提样式要求后重新点击模板更新。";
    } catch (err) {
        console.error(err);
        if (statusEl) statusEl.textContent = `生成失败：${err.message || err}`;
    }
}

function initializeChat() {
    loadSessions();
    renderHistoryList();
    renderMessages();
    initWebSearchToggle();
    bindChatEvents();
}

initializeChat();
bindCenterViewEvents();
bindWorkbenchEvents();
setCenterView("report");

$("analyzeBtn").addEventListener("click", async () => {
    const file = $("fileInput").files[0];
    const prompt = $("promptInput") ? $("promptInput").value.trim() : "";
    if (!file) {
        $("status").textContent = "请选择数据文件";
        return;
    }
    $("status").textContent = "正在上传与分析…";

    try {
        await ensurePlotly();
    } catch (e) {
        console.error(e);
        $("status").textContent = `出错：${e.message}`;
        return;
    }

    const form = new FormData();
    form.append("file", file);
    if (prompt) form.append("prompt", prompt);

    try {
        const res = await fetch(`${API_BASE}/analyze`, {
            method: "POST",
            body: form,
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        $("status").textContent = "分析完成";
        analysisContextHint = `用户分析需求：${prompt || "无"}\n数据摘要：${JSON.stringify(data.summary)}`;

        $("summary").textContent = JSON.stringify(data.summary, null, 2);

        const deepText = [data.deepseek_suggestions, "\n\n", data.deepseek_analysis].join("");
        $("deepseekText").innerHTML = marked.parse(deepText);
        $("cozeText").innerHTML = marked.parse(data.coze_report);

        latestAnalysisResult = {
            summary: data.summary || null,
            deepseekMarkdown: deepText || "",
            cozeMarkdown: data.coze_report || "",
        };

        appendMessage("assistant", "数据分析已完成。你可以继续在上方自由提问，我会结合最新分析结果回答。");
        setCenterView(currentCenterView);
    } catch (err) {
        console.error(err);
        $("status").textContent = `出错：${err}`;
    }
});

function buildReportMarkdown(payload) {
    const now = new Date().toLocaleString("zh-CN", { hour12: false });

    const lines = [
        "# 硒产业分析报告",
        `生成时间：${now}`,
        "",
        "## 深度分析建议 (DeepSeek)",
        payload?.deepseekMarkdown?.trim() || "暂无内容",
        "",
        "## 行业报告 (Coze)",
        payload?.cozeMarkdown?.trim() || "暂无内容",
    ];

    return lines.join("\n");
}

function removeScriptTags(html) {
    return String(html || "").replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
}

function buildPrintDocumentStyle() {
    return `
        @page {
            size: A4;
            margin: 14mm 12mm 16mm;
        }

        * {
            box-sizing: border-box;
        }

        html, body {
            margin: 0;
            padding: 0;
            color: #111827;
            background: #ffffff;
            font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
            font-size: 12pt;
            line-height: 1.7;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }

        .report {
            width: 100%;
            max-width: none;
            margin: 0;
            padding: 0;
        }

        h1, h2, h3 {
            color: #0f172a;
            line-height: 1.4;
            page-break-after: avoid;
            break-after: avoid;
            page-break-inside: avoid;
            break-inside: avoid;
            margin: 0.5em 0 0.35em;
        }

        p, li {
            page-break-inside: auto;
            break-inside: auto;
            margin: 0.2em 0;
            orphans: 3;
            widows: 3;
        }

        table, pre, blockquote {
            page-break-inside: avoid;
            break-inside: avoid;
        }

        pre {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            word-break: break-word;
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            padding: 10px 12px;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 8px 0;
        }

        th, td {
            border: 1px solid #cbd5e1;
            padding: 6px 8px;
            vertical-align: top;
            overflow-wrap: anywhere;
            word-break: break-word;
        }

        img {
            max-width: 100%;
            height: auto;
            page-break-inside: avoid;
            break-inside: avoid;
        }
    `;
}

function buildPrintDocumentHtml(renderedHtml) {
    const style = buildPrintDocumentStyle();
    const safeHtml = removeScriptTags(renderedHtml);
    return `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>硒产业分析报告</title>
    <style>${style}</style>
</head>
<body>
    <article class="report">${safeHtml}</article>
    <script>
        window.addEventListener("load", function () {
            setTimeout(function () {
                window.focus();
                window.print();
            }, 250);
        });
        window.addEventListener("afterprint", function () {
            window.close();
        });
    <\/script>
</body>
</html>`;
}

async function exportReportAsMarkdownPdf() {
    const statusEl = $("status");
    const exportBtn = document.getElementById("exportPdfBtn");

    if (!latestAnalysisResult) {
        if (statusEl) statusEl.textContent = "请先完成一次数据分析再导出 PDF";
        return;
    }

    const originalText = exportBtn ? exportBtn.textContent : "导出PDF";
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.textContent = "准备导出...";
    }
    if (statusEl) statusEl.textContent = "正在生成文本型导出文档（非图片截图）...";

    try {
        const markdown = buildReportMarkdown(latestAnalysisResult);
        if (!markdown || !markdown.replace(/\s/g, "")) {
            throw new Error("导出内容为空");
        }
        const html = marked.parse(markdown, { gfm: true, breaks: true });
        const printDoc = buildPrintDocumentHtml(html);
        const printBlob = new Blob([printDoc], { type: "text/html;charset=utf-8" });
        const printUrl = URL.createObjectURL(printBlob);
        const printWindow = window.open(printUrl, "_blank", "width=980,height=760");
        if (!printWindow) {
            URL.revokeObjectURL(printUrl);
            throw new Error("浏览器拦截了导出窗口，请允许弹窗后重试");
        }
        // Keep URL alive long enough for the new window to load and print.
        setTimeout(() => URL.revokeObjectURL(printUrl), 60000);

        if (statusEl) statusEl.textContent = "已打开导出窗口，请在打印对话框中选择“另存为 PDF”";
    } catch (err) {
        console.error(err);
        if (statusEl) statusEl.textContent = `导出失败：${err.message || err}`;
    } finally {
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.textContent = originalText;
        }
    }
}

if (document.getElementById("exportPdfBtn")) {
    document.getElementById("exportPdfBtn").addEventListener("click", exportReportAsMarkdownPdf);
}

window.addEventListener("resize", () => {
    resizeWorkbenchChart();
});



// Chat Resizer Logic
const chatResizer = document.getElementById('chatResizer');
const chatPanel = document.getElementById('chatPanel');

if (chatResizer && chatPanel) {
    let isResizing = false;

    chatResizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        chatPanel.classList.add('no-transition');
        chatResizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        // Calculate new width: window innerWidth - mouse X position
        const newWidth = window.innerWidth - e.clientX;
        
        // Keep constraints (min 420px, max 80vw)
        const constrainedWidth = Math.max(420, Math.min(newWidth, window.innerWidth * 0.8));
        
        chatPanel.style.width = constrainedWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            chatPanel.classList.remove('no-transition');
            chatResizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            setTimeout(resizeWorkbenchChart, 0);
        }
    });
}
