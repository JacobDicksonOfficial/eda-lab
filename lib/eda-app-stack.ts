import * as cdk from "aws-cdk-lib";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as source from "aws-cdk-lib/aws-lambda-event-sources"; // Add an import:
import { Construct } from "constructs";

export class EDAAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3 bucket (as before) ---
    const imagesBucket = new s3.Bucket(this, "images", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false,
    });

    //  NEW
    const dlq = new sqs.Queue(this, "img-dlq", {
      receiveMessageWaitTime: cdk.Duration.seconds(10),
    });

    // --- SQS queue (for image processing consumer) ---
    // UPDATE
    const imageProcessQueue = new sqs.Queue(this, "img-process-q", {
      receiveMessageWaitTime: cdk.Duration.seconds(10),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 1,
      },
    });

    // --- SNS topic for fan-out ---
    const newImageTopic = new sns.Topic(this, "NewImageTopic", {
      displayName: "New Image topic",
    });

    // --- DynamoDB table for image records ---
    const imagesTable = new dynamodb.Table(this, "ImagesTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "name", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      tableName: "Imagess",
      stream: dynamodb.StreamViewType.NEW_IMAGE,         //. UPDATE
    });

    // --- ProcessImage Lambda (now with env for DDB + region + bucket) ---
    const processImageFn = new lambdanode.NodejsFunction(this, "ProcessImageFn", {
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: `${__dirname}/../lambdas/processImage.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        TABLE_NAME: imagesTable.tableName,
        BUCKET_NAME: imagesBucket.bucketName,
        REGION: "eu-west-1",
      },
    });

    // --- S3 -> SNS notification ---
    imagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SnsDestination(newImageTopic)
    );

    // --- SNS -> SQS (image processing queue subscribes to topic) ---
    // (Replaced the simple subscription with body-filter + raw delivery)
    newImageTopic.addSubscription(
      new subs.SqsSubscription(imageProcessQueue, {
        filterPolicyWithMessageBody: {
          Records: sns.FilterOrPolicy.policy({
            s3: sns.FilterOrPolicy.policy({
              object: sns.FilterOrPolicy.policy({
                key: sns.FilterOrPolicy.filter(
                  sns.SubscriptionFilter.stringFilter({
                    matchPrefixes: ["image"],
                  })
                ),
              }),
            }),
          }),
        },
        rawMessageDelivery: true,
      })
    );

    // --- SQS -> Lambda (image processing) ---
    const newImageEventSource = new events.SqsEventSource(imageProcessQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(5),
    });
    processImageFn.addEventSource(newImageEventSource);

    // --- Permissions for ProcessImage ---
    imagesBucket.grantRead(processImageFn);
    imagesTable.grantReadWriteData(processImageFn);

    // ------------- SES path now via DynamoDB Streams -------------

    // b) mailer lambda function
    const mailerFn = new lambdanode.NodejsFunction(this, "mailer", {
      // per lab: Node 16; change to NODEJS_18_X if your account restricts 16
      runtime: lambda.Runtime.NODEJS_16_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(3),
      entry: `${__dirname}/../lambdas/mailer.ts`,
    });

    // e) allow SES sends for the mailer lambda
    mailerFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ses:SendEmail", "ses:SendRawEmail", "ses:SendTemplatedEmail"],
        resources: ["*"],
      })
    );

    // Remove the code that sets the mail queue as the event source for the lambda:
    // mailerFn.addEventSource(newImageMailEventSource);

    // Remove the code that sets the subscription of the mail queue to the topic:
    // newImageTopic.addSubscription(new subs.SqsSubscription(mailerQ), {
    //   . . . configuration . . . 
    // });

    // Remove the code that sets sets the mail queue event source to triggers the lambda function:
    // const newImageMailEventSource = new events.SqsEventSource(mailerQ, {
    //   batchSize: 5,
    //   maxBatchingWindow: cdk.Duration.seconds(5),
    // });

    // Remove the mail SQS queue code:
    // const mailerQ = new sqs.Queue(this, "mailer-q", {
    //   receiveMessageWaitTime: cdk.Duration.seconds(10),
    // });

    // Set the DnamoDB stream as the event source for the lambda: the Dy
    mailerFn.addEventSource(
      new source.DynamoEventSource(imagesTable, {
        startingPosition: lambda.StartingPosition.LATEST,
      })
    );

    // Output the topic ARN:
    new cdk.CfnOutput(this, "SnsTopicArn", {
      value: newImageTopic.topicArn,
    });

    // --- Output (unchanged) ---
    new cdk.CfnOutput(this, "bucketName", {
      value: imagesBucket.bucketName,
    });
  }
}
