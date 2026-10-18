import { SQSClient } from "@aws-sdk/client-sqs";

export interface SqsConfig {
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  queueUrl?: string;
  dlqUrl?: string;
}

export function createSqsClient(config?: SqsConfig): SQSClient {
  const region = config?.region || process.env.AWS_REGION || "us-east-1";
  const endpoint = config?.endpoint || process.env.AWS_ENDPOINT || "http://localhost:4566";
  const accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "test";
  const secretAccessKey = config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "test";

  return new SQSClient({
    region,
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}
