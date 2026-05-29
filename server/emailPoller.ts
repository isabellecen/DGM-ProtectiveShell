import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { db } from "./db";
import { storage } from "./storage";
import {
  emails,
  emailIngestionFailures,
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
    const mailboxKey = mailboxStorageKey(settings);
    const checkpoint = await getCheckpoint(mailboxKey, selected.uidvalidity, settings.folder);
    const uids = selectUidsForPoll(
      await client.searchNewUids(checkpoint.lastSeenUid),
      checkpoint.lastSeenUid,
      settings.fetchLimit,
    );

    const maxUid = await processMailboxUids({
      uids,
      lastSeenUid: checkpoint.lastSeenUid,
      fetchMessage: (uid) => client.fetchMessage(uid),
      handleMessage: async (uid, raw) => {
        const parsed = await parseEmailSource(raw);
        await persistParsedEmail(mailboxKey, selected.uidvalidity, uid, parsed);
        await clearIngestionFailure(mailboxKey, selected.uidvalidity, uid);
      },
      recordFailure: (uid, err, raw) => recordIngestionFailure(mailboxKey, selected.uidvalidity, uid, err, raw),
      checkpoint: (uid) => upsertCheckpoint(mailboxKey, selected.uidvalidity, uid),
    });
    await upsertCheckpoint(mailboxKey, selected.uidvalidity, maxUid);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function processMailboxUids(input: {
  uids: number[];
  lastSeenUid: number;
  fetchMessage: (uid: number) => Promise<string>;
  handleMessage: (uid: number, raw: string) => Promise<void>;
  recordFailure: (uid: number, err: unknown, raw?: string) => Promise<void>;
  checkpoint: (lastSeenUid: number) => Promise<void>;
}): Promise<number> {
  let maxUid = input.lastSeenUid;
  for (const uid of input.uids) {
    let raw: string | undefined;
    try {
      raw = await input.fetchMessage(uid);
      await input.handleMessage(uid, raw);
      maxUid = Math.max(maxUid, uid);
      await input.checkpoint(maxUid);
    } catch (err) {
      if (isConnectionLevelImapError(err)) {
        throw err;
      }
      await input.recordFailure(uid, err, raw);
      maxUid = Math.max(maxUid, uid);
      await input.checkpoint(maxUid);
    }
  }
  return maxUid;
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
  await db.transaction(async (tx) => {
    const [inserted] = await tx
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

    const [email] = inserted
      ? [inserted]
      : await tx
          .select()
          .from(emails)
          .where(
            and(
              eq(emails.folder, folder),
              eq(emails.uidvalidity, uidvalidity),
              eq(emails.uid, uid),
            ),
          )
          .limit(1);

    if (!email) {
      return;
    }

    const rule = await findMatchingRule(parsed, tx);
    if (!rule) {
      return;
    }

    const receivedAt = parsed.receivedAt || email.receivedAt || new Date();
    const status = detectEventStatus(`${parsed.subject || ""}\n${parsed.snippet || ""}`);
    const [existingEvent] = await tx.select().from(events).where(eq(events.emailId, email.id)).limit(1);
    const [existingRun] = existingEvent?.expectedRunId
      ? await tx.select().from(expectedRuns).where(eq(expectedRuns.id, existingEvent.expectedRunId)).limit(1)
      : [];
    const [pendingRun] = existingRun
      ? []
      : await tx
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
    const run = existingRun || pendingRun;
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, rule.jobId));

    const [event] = existingEvent
      ? await tx
          .update(events)
          .set({
            jobId: rule.jobId,
            expectedRunId: run?.id ?? null,
            status,
            receivedAt,
          })
          .where(eq(events.id, existingEvent.id))
          .returning()
      : await tx
          .insert(events)
          .values({
            jobId: rule.jobId,
            expectedRunId: run?.id ?? null,
            status,
            receivedAt,
            emailId: email.id,
          })
          .returning();

    await tx
      .update(emails)
      .set({ matchedJobId: rule.jobId, ingestedOk: true })
      .where(eq(emails.id, email.id));

    if (run && status !== "UNKNOWN") {
      await tx
        .update(expectedRuns)
        .set({ status, linkedEventId: event.id })
        .where(eq(expectedRuns.id, run.id));
    }

    await syncBackupEmailIncident({
      client: tx as unknown as Parameters<typeof syncBackupEmailIncident>[0]["client"],
      jobId: rule.jobId,
      jobName: job?.name,
      emailId: email.id,
      expectedRunId: run?.id ?? null,
      status,
      receivedAt,
      subject: parsed.subject,
      snippet: parsed.snippet,
    });
  });
}

