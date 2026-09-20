FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

WORKDIR /app

# 先装依赖，利用层缓存
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 应用代码、静态资源与内置示例数据
COPY app/ ./app/
COPY static/ ./static/
COPY data/sample_state.json ./data/sample_state.json

# 运行期状态文件目录（首次启动自动由示例数据生成 state.json）
RUN mkdir -p /app/data

EXPOSE 8000

# 单 worker：状态保存在本地 JSON 文件，多 worker 亦安全（原子替换），
# 这里保持单进程即可满足窑车现场单机使用。
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT} --workers 1 --timeout 30 'app.server:app'"]
