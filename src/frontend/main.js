const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "xi_agent_chat_sessions_v1";
const WEB_SEARCH_TOGGLE_KEY = "xi_agent_web_search_toggle_v1";
const DEFAULT_ASSISTANT_GREETING = "你好，我是硒产业智能助手。你可以直接开始自由提问。";
const WORKBENCH_EXPORT_FILENAME = "xi-agent-chart";
const SNAPSHOT_UPLOAD_MAX_EDGE = 1280;
const SNAPSHOT_UPLOAD_MIN_EDGE = 640;
const SNAPSHOT_UPLOAD_TARGET_BYTES = 380 * 1024;
const SNAPSHOT_JPEG_INITIAL_QUALITY = 0.84;
const SNAPSHOT_JPEG_MIN_QUALITY = 0.52;
const SNAPSHOT_JPEG_QUALITY_STEP = 0.08;
const SNAPSHOT_DOWNSCALE_STEP = 0.85;
const SNAPSHOT_COMPRESSION_MAX_ATTEMPTS = 10;
const WORKBENCH_CHART_WIDTH_RATIO = 0.9;

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

function estimateDataUrlBytes(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return 0;
    const commaIndex = dataUrl.indexOf(",");
    const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
    const padding = base64.endsWith("==") ? 2 : (base64.endsWith("=") ? 1 : 0);
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("无法解码图表快照"));
        img.src = dataUrl;
    });
}

function getInitialUploadSnapshotSize(width, height) {
    const longEdge = Math.max(1, Math.max(width, height));
    const ratio = Math.min(1, SNAPSHOT_UPLOAD_MAX_EDGE / longEdge);
    return {
        width: Math.max(1, Math.round(width * ratio)),
        height: Math.max(1, Math.round(height * ratio)),
    };
}

function downscaleSnapshotSize(width, height) {
    const currentLongEdge = Math.max(width, height);
    if (currentLongEdge <= SNAPSHOT_UPLOAD_MIN_EDGE) {
        return { width, height, changed: false };
    }

    const nextLongEdge = Math.max(
        SNAPSHOT_UPLOAD_MIN_EDGE,
        Math.floor(currentLongEdge * SNAPSHOT_DOWNSCALE_STEP)
    );
    const ratio = nextLongEdge / currentLongEdge;
    const nextWidth = Math.max(1, Math.round(width * ratio));
    const nextHeight = Math.max(1, Math.round(height * ratio));
    const changed = nextWidth !== width || nextHeight !== height;
    return { width: nextWidth, height: nextHeight, changed };
}

function encodeImageToJpegDataUrl(img, width, height, quality) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("浏览器不支持 Canvas 2D");
    }

    // Use white background for JPEG to avoid black fill in transparent areas.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", quality);
}

async function buildCompressedSnapshotDataUrl(rawPngDataUrl, sourceWidth, sourceHeight) {
    try {
        const img = await loadImageFromDataUrl(rawPngDataUrl);
        let { width, height } = getInitialUploadSnapshotSize(sourceWidth, sourceHeight);
        let quality = SNAPSHOT_JPEG_INITIAL_QUALITY;
        let bestDataUrl = "";
        let bestBytes = Number.POSITIVE_INFINITY;

        for (let i = 0; i < SNAPSHOT_COMPRESSION_MAX_ATTEMPTS; i += 1) {
            const jpegDataUrl = encodeImageToJpegDataUrl(img, width, height, quality);
            const bytes = estimateDataUrlBytes(jpegDataUrl);
            if (bytes < bestBytes) {
                bestBytes = bytes;
                bestDataUrl = jpegDataUrl;
            }
            if (bytes <= SNAPSHOT_UPLOAD_TARGET_BYTES) {
                return jpegDataUrl;
            }

            if (quality > SNAPSHOT_JPEG_MIN_QUALITY + 1e-6) {
                quality = Math.max(SNAPSHOT_JPEG_MIN_QUALITY, quality - SNAPSHOT_JPEG_QUALITY_STEP);
                continue;
            }

            const next = downscaleSnapshotSize(width, height);
            if (!next.changed) {
                break;
            }
            width = next.width;
            height = next.height;
            quality = SNAPSHOT_JPEG_INITIAL_QUALITY;
        }

        return bestDataUrl || rawPngDataUrl;
    } catch {
        return rawPngDataUrl;
    }
}

async function capturePlotImageDataUrl(chartEl) {
    if (!chartEl || !window.Plotly || !Array.isArray(chartEl.data) || chartEl.data.length === 0) {
        return "";
    }

    const { width, height } = getChartViewportSize(chartEl);
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
        const rawPngDataUrl = await Plotly.toImage(chartEl, {
            format: "png",
            width,
            height,
            scale: 1,
        });
        // Model-upload snapshot only: downscale + JPEG + adaptive compression.
        return await buildCompressedSnapshotDataUrl(rawPngDataUrl, width, height);
    } finally {
        if (needsPatch) {
            await Plotly.relayout(chartEl, {
                paper_bgcolor: prevLayout.paper_bgcolor ?? "rgba(0,0,0,0)",
                plot_bgcolor: prevLayout.plot_bgcolor ?? "rgba(0,0,0,0)",
            });
        }
    }
}

