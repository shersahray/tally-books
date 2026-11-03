FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 audit && useradd -u 10001 -g audit --home /nonexistent --shell /usr/sbin/nologin audit
WORKDIR /worker
COPY src/server/audit-pdf.js src/server/audit-worker-cli.js ./
USER 10001:10001
ENV HOME=/tmp
CMD ["node","audit-worker-cli.js"]
