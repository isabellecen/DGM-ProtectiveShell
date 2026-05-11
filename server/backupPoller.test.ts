import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import path from "node:path";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL ||= "postgres://user:password@localhost:5432/protectiveshell_test";

const { backupPollerInternals } = await import("./backupPoller");

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
