FROM python:3.11-slim
WORKDIR /app
COPY . .
CMD ["uvicorn","transformer:app","--host","0.0.0.0","--port","8000"]
