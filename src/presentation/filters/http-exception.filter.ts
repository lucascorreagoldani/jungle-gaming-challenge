import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { DomainError, FailureCode } from "../../domain/errors/domain.error";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Internal server error";
    let failureCode: FailureCode | string = "INTERNAL_ERROR";
    let errorTitle = "Internal Server Error";

    if (exception instanceof DomainError) {
      failureCode = exception.code;
      message = exception.message;

      switch (exception.code) {
        case FailureCode.WALLET_NOT_FOUND:
        case FailureCode.REFERENCE_NOT_FOUND:
          status = HttpStatus.NOT_FOUND;
          errorTitle = "Not Found";
          break;

        case FailureCode.IDEMPOTENCY_CONFLICT:
          status = HttpStatus.CONFLICT;
          errorTitle = "Idempotency Conflict";
          break;

        case FailureCode.INVALID_PAYLOAD:
          status = HttpStatus.BAD_REQUEST;
          errorTitle = "Bad Request";
          break;

        case FailureCode.INSUFFICIENT_FUNDS:
        case FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE:
        case FailureCode.REFERENCE_ALREADY_REVERSED:
        case FailureCode.REFERENCE_MISMATCH:
        case FailureCode.REFERENCE_INVALID_STATE:
        case FailureCode.CURRENCY_MISMATCH:
        case FailureCode.INVALID_OPERATION:
          status = HttpStatus.UNPROCESSABLE_ENTITY;
          errorTitle = "Unprocessable Entity";
          break;

        default:
          status = HttpStatus.BAD_REQUEST;
          errorTitle = "Domain Error";
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === "string") {
        message = res;
      } else if (typeof res === "object" && res !== null) {
        const resObj = res as Record<string, unknown>;
        message = (resObj.message as string) || exception.message;
        failureCode = (resObj.error as string) || "HTTP_ERROR";
      }
      errorTitle = exception.name;
    } else if (exception instanceof Error) {
      message = exception.message;
      if (message.includes("duplicate key") || message.includes("uq_")) {
        status = HttpStatus.CONFLICT;
        failureCode = "DUPLICATE_RESOURCE";
        errorTitle = "Conflict";
      }
    }

    response.status(status).json({
      statusCode: status,
      error: errorTitle,
      failureCode,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
