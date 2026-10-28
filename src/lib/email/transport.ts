export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends via SMTP (local Mailpit or any provider), the Resend API, or logs to the console. */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const mode = process.env.EMAIL_TRANSPORT ?? "console";
  const from = process.env.EMAIL_FROM ?? "Limit Gauge <alerts@limitgauge.local>";

  if (mode === "smtp") {
    const nodemailer = await import("nodemailer");
    const port = Number(process.env.SMTP_PORT ?? 587);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "127.0.0.1",
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await transport.sendMail({ from, ...msg });
    return;
  }

  if (mode === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}`);
    return;
  }

  console.info(`[email:console] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
}
