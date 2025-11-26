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

    // --- SQS queue (RENAMED for image processing consumer) ---
    const imageProcessQueue = new sqs.Queue(this, "img-process-q", {
      // longer long-poll to reduce API calls & cost
      receiveMessageWaitTime: cdk.Duration.seconds(10),
    });

    // --- SNS topic for fan-out ---
    const newImageTopic = new sns.Topic(this, "NewImageTopic", {
      displayName: "New Image topic",
    });

    // --- Lambda (unchanged) ---
    const processImageFn = new lambdanode.NodejsFunction(this, "ProcessImage", {
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: `${__dirname}/../lambdas/processImage.ts`,
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
    });

    // --- S3 -> SNS (changed from SQS destination to SNS destination) ---
    imagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SnsDestination(newImageTopic)
    );

    // --- SNS -> SQS subscription (queue subscribes to the topic) ---
    newImageTopic.addSubscription(new subs.SqsSubscription(imageProcessQueue));

    // --- SQS -> Lambda (event source mapping; FIXED variable name) ---
    const newImageEventSource = new events.SqsEventSource(imageProcessQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(5),
    });
    processImageFn.addEventSource(newImageEventSource);

    // --- Permissions (least privilege read of S3 objects) ---
    imagesBucket.grantRead(processImageFn);

    // --- Output (unchanged) ---
    new cdk.CfnOutput(this, "bucketName", {
      value: imagesBucket.bucketName,
    });
  }
}
