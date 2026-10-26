# UAVLogViewer: nginx serving the prebuilt release from github.com/Vexy-AA/UAVLogViewer.
#
# To move to another release, change both values (sha256sum logviewer.tar.gz)
# and run: docker compose up -d --build logviewer
# nginx.conf and runtime-config.js stay outside the image (bind-mounted by
# docker-compose.yml), so they can be edited without a rebuild.
FROM nginx:alpine

ARG LOGVIEWER_VERSION=v1.0.3
ARG LOGVIEWER_SHA256=2c5001084059505abf0aa0ae9304464f7d630d9751192f0fa3bd5abc7641d79e

ADD https://github.com/Vexy-AA/UAVLogViewer/releases/download/${LOGVIEWER_VERSION}/logviewer.tar.gz /tmp/logviewer.tar.gz
RUN echo "${LOGVIEWER_SHA256}  /tmp/logviewer.tar.gz" | sha256sum -c - \
 && rm -rf /usr/share/nginx/html/* \
 && tar -xzf /tmp/logviewer.tar.gz -C /tmp \
 && cp -a /tmp/dist/. /usr/share/nginx/html/ \
 && rm -rf /tmp/dist /tmp/logviewer.tar.gz \
 && echo "${LOGVIEWER_VERSION}" > /usr/share/nginx/html/logviewer-version.txt
