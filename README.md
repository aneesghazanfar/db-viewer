# DRAP Database Console

Local web console for SQL Server on macOS. It can install/start Docker, pull SQL Server, create databases, browse tables, run queries, and import/export `.bacpac` backups.

## Requirements

- **macOS** (Apple Silicon or Intel)
- **Node.js** 18+ ([nodejs.org](https://nodejs.org/) or `brew install node`)
- **Docker Desktop** (the app can help download it on first run if it is missing)
- Enough free disk for the SQL Server image (~2 GB) plus your databases

> On Apple Silicon, SQL Server runs as `linux/amd64` under Docker. The first download and start can take several minutes.

## Install

```bash
cd "/path/to/db-viewer"
npm install
```

## Start

```bash
npm start
```

The console opens at [http://127.0.0.1:5050](http://127.0.0.1:5050) (localhost only).

### First run

1. Enter a **database name** (for example `DB`).
2. Set the SQL Server **`sa` password**.
3. Leave SQL login as `sa` (default).
4. Wait while the app:
   - checks Docker
   - downloads the SQL Server image if needed
   - starts the `sqlserver` container
   - creates your database

**Password rules (SQL Server):** at least 8 characters, and at least 3 of: uppercase, lowercase, number, symbol.  
Example: `SqlServer@2026!`

Credentials are saved in `.db-config.json` (gitignored) so later starts skip the form.

### Later runs

```bash
npm start
```

If Docker Desktop is stopped, the app tries to start it. If the container already exists, it is started again.

## Features

| Area | What you can do |
|------|------------------|
| **Data** | Browse tables and views |
| **Structure** | Inspect columns and keys |
| **Query** | Run SQL (results capped at 2,000 rows per set) |
| **Databases** | Create, open, or delete user databases |
| **Export** | Export a database to `.bacpac` |
| **Restore** | Import a `.bacpac` into a target database |

Export/import need **sqlpackage** on your Mac (`dotnet tool install -g microsoft.sqlpackage` or see [Microsoft’s docs](https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage-download)).

## Optional environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DB_VIEWER_PORT` | `5050` | Web UI port |
| `DB_HOST` | `127.0.0.1` | SQL Server host |
| `DB_PORT` | `1433` | SQL Server port |
| `SQLSERVER_CONTAINER` | `sqlserver` | Docker container name |
| `SQLSERVER_IMAGE` | `mcr.microsoft.com/mssql/server:2022-latest` | Image to pull |

Example:

```bash
DB_VIEWER_PORT=5051 npm start
```

## Reset / troubleshooting

**Show the setup form again**

```bash
rm .db-config.json
npm start
```

**Docker or image seems stuck**

1. Open Docker Desktop and wait until it is fully running.
2. Retry from the setup screen, or restart:

```bash
npm start
```

**Check the SQL Server container manually**

```bash
docker ps -a --filter name=sqlserver
docker start sqlserver
```

**Port 5050 already in use**

`npm start` tries to free the old viewer process. Or use another port:

```bash
DB_VIEWER_PORT=5051 npm start
```

**Login failed after recreate**

The `sa` password is set when the container is **created**. If you change only `.db-config.json`, it will not change an existing container password. Either use the original password, or remove the container and let setup create it again (this deletes container data unless you use volumes carefully):

```bash
docker rm -f sqlserver
rm .db-config.json
npm start
```

## Security notes

- The UI binds to **127.0.0.1** only. Do not expose it on a network.
- Treat `.db-config.json` as a secret. Do not commit it.
- SQL Server accepts Microsoft’s container EULA when the container is created (`ACCEPT_EULA=Y`).

## Project scripts

```bash
npm start          # free port if needed, then start the console
npm run start:server   # start server.js directly
```
