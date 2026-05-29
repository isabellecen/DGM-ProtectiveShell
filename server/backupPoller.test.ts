import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { backupPollerInternals, pollBackupTarget } = await import("./backupPoller");

async function withPbsServer(
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
) {
  const [cert, key] = await Promise.all([
    readFile(path.resolve("node_modules", "ssh2", "test", "fixtures", "https_cert.pem")),
    readFile(path.resolve("node_modules", "ssh2", "test", "fixtures", "https_key.pem")),
  ]);
  const server = https.createServer({ cert, key }, handler);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert(address);
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function pbsInput(port: number) {
  return {
    type: "PBS" as const,
    host: "127.0.0.1",
    port,
    username: "root@pam",
    password: "secret",
    allowInsecureTls: true,
  };
}

function json(res: http.ServerResponse, value: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function pbsHandler(options: {
  stores: string[];
  failingStatusStores?: string[];
  failSnapshots?: boolean;
}): http.RequestListener {
  return (req, res) => {
    const pathName = new URL(req.url || "/", "https://127.0.0.1").pathname;
    if (pathName === "/api2/json/access/ticket") {
      json(res, { data: { ticket: "ticket", CSRFPreventionToken: "csrf" } });
      return;
    }
    if (pathName === "/api2/json/admin/datastore") {
      json(res, { data: options.stores.map((store) => ({ store })) });
      return;
    }
    const statusMatch = pathName.match(/^\/api2\/json\/admin\/datastore\/([^/]+)\/status$/);
    if (statusMatch) {
      const store = decodeURIComponent(statusMatch[1]);
      if (options.failingStatusStores?.includes(store)) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("status failed");
        return;
      }
      json(res, { data: { total: store === "fast" ? 1000 : 500, used: store === "fast" ? 250 : 100 } });
      return;
    }
    const snapshotsMatch = pathName.match(/^\/api2\/json\/admin\/datastore\/([^/]+)\/snapshots$/);
    if (snapshotsMatch) {
      if (options.failSnapshots) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("snapshots failed");
        return;
      }
      json(res, { data: [{ id: 1 }, { id: 2 }] });
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

test("TLS fingerprint mismatch rejects before request body is sent", async () => {
  const [cert, key] = await Promise.all([
    readFile(path.resolve("node_modules", "ssh2", "test", "fixtures", "https_cert.pem")),
    readFile(path.resolve("node_modules", "ssh2", "test", "fixtures", "https_key.pem")),
  ]);
  let receivedBody = "";

  const server = https.createServer({ cert, key }, (req, res) => {
    req.on("data", (chunk) => {
      receivedBody += chunk.toString();
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert(address);

    await assert.rejects(
      backupPollerInternals.fetchTargetApi(
        `https://127.0.0.1:${address.port}/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: "secret" }),
        },
        { tlsFingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000" },
      ),
      /TLS_FINGERPRINT_MISMATCH/,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(receivedBody, "");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("target API requests can pin the approved address while preserving the Host header", async () => {
  let observedHost = "";
  const server = http.createServer((req, res) => {
    observedHost = req.headers.host || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert(address);

    const result = await backupPollerInternals.fetchTargetApi(
      `http://target.example:${address.port}/status`,
      undefined,
      { connectHost: "127.0.0.1" },
    );

    assert.equal(result.success, true);
    assert.equal(observedHost, `target.example:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("target API responses are size limited", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("x".repeat(backupPollerInternals.maxTargetApiResponseBytes + 1));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert(address);

    await assert.rejects(
      backupPollerInternals.fetchTargetApi(`http://127.0.0.1:${address.port}/status`),
      /TARGET_RESPONSE_TOO_LARGE/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test("PBS polling is OK when all datastore status calls succeed", async () => {
  await withPbsServer(pbsHandler({ stores: ["fast", "archive"] }), async (port) => {
    const result = await pollBackupTarget(pbsInput(port));

    assert.equal(result.pollStatus, "OK");
    assert.equal(result.pollError, null);
    assert.equal(result.totalBytes, "1500");
    assert.equal(result.usedBytes, "350");
    assert.equal(result.datastoresJson?.[0]?.snapshotCount, 2);
  });
});

test("PBS polling is WARN when some datastore status calls fail", async () => {
  await withPbsServer(
    pbsHandler({ stores: ["fast", "broken"], failingStatusStores: ["broken"] }),
    async (port) => {
      const result = await pollBackupTarget(pbsInput(port));

      assert.equal(result.pollStatus, "WARN");
      assert.match(result.pollError || "", /broken/);
      assert.equal(result.totalBytes, "1000");
      assert.equal(result.usedBytes, "250");
      assert.equal(result.datastoresJson?.find((store) => store.name === "broken")?.status, "ERROR");
      assert.match(result.datastoresJson?.find((store) => store.name === "broken")?.error || "", /status/i);
    },
  );
});

test("PBS polling is ERROR when no datastore status calls succeed", async () => {
  await withPbsServer(
    pbsHandler({ stores: ["broken"], failingStatusStores: ["broken"] }),
    async (port) => {
      const result = await pollBackupTarget(pbsInput(port));

      assert.equal(result.pollStatus, "ERROR");
      assert.equal(result.totalBytes, null);
      assert.equal(result.usedBytes, null);
      assert.equal(result.datastoresJson?.[0]?.status, "ERROR");
    },
  );
});

test("PBS snapshot count failures do not fail capacity polling", async () => {
  await withPbsServer(pbsHandler({ stores: ["fast"], failSnapshots: true }), async (port) => {
    const result = await pollBackupTarget(pbsInput(port));

    assert.equal(result.pollStatus, "OK");
    assert.equal(result.pollError, null);
    assert.equal(result.datastoresJson?.[0]?.snapshotCount, undefined);
  });
});
