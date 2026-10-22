FROM postgis/postgis:16-3.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /docker-entrypoint-initdb.d/10_postgis.sh
COPY initdb/ /docker-entrypoint-initdb.d/
