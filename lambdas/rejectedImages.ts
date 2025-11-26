/* eslint-disable import/extensions, import/no-absolute-path */
import { SQSHandler } from "aws-lambda";

export const handler: SQSHandler = async (event) => {
  console.log("Event ", event);
  for (const record of event.Records) {
    const recordBody = JSON.parse(record.body);              // SQS message
    const snsMessage = recordBody.Message
      ? JSON.parse(recordBody.Message)                       // SNS message
      : recordBody;

    if (snsMessage.Records) {
      for (const s3Message of snsMessage.Records) {
        const s3e = s3Message.s3;
        const srcBucket = s3e.bucket.name;
        console.log("Rejected file: ", s3Message.s3.object.key);
      }
    }
  }
};
