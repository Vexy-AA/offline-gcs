# Data-preparation tools for the offline GCS stack.
#
# Everything is pinned so a rebuild gives the same tool chain:
#   Ubuntu 24.04 release packages (GDAL 3.8.4, numpy 1.26.4) + hash-pinned pydelatin.
#
#   docker compose build tools
#   docker compose up -d tools          -> the tools page on :8095
#   docker compose run --rm tools --help
FROM ubuntu:24.04

ARG GDAL_VERSION=3.8.4+dfsg-3ubuntu3
ARG NUMPY_VERSION=1:1.26.4+ds-6ubuntu1

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        gdal-bin=${GDAL_VERSION} python3-gdal=${GDAL_VERSION} python3-numpy=${NUMPY_VERSION} \
        python3-pip bc ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /opt/gcs-tools/requirements.txt
RUN pip3 install --break-system-packages --require-hashes --no-deps -r /opt/gcs-tools/requirements.txt

COPY gcs_tools /opt/gcs-tools/gcs_tools
COPY tests /opt/gcs-tools/tests

# open-elevation's create-tiles.sh is bind-mounted here by docker-compose.yml
ENV PYTHONPATH=/opt/gcs-tools \
    OPEN_ELEVATION_TILES_SCRIPT=/opt/open-elevation/create-tiles.sh \
    HOME=/tmp

WORKDIR /data
EXPOSE 8095
ENTRYPOINT ["python3", "-m", "gcs_tools"]
CMD ["serve"]
