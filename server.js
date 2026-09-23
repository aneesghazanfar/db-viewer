"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const sql = require("mssql");
const setup = require("./setup");

const PORT = Number(process.env.DB_VIEWER_PORT || 5050);
const HOST = "127.0.0.1";
const MAX_QUERY_ROWS = 2000;
const SEARCHABLE_TYPES = new Set([
  "char",
  "nchar",
  "varchar",
  "nvarchar",
  "text",
  "ntext",
  "uniqueidentifier",
  "int",
  "bigint",
  "smallint",
  "tinyint",
  "decimal",
  "numeric",
  "float",
  "real",
  "date",
  "datetime",
  "datetime2",
  "smalldatetime",
]);

const config = {
  user: "",
  password: "",
  server:
    process.env.DB_HOST === "localhost"
      ? "127.0.0.1"
      : process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 1433),
  database: "",
  options: {
    encrypt: String(process.env.DB_ENCRYPT || "false").toLowerCase() === "true",
    trustServerCertificate:
      String(process.env.DB_TRUST_SERVER_CERTIFICATE || "true").toLowerCase() ===
      "true",
    enableArithAbort: true,
  },
  pool: { max: 2, min: 0, idleTimeoutMillis: 8000 },
  requestTimeout: 60 * 1000,
  connectionTimeout: 15 * 1000,
};

let pool = null;
let poolReady = null;
let packageRunning = false;
let lastExportPath = null;

async function connectPool() {
  pool = new sql.ConnectionPool(config);
  poolReady = pool.connect();
  await poolReady;
  return pool;
}

async function reconnectPool() {
  try {
    if (pool) await pool.close();
  } catch (_) {
    /* ignore */
  }
  return connectPool();
}

function findSqlPackage() {
  const candidates = [
    process.env.SQLPACKAGE_PATH,
    path.join(process.env.HOME || "", ".dotnet", "tools", "sqlpackage"),
    "sqlpackage",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === "sqlpackage") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "sqlpackage";
}

function masterConfig() {
  return {
    ...config,
    database: "master",
    requestTimeout: 120000,
    connectionTimeout: 30000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
  };
}

async function databaseExists(name) {
  const master = new sql.ConnectionPool(masterConfig());
  await master.connect();
  try {
    const result = await master
      .request()
      .input("name", sql.NVarChar(128), name)
      .query("SELECT DB_ID(@name) AS id");
    return result.recordset[0] && result.recordset[0].id != null;
  } finally {
    await master.close();
  }
}

async function dropDatabase(name) {
  const master = new sql.ConnectionPool(masterConfig());
  await master.connect();
  try {
    await master.request().query(`
      IF DB_ID(N'${name.replace(/'/g, "''")}') IS NOT NULL
      BEGIN
        ALTER DATABASE ${ident(name)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE ${ident(name)};
      END
    `);
  } finally {
    await master.close();
  }
}

function runSqlPackage({ action, file, database, onLog }) {
  const sqlpackage = findSqlPackage();
  const encrypt = config.options.encrypt ? "True" : "False";
  const trust = config.options.trustServerCertificate ? "True" : "False";
  const server = `${config.server},${config.port}`;
  const args =
    action === "Export"
      ? [
          "/Action:Export",
          `/SourceServerName:${server}`,
          `/SourceDatabaseName:${database}`,
          `/SourceUser:${config.user}`,
          `/SourcePassword:${config.password}`,
          `/SourceTrustServerCertificate:${trust}`,
          `/SourceEncryptConnection:${encrypt}`,
          `/TargetFile:${file}`,
          `/p:CommandTimeout=0`,
        ]
      : [
          "/Action:Import",
          `/SourceFile:${file}`,
          `/TargetServerName:${server}`,
          `/TargetDatabaseName:${database}`,
          `/TargetUser:${config.user}`,
          `/TargetPassword:${config.password}`,
          `/TargetTrustServerCertificate:${trust}`,
          `/TargetEncryptConnection:${encrypt}`,
          `/p:CommandTimeout=0`,
        ];

  return new Promise((resolve, reject) => {
    const child = spawn(sqlpackage, args, { env: process.env });
    let stderr = "";
    child.stdout.on("data", (chunk) => onLog(String(chunk)));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (stderr.length > 16000) stderr = stderr.slice(stderr.length - 16000);
      onLog(text);
    });
    child.on("error", (err) => {
      reject(
        new Error(
          `${err.message}. Install sqlpackage or set SQLPACKAGE_PATH.`
        )
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `sqlpackage exited with code ${code}`));
    });
  });
}

