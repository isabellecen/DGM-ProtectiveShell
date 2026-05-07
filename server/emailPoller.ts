import net from "node:net";
import tls from "node:tls";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import {
  emails,
  events,
  expectedRuns,
  imapCheckpoints,
  jobs,
  jobRules,
} from "@shared/schema";
export { detectEventStatus } from "./emailStatus";
import { detectEventStatus } from "./emailStatus";
import { syncBackupEmailIncident } from "./backupIncidents";

type ImapSettings = {
  host: string;
  port: number;
  username: string;
  password: string;
  folder: string;
  useTls: boolean;
  fetchLimit: number;
};

type ParsedEmail = {
  messageId: string | null;
  fromAddr: string | null;
  subject: string | null;
  receivedAt: Date | null;
  snippet: string | null;
  rawExcerpt: string | null;
};

type ImapSocket = net.Socket | tls.TLSSocket;

let pollRunning = false;

export async function pollImapInboxAndPersist() {
  if (pollRunning) {
    return;
  }

  pollRunning = true;
  try {
    const settings = await getImapSettings();
    if (!settings) {
      return;
    }

    await pollConfiguredMailbox(settings);
  } finally {
    pollRunning = false;
  }
}

export async function testImapConnection() {
  const settings = await getImapSettings();
  if (!settings) {
    throw new Error("IMAP settings are incomplete");
  }

  const client = new SimpleImapClient(settings);
  await client.connect();
  try {
    await client.login();
    await client.select(settings.folder);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function pollConfiguredMailbox(settings: ImapSettings) {
  const client = new SimpleImapClient(settings);
  await client.connect();
  try {
    await client.login();
    const selected = await client.select(settings.folder);
    const checkpoint = await getCheckpoint(settings.folder, selected.uidvalidity);
    const uids = selectUidsForPoll(
      await client.searchNewUids(checkpoint.lastSeenUid),
      checkpoint.lastSeenUid,
      settings.fetchLimit,
    );

    let maxUid = checkpoint.lastSeenUid;
    for (const uid of uids) {
      const raw = await client.fetchMessage(uid);
      const parsed = parseEmailSource(raw);
      await persistParsedEmail(settings.folder, selected.uidvalidity, uid, parsed);
      maxUid = Math.max(maxUid, uid);
    }

    await upsertCheckpoint(settings.folder, selected.uidvalidity, maxUid);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export function selectUidsForPoll(
  candidateUids: number[],
  lastSeenUid: number,
  fetchLimit: number,
): number[] {
  return candidateUids
    .filter((uid) => uid > lastSeenUid)
    .sort((a, b) => a - b)
    .slice(0, fetchLimit);
}

async function persistParsedEmail(
  folder: string,
  uidvalidity: number,
  uid: number,
  parsed: ParsedEmail,
) {
  const [inserted] = await db
    .insert(emails)
    .values({
      folder,
      uidvalidity,
      uid,
      messageId: parsed.messageId,
      fromAddr: parsed.fromAddr,
      subject: parsed.subject,
      receivedAt: parsed.receivedAt,
      snippet: parsed.snippet,
      rawExcerpt: parsed.rawExcerpt,
      ingestedOk: false,
      matchedJobId: null,
    })
    .onConflictDoNothing({
      target: [emails.folder, emails.uidvalidity, emails.uid],
    })
    .returning();

  if (!inserted) {
    return;
  }

  const rule = await findMatchingRule(parsed);
  if (!rule) {
    return;
  }

  const receivedAt = parsed.receivedAt || new Date();
  const status = detectEventStatus(`${parsed.subject || ""}\n${parsed.snippet || ""}`);
  const [run] = await db
    .select()
    .from(expectedRuns)
    .where(
      and(
        eq(expectedRuns.jobId, rule.jobId),
        eq(expectedRuns.status, "PENDING"),
        lte(expectedRuns.scheduledFor, receivedAt),
        gte(expectedRuns.deadlineAt, receivedAt),
      ),
    )
    .orderBy(desc(expectedRuns.scheduledFor))
    .limit(1);
  const [job] = await db.select().from(jobs).where(eq(jobs.id, rule.jobId));

  const [event] = await db
    .insert(events)
    .values({
      jobId: rule.jobId,
      expectedRunId: run?.id ?? null,
      status,
      receivedAt,
      emailId: inserted.id,
    })
    .returning();

  await db
    .update(emails)
    .set({ matchedJobId: rule.jobId, ingestedOk: true })
    .where(eq(emails.id, inserted.id));

  if (run && status !== "UNKNOWN") {
    await db
      .update(expectedRuns)
      .set({ status, linkedEventId: event.id })
      .where(eq(expectedRuns.id, run.id));
  }

  await syncBackupEmailIncident({
    jobId: rule.jobId,
    jobName: job?.name,
    emailId: inserted.id,
    expectedRunId: run?.id ?? null,
    status,
    receivedAt,
    subject: parsed.subject,
    snippet: parsed.snippet,
  });
}

async function findMatchingRule(parsed: ParsedEmail) {
  const haystack = {
    sender: (parsed.fromAddr || "").toLowerCase(),
    subject: (parsed.subject || "").toLowerCase(),
    body: (parsed.snippet || "").toLowerCase(),
  };
  const rules = await db.select().from(jobRules).orderBy(desc(jobRules.priority));

  return rules.find((rule) => {
    const checks = [
      [rule.senderMatch, haystack.sender],
      [rule.subjectMatch, haystack.subject],
      [rule.bodyMatch, haystack.body],
    ] as const;
    const activeChecks = checks.filter(([needle]) => !!needle?.trim());
    if (activeChecks.length === 0) {
      return false;
    }
    return activeChecks.every(([needle, value]) => value.includes(needle!.trim().toLowerCase()));
  });
}

async function getCheckpoint(folder: string, uidvalidity: number) {
  const [checkpoint] = await db
    .select()
    .from(imapCheckpoints)
    .where(eq(imapCheckpoints.folder, folder));

  if (!checkpoint || checkpoint.uidvalidity !== uidvalidity) {
    return { lastSeenUid: 0 };
  }

  return checkpoint;
}

async function upsertCheckpoint(folder: string, uidvalidity: number, lastSeenUid: number) {
  await db
    .insert(imapCheckpoints)
    .values({
      folder,
      uidvalidity,
      lastSeenUid,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: imapCheckpoints.folder,
      set: {
        uidvalidity,
        lastSeenUid,
        updatedAt: new Date(),
      },
    });
}

class SimpleImapClient {
  private socket?: ImapSocket;
  private tagCounter = 0;
  private readonly settings: ImapSettings;

  constructor(settings: ImapSettings) {
    this.settings = settings;
  }

  async connect() {
    this.socket = await new Promise<ImapSocket>((resolve, reject) => {
      const onConnect = () => resolve(socket);
      const socket = this.settings.useTls
        ? tls.connect({
            host: this.settings.host,
            port: this.settings.port,
            servername: this.settings.host,
          }, onConnect)
        : net.connect({
            host: this.settings.host,
            port: this.settings.port,
          }, onConnect);

      socket.setEncoding("utf8");
      socket.setTimeout(20000, () => {
        socket.destroy(new Error("IMAP_TIMEOUT"));
      });
      socket.once("error", reject);
    });

    await this.readUntil(/\* OK|\* PREAUTH/i);
  }

  async login() {
    await this.command(`LOGIN ${quoteImap(this.settings.username)} ${quoteImap(this.settings.password)}`);
  }

  async select(folder: string): Promise<{ uidvalidity: number }> {
    const response = await this.command(`SELECT ${quoteImap(folder)}`);
    const uidvalidity = Number(response.match(/UIDVALIDITY\s+(\d+)/i)?.[1] || 0);
    if (!Number.isInteger(uidvalidity) || uidvalidity <= 0) {
      throw new Error("IMAP UIDVALIDITY was not returned");
    }
    return { uidvalidity };
  }

  async searchNewUids(lastSeenUid: number): Promise<number[]> {
    const response = await this.command(`UID SEARCH UID ${lastSeenUid + 1}:*`);
    const searchLine = response.match(/\* SEARCH([^\r\n]*)/i)?.[1] || "";
    return searchLine
      .trim()
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  async fetchMessage(uid: number): Promise<string> {
    return this.command(`UID FETCH ${uid} (BODY.PEEK[]<0.16384>)`);
  }

  async logout() {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    await this.command("LOGOUT");
    this.socket.end();
  }

  private async command(command: string): Promise<string> {
    const tag = `A${(++this.tagCounter).toString().padStart(4, "0")}`;
    this.socket?.write(`${tag} ${command}\r\n`);
    const response = await this.readUntil(new RegExp(`(?:^|\\r?\\n)${tag} (OK|NO|BAD)`, "i"));
    if (new RegExp(`(?:^|\\r?\\n)${tag} (NO|BAD)`, "i").test(response)) {
      throw new Error(`IMAP command failed: ${command.replace(/LOGIN .*/i, "LOGIN ***")}`);
    }
    return response;
  }

  private readUntil(pattern: RegExp): Promise<string> {
    const socket = this.socket;
    if (!socket) {
      throw new Error("IMAP socket is not connected");
    }

    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => cleanup(new Error("IMAP_TIMEOUT")), 20000);

      const onData = (chunk: string | Buffer) => {
        buffer += chunk.toString();
        if (pattern.test(buffer)) {
          cleanup(undefined, buffer);
        }
      };

      const onError = (err: Error) => cleanup(err);

      const cleanup = (err?: Error, value?: string) => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        if (err) {
          reject(err);
          return;
        }
        resolve(value || buffer);
      };

      socket.on("data", onData);
      socket.once("error", onError);
    });
  }
}

function quoteImap(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function getImapSettings(): Promise<ImapSettings | null> {
  const host = await setting("IMAP_HOST");
  const username = await setting("IMAP_USER");
  const password = await setting("IMAP_PASS");
  if (!host || !username || !password) {
    return null;
  }

  return {
    host,
    port: Number((await setting("IMAP_PORT")) || 993),
    username,
    password,
    folder: (await setting("IMAP_FOLDER")) || "INBOX",
    useTls: ((await setting("IMAP_TLS")) || "1") !== "0",
    fetchLimit: Math.max(1, Math.min(Number((await setting("IMAP_FETCH_LIMIT")) || 50), 200)),
  };
}

async function setting(key: string): Promise<string | undefined> {
  return (await storage.getSettingValue(key)) || process.env[key];
}

export function parseEmailSource(raw: string): ParsedEmail {
  const source = extractMessageSource(raw).replace(/\r\n/g, "\n");
  const [headerRaw, ...bodyParts] = source.split(/\n\n/);
  const headers = unfoldHeaders(headerRaw || "");
  const body = bodyParts.join("\n\n").trim();
  const receivedAtRaw = header(headers, "Date");
  const receivedAt = receivedAtRaw ? new Date(receivedAtRaw) : null;

  return {
    messageId: header(headers, "Message-ID"),
    fromAddr: decodeMimeWords(header(headers, "From") || ""),
    subject: decodeMimeWords(header(headers, "Subject") || ""),
    receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
    snippet: body ? normalizeSnippet(decodeMimeWords(stripHtml(body))) : null,
    rawExcerpt: source.slice(0, 4000),
  };
}

function extractMessageSource(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const headerStart = normalized.search(/^(Message-ID|From|Subject|Date):/im);
  if (headerStart >= 0) {
    return normalized
      .slice(headerStart)
      .replace(/\n\)\nA\d+\s+OK[\s\S]*$/i, "")
      .trim();
  }
  return normalized;
}

function unfoldHeaders(raw: string): string {
  return raw.replace(/\n[ \t]+/g, " ");
}

function header(headers: string, name: string): string | null {
  const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || null;
}

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_match, charset, encoding, text) => {
    const normalizedCharset = String(charset).toLowerCase();
    if (normalizedCharset !== "utf-8" && normalizedCharset !== "us-ascii") {
      return text;
    }

    if (String(encoding).toUpperCase() === "B") {
      return Buffer.from(text, "base64").toString("utf8");
    }

    const qp = String(text)
      .replace(/_/g, " ")
      .replace(/=([A-Fa-f0-9]{2})/g, (_hexMatch, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(qp, "binary").toString("utf8");
  });
}
