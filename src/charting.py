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


def generate_default_figures(df: pd.DataFrame) -> List[Dict[str, Any]]:
    figs: List[Dict[str, Any]] = []

    x, y = _pick_axes(df)
    # Histogram for first numeric column
    if x is not None:
        fig_hist = px.histogram(df, x=x, nbins=30, title=f"Distribution of {x}")
        figs.append(fig_hist.to_plotly_json())

    # Scatter if at least two numeric columns
    if x is not None and y is not None:
        fig_scatter = px.scatter(df, x=x, y=y, title=f"Scatter: {x} vs {y}")
        figs.append(fig_scatter.to_plotly_json())

    # Bar chart for first categorical column vs first numeric (mean)
    cat_cols = df.select_dtypes(exclude=[np.number]).columns.tolist()
    if cat_cols and x is not None:
        cat = cat_cols[0]
        grouped = df.groupby(cat)[x].mean().reset_index()
        fig_bar = px.bar(grouped, x=cat, y=x, title=f"Mean {x} by {cat}")
        figs.append(fig_bar.to_plotly_json())

    # Line chart for time-like index if present
    time_cols = [c for c in df.columns if pd.api.types.is_datetime64_any_dtype(df[c])]
    if time_cols and x is not None:
        t = time_cols[0]
        fig_line = px.line(df.sort_values(t), x=t, y=x, title=f"Trend of {x} over {t}")
        figs.append(fig_line.to_plotly_json())

    return figs
