#!/bin/bash
# Runs inside LocalStack when it is ready. Idempotent: CreateQueue with identical
# attributes returns the existing queue. Keep in sync with ensureQueues() in sqs.ts.
set -euo pipefail

MAX_ATTEMPTS="${SQS_MAX_ATTEMPTS:-5}"

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 >/dev/null

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"$((MAX_ATTEMPTS + 1))\\\"}\"}" >/dev/null

awslocal sqs create-queue --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null

echo "SQS queues ready"
