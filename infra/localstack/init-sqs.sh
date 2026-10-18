#!/bin/bash
set -e

echo "Creating SQS FIFO Queues in LocalStack..."

# Create Dead Letter Queue
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text 2>/dev/null || echo "arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo")

# Create Main Processing Queue with RedrivePolicy pointing to DLQ
REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,RedrivePolicy="$REDRIVE_POLICY"

echo "Queues created successfully:"
awslocal sqs list-queues
