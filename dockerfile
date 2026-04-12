FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Optional mirror support for faster installs in CN networks.
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

# Install dependencies first to maximize Docker layer cache hit rate.
COPY requirements.txt ./
# 升级pip并安装依赖（使用阿里云源 + 超时设置）
RUN python -m pip install --upgrade pip -i https://mirrors.aliyun.com/pypi/simple/ \
    --default-timeout=100

RUN python -m pip install -r requirements.txt \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --default-timeout=200 \
    --no-cache-dir
# Copy only runtime files.
COPY src ./src

# Run as non-root for better container security.
RUN groupadd --system appgroup \
    && useradd --system --gid appgroup --create-home --home-dir /home/appuser appuser \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 8000

# Basic liveness check against root endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os,urllib.request;port=os.getenv('PORT','8000');urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=3)" || exit 1

# Use environment variables for cloud platforms (e.g. PORT injection).
CMD ["sh", "-c", "python -m uvicorn src.server:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${UVICORN_WORKERS:-2}"]
