FROM python:3.12-slim

WORKDIR /app
RUN useradd -m -u 1000 appuser && mkdir -p /map && chown -R appuser:appuser /app /map
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir gunicorn==23.0.0
COPY app/ ./app/
COPY tests/ ./tests/
COPY pytest.ini .

ENV PYTHONUNBUFFERED=1 \
    MAP_DATABASE_PATH=/map/map.db \
    MAP_FILES=/map/plans \
    MOCLO_DATABASE_PATH=/moclo/moclo.db \
    SUITE_DATABASE_PATH=/suite/suite.db \
    URL_PREFIX=/map \
    PORT=5010
USER appuser
EXPOSE 5010
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5010/map/health')" || exit 1
CMD ["gunicorn", "--bind", "0.0.0.0:5010", "--workers", "1", "--threads", "4", "--timeout", "180", "app.main:app"]