function ident(name) {
  if (typeof name !== "string" || !name.length || name.length > 128) {
    throw new Error("Invalid identifier");
  }
  if (name.includes("\0")) throw new Error("Invalid identifier");
  return `[${name.replace(/]/g, "]]")}]`;
}

function qualify(schema, table) {
  return `${ident(schema)}.${ident(table)}`;
}

const MAX_CELL_CHARS = 4000;

function serializeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return {
      __type: "binary",
      length: value.length,
      preview: value.toString("hex").slice(0, 64),
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (value.length <= MAX_CELL_CHARS) return value;
    return `${value.slice(0, MAX_CELL_CHARS)}… (${value.length} chars)`;
  }
  return value;
}

function columnNames(recordset, columnsMeta) {
  if (Array.isArray(columnsMeta) && columnsMeta.length) {
    if (typeof columnsMeta[0] === "string") return columnsMeta;
    if (columnsMeta[0] && columnsMeta[0].name) return columnsMeta.map((c) => c.name);
  }
  if (recordset?.columns) {
    const meta = recordset.columns;
    if (Array.isArray(meta)) return meta.map((c) => c.name || c);
    return Object.keys(meta);
  }
  if (recordset?.[0] && !Array.isArray(recordset[0])) {
    return Object.keys(recordset[0]);
  }
  return [];
}

function serializeRows(recordset, columnsMeta, maxRows = Infinity) {
  if (!recordset || !recordset.length) return [];
  const names = columnNames(recordset, columnsMeta);
  const first = recordset[0];
  const arrayRows = Array.isArray(first);
  const limit = Math.min(recordset.length, maxRows);
  const rows = new Array(limit);
  for (let i = 0; i < limit; i += 1) {
    const src = recordset[i];
    const out = {};
    if (arrayRows) {
      for (let c = 0; c < names.length; c += 1) {
        out[names[c]] = serializeValue(src[c]);
      }
    } else {
      for (let c = 0; c < names.length; c += 1) {
        out[names[c]] = serializeValue(src[names[c]]);
      }
    }
    rows[i] = out;
  }
  return rows;
}

async function exec(request, sqlText) {
  request.arrayRowMode = true;
  return request.query(sqlText);
}

function objectsFromResult(result, recordsetIndex = 0, maxRows = Infinity) {
  const recordset = Array.isArray(result.recordsets)
    ? result.recordsets[recordsetIndex]
    : result.recordset;
  const columnsMeta = Array.isArray(result.columns)
    ? Array.isArray(result.columns[0])
      ? result.columns[recordsetIndex]
      : result.columns
    : result.columns;
  return serializeRows(recordset, columnsMeta || recordset?.columns, maxRows);
}

async function getPool() {
  if (!setup.isReady() || !poolReady) {
    throw new Error("SQL Server is still starting");
  }
  await poolReady;
  return pool;
}

async function getColumns(schema, table) {
  const p = await getPool();
  const request = p
    .request()
    .input("schema", sql.NVarChar(128), schema)
    .input("table", sql.NVarChar(128), table);
  const result = await exec(request, `
      SELECT
        c.name,
        ty.name AS type_name,
        c.max_length,
        c.is_nullable,
        c.is_identity,
        dc.definition AS default_value,
        CAST(CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS bit) AS is_pk
      FROM sys.columns c
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      JOIN sys.objects o ON o.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.default_constraints dc
        ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        JOIN sys.indexes i
          ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1
      ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
      WHERE s.name = @schema AND o.name = @table
      ORDER BY c.column_id
    `);
  return objectsFromResult(result);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/setup/status", (_req, res) => {
  res.json(setup.getStatus());
});

