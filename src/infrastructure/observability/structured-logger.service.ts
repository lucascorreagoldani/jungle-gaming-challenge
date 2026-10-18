import { Injectable, LoggerService } from "@nestjs/common";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

@Injectable()
export class StructuredLoggerService implements LoggerService {
  private static sanitize(meta?: LogContext): Record<string, unknown> | undefined {
    if (!meta) return undefined;

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
      // Impede vazamento de dados sensíveis ou payloads brutos nos logs
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("password") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("token") ||
        lowerKey.includes("card") ||
        lowerKey.includes("payload")
      ) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  log(message: string, contextOrMeta?: string | LogContext): void {
    this.print("INFO", message, contextOrMeta);
  }

  error(message: string, trace?: string, contextOrMeta?: string | LogContext): void {
    this.print("ERROR", message, contextOrMeta, trace);
  }

  warn(message: string, contextOrMeta?: string | LogContext): void {
    this.print("WARN", message, contextOrMeta);
  }

  debug(message: string, contextOrMeta?: string | LogContext): void {
    this.print("DEBUG", message, contextOrMeta);
  }

  private print(
    level: string,
    message: string,
    contextOrMeta?: string | LogContext,
    trace?: string,
  ): void {
    let context = "Application";
    let meta: Record<string, unknown> | undefined;

    if (typeof contextOrMeta === "string") {
      context = contextOrMeta;
    } else if (contextOrMeta && typeof contextOrMeta === "object") {
      meta = StructuredLoggerService.sanitize(contextOrMeta);
      if (typeof contextOrMeta.context === "string") {
        context = contextOrMeta.context;
      }
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      ...(meta ? { meta } : {}),
      ...(trace ? { trace } : {}),
    };

    console.log(JSON.stringify(logEntry));
  }
}
