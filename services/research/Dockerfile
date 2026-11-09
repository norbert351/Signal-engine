FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY signal_engine_research ./signal_engine_research
RUN pip install --no-cache-dir . fastapi uvicorn
EXPOSE 8000
CMD ["uvicorn","signal_engine_research.api:app","--host","0.0.0.0","--port","8000"]
