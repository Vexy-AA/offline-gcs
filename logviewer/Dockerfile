# UAVLogViewer: nginx serving the prebuilt release from github.com/Vexy-AA/UAVLogViewer.
#
# The release file is taken from logviewer/logviewer.tar.gz if you put it there
# (no download), otherwise downloaded with curl (retries, resumes, gives up on a
# stalled connection). Either way it must match LOGVIEWER_SHA256.
#
# To move to another release, change both values (sha256sum logviewer.tar.gz),
# the image tag in docker-compose.yml, and run: docker compose up -d --build logviewer
# nginx.conf and runtime-config.js stay outside the image (bind-mounted by
# docker-compose.yml), so they can be edited without a rebuild.
FROM nginx:alpine AS fetch

ARG LOGVIEWER_VERSION=v1.0.3
ARG LOGVIEWER_SHA256=2c5001084059505abf0aa0ae9304464f7d630d9751192f0fa3bd5abc7641d79e
ARG LOGVIEWER_URL=https://github.com/Vexy-AA/UAVLogViewer/releases/download/${LOGVIEWER_VERSION}/logviewer.tar.gz

# "logviewer.tar.g[z]" matches nothing when the file is absent, which COPY allows
# as long as another source (the Dockerfile) exists.
COPY Dockerfile logviewer.tar.g[z] /tmp/lv/

RUN set -e; f=/tmp/lv/logviewer.tar.gz; \
    if [ -f "$f" ] && echo "${LOGVIEWER_SHA256}  $f" | sha256sum -c - >/dev/null 2>&1; then \
        echo "Using logviewer/logviewer.tar.gz"; \
    else \
        rm -f "$f"; \
        echo "Downloading ${LOGVIEWER_URL}"; \
        if command -v curl >/dev/null; then \
            curl -fL --retry 8 --retry-delay 5 --retry-all-errors -C - \
                 --connect-timeout 30 --speed-limit 1024 --speed-time 120 \
                 -o "$f" "${LOGVIEWER_URL}"; \
        else \
            wget -T 120 -O "$f" "${LOGVIEWER_URL}"; \
        fi; \
    fi; \
    echo "${LOGVIEWER_SHA256}  $f" | sha256sum -c - \
      || { echo "logviewer.tar.gz does not match LOGVIEWER_SHA256 (wrong file or incomplete download)"; exit 1; }; \
    tar -xzf "$f" -C /tmp/lv; \
    echo "${LOGVIEWER_VERSION}" > /tmp/lv/dist/logviewer-version.txt

# Final image: only the unpacked app, not the archive
FROM nginx:alpine
RUN rm -rf /usr/share/nginx/html/*
COPY --from=fetch /tmp/lv/dist/ /usr/share/nginx/html/
