import net from "node:net";
import tls from "node:tls";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import {
  backupTargets,
  incidents,
  jobs,
  notificationRoutes,
  proxmoxHosts,
  recipients,
} from "@shared/schema";

type Incident = typeof incidents.$inferSelect;
type Recipient = typeof recipients.$inferSelect;
type SmtpSocket = net.Socket | tls.TLSSocket;

type SmtpSettings = {
  host: string;
  port: number;
  username?: string;
  password?: string;
  from: string;
  startTls: boolean;
};

let notifyRunning = false;

export async function notifyOpenIncidents() {
  if (notifyRunning) {
    return;
  }

  notifyRunning = true;
  try {
    const smtp = await getSmtpSettings();
    if (!smtp) {
      return;
    }

    const pending = await db
      .select()
      .from(incidents)
      .where(and(eq(incidents.state, "OPEN"), isNull(incidents.notificationSentAt)))
      .limit(25);

    for (const incident of pending) {
      const resolvedRecipients = await resolveRecipients(incident);
      if (resolvedRecipients.length === 0) {
        continue;
      }

      await sendIncidentEmail(smtp, incident, resolvedRecipients);
      await db
        .update(incidents)
        .set({ notificationSentAt: new Date(), updatedAt: new Date() })
        .where(eq(incidents.id, incident.id));
    }
  } finally {
    notifyRunning = false;
  }
}

export async function testSmtpConnection() {
  const smtp = await getSmtpSettings();
  if (!smtp) {
    throw new Error("SMTP settings are incomplete");
  }

  const client = new SimpleSmtpClient(smtp);
  await client.connect();
  client.close();
}

async function resolveRecipients(incident: Incident): Promise<Recipient[]> {
  const allRecipients = await db.select().from(recipients).where(eq(recipients.enabled, true));
  const routes = await db.select().from(notificationRoutes);
  const eventType = eventTypeForIncident(incident);
  const severityRank = severityValue(incident.severity);
  const customerId = await customerIdForIncident(incident);

  const matchingRoutes = routes.filter((route) => {
    if (route.eventType !== eventType && route.eventType !== incident.severity) {
      return false;
    }
    if (severityValue(route.severityMin) > severityRank) {
      return false;
    }
    if (route.scopeType === "CUSTOMER" && route.scopeId !== customerId) {
      return false;
    }
    if (route.scopeType === "JOB" && (incident.sourceType !== "BACKUP" || route.scopeId !== incident.sourceId)) {
      return false;
    }
    return route.scopeType === "GLOBAL" || route.scopeType === "CUSTOMER" || route.scopeType === "JOB";
  });

  const routeRecipients = matchingRoutes.flatMap((route) => recipientsFromRoute(route.recipientsJson, allRecipients));
  if (routeRecipients.length > 0) {
    return uniqueRecipients(routeRecipients);
  }

  return uniqueRecipients(
    allRecipients.filter((recipient) => recipient.customerId == null || recipient.customerId === customerId),
  );
}

function recipientsFromRoute(value: unknown, allRecipients: Recipient[]): Recipient[] {
  const ids = new Set<number>();
  const emails = new Set<string>();

  const visit = (entry: unknown) => {
    if (typeof entry === "number") {
      ids.add(entry);
    } else if (typeof entry === "string") {
      if (/^\d+$/.test(entry)) {
        ids.add(Number(entry));
      } else {
        emails.add(entry.toLowerCase());
      }
    } else if (entry && typeof entry === "object") {
      const obj = entry as { id?: unknown; email?: unknown; recipientIds?: unknown; emails?: unknown };
      visit(obj.id);
      visit(obj.email);
      if (Array.isArray(obj.recipientIds)) obj.recipientIds.forEach(visit);
      if (Array.isArray(obj.emails)) obj.emails.forEach(visit);
    }
  };

  if (Array.isArray(value)) {
    value.forEach(visit);
  } else {
    visit(value);
  }

  return allRecipients.filter((recipient) => ids.has(recipient.id) || emails.has(recipient.email.toLowerCase()));
}