function isConnectionLevelImapError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /IMAP_TIMEOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket is not connected/i.test(message);
}

function ingestionFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 1000) || "Unknown IMAP ingestion error";
}

async function recordIngestionFailure(
  mailboxKey: string,
  uidvalidity: number,
  uid: number,
  err: unknown,
  raw?: string,
) {
  const now = new Date();
  await db
    .insert(emailIngestionFailures)
    .values({
      mailboxKey,
      uidvalidity,
      uid,
      errorMessage: ingestionFailureMessage(err),
      rawExcerpt: raw?.slice(0, 4000) ?? null,
      attemptCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [
        emailIngestionFailures.mailboxKey,
        emailIngestionFailures.uidvalidity,
        emailIngestionFailures.uid,
      ],
      set: {
        errorMessage: ingestionFailureMessage(err),
        rawExcerpt: raw?.slice(0, 4000) ?? null,
        attemptCount: sql`${emailIngestionFailures.attemptCount} + 1`,
        lastSeenAt: now,
      },
    });
}

async function clearIngestionFailure(mailboxKey: string, uidvalidity: number, uid: number) {
  await db
    .delete(emailIngestionFailures)
    .where(
      and(
        eq(emailIngestionFailures.mailboxKey, mailboxKey),
        eq(emailIngestionFailures.uidvalidity, uidvalidity),
        eq(emailIngestionFailures.uid, uid),
      ),
    );
}

async function findMatchingRule(parsed: ParsedEmail, client: Pick<typeof db, "select"> = db) {
  const haystack = {
    sender: (parsed.fromAddr || "").toLowerCase(),
    subject: (parsed.subject || "").toLowerCase(),
    body: (parsed.snippet || "").toLowerCase(),
  };
  const rules = await client.select().from(jobRules).orderBy(desc(jobRules.priority));

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

function checkpointLastSeenUid(
  scopedCheckpoint: { uidvalidity: number; lastSeenUid: number } | undefined,
  legacyCheckpoint: { uidvalidity: number; lastSeenUid: number } | undefined,
  uidvalidity: number,
): number {
  if (scopedCheckpoint) {
    return scopedCheckpoint.uidvalidity === uidvalidity ? scopedCheckpoint.lastSeenUid : 0;
  }
  if (legacyCheckpoint?.uidvalidity === uidvalidity) {
    return legacyCheckpoint.lastSeenUid;
  }
  return 0;
}

async function getCheckpoint(folder: string, uidvalidity: number, legacyFolder?: string) {
  const [checkpoint] = await db
    .select()
    .from(imapCheckpoints)
    .where(eq(imapCheckpoints.folder, folder));

  const [legacyCheckpoint] = !checkpoint && legacyFolder && legacyFolder !== folder
    ? await db
        .select()
        .from(imapCheckpoints)
        .where(eq(imapCheckpoints.folder, legacyFolder))
    : [];

  return { lastSeenUid: checkpointLastSeenUid(checkpoint, legacyCheckpoint, uidvalidity) };
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

function mailboxStorageKey(settings: Pick<ImapSettings, "host" | "port" | "username" | "folder" | "useTls">): string {
  const identity = [
    settings.host.trim().toLowerCase(),
    settings.port,
    settings.useTls ? "tls" : "plain",
    settings.username.trim(),
    settings.folder.trim(),
  ].join("\0");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${settings.folder}#${digest}`;
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

export async function parseEmailSource(raw: string): Promise<ParsedEmail> {
  const source = extractMessageSource(raw).replace(/\r\n/g, "\n");
  const parsed = await simpleParser(source);
  const receivedAt = parsed.date ?? null;
  const body = parsed.text || (typeof parsed.html === "string" ? stripHtml(parsed.html) : "");

  return {
    messageId: parsed.messageId || null,
    fromAddr: formatAddress(parsed.from?.value?.[0]) || parsed.from?.text || null,
    subject: parsed.subject || null,
    receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
    snippet: body ? normalizeSnippet(stripHtml(body)) : null,
    rawExcerpt: source.slice(0, 4000),
  };
}

export const emailPollerInternals = {
  checkpointLastSeenUid,
  mailboxStorageKey,
  isConnectionLevelImapError,
  processMailboxUids,
};

function formatAddress(address: { name?: string; address?: string } | undefined): string | null {
  if (!address?.address) {
    return null;
  }
  const name = address.name?.trim();
  return name ? `${name} <${address.address}>` : address.address;
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

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}
