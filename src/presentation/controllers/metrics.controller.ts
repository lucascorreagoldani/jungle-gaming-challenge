import { Controller, Get, Res, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { Public } from "../guards/auth.guard";

@Controller("metrics")
@Public()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) { }

  @Get()
  getPrometheusMetrics(@Res() res: Response) {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return res.status(HttpStatus.OK).send(this.metricsService.toPrometheusFormat());
  }

  @Get("json")
  getJsonMetrics(@Res() res: Response) {
    return res.status(HttpStatus.OK).json(this.metricsService.getMetricsSnapshot());
  }
}