function uniqueRecipients(input: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  return input.filter((recipient) => {
    const key = recipient.email.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function customerIdForIncident(incident: Incident): Promise<number | null> {
  if (!incident.sourceId) {
    return null;
  }

  if (incident.sourceType === "BACKUP") {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, incident.sourceId));
    return job?.customerId ?? null;
  }

  if (incident.sourceType === "PROXMOX") {
    const [host] = await db.select().from(proxmoxHosts).where(eq(proxmoxHosts.id, incident.sourceId));
    return host?.customerId ?? null;
  }

  if (incident.sourceType === "MONITOR") {
    const [target] = await db.select().from(backupTargets).where(eq(backupTargets.id, incident.sourceId));
    return target?.customerId ?? null;
  }

  return null;
}

function eventTypeForIncident(incident: Incident): string {
  const text = `${incident.title} ${incident.details || ""}`.toLowerCase();
  if (text.includes("missed") || text.includes("missing")) return "MISSING";
  if (incident.sourceType === "MONITOR") return "MONITOR_DOWN";
  if (incident.severity === "WARN") return "WARN";
  if (incident.severity === "CRIT") return "FAIL";
  return "INFO";
}

function severityValue(severity: string): number {
  return { INFO: 0, WARN: 1, CRIT: 2 }[severity] ?? 0;
}

async function sendIncidentEmail(settings: SmtpSettings, incident: Incident, resolvedRecipients: Recipient[]) {
  const client = new SimpleSmtpClient(settings);
  await client.connect();
  try {
    await client.send({
      to: resolvedRecipients.map((recipient) => recipient.email),
      subject: `[ProtectiveShell] ${incident.severity}: ${incident.title}`,
      body: [
        incident.title,
        "",
        `Severity: ${incident.severity}`,
        `Source: ${incident.sourceType}${incident.sourceId ? ` #${incident.sourceId}` : ""}`,
        `State: ${incident.state}`,
        "",
        incident.details || "No additional details.",
      ].join("\n"),
    });
  } finally {
    client.close();
  }
}

class SimpleSmtpClient {
  private socket?: SmtpSocket;
  private readonly settings: SmtpSettings;

  constructor(settings: SmtpSettings) {
    this.settings = settings;
  }

  async connect() {
    this.socket = await new Promise<SmtpSocket>((resolve, reject) => {
      let socket: SmtpSocket;
      const onConnect = () => resolve(socket);
      socket = this.settings.port === 465
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
      socket.setTimeout(20000, () => socket.destroy(new Error("SMTP_TIMEOUT")));
      socket.once("error", reject);
    });

    await this.expect(220);
    await this.ehlo();

    if (this.settings.port !== 465 && this.settings.startTls) {
      await this.line("STARTTLS", 220);
      await this.upgradeToTls();
      await this.ehlo();
    }

    if (this.settings.username && this.settings.password) {
      await this.line("AUTH LOGIN", 334);
      await this.line(Buffer.from(this.settings.username).toString("base64"), 334);
      await this.line(Buffer.from(this.settings.password).toString("base64"), 235);
    }
  }

  async send(message: { to: string[]; subject: string; body: string }) {
    await this.line(`MAIL FROM:<${this.settings.from}>`, 250);
    for (const recipient of message.to) {
      await this.line(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await this.line("DATA", 354);
    this.socket?.write(formatMessage(this.settings.from, message.to, message.subject, message.body));
    await this.expect(250);
  }

  close() {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    this.socket.write("QUIT\r\n");
    this.socket.end();
  }

  private async ehlo() {
    await this.line(`EHLO ${this.settings.host}`, 250);
  }

  private async upgradeToTls() {
    const existing = this.socket;
    if (!existing) {
      throw new Error("SMTP socket is not connected");
    }

    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const secure = tls.connect({
        socket: existing,
        servername: this.settings.host,
      }, () => resolve(secure));
      secure.setEncoding("utf8");
      secure.once("error", reject);
    });
  }

  private async line(command: string, expected: number | number[]) {
    this.socket?.write(`${command}\r\n`);
    await this.expect(expected);
  }

  private expect(expected: number | number[]): Promise<string> {
    const socket = this.socket;
    if (!socket) {
      throw new Error("SMTP socket is not connected");
    }
    const expectedCodes = Array.isArray(expected) ? expected : [expected];

    return new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => cleanup(new Error("SMTP_TIMEOUT")), 20000);

      const onData = (chunk: string | Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1];
        const code = Number(last?.slice(0, 3));
        if (last && /^\d{3} /.test(last)) {
          if (expectedCodes.includes(code)) {
            cleanup(undefined, buffer);
          } else {
            cleanup(new Error(`SMTP expected ${expectedCodes.join("/")} but got ${last}`));
          }
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

function formatMessage(from: string, to: string[], subject: string, body: string): string {
  const normalizedBody = body.replace(/\r?\n\./g, "\n..");
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject.replace(/\r?\n/g, " ")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    normalizedBody,
    ".",
    "",
  ].join("\r\n");
}

async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const host = await setting("SMTP_HOST");
  const from = await setting("SMTP_FROM");
  if (!host || !from) {
    return null;
  }

  return {
    host,
    port: Number((await setting("SMTP_PORT")) || 587),
    username: await setting("SMTP_USER"),
    password: await setting("SMTP_PASS"),
    from,
    startTls: ((await setting("SMTP_STARTTLS")) || "1") !== "0",
  };
}

async function setting(key: string): Promise<string | undefined> {
  return (await storage.getSettingValue(key)) || process.env[key];
}