app.post("/api/setup/docker-download", (_req, res) => {
  setup.openDockerDownload();
  res.json({ ok: true });
});

app.post("/api/setup/retry", (_req, res) => {
  setup.retry();
  res.json({ ok: true });
});

app.post("/api/setup/credentials", (req, res) => {
  try {
    setup.saveCredentials({
      user: req.body?.user,
      password: req.body?.password,
      database: req.body?.database,
    });
    setup.applyCredentialsTo(config);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/meta", async (_req, res) => {
  try {
    const p = await getPool();
    const stats = await exec(
      p.request(),
      `
      SELECT
        DB_NAME() AS database_name,
        (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS table_count,
        (SELECT COUNT(*) FROM sys.views WHERE is_ms_shipped = 0) AS view_count,
        CAST(SUM(size) * 8.0 / 1024 AS decimal(18,1)) AS size_mb
      FROM sys.database_files
    `
    );
    res.json({
      connected: true,
      host: config.server,
      port: config.port,
      database: config.database,
      user: config.user,
      ...(objectsFromResult(stats)[0] || {}),
    });
  } catch (err) {
    res.status(500).json({
      connected: false,
      host: config.server,
      port: config.port,
      database: config.database,
      error: err.message,
    });
  }
});

app.get("/api/objects", async (_req, res) => {
  try {
    const p = await getPool();
    const tables = await exec(
      p.request(),
      `
      SELECT
        s.name AS schema_name,
        t.name AS object_name,
        'TABLE' AS object_type,
        SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) AS row_count
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id
      WHERE t.is_ms_shipped = 0
      GROUP BY s.name, t.name
      ORDER BY s.name, t.name
    `
    );
    const views = await exec(
      p.request(),
      `
      SELECT
        s.name AS schema_name,
        v.name AS object_name,
        'VIEW' AS object_type,
        CAST(NULL AS bigint) AS row_count
      FROM sys.views v
      JOIN sys.schemas s ON s.schema_id = v.schema_id
      WHERE v.is_ms_shipped = 0
      ORDER BY s.name, v.name
    `
    );
    res.json({
      objects: [...objectsFromResult(tables), ...objectsFromResult(views)],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/objects/:schema/:table/columns", async (req, res) => {
  try {
    const columns = await getColumns(req.params.schema, req.params.table);
    if (!columns.length) {
      return res.status(404).json({ error: "Table or view not found" });
    }
    res.json({ columns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/objects/:schema/:table/rows", async (req, res) => {
  try {
    const schema = req.params.schema;
    const table = req.params.table;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const sort = typeof req.query.sort === "string" ? req.query.sort : "";
    const dir = String(req.query.dir).toLowerCase() === "desc" ? "DESC" : "ASC";
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    const columns = await getColumns(schema, table);
    if (!columns.length) {
      return res.status(404).json({ error: "Table or view not found" });
    }

    const colNames = new Set(columns.map((c) => c.name));
    const pk = columns.find((c) => c.is_pk)?.name;
    const sortCol = colNames.has(sort) ? sort : pk || columns[0].name;
    const offset = (page - 1) * pageSize;

    const p = await getPool();
    const countRequest = p.request();
    let whereSql = "";
    if (q) {
      const searchable = columns.filter((c) => SEARCHABLE_TYPES.has(c.type_name));
      if (searchable.length) {
        countRequest.input("q", sql.NVarChar(4000), `%${q}%`);
        whereSql =
          " WHERE " +
          searchable
            .map((c) => `CAST(${ident(c.name)} AS NVARCHAR(4000)) LIKE @q`)
            .join(" OR ");
      }
    }

    const fromSql = qualify(schema, table);
    const countResult = await exec(
      countRequest,
      `SELECT COUNT(*) AS total FROM ${fromSql}${whereSql}`
    );
    const total = Number((objectsFromResult(countResult)[0] || {}).total || 0);

    const dataRequest = p.request();
    if (q && whereSql) {
      dataRequest.input("q", sql.NVarChar(4000), `%${q}%`);
    }
    dataRequest.input("offset", sql.Int, offset);
    dataRequest.input("limit", sql.Int, pageSize);

    const orderCols = [];
    if (colNames.has(sortCol)) orderCols.push(`${ident(sortCol)} ${dir}`);
    for (const col of columns) {
      if (col.is_pk && col.name !== sortCol) {
        orderCols.push(`${ident(col.name)} ${dir}`);
      }
    }
    const orderSql = orderCols.join(", ") || `${ident(columns[0].name)} ${dir}`;

    const dataResult = await exec(
      dataRequest,
      `
      SELECT * FROM ${fromSql}
      ${whereSql}
      ORDER BY ${orderSql}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `
    );

    res.json({
      columns: columns.map((c) => c.name),
      rows: objectsFromResult(dataResult),
      page,
      pageSize,
      total,
      sort: sortCol,
      dir: dir.toLowerCase(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/restore/upload", (req, res) => {
  const original = String(req.headers["x-filename"] || "backup.bacpac")
    .split(/[/\\]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]/g, "_");
  const name = original.toLowerCase().endsWith(".bacpac")
    ? original
    : `${original}.bacpac`;
  const dest = path.join(os.tmpdir(), `drap-restore-${Date.now()}-${name}`);
  const out = fs.createWriteStream(dest, { highWaterMark: 64 * 1024 });

  req.pipe(out);
  out.on("finish", () => {
    res.json({ path: dest, size: out.bytesWritten });
  });
  const fail = (err) => {
    try {
      fs.unlinkSync(dest);
    } catch (_) {
      /* ignore */
    }
    if (!res.headersSent) res.status(500).json({ error: err.message });
  };
  req.on("error", fail);
  out.on("error", fail);
});

function exportDownloadName(database) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  const safe = String(database || "database").replace(/[^A-Za-z0-9._-]/g, "_") || "database";
  return `${safe}-${stamp}.bacpac`;
}

function isExportTempName(name) {
  return /^drap-export-\d+-[A-Za-z0-9._-]+\.bacpac$/.test(name);
}

app.post("/api/export", async (req, res) => {
  if (packageRunning) {
    return res.status(409).json({ error: "A backup job is already running" });
  }
  if (!setup.isReady()) {
    return res.status(503).json({ error: "SQL Server is still starting" });
  }

  const database = String(req.body?.database || config.database).trim();
  try {
    ident(database);
  } catch {
    return res.status(400).json({ error: "Invalid database name" });
  }

  const exists = await databaseExists(database).catch((err) => {
    res.status(500).json({ error: err.message });
    return null;
  });
  if (exists === null) return;
  if (!exists) {
    return res.status(404).json({ error: `Database [${database}] was not found` });
  }

  const safeDb = database.replace(/[^A-Za-z0-9._-]/g, "_") || "database";
  const tempName = `drap-export-${Date.now()}-${safeDb}.bacpac`;
  const dest = path.join(os.tmpdir(), tempName);
  const downloadName = exportDownloadName(database);

  packageRunning = true;
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const log = (text) => {
    res.write(String(text).endsWith("\n") ? text : `${text}\n`);
  };

  try {
    if (lastExportPath && lastExportPath !== dest) {
      try {
        fs.unlinkSync(lastExportPath);
      } catch (_) {
        /* ignore */
      }
    }
    log(`Exporting [${database}] to ${downloadName}`);
    log("Running sqlpackage export. This can take several minutes...");
    await runSqlPackage({
      action: "Export",
      file: dest,
      database,
      onLog: log,
    });
    if (!fs.existsSync(dest)) {
      throw new Error("sqlpackage finished, but the .bacpac file was not created.");
    }
    lastExportPath = dest;
    const sizeMb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(1);
    log(`Export finished (${sizeMb} MB).`);
    log(`DONE ${tempName} ${downloadName}`);
    res.end();
  } catch (err) {
    try {
      fs.unlinkSync(dest);
    } catch (_) {
      /* ignore */
    }
    log(`ERROR: ${err.message}`);
    res.end();
  } finally {
    packageRunning = false;
  }
});

app.get("/api/export/download/:file", (req, res) => {
  const name = path.basename(String(req.params.file || ""));
  if (!isExportTempName(name)) {
    return res.status(400).json({ error: "Invalid export file" });
  }
  const full = path.join(os.tmpdir(), name);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return res.status(404).json({ error: "Export file not found. Run export again." });
  }
  const suggested = String(req.query.name || name).replace(/[^A-Za-z0-9._-]/g, "_");
  const downloadName = suggested.toLowerCase().endsWith(".bacpac")
    ? suggested
    : `${suggested}.bacpac`;
  res.download(full, downloadName);
});

app.post("/api/restore", async (req, res) => {
  if (packageRunning) {
    return res.status(409).json({ error: "A backup job is already running" });
  }

  const sourcePath = String(req.body?.sourcePath || "").trim();
  const database = String(req.body?.database || config.database).trim();
  const replace = Boolean(req.body?.replace);

  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    return res.status(400).json({ error: "Provide an absolute path to a .bacpac file" });
  }
  if (!sourcePath.toLowerCase().endsWith(".bacpac")) {
    return res.status(400).json({ error: "File must be a .bacpac backup" });
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return res.status(400).json({ error: `File not found: ${sourcePath}` });
  }
  try {
    ident(database);
  } catch {
    return res.status(400).json({ error: "Invalid target database name" });
  }

  packageRunning = true;
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const log = (text) => {
    res.write(String(text).endsWith("\n") ? text : `${text}\n`);
  };

  try {
    const sizeMb = (fs.statSync(sourcePath).size / (1024 * 1024)).toFixed(1);
    log(`Importing ${sourcePath} (${sizeMb} MB) into [${database}]`);

    const exists = await databaseExists(database);
    if (exists && !replace) {
      throw new Error(
        `Database [${database}] already exists. Check "Replace if it already exists" to drop it first.`
      );
    }

    if (exists && replace) {
      log("Closing current connections and dropping the existing database...");
      if (database === config.database) {
        try {
          await pool.close();
        } catch (_) {
          /* ignore */
        }
      }
      await dropDatabase(database);
      log("Existing database dropped.");
    }

    log("Running sqlpackage import. This can take several minutes...");
    await runSqlPackage({
      action: "Import",
      file: sourcePath,
      database,
      onLog: log,
    });
    log("Import finished.");

    if (database === config.database) {
      log("Reconnecting the viewer...");
      await reconnectPool();
    } else {
      log(
        `Imported into [${database}]. The viewer is still connected to [${config.database}].`
      );
    }
    log("DONE");
    res.end();
  } catch (err) {
    log(`ERROR: ${err.message}`);
    try {
      if (database === config.database) await reconnectPool();
    } catch (_) {
      /* ignore */
    }
    res.end();
  } finally {
    packageRunning = false;
  }
});

app.post("/api/query", async (req, res) => {
  try {
    const sqlText = String(req.body?.sql || "").trim();
    if (!sqlText) {
      return res.status(400).json({ error: "SQL is required" });
    }
    const p = await getPool();
    const request = p.request();
    request.multiple = true;
    const result = await exec(request, sqlText);

    const recordsets = Array.isArray(result.recordsets)
      ? result.recordsets
      : result.recordset
        ? [result.recordset]
        : [];

    const sets = recordsets.map((rs, i) => {
      const totalRows = Array.isArray(rs) ? rs.length : 0;
      const rows = objectsFromResult(result, i, MAX_QUERY_ROWS);
      const columns = rows[0]
        ? Object.keys(rows[0])
        : columnNames(rs, Array.isArray(result.columns) ? result.columns[i] : result.columns);
      return {
        columns,
        rows,
        truncated: totalRows > MAX_QUERY_ROWS,
        rowCount: totalRows || rows.length,
      };
    });

    res.json({
      sets,
      rowsAffected: result.rowsAffected || [],
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`DRAP DB viewer: ${url}`);
  console.log("Bound to localhost only. Do not expose this tool on a network.");
  setup.openUrl(url);
  setup.start({
    onReady: async () => {
      setup.applyCredentialsTo(config);
      await connectPool();
      console.log(
        `Connected to ${config.database} on ${config.server}:${config.port}`
      );
    },
  });
});
