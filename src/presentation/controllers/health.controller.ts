import { Controller, Get, Res, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { EntityManager } from "@mikro-orm/postgresql";
import { SQSClient, ListQueuesCommand } from "@aws-sdk/client-sqs";
import { Public } from "../guards/auth.guard";

@Controller("health")
@Public()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqsClient?: SQSClient,
  ) { }

  @Get("live")
  live(@Res() res: Response) {
    return res.status(HttpStatus.OK).json({
      status: "UP",
      timestamp: new Date().toISOString(),
    });
  }

  @Get("ready")
  async ready(@Res() res: Response) {
    let dbStatus = "UP";
    let sqsStatus = "UP";
    let hasError = false;

    // Check PostgreSQL connection
    try {
      await this.em.getConnection().execute("SELECT 1");
    } catch (err) {
      dbStatus = "DOWN";
      hasError = true;
    }

    // Check SQS connection
    if (this.sqsClient) {
      try {
        await this.sqsClient.send(new ListQueuesCommand({ MaxResults: 1 }));
      } catch (err) {
        sqsStatus = "DOWN";
        hasError = true;
      }
    }

    const statusCode = hasError ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK;

    return res.status(statusCode).json({
      status: hasError ? "DOWN" : "UP",
      database: dbStatus,
      sqs: sqsStatus,
      timestamp: new Date().toISOString(),
    });
  }
}
