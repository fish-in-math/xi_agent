from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict

import numpy as np
import pandas as pd

from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.encoders import jsonable_encoder
from fastapi.staticfiles import StaticFiles

from .charting import load_dataframe, summarize_dataframe, generate_default_figures
from .deepseek_client import generate_chart_suggestions, generate_text_analysis, DeepSeekError
from .coze_service import generate_industry_report

BASE_DIR = Path(__file__).parent
FRONTEND_DIR = BASE_DIR / "frontend"
INDEX_FILE = FRONTEND_DIR / "index.html"

app = FastAPI(title="Se Industry Agent (硒产业智能体)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve frontend static assets
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


@app.get("/")
def serve_index() -> FileResponse:
    if not INDEX_FILE.exists():
        raise HTTPException(status_code=404, detail="frontend/index.html not found")
    return FileResponse(str(INDEX_FILE))


@app.post("/analyze")
def analyze(file: UploadFile = File(...), prompt: str | None = Form(None)) -> JSONResponse:
    try:
        data = file.file.read()
    finally:
        file.file.close()

    try:
        df = load_dataframe(data, file.filename)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse file: {e}")

    summary = summarize_dataframe(df)
    figures = generate_default_figures(df)

    deepseek_suggestions = ""
    deepseek_analysis = ""
    try:
        deepseek_suggestions = generate_chart_suggestions(summary, user_prompt=prompt)
        deepseek_analysis = generate_text_analysis(summary, domain_hint="硒产业", user_prompt=prompt)
    except Exception as e:
        # Catch all DeepSeek-related failures (network, key, quota) and degrade gracefully
        deepseek_suggestions = f"[DeepSeek unavailable] {e}"
        deepseek_analysis = deepseek_suggestions

    coze_report = ""
    try:
        coze_report = generate_industry_report(summary, extra_instruction=prompt)
    except Exception as e:
        coze_report = f"[Coze unavailable] {e}"

    payload: Dict[str, Any] = {
        "summary": summary,
        "figures": figures,
        "deepseek_suggestions": deepseek_suggestions,
        "deepseek_analysis": deepseek_analysis,
        "coze_report": coze_report,
    }
    safe_payload = jsonable_encoder(
        payload,
        custom_encoder={
            np.ndarray: lambda x: x.tolist(),
            np.generic: lambda x: x.item(),
            pd.Series: lambda x: x.tolist(),
            pd.DataFrame: lambda x: x.to_dict(orient="records"),
            tuple: lambda x: list(x),
        },
    )
    return JSONResponse(safe_payload)