function normalizeFigureLayout(rawLayout = {}, figData = [], containerWidth = 0) {
    const annotations = Array.isArray(rawLayout.annotations) ? rawLayout.annotations : [];
    const baseMargin = { ...BASE_LAYOUT.margin, ...(rawLayout.margin || {}) };
    const extraTopMargin = annotations.length > 1 ? Math.min(40, annotations.length * 6) : 0;
    const compact = containerWidth > 0 && containerWidth < 860;

    const margin = {
        ...baseMargin,
        l: Math.max(compact ? 40 : 56, baseMargin.l || 0),
        r: Math.max(compact ? 16 : 28, baseMargin.r || 0),
        b: Math.max(compact ? 44 : 58, baseMargin.b || 0),
        t: Math.max((compact ? 54 : 72) + extraTopMargin, baseMargin.t || 0),
    };

    const legend = { ...BASE_LAYOUT.legend, ...(rawLayout.legend || {}) };
    if ((Array.isArray(figData) && figData.length > 8 && !legend.orientation) || compact) {
        legend.orientation = "h";
        legend.x = 0;
        legend.y = compact ? 1.12 : 1.16;
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
    const { rows } = estimateSubplotGrid(rawLayout);
    const viewportWidth = Math.max(
        320,
        Math.floor(viewportEl?.clientWidth || chartEl.parentElement?.clientWidth || chartEl.clientWidth || 0)
    );
    const containerWidth = Math.max(320, Math.floor(viewportWidth * WORKBENCH_CHART_WIDTH_RATIO));

    const rowBasedHeight = rows > 1 ? rows * 320 + 120 : Math.max(460, Math.floor(containerWidth * 0.58));
    const providedHeight = Number(rawLayout.height) || 0;
    const chartHeight = Math.max(460, rowBasedHeight, providedHeight);

    chartEl.style.width = `${Math.round(WORKBENCH_CHART_WIDTH_RATIO * 100)}%`;
    chartEl.style.height = `${chartHeight}px`;
    chartEl.style.minWidth = "0";
    chartEl.style.margin = "0 auto";

    const layout = normalizeFigureLayout(rawLayout, safeFig.data || [], containerWidth);
    layout.height = chartHeight;
    layout.width = null;
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
    scheduleWorkbenchResizeStabilization();
}

function resizeWorkbenchChart() {
    const chartEl = $("workbenchChart");
    if (!chartEl || !window.Plotly || !Array.isArray(chartEl.data) || chartEl.data.length === 0) return;
    Plotly.Plots.resize(chartEl);
}
let workbenchResizeDebounceTimer = 0;

function scheduleWorkbenchResizeStabilization() {
    const runResize = () => {
        try {
            resizeWorkbenchChart();
        } catch {
            // Ignore transient resize errors during layout transition.
        }
    };

    requestAnimationFrame(runResize);
    window.setTimeout(runResize, 90);
    window.setTimeout(runResize, 220);
    window.setTimeout(runResize, 420);
}

function requestWorkbenchResize() {
    if (workbenchResizeDebounceTimer) {
        window.clearTimeout(workbenchResizeDebounceTimer);
    }
    workbenchResizeDebounceTimer = window.setTimeout(() => {
        workbenchResizeDebounceTimer = 0;
        scheduleWorkbenchResizeStabilization();
    }, 40);
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
let currentChartCode = "";
let currentChartFig = null;
let currentVizSessionId = "";
let chartHistory = [];
let sessions = [];
let activeSessionId = "";
let latestAnalysisResult = null;
let currentCenterView = "report";

const STYLE_ONLY_PROMPT_KEYWORDS = [
    "配色", "颜色", "色系", "主题色", "渐变", "风格", "美化", "学术风", "简约", "高端", "高级",
    "字体", "字号", "线宽", "线条", "透明度", "背景", "明亮", "清新", "柔和", "更好看",
];
const VISUAL_REQUIRED_PROMPT_KEYWORDS = [
    "当前图", "这个图", "上图", "上一张", "参考图", "看图", "图例位置", "标题位置", "坐标轴范围",
    "重叠", "遮挡", "间距", "布局", "对齐", "错位", "左边", "右边", "上方", "下方", "子图",
    "保持其余不变", "在原图基础上", "按这张图",
];

const TITLE_REMOVAL_KEYWORDS = ["不需要", "不要", "去掉", "移除", "删掉", "取消", "隐藏", "去除"];
const TITLE_TARGET_KEYWORDS = ["标题", "title", "label", "标签"];
const SIDE_OR_SUBPLOT_KEYWORDS = ["子图", "subplot", "坐标轴", "轴", "侧边", "左边", "右边"];
const POSITION_ACTION_KEYWORDS = ["放", "放在", "移到", "移动到", "位置", "置于", "设为", "改到", "position"];
const POSITION_TARGET_KEYWORDS = ["上", "上方", "顶部", "下", "下方", "底部", "左", "左侧", "右", "右侧", "中", "居中", "图内", "图外", "inside", "outside", "top", "bottom", "left", "right", "center"];
const MARGIN_KEYWORDS = ["边距", "留白", "间距", "margin", "padding", "距顶", "距上", "距下"];
const SUBPLOT_GAP_ACTION_INCREASE_KEYWORDS = ["增加", "加大", "增大", "拉开", "远一点", "抬高", "上移", "往上", "避免重叠", "不要重叠"];
const SUBPLOT_GAP_ACTION_DECREASE_KEYWORDS = ["减小", "减少", "缩小", "靠近", "近一点", "下移", "往下"];
const CHART_STRUCTURE_CHANGE_KEYWORDS = ["折线", "柱状", "散点", "饼图", "箱线", "热力", "雷达", "面积", "直方", "3d", "三维", "图表类型", "换成", "改成", "重画", "重新画"];

function containsAnyKeyword(text, keywords) {
    if (!text) return false;
    return keywords.some((kw) => text.includes(kw));
}

function shouldAttachChartImageForPrompt(chatText) {
    const text = String(chatText || "").trim();
    if (!text) return false;

    if (containsAnyKeyword(text, VISUAL_REQUIRED_PROMPT_KEYWORDS)) {
        return true;
    }
    if (containsAnyKeyword(text, STYLE_ONLY_PROMPT_KEYWORDS)) {
        return false;
    }

    // Default to no image to reduce payload unless user clearly asks for visual-position/layout fixes.
    return false;
}

function normalizePromptText(text) {
    return String(text || "").trim().toLowerCase().replace(/\s+/g, "");
}

function hasAnyKeyword(normalizedText, keywords) {
    if (!normalizedText) return false;
    return keywords.some((kw) => normalizedText.includes(String(kw).toLowerCase()));
}

function shouldRemoveSubplotSideTitles(chatText) {
    const normalized = normalizePromptText(chatText);
    if (!normalized) return false;
    return (
        hasAnyKeyword(normalized, TITLE_REMOVAL_KEYWORDS)
        && hasAnyKeyword(normalized, TITLE_TARGET_KEYWORDS)
        && hasAnyKeyword(normalized, SIDE_OR_SUBPLOT_KEYWORDS)
    );
}

function clearAxisTitle(axis) {
    if (!axis || typeof axis !== "object") return axis;
    const axisTitle = axis.title;
    const nextTitle = axisTitle && typeof axisTitle === "object"
        ? { ...axisTitle, text: "" }
        : "";
    return {
        ...axis,
        title: nextTitle,
    };
}

function applyPromptLayoutOverrides(fig, chatText) {
    if (!fig || typeof fig !== "object") return fig;

    const layout = fig.layout && typeof fig.layout === "object" ? { ...fig.layout } : {};

    if (shouldRemoveSubplotSideTitles(chatText)) {
        Object.keys(layout).forEach((key) => {
            if (!/^xaxis\d*$/.test(key) && !/^yaxis\d*$/.test(key)) return;
            layout[key] = clearAxisTitle(layout[key]);
        });

        if (Array.isArray(layout.annotations)) {
            layout.annotations = layout.annotations.map((annotation) => {
                if (!annotation || typeof annotation !== "object") return annotation;
                const isSubplotTitleLike = annotation.showarrow === false
                    && (annotation.xref === "paper" || annotation.yref === "paper");
                if (!isSubplotTitleLike) return annotation;
                return { ...annotation, text: "" };
            });
        }
    }

    applySubplotTitleGapOverrides(layout, chatText);

    return {
        ...fig,
        layout,
    };
}

function resolveSubplotTitleGapDelta(chatText) {
    const normalized = normalizePromptText(chatText);
    if (!normalized) return 0;

    const hasSubplot = hasAnyKeyword(normalized, ["子图", "subplot"]);
    const hasTitle = hasAnyKeyword(normalized, ["标题", "title"]);
    const mentionsTitleToChartGap = hasAnyKeyword(normalized, [
        "标题与子图", "标题和子图", "标题到子图", "标题离子图", "标题与图", "标题和图", "titleandsubplot",
    ]) || hasAnyKeyword(normalized, ["重叠", "遮挡", "挤", "太近", "间距", "距离"]);
    const mentionsSubplotToSubplotGap = hasAnyKeyword(normalized, ["子图之间", "子图与子图", "subplot之间", "subplot间"]);

    // Only trigger when request is about title-vs-subplot spacing, not subplot-vs-subplot spacing.
    if (!hasSubplot || !hasTitle || !mentionsTitleToChartGap || mentionsSubplotToSubplotGap) {
        return 0;
    }

    if (hasAnyKeyword(normalized, SUBPLOT_GAP_ACTION_DECREASE_KEYWORDS)) return -10;
    if (hasAnyKeyword(normalized, SUBPLOT_GAP_ACTION_INCREASE_KEYWORDS)) return 12;

    // If user only says overlap/spacing issue without explicit direction, default to increasing gap.
    return 12;
}

function isLikelySubplotTitleAnnotation(annotation) {
    if (!annotation || typeof annotation !== "object") return false;
    if (annotation.showarrow !== false) return false;
    const text = String(annotation.text || "").trim();
    if (!text) return false;
    const xref = String(annotation.xref || "").toLowerCase();
    const yref = String(annotation.yref || "").toLowerCase();
    const paperLike = xref === "paper" || yref === "paper" || xref.includes("domain") || yref.includes("domain");
    return paperLike;
}

function applySubplotTitleGapOverrides(layout, chatText) {
    if (!layout || typeof layout !== "object" || !Array.isArray(layout.annotations)) return;
    const delta = resolveSubplotTitleGapDelta(chatText);
    if (!delta) return;

    let adjustedCount = 0;
    layout.annotations = layout.annotations.map((annotation) => {
        if (!isLikelySubplotTitleAnnotation(annotation)) return annotation;
        adjustedCount += 1;
        const currentShift = Number(annotation.yshift);
        return {
            ...annotation,
            yshift: (Number.isFinite(currentShift) ? currentShift : 0) + delta,
        };
    });

    if (!adjustedCount || delta <= 0) return;

    const margin = layout.margin && typeof layout.margin === "object" ? layout.margin : {};
    const topGrow = Math.min(80, 16 + adjustedCount * 4);
    layout.margin = {
        ...margin,
        t: Math.max(72, Number(margin.t || 0) + topGrow),
    };
}

function safeDeepClone(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

function isLayoutOnlyCommand(chatText) {
    const normalized = normalizePromptText(chatText);
    if (!normalized) return false;

    const hasLayoutKeyword = hasAnyKeyword(normalized, [
        "间距", "距离", "重叠", "遮挡", "图例", "标题", "坐标轴", "位置", "边距", "留白", "对齐", "布局",
    ]);
    const hasStructureKeyword = hasAnyKeyword(normalized, CHART_STRUCTURE_CHANGE_KEYWORDS);
    return hasLayoutKeyword && !hasStructureKeyword;
}

function detectPrecisionIntent(chatText) {
    const normalized = normalizePromptText(chatText);
    if (!normalized) return "none";

    const hasSubplot = hasAnyKeyword(normalized, ["子图", "subplot"]);
    const hasTitle = hasAnyKeyword(normalized, ["标题", "title"]);
    const mentionsSubplotToSubplot = hasAnyKeyword(normalized, ["子图之间", "子图与子图", "subplot之间", "subplot间"]);
    const mentionsGap = hasAnyKeyword(normalized, ["距离", "间距", "重叠", "太近", "遮挡"]);

    if (hasSubplot && hasTitle && mentionsGap && !mentionsSubplotToSubplot) {
        return "subplot_title_gap";
    }
    if (hasSubplot && mentionsSubplotToSubplot && mentionsGap) {
        return "subplot_gap";
    }
    if (hasAnyKeyword(normalized, ["图例", "legend"]) && hasAnyKeyword(normalized, ["位置", "放", "移", "左", "右", "上", "下", "内", "外"])) {
        return "legend_position";
    }
    return "none";
}

function getAxisLayoutKeys(layout) {
    if (!layout || typeof layout !== "object") return [];
    return Object.keys(layout).filter((key) => /^xaxis\d*$/.test(key) || /^yaxis\d*$/.test(key));
}

function preserveAxisDomains(prevLayout, nextLayout) {
    const axisKeys = new Set([...getAxisLayoutKeys(prevLayout), ...getAxisLayoutKeys(nextLayout)]);
    axisKeys.forEach((key) => {
        const prevAxis = prevLayout?.[key];
        const nextAxis = nextLayout?.[key];
        if (!prevAxis || typeof prevAxis !== "object" || !Array.isArray(prevAxis.domain)) return;
        if (!nextAxis || typeof nextAxis !== "object") return;
        nextLayout[key] = {
            ...nextAxis,
            domain: safeDeepClone(prevAxis.domain),
        };
    });
}

function preserveTitleAnnotations(prevLayout, nextLayout) {
    const prevAnnotations = Array.isArray(prevLayout?.annotations) ? prevLayout.annotations : null;
    const nextAnnotations = Array.isArray(nextLayout?.annotations) ? nextLayout.annotations : null;
    if (!prevAnnotations || !nextAnnotations) return;

    // Keep previous subplot-title annotation offsets/positions to avoid unintended coupling.
    nextLayout.annotations = nextAnnotations.map((ann, idx) => {
        if (!isLikelySubplotTitleAnnotation(ann)) return ann;
        const prev = prevAnnotations[idx];
        if (!prev || typeof prev !== "object") return ann;
        return {
            ...ann,
            yshift: prev.yshift,
            y: prev.y,
            yref: prev.yref,
        };
    });
}

function applyPreciseCommandExecution(previousFig, currentFig, chatText) {
    if (!previousFig || !currentFig) return currentFig;

    const intent = detectPrecisionIntent(chatText);
    if (intent === "none") return currentFig;

    const prevLayout = previousFig.layout && typeof previousFig.layout === "object" ? previousFig.layout : {};
    const nextLayout = currentFig.layout && typeof currentFig.layout === "object" ? { ...currentFig.layout } : {};
    const result = {
        ...currentFig,
        layout: nextLayout,
    };

    if (isLayoutOnlyCommand(chatText) && Array.isArray(previousFig.data)) {
        // For layout-only commands, keep traces unchanged to avoid accidental model drift.
        result.data = safeDeepClone(previousFig.data);
    }

    if (intent === "subplot_title_gap") {
        preserveAxisDomains(prevLayout, nextLayout);
        if (prevLayout.grid) nextLayout.grid = safeDeepClone(prevLayout.grid);
        if (Number.isFinite(Number(prevLayout.height))) {
            nextLayout.height = Number(prevLayout.height);
        }
        return result;
    }

    if (intent === "subplot_gap") {
        preserveTitleAnnotations(prevLayout, nextLayout);
        if (prevLayout.title && typeof prevLayout.title === "object") {
            nextLayout.title = {
                ...nextLayout.title,
                x: prevLayout.title.x,
                y: prevLayout.title.y,
                xanchor: prevLayout.title.xanchor,
                yanchor: prevLayout.title.yanchor,
                pad: safeDeepClone(prevLayout.title.pad),
            };
        }
        return result;
    }

    if (intent === "legend_position") {
        // Keep subplot spacing unchanged for pure legend position commands.
        preserveAxisDomains(prevLayout, nextLayout);
        if (prevLayout.grid) nextLayout.grid = safeDeepClone(prevLayout.grid);
        return result;
    }

    return result;
}

function hasExplicitPositionInstruction(chatText, subjectKeywords) {
    const normalized = normalizePromptText(chatText);
    if (!normalized) return false;
    if (!hasAnyKeyword(normalized, subjectKeywords)) return false;
    return hasAnyKeyword(normalized, POSITION_ACTION_KEYWORDS) || hasAnyKeyword(normalized, POSITION_TARGET_KEYWORDS);
}

function extractTitleText(layout) {
    const title = layout?.title;
    if (!title) return "";
    if (typeof title === "string") return title.trim();
    if (typeof title === "object" && title.text) return String(title.text).trim();
    return "";
}

function hasHighRiskLayoutOverlap(fig) {
    if (!fig || typeof fig !== "object") return false;
    const layout = fig.layout && typeof fig.layout === "object" ? fig.layout : {};
    const traceCount = Array.isArray(fig.data) ? fig.data.length : 0;
    const titleText = extractTitleText(layout);
    const hasTitle = Boolean(titleText);
    const topMargin = Number(layout?.margin?.t || 0);
    const legend = layout.legend && typeof layout.legend === "object" ? layout.legend : {};
    const showLegend = layout.showlegend !== false;
    const legendOrientation = String(legend.orientation || "v").toLowerCase();
    const legendY = Number(legend.y);
    const hasLegendY = Number.isFinite(legendY);
    const legendNearTop = showLegend && (
        (!hasLegendY && traceCount >= 6)
        || (legendOrientation === "h" && (!hasLegendY || legendY <= 1.06))
        || (legendOrientation !== "h" && (!hasLegendY || legendY >= 0.85))
    );

    const annotations = Array.isArray(layout.annotations) ? layout.annotations : [];
    const topAnnotationCount = annotations.filter((ann) => {
        if (!ann || typeof ann !== "object") return false;
        const y = Number(ann.y);
        return ann.showarrow === false && (!Number.isFinite(y) || y >= 0.9);
    }).length;

    if (hasTitle && topMargin < 86) return true;
    if (topAnnotationCount >= 2 && topMargin < 96) return true;
    if (hasTitle && legendNearTop) return true;
    if (traceCount >= 9 && showLegend && !legend.orientation) return true;
    return false;
}

function applyFirstFigureLayoutSanitizer(fig, chatText, enabled) {
    if (!enabled || !fig || typeof fig !== "object") return fig;
    if (!hasHighRiskLayoutOverlap(fig)) return fig;

    const explicitLegendPosition = hasExplicitPositionInstruction(chatText, ["图例", "legend"]);
    const explicitTitlePosition = hasExplicitPositionInstruction(chatText, ["标题", "title"]);
    const explicitMarginInstruction = hasAnyKeyword(normalizePromptText(chatText), MARGIN_KEYWORDS);

    const layout = fig.layout && typeof fig.layout === "object" ? { ...fig.layout } : {};
    const traceCount = Array.isArray(fig.data) ? fig.data.length : 0;
    const annotations = Array.isArray(layout.annotations) ? layout.annotations : [];
    const dynamicTopPad = Math.min(24, annotations.length * 4);

    if (!explicitMarginInstruction) {
        const currentMargin = layout.margin && typeof layout.margin === "object" ? layout.margin : {};
        layout.margin = {
            ...currentMargin,
            l: Math.max(46, Number(currentMargin.l || 0)),
            r: Math.max(24, Number(currentMargin.r || 0)),
            b: Math.max(52, Number(currentMargin.b || 0)),
            t: Math.max(96 + dynamicTopPad, Number(currentMargin.t || 0)),
        };
    }

    if (!explicitTitlePosition) {
        const title = layout.title;
        if (typeof title === "string") {
            layout.title = {
                text: title,
                x: 0.02,
                xanchor: "left",
                y: 0.985,
                yanchor: "top",
                pad: { t: 12, b: 8 },
            };
        } else if (title && typeof title === "object") {
            layout.title = {
                ...title,
                x: title.x ?? 0.02,
                xanchor: title.xanchor ?? "left",
                y: title.y ?? 0.985,
                yanchor: title.yanchor ?? "top",
                pad: {
                    ...(title.pad || {}),
                    t: Math.max(12, Number(title?.pad?.t || 0)),
                    b: Math.max(8, Number(title?.pad?.b || 0)),
                },
            };
        }
    }

    if (!explicitLegendPosition && layout.showlegend !== false) {
        const legend = layout.legend && typeof layout.legend === "object" ? layout.legend : {};
        const currentY = Number(legend.y);
        const legendRisky = !Number.isFinite(currentY) || currentY <= 1.06 || traceCount >= 6;
        if (legendRisky) {
            layout.legend = {
                ...legend,
                orientation: "h",
                x: legend.x ?? 0,
                xanchor: legend.xanchor ?? "left",
                y: legend.y ?? 1.14,
                yanchor: legend.yanchor ?? "bottom",
            };

            if (!explicitMarginInstruction) {
                const margin = layout.margin && typeof layout.margin === "object" ? layout.margin : {};
                layout.margin = {
                    ...margin,
                    t: Math.max(Number(margin.t || 0), 118 + dynamicTopPad),
                };
            }
        }
    }

    return {
        ...fig,
        layout,
    };
}

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

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function splitCitationsFromMarkdown(markdownText) {
    const raw = String(markdownText || "");
    const match = raw.match(/(?:^|\n)\s*参考来源[：:]\s*(?:\n|$)/);
    if (!match || typeof match.index !== "number") {
        return { body: raw, citations: "" };
    }

    let start = match.index;
    if (raw[start] === "\n") {
        start += 1;
    }

    const body = raw.slice(0, start).trimEnd();
    let citations = raw.slice(start).trim();
    citations = citations.replace(/^\s*参考来源[：:]\s*/, "").trim();
    return { body, citations };
}

function renderAssistantMessageHtml(markdownText) {
    const { body, citations } = splitCitationsFromMarkdown(markdownText);
    const citationCount = (citations.match(/^\d+\.\s+\[/gm) || []).length;
    const summaryText = citationCount > 0 ? `参考来源（${citationCount}）` : "参考来源";

    if (!window.marked) {
        const bodyHtml = escapeHtml(body).replace(/\n/g, "<br>");
        if (!citations) return bodyHtml;
        const citationsHtml = escapeHtml(citations).replace(/\n/g, "<br>");
        return `${bodyHtml}<details class="citations-fold"><summary>${summaryText}</summary><div class="citations-body">${citationsHtml}</div></details>`;
    }

    const bodyHtml = body ? marked.parse(body) : "";
    if (!citations) return bodyHtml;
    const citationsHtml = marked.parse(citations);
    return `${bodyHtml}<details class="citations-fold"><summary>${summaryText}</summary><div class="citations-body">${citationsHtml}</div></details>`;
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
            bubble.innerHTML = renderAssistantMessageHtml(m.content || "");
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
                    bubble.innerHTML = renderAssistantMessageHtml(fullText);
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
            requestWorkbenchResize();
        });
    }
    
    if ($("chatToggle")) {
        $("chatToggle").addEventListener("click", () => {
            const layout = $("appLayout");
            if (!layout) return;
            layout.classList.toggle("chat-open");
            $("chatToggle").textContent = layout.classList.contains("chat-open") ? "关闭对话" : "开启对话";
        });
    }

    if ($("clearCurrentChatBtn")) {
        $("clearCurrentChatBtn").addEventListener("click", clearCurrentChatMessages);
    }
}

function setCenterView(view) {
    const report = $("reportContainer");
    const workbench = $("workbenchContainer");
    const analysisEntryCard = $("analysisEntryCard");
    const startVizBtn = $("startVizBtn");
    const backToReportTopBtn = $("backToReportTopBtn");
    const exportBtn = $("exportPdfBtn");
    if (!report || !workbench) return;

    currentCenterView = view;
    const onWorkbench = view === "workbench";

    report.classList.toggle("hidden", onWorkbench);
    workbench.classList.toggle("hidden", !onWorkbench);
    if (analysisEntryCard) {
        analysisEntryCard.style.display = onWorkbench ? "none" : "block";
    }

    if (onWorkbench) {
        requestWorkbenchResize();
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

function bindWorkbenchEvents() {
    const vizChatInput = $("vizChatInput");
    const btnVizChatSend = $("btnVizChatSend");
    const btnVizNewChart = $("btnVizNewChart");

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

    if (btnVizNewChart) {
        btnVizNewChart.addEventListener("click", () => {
            resetWorkbenchForNewFigure();
        });
    }

    if ($("exportChartBtn")) {
        $("exportChartBtn").addEventListener("click", exportWorkbenchChartImage);
    }
    if ($("undoChartBtn")) {
        $("undoChartBtn").addEventListener("click", undoLastChart);
    }
}

function resetWorkbenchForNewFigure() {
    const chartEl = $("workbenchChart");
    const metaEl = $("vizMeta");
    const statusEl = $("vizStatus");
    const inputEl = $("vizChatInput");

    currentChartCode = "";
    currentChartFig = null;
    chartHistory = [];

    if ($("undoChartBtn")) {
        $("undoChartBtn").style.display = "none";
    }
    setChartExportButtonVisible(false);

    if (metaEl) {
        metaEl.style.display = "none";
        metaEl.innerHTML = "";
    }

    if (chartEl) {
        if (window.Plotly && typeof Plotly.purge === "function") {
            try {
                Plotly.purge(chartEl);
            } catch {
                // ignore purge failure
            }
        }
        chartEl.innerHTML = "";
        chartEl.style.width = "";
        chartEl.style.height = "";
        chartEl.style.minWidth = "";
        chartEl.style.margin = "";
    }

    if (inputEl) {
        inputEl.value = "";
    }
    if (statusEl) {
        statusEl.textContent = "已重置为初始状态，请输入新需求开始绘制。";
    }

    requestWorkbenchResize();
}

async function undoLastChart() {
    if (chartHistory.length === 0) return;
    const lastState = chartHistory.pop();
    
    currentChartCode = lastState.code;
    currentChartFig = lastState.fig;
    
    const chartEl = $("workbenchChart");
    await renderFigureToWorkbench(chartEl, currentChartFig);
    
    const metaEl = $("vizMeta");
    if (metaEl) {
        metaEl.innerHTML = `后台生成代码：<details><summary>点击查看</summary><pre style="font-size:12px;margin:4px 0;background:#f8fafc;padding:8px;border-radius:4px;overflow-x:auto;">${currentChartCode || ""}</pre></details>`;
    }
    
    if (chartHistory.length === 0) {
        $("undoChartBtn").style.display = "none";
    }
}

async function handleVizChatInput(chatText) {
    if (!chatText) return;
    const file = $("fileInput")?.files?.[0];
    const statusEl = $("vizStatus");
    const chartEl = $("workbenchChart");
    const metaEl = $("vizMeta");
    const isFirstWorkbenchGeneration = !currentChartFig && !currentChartCode;
    
    if (!file && !currentVizSessionId) {
        alert("请先在最上方选择要分析的本地数据文件！");
        if (statusEl) statusEl.textContent = "请先在上方选择数据文件。";
        return;
    }
    if (statusEl) statusEl.textContent = "正由大模型动态推断和编写代码...";
    
    // UI state update
    const btnVizChatSend = $("btnVizChatSend");
    const btnVizNewChart = $("btnVizNewChart");
    if (btnVizChatSend) {
        btnVizChatSend.textContent = "生成中...";
        btnVizChatSend.disabled = true;
    }
    if (btnVizNewChart) {
        btnVizNewChart.disabled = true;
    }

    try {
        await ensurePlotly();
        const form = new FormData();
        form.append("prompt", chatText);

        if (currentVizSessionId) {
            form.append("viz_session_id", currentVizSessionId);
        } else if (file) {
            form.append("file", file);
        }

        const shouldSendChartImage = shouldAttachChartImageForPrompt(chatText);
        let currentChartImageDataUrl = "";
        if (shouldSendChartImage) {
            currentChartImageDataUrl = await capturePlotImageDataUrl(chartEl);
            if (currentChartImageDataUrl) {
                form.append("chart_image_data_url", currentChartImageDataUrl);
            }
        }

        if (currentChartCode) {
            form.append("previous_code", currentChartCode);
        }

        let res = await fetch(`${API_BASE}/visualize_custom`, {
            method: "POST",
            body: form,
        });

        if (!res.ok) {
            const firstErrText = await res.text();
            const firstErrLower = String(firstErrText || "").toLowerCase();
            const shouldRetryWithFile = Boolean(
                currentVizSessionId
                && file
                && (
                    firstErrLower.includes("viz_session_id")
                    || firstErrLower.includes("expired")
                    || firstErrLower.includes("upload file again")
                )
            );

            if (!shouldRetryWithFile) {
                throw new Error(firstErrText);
            }

            currentVizSessionId = "";
            if (statusEl) statusEl.textContent = "缓存会话已失效，正在自动重传文件重试...";

            const retryForm = new FormData();
            retryForm.append("file", file);
            retryForm.append("prompt", chatText);
            if (currentChartCode) {
                retryForm.append("previous_code", currentChartCode);
            }
            if (currentChartImageDataUrl) {
                retryForm.append("chart_image_data_url", currentChartImageDataUrl);
            }

            res = await fetch(`${API_BASE}/visualize_custom`, {
                method: "POST",
                body: retryForm,
            });
            if (!res.ok) throw new Error(await res.text());
        }

        const data = await res.json();
        const previousFigSnapshot = currentChartFig ? safeDeepClone(currentChartFig) : null;
        const figAfterPromptOverrides = applyPromptLayoutOverrides(data.figure || {}, chatText);
        const figAfterPrecision = applyPreciseCommandExecution(previousFigSnapshot, figAfterPromptOverrides, chatText);
        const fig = applyFirstFigureLayoutSanitizer(figAfterPrecision, chatText, isFirstWorkbenchGeneration);
        currentVizSessionId = data.viz_session_id || currentVizSessionId;

        if (currentChartCode && currentChartFig) {
            chartHistory.push({ code: currentChartCode, fig: currentChartFig });
            if ($("undoChartBtn")) $("undoChartBtn").style.display = "inline-block";
        }
        currentChartCode = data.code || "";
        currentChartFig = fig;

        await renderFigureToWorkbench(chartEl, fig);
        setChartExportButtonVisible(true);

        const meta = data.meta || {};
        if (metaEl) {
            metaEl.style.display = "block";
            metaEl.innerHTML = `后台生成代码：<details><summary>点击查看</summary><pre style="font-size:12px;margin:4px 0;background:#f8fafc;padding:8px;border-radius:4px;overflow-x:auto;">${data.code || ""}</pre></details>`;
        }

        if (statusEl) statusEl.textContent = "已根据提示词通过 AI 构图成功。";
    } catch (e) {
        if (statusEl) statusEl.textContent = `AI 动态生成失败：${e.message || e}`;
    } finally {
        if (btnVizChatSend) {
            btnVizChatSend.textContent = "生成";
            btnVizChatSend.disabled = false;
        }
        if (btnVizNewChart) {
            btnVizNewChart.disabled = false;
        }
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

if ($("fileInput")) {
    $("fileInput").addEventListener("change", () => {
        currentChartCode = "";
        currentChartFig = null;
        currentVizSessionId = "";
        chartHistory = [];
        if ($("undoChartBtn")) $("undoChartBtn").style.display = "none";
    });
}

$("analyzeBtn").addEventListener("click", async () => {
    const file = $("fileInput").files[0];
    const prompt = $("promptInput") ? $("promptInput").value.trim() : "";
    if (!file) {
        $("status").textContent = "请选择数据文件";
        return;
    }
    
    // Switch to new file, reset continuous chart code
    currentChartCode = "";
    currentChartFig = null;
    currentVizSessionId = "";
    chartHistory = [];
    if ($("undoChartBtn")) $("undoChartBtn").style.display = "none";
    
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
        currentVizSessionId = data.viz_session_id || "";
        analysisContextHint = `行业背景：硒产业\n用户分析需求：${prompt || "无"}\n数据摘要：${JSON.stringify(data.summary)}`;

        $("summary").textContent = JSON.stringify(data.summary, null, 2);

        // Populate Visualization Workbench Suggestion
        const vizSuggestion = (data.deepseek_suggestions || "").trim();
        if (vizSuggestion) {
            $("vizSuggestionBox").style.display = "block";
            // Strip markdown strong or bullet points if any, to keep it clean (or just use innerHTML)
            $("vizSuggestionText").innerHTML = marked.parseInline(vizSuggestion);
        } else {
            $("vizSuggestionBox").style.display = "none";
        }

        const deepText = [data.deepseek_analysis].join("");
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

function buildPdfFileName() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    return `硒产业分析报告-${yyyy}${mm}${dd}-${hh}${mi}.pdf`;
}

function extractFileNameFromDisposition(disposition) {
    if (!disposition) return "";
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match && utf8Match[1]) {
        try {
            return decodeURIComponent(utf8Match[1]);
        } catch {
            return utf8Match[1];
        }
    }

    const basicMatch = disposition.match(/filename="?([^";]+)"?/i);
    return basicMatch && basicMatch[1] ? basicMatch[1] : "";
}

async function exportReportAsServerPdf(markdown, fallbackName) {
    const res = await fetch(`${API_BASE}/export_pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown, file_name: fallbackName }),
    });

    if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        const raw = await res.text();
        if (raw) {
            try {
                const payload = JSON.parse(raw);
                if (payload && payload.detail) {
                    errMsg = String(payload.detail);
                } else {
                    errMsg = raw;
                }
            } catch {
                errMsg = raw;
            }
        }
        throw new Error(errMsg);
    }

    const blob = await res.blob();
    if (!blob || blob.size <= 0) {
        throw new Error("服务端返回了空 PDF");
    }

    const fromHeader = extractFileNameFromDisposition(res.headers.get("content-disposition"));
    const finalName = (fromHeader || fallbackName || "report.pdf").replace(/[\\/:*?"<>|]+/g, "_");
    const downloadUrl = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = finalName.toLowerCase().endsWith(".pdf") ? finalName : `${finalName}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(downloadUrl), 15000);
}

function buildPrintDocumentHtml(renderedHtml) {
    const safeHtml = removeScriptTags(renderedHtml);
    const style = buildPrintDocumentStyle();
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
</body>
</html>`;
}

function printReportInHiddenFrame(documentHtml) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement("iframe");
        frame.style.position = "fixed";
        frame.style.right = "0";
        frame.style.bottom = "0";
        frame.style.width = "1px";
        frame.style.height = "1px";
        frame.style.border = "0";
        frame.style.opacity = "0";
        frame.setAttribute("aria-hidden", "true");

        let finished = false;
        const safeCleanup = () => {
            setTimeout(() => {
                if (frame.parentNode) frame.parentNode.removeChild(frame);
            }, 1200);
        };
        const finish = () => {
            if (finished) return;
            finished = true;
            safeCleanup();
            resolve();
        };
        const fail = (reason) => {
            if (finished) return;
            finished = true;
            safeCleanup();
            reject(reason instanceof Error ? reason : new Error(String(reason)));
        };

        frame.onload = async () => {
            try {
                const win = frame.contentWindow;
                const doc = frame.contentDocument;
                if (!win || !doc) {
                    fail(new Error("打印框架初始化失败"));
                    return;
                }

                const onAfterPrint = () => {
                    win.removeEventListener("afterprint", onAfterPrint);
                    finish();
                };
                win.addEventListener("afterprint", onAfterPrint);

                if (doc.fonts && doc.fonts.ready) {
                    await doc.fonts.ready;
                }

                setTimeout(() => {
                    try {
                        win.focus();
                        win.print();
                        // Some browsers do not fire afterprint reliably.
                        setTimeout(finish, 1600);
                    } catch (error) {
                        fail(error);
                    }
                }, 80);
            } catch (error) {
                fail(error);
            }
        };

        document.body.appendChild(frame);
        const frameDoc = frame.contentDocument;
        if (!frameDoc) {
            fail(new Error("无法创建打印文档"));
            return;
        }
        frameDoc.open();
        frameDoc.write(documentHtml);
        frameDoc.close();
    });
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
        exportBtn.textContent = "生成中...";
    }
    if (statusEl) statusEl.textContent = "正在直接导出 PDF...";

    try {
        const markdown = buildReportMarkdown(latestAnalysisResult);
        if (!markdown || !markdown.replace(/\s/g, "")) {
            throw new Error("导出内容为空");
        }

        const preferredName = buildPdfFileName();
        await exportReportAsServerPdf(markdown, preferredName);
        if (statusEl) statusEl.textContent = "PDF 已直接下载。";
    } catch (err) {
        console.error(err);
        if (statusEl) {
            statusEl.textContent = `导出失败：${err.message || err}。请先确认后端已重启并可访问 /export_pdf。`;
        }
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
    requestWorkbenchResize();
    syncChatPanelWidthToViewport();
});



// Chat Resizer Logic (supports mouse + touch/pointer)
const chatResizer = document.getElementById("chatResizer");
const chatPanel = document.getElementById("chatPanel");
const CHAT_PANEL_WIDTH_KEY = "xi_agent_chat_panel_width_v1";
const TABLET_BREAKPOINT = 1366;

function getChatResizeBounds() {
    const isTabletLike = window.innerWidth <= TABLET_BREAKPOINT;
    const minWidth = isTabletLike ? 260 : 420;
    const maxWidthRatio = isTabletLike ? 0.7 : 0.8;
    const maxWidth = Math.max(minWidth + 20, Math.floor(window.innerWidth * maxWidthRatio));
    return { minWidth, maxWidth };
}

function constrainChatWidth(width) {
    const { minWidth, maxWidth } = getChatResizeBounds();
    return Math.max(minWidth, Math.min(Math.floor(width), maxWidth));
}

function applyChatPanelWidth(width, persist = true) {
    if (!chatPanel || !Number.isFinite(width)) return;
    const constrained = constrainChatWidth(width);
    chatPanel.style.width = `${constrained}px`;
    if (!persist) return;
    try {
        localStorage.setItem(CHAT_PANEL_WIDTH_KEY, String(constrained));
    } catch {
        // ignore localStorage failure
    }
}

function syncChatPanelWidthToViewport() {
    if (!chatPanel) return;
    const currentWidth = chatPanel.getBoundingClientRect().width;
    if (!Number.isFinite(currentWidth) || currentWidth <= 0) return;
    applyChatPanelWidth(currentWidth, false);
}

function restoreChatPanelWidth() {
    if (!chatPanel) return;
    let rawWidth = null;
    try {
        rawWidth = localStorage.getItem(CHAT_PANEL_WIDTH_KEY);
    } catch {
        rawWidth = null;
    }
    const parsedWidth = Number(rawWidth);
    if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
        syncChatPanelWidthToViewport();
        requestWorkbenchResize();
        return;
    }
    applyChatPanelWidth(parsedWidth, false);
    requestWorkbenchResize();
}

if (chatResizer && chatPanel) {
    let isResizing = false;
    let activePointerId = null;

    const beginResize = () => {
        isResizing = true;
        chatPanel.classList.add("no-transition");
        chatResizer.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    const updateResize = (clientX) => {
        if (!isResizing || !Number.isFinite(clientX)) return;
        const nextWidth = window.innerWidth - clientX;
        applyChatPanelWidth(nextWidth, false);
    };

    const endResize = () => {
        if (!isResizing) return;
        isResizing = false;
        activePointerId = null;
        chatPanel.classList.remove("no-transition");
        chatResizer.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        applyChatPanelWidth(chatPanel.getBoundingClientRect().width, true);
        requestWorkbenchResize();
    };

    if (window.PointerEvent) {
        chatResizer.addEventListener("pointerdown", (e) => {
            activePointerId = e.pointerId;
            beginResize();
            chatResizer.setPointerCapture(e.pointerId);
            updateResize(e.clientX);
            e.preventDefault();
        });

        chatResizer.addEventListener("pointermove", (e) => {
            if (!isResizing) return;
            if (activePointerId !== null && e.pointerId !== activePointerId) return;
            updateResize(e.clientX);
        });

        chatResizer.addEventListener("pointerup", () => {
            endResize();
        });

        chatResizer.addEventListener("pointercancel", () => {
            endResize();
        });
    } else {
        chatResizer.addEventListener("mousedown", (e) => {
            beginResize();
            updateResize(e.clientX);
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            updateResize(e.clientX);
        });

        document.addEventListener("mouseup", () => {
            endResize();
        });

        chatResizer.addEventListener(
            "touchstart",
            (e) => {
                if (!e.touches || e.touches.length === 0) return;
                beginResize();
                updateResize(e.touches[0].clientX);
                e.preventDefault();
            },
            { passive: false }
        );

        document.addEventListener(
            "touchmove",
            (e) => {
                if (!isResizing || !e.touches || e.touches.length === 0) return;
                updateResize(e.touches[0].clientX);
                e.preventDefault();
            },
            { passive: false }
        );

        document.addEventListener("touchend", () => {
            endResize();
        });

        document.addEventListener("touchcancel", () => {
            endResize();
        });
    }

    restoreChatPanelWidth();
}
