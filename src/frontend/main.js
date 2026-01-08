const $ = (id) => document.getElementById(id);

// Dynamically load a script by URL
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load: ${src}`));
        document.head.appendChild(s);
    });
}

// Ensure Plotly is available; try fallback CDN if missing
async function ensurePlotly() {
    if (window.Plotly) return;
    try {
        await loadScript("https://cdn.plot.ly/plotly-2.29.1.min.js");
    } catch {
        await loadScript("https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.29.1/plotly.min.js");
    }
    if (!window.Plotly) throw new Error("Plotly 加载失败，请检查网络或 CDN 访问");
}

const API_BASE = ""; // same origin

const BASE_LAYOUT = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#e5e7eb", family: "Inter, system-ui" },
    margin: { l: 50, r: 30, t: 50, b: 50, pad: 6 },
    xaxis: { gridcolor: "rgba(148,163,184,0.2)", zeroline: false, linecolor: "rgba(148,163,184,0.3)" },
    yaxis: { gridcolor: "rgba(148,163,184,0.2)", zeroline: false, linecolor: "rgba(148,163,184,0.3)" },
    legend: { bgcolor: "rgba(0,0,0,0)", bordercolor: "rgba(255,255,255,0.08)" },
    hoverlabel: { bgcolor: "#0f172a", bordercolor: "#6ee7ff" },
};

const BASE_CONFIG = {
    responsive: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["select2d", "lasso2d", "zoomIn2d", "zoomOut2d"],
};

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

        // Summary
        $("summary").textContent = JSON.stringify(data.summary, null, 2);

        // Charts
        const charts = $("charts");
        charts.innerHTML = "";
        (data.figures || []).forEach((fig, i) => {
            const div = document.createElement("div");
            div.className = "chart";
            div.id = `plot-${i}`;
            div.style.minHeight = "320px";
            charts.appendChild(div);
            const layout = { ...BASE_LAYOUT, ...(fig.layout || {}), autosize: true };
            Plotly.newPlot(div.id, fig.data, layout, BASE_CONFIG);
        });

        // DeepSeek text
        const deepText = [data.deepseek_suggestions, "\n\n", data.deepseek_analysis].join("");
        $("deepseekText").value = deepText;

        // Coze
        $("cozeText").value = data.coze_report;
    } catch (err) {
        console.error(err);
        $("status").textContent = `出错：${err}`;
    }
});
