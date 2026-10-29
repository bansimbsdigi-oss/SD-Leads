#!/bin/sh
# Least-privilege role for the app. Migrations run as the owner ($POSTGRES_USER).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE ${POSTGRES_APP_USER:-sabhi_app} LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}';
-- A runaway query can't hold the database; migrations (owner role) are not limited.
ALTER ROLE ${POSTGRES_APP_USER:-sabhi_app} SET statement_timeout = '15s';
GRANT CONNECT ON DATABASE $POSTGRES_DB TO ${POSTGRES_APP_USER:-sabhi_app};
GRANT USAGE ON SCHEMA public TO ${POSTGRES_APP_USER:-sabhi_app};
ALTER DEFAULT PRIVILEGES FOR ROLE $POSTGRES_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_APP_USER:-sabhi_app};
ALTER DEFAULT PRIVILEGES FOR ROLE $POSTGRES_USER IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${POSTGRES_APP_USER:-sabhi_app};
SQL
