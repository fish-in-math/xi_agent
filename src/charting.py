from __future__ import annotations

import io
from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd
import plotly.express as px


SUPPORTED_TEXT_EXTS = {".csv"}
SUPPORTED_EXCEL_EXTS = {".xlsx", ".xls"}


def load_dataframe(file_bytes: bytes, filename: str) -> pd.DataFrame:
    name = filename.lower()
    if any(name.endswith(ext) for ext in SUPPORTED_TEXT_EXTS):
        return pd.read_csv(io.BytesIO(file_bytes))
    if any(name.endswith(ext) for ext in SUPPORTED_EXCEL_EXTS):
        engine = "openpyxl" if name.endswith(".xlsx") else "xlrd"
        try:
            return pd.read_excel(io.BytesIO(file_bytes), engine=engine)
        except ImportError as e:
            # Provide clearer error when engine is missing
            raise ImportError(
                "缺少 Excel 依赖，请安装: pip install openpyxl xlrd"
            ) from e
    # Attempt CSV as fallback
    return pd.read_csv(io.BytesIO(file_bytes))


def summarize_dataframe(df: pd.DataFrame) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}
    summary["rows"], summary["cols"] = int(df.shape[0]), int(df.shape[1])
    summary["columns"] = [str(c) for c in df.columns]
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    categorical_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()
    summary["numeric_columns"] = numeric_cols
    summary["categorical_columns"] = categorical_cols
    if numeric_cols:
        desc = df[numeric_cols].describe().to_dict()
        summary["describe"] = desc
    # top categories for first categorical col if any
    if categorical_cols:
        col = categorical_cols[0]
        top_counts = df[col].value_counts().head(10)
        summary["top_categories"] = {col: top_counts.to_dict()}
    return summary


def _pick_axes(df: pd.DataFrame) -> Tuple[str | None, str | None]:
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    if len(numeric_cols) >= 2:
        return numeric_cols[0], numeric_cols[1]
    if len(numeric_cols) == 1:
        return numeric_cols[0], None
    return None, None


def _apply_theme(fig):
    fig.update_layout(
        template="plotly_white",
        font=dict(family="Noto Sans SC, PingFang SC, sans-serif", size=13, color="#334155"),
        title=dict(font=dict(size=16, color="#0f172a")),
        margin=dict(l=40, r=20, t=60, b=40),
        colorway=["#0ea5a4", "#f59e0b", "#3b82f6", "#8b5cf6", "#ec4899", "#10b981"],
        hoverlabel=dict(bgcolor="white", font_size=13),
        title_x=0.02
    )
    fig.update_xaxes(showgrid=False, linecolor="#cbd5e1", title_font=dict(size=13))
    fig.update_yaxes(showgrid=True, gridcolor="#f1f5f9", linecolor="#cbd5e1", zeroline=False, title_font=dict(size=13))
    return fig


def generate_default_figures(df: pd.DataFrame, style_hint: str | None = None) -> List[Dict[str, Any]]:
    figs: List[Dict[str, Any]] = []

    x, y = _pick_axes(df)
    # Histogram for first numeric column
    if x is not None:
        fig_hist = px.histogram(df, x=x, nbins=30, title=f"📊 分布情况: {x}")
        fig_hist.update_traces(marker=dict(line=dict(width=1, color='white')), opacity=0.8)
        fig_hist = _apply_theme(fig_hist)
        _apply_style_hint(fig_hist, style_hint)
        figs.append(fig_hist.to_plotly_json())

    # Scatter if at least two numeric columns
    if x is not None and y is not None:
        fig_scatter = px.scatter(df, x=x, y=y, title=f"📈 散点分析: {x} vs {y}")
        fig_scatter.update_traces(marker=dict(size=8, opacity=0.7, line=dict(width=1, color='white')))
        fig_scatter = _apply_theme(fig_scatter)
        _apply_style_hint(fig_scatter, style_hint)
        figs.append(fig_scatter.to_plotly_json())

    # Bar chart for first categorical column vs first numeric (mean)
    cat_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()
    if cat_cols and x is not None:
        cat = cat_cols[0]
        # limit to top 15 defaults so it doesn't get squished
        grouped = df.groupby(cat)[x].mean().reset_index().nlargest(15, x)
        fig_bar = px.bar(grouped, x=cat, y=x, title=f"📊 平均值对比: {x} 按 {cat}")
        fig_bar.update_traces(marker_line_width=0, opacity=0.9, width=0.5)
        fig_bar = _apply_theme(fig_bar)
        _apply_style_hint(fig_bar, style_hint)
        figs.append(fig_bar.to_plotly_json())

    # Line chart for time-like index if present
    time_cols = [c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])]
    if time_cols and x is not None:
        t = time_cols[0]
        fig_line = px.line(df.sort_values(t), x=t, y=x, title=f"📉 趋势走势: {x} 随 {t} 变化")
        fig_line.update_traces(line=dict(width=3))
        fig_line = _apply_theme(fig_line)
        _apply_style_hint(fig_line, style_hint)
        figs.append(fig_line.to_plotly_json())

    return figs


def _first_time_like_column(df: pd.DataFrame) -> str | None:
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            return col

    for col in df.columns:
        series = df[col]
        if not pd.api.types.is_object_dtype(series):
            continue
        parsed = pd.to_datetime(series, errors="coerce")
        if parsed.notna().mean() >= 0.7:
            return col
    return None


def _apply_style_hint(fig, style_hint: str | None) -> List[str]:
    if not style_hint:
        return []

    hint = style_hint.lower()
    applied: List[str] = []

    def apply_palette(palette: List[str]) -> None:
        for i, trace in enumerate(fig.data):
            color = palette[i % len(palette)]
            trace_type = getattr(trace, "type", "")

            if trace_type in {"pie", "sunburst", "treemap", "funnelarea"}:
                if hasattr(trace, "marker") and trace.marker is not None:
                    try:
                        trace.marker.colors = palette
                    except Exception:
                        pass
                continue

            if hasattr(trace, "marker") and trace.marker is not None:
                try:
                    trace.marker.color = color
                except Exception:
                    pass

            if hasattr(trace, "line") and trace.line is not None:
                try:
                    trace.line.color = color
                except Exception:
                    pass

    if any(k in hint for k in ["深色", "dark"]):
        fig.update_layout(
            template="plotly_dark",
            paper_bgcolor="rgba(15,23,42,0.88)",
            plot_bgcolor="rgba(15,23,42,0.65)",
            font=dict(color="#e2e8f0"),
        )
        fig.update_xaxes(gridcolor="rgba(148,163,184,0.25)", linecolor="rgba(148,163,184,0.5)")
        fig.update_yaxes(gridcolor="rgba(148,163,184,0.25)", linecolor="rgba(148,163,184,0.5)")
        applied.append("深色主题")

    if any(k in hint for k in ["浅色", "light", "明亮"]):
        fig.update_layout(
            template="plotly_white",
            paper_bgcolor="rgba(255,255,255,0.88)",
            plot_bgcolor="rgba(255,255,255,0.72)",
            font=dict(color="#334155"),
        )
        applied.append("浅色主题")

    if any(k in hint for k in ["暖色", "橙", "红", "warm"]):
        warm_palette = ["#dc2626", "#f97316", "#f59e0b", "#fb7185", "#eab308"]
        fig.update_layout(colorway=warm_palette)
        apply_palette(warm_palette)
        applied.append("暖色配色")
    elif any(k in hint for k in ["冷色", "蓝", "青", "cool"]):
        cool_palette = ["#0ea5e9", "#3b82f6", "#14b8a6", "#06b6d4", "#22c55e"]
        fig.update_layout(colorway=cool_palette)
        apply_palette(cool_palette)
        applied.append("冷色配色")

    if any(k in hint for k in ["绿色", "绿", "自然", "nature"]):
        green_palette = ["#2a9d8f", "#10b981", "#34d399", "#6ee7b7", "#059669"]
        fig.update_layout(colorway=green_palette)
        if any(k in hint for k in ["学术"]):
            # Nature 学术感：更克制的色调、网格淡化、边框加深
            green_palette = ["#457b9d", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51"]
            fig.update_layout(
                colorway=green_palette,
                plot_bgcolor="rgba(255,255,255,1)",
                paper_bgcolor="rgba(255,255,255,1)",
                font=dict(family="Arial, sans-serif", color="#333333")
            )
            fig.update_xaxes(showline=True, linewidth=1, linecolor='black', mirror=True, showgrid=False)
            fig.update_yaxes(showline=True, linewidth=1, linecolor='black', mirror=True, showgrid=True, gridcolor="rgba(0,0,0,0.05)")
        apply_palette(green_palette)
        applied.append("自然学术/绿色配色")

    if any(k in hint for k in ["极简", "简约", "minimal"]):
        fig.update_xaxes(showgrid=False)
        fig.update_yaxes(showgrid=False)
        fig.update_layout(showlegend=False)
        applied.append("极简风格")

    if any(k in hint for k in ["加粗", "粗线", "线条粗"]):
        for trace in fig.data:
            if hasattr(trace, "line") and trace.line is not None:
                try:
                    trace.line.width = 4
                except Exception:
                    pass
            if hasattr(trace, "marker") and trace.marker is not None and hasattr(trace.marker, "line"):
                try:
                    trace.marker.line.width = 2
                except Exception:
                    pass
        applied.append("线条加粗")

    if any(k in hint for k in ["透明", "半透明", "玻璃"]):
        fig.update_traces(opacity=0.6)
        if "玻璃" in hint:
            fig.update_layout(
                paper_bgcolor="rgba(255,255,255,0.2)",
                plot_bgcolor="rgba(255,255,255,0.1)",
            )
        applied.append("半透明/玻璃质感")

    if any(k in hint for k in ["淡蓝"]):
        blue_palette = ["#7dd3fc", "#38bdf8", "#0ea5e9", "#0284c7"]
        fig.update_layout(colorway=blue_palette)
        apply_palette(blue_palette)
        if "透明" not in hint:
            fig.update_traces(opacity=0.85)
        applied.append("淡蓝配色")

    if any(k in hint for k in ["高对比", "对比"]):
        fig.update_layout(
            font=dict(color="#0f172a"),
            title=dict(font=dict(size=18, color="#0f172a")),
        )
        fig.update_xaxes(showgrid=True, gridcolor="rgba(15,23,42,0.18)")
        fig.update_yaxes(showgrid=True, gridcolor="rgba(15,23,42,0.18)")
        applied.append("高对比")

    if not applied and style_hint.strip():
        # Fallback: ensure user can observe a style change even if no keyword was matched.
        fallback_palette = ["#0ea5a4", "#f59e0b", "#3b82f6", "#ef4444"]
        fig.update_layout(colorway=fallback_palette)
        apply_palette(fallback_palette)
        fig.update_layout(title=dict(font=dict(size=18)))
        applied.append("通用样式增强")

    return applied


def generate_preset_figure(
    df: pd.DataFrame,
    preset: str,
    style_hint: str | None = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    preset_key = (preset or "").strip().lower()
    allowed = {"bar", "line", "scatter", "histogram", "box", "pie"}
    if preset_key not in allowed:
        raise ValueError(f"不支持的图表类型: {preset_key}")

    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    categorical_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()
    x, y = _pick_axes(df)

    if preset_key in {"line", "scatter", "histogram", "box", "bar"} and not numeric_cols:
        raise ValueError("当前数据没有可用于该图表的数值列")

    if preset_key == "histogram":
        fig = px.histogram(df, x=numeric_cols[0], nbins=30, title=f"📊 直方图: {numeric_cols[0]}")
        fig.update_traces(marker=dict(line=dict(width=1, color="white")), opacity=0.82)
        meta = {"x": numeric_cols[0], "y": "计数", "preset": "直方图"}

    elif preset_key == "scatter":
        if len(numeric_cols) < 2:
            raise ValueError("散点图至少需要两列数值字段")
        fig = px.scatter(df, x=numeric_cols[0], y=numeric_cols[1], title=f"📈 散点图: {numeric_cols[0]} vs {numeric_cols[1]}")
        fig.update_traces(marker=dict(size=8, opacity=0.75, line=dict(width=1, color="white")))
        meta = {"x": numeric_cols[0], "y": numeric_cols[1], "preset": "散点图"}

    elif preset_key == "box":
        y_col = numeric_cols[0]
        x_col = categorical_cols[0] if categorical_cols else None
        if x_col:
            top_cats = df[x_col].value_counts().head(15).index
            box_df = df[df[x_col].isin(top_cats)]
            fig = px.box(box_df, x=x_col, y=y_col, title=f"📦 箱线图: {y_col} 按 {x_col}")
        else:
            fig = px.box(df, y=y_col, title=f"📦 箱线图: {y_col}")
        meta = {"x": x_col or "样本", "y": y_col, "preset": "箱线图"}

    elif preset_key == "line":
        y_col = numeric_cols[0]
        t_col = _first_time_like_column(df)
        if t_col:
            line_df = df.copy()
            line_df[t_col] = pd.to_datetime(line_df[t_col], errors="coerce")
            line_df = line_df.dropna(subset=[t_col]).sort_values(t_col)
            fig = px.line(line_df, x=t_col, y=y_col, title=f"📉 折线图: {y_col} 随 {t_col} 变化")
            meta = {"x": t_col, "y": y_col, "preset": "折线图"}
        else:
            line_df = df.reset_index(drop=True).copy()
            line_df["_index"] = line_df.index
            fig = px.line(line_df, x="_index", y=y_col, title=f"📉 折线图: {y_col} 随样本序号变化")
            meta = {"x": "样本序号", "y": y_col, "preset": "折线图"}
        fig.update_traces(line=dict(width=3))

    elif preset_key == "pie":
        if categorical_cols:
            col = categorical_cols[0]
            pie_df = (
                df[col]
                .value_counts()
                .head(10)
                .rename_axis(col)
                .reset_index(name="count")
            )
            fig = px.pie(pie_df, names=col, values="count", title=f"🥧 饼图: {col} 占比")
            meta = {"x": col, "y": "count", "preset": "饼图"}
        elif numeric_cols:
            col = numeric_cols[:6]
            pie_df = pd.DataFrame({"字段": col, "值": [float(df[c].mean()) for c in col]})
            fig = px.pie(pie_df, names="字段", values="值", title="🥧 饼图: 数值字段均值占比")
            meta = {"x": "字段", "y": "值", "preset": "饼图"}
        else:
            raise ValueError("当前数据不适合生成饼图")

    else:  # bar
        if categorical_cols:
            cat_col = categorical_cols[0]
            num_col = numeric_cols[0]
            bar_df = (
                df.groupby(cat_col, dropna=False)[num_col]
                .mean()
                .reset_index()
                .nlargest(15, num_col)
            )
            fig = px.bar(bar_df, x=cat_col, y=num_col, title=f"📊 柱状图: {num_col} 按 {cat_col}")
            meta = {"x": cat_col, "y": num_col, "preset": "柱状图"}
        else:
            num_col = numeric_cols[0]
            bar_df = df[[num_col]].head(20).reset_index().rename(columns={"index": "样本序号"})
            fig = px.bar(bar_df, x="样本序号", y=num_col, title=f"📊 柱状图: {num_col} 前20条")
            meta = {"x": "样本序号", "y": num_col, "preset": "柱状图"}
        fig.update_traces(marker_line_width=0, opacity=0.9)

    fig = _apply_theme(fig)
    applied_style = _apply_style_hint(fig, style_hint)
    meta["applied_style"] = applied_style or ["默认主题"]
    return fig.to_plotly_json(), meta
